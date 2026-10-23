import type { FastifyInstance, FastifyRequest } from "fastify";
import { isWebApiV5Plus, type Env } from "./env.js";
import { isTimeoutError, loginQb, qbVersion, extractSid, type QbSid } from "./qbClient.js";
import type { SessionStore } from "./sessionStore.js";
import { veneerCookieOpts, veneerIdFrom } from "./cookies.js";

interface LoginBody {
  username?: string;
  password?: string;
}

// Per-IP failed-login brake: qB bans the *container* IP after 5 consecutive
// failures, so never let one client burn more than a few qB-bound attempts.
// Attempts past the threshold are rejected WITHOUT touching qB.
const FAIL_THRESHOLD = 3;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
interface FailEntry {
  fails: number;
  windowStart: number;
  blockedUntil: number;
}
const failMap = new Map<string, FailEntry>();

// In-flight login attempts per IP: failBlocked/failRecord alone have a
// check-then-act race — N parallel bad logins all pass the check before any
// records, letting one burst burn the container-IP ban budget. Counting
// in-flight attempts closes it: at most FAIL_THRESHOLD concurrent qB attempts.
// Declared before failBlocked: the check MUST consult inflight even for
// unknown keys (no failMap entry yet), otherwise the first burst on a clean
// IP sails through untouched.
const inflight = new Map<string, number>();

function failBlocked(key: string): boolean {
  // Concurrent burst on a clean IP: no failMap entry exists yet, but
  // in-flight attempts already count toward the threshold.
  if ((inflight.get(key) ?? 0) >= FAIL_THRESHOLD) return true;
  const e = failMap.get(key);
  if (e) {
    if (e.blockedUntil > Date.now()) return true;
    if (Date.now() - e.windowStart > FAIL_WINDOW_MS) failMap.delete(key);
    else if (e.fails + (inflight.get(key) ?? 0) >= FAIL_THRESHOLD) return true;
    return false;
  }
  // Fail closed under flood: an unknown key when the map is full is treated
  // as blocked rather than growing memory without bound.
  return failMap.size >= 5000;
}

function failRecord(key: string, success: boolean): void {
  if (success) {
    failMap.delete(key);
    return;
  }
  const now = Date.now();
  const e = failMap.get(key);
  if (!e || now - e.windowStart > FAIL_WINDOW_MS) {
    failMap.set(key, { fails: 1, windowStart: now, blockedUntil: 0 });
    return;
  }
  e.fails++;
  if (e.fails >= FAIL_THRESHOLD) e.blockedUntil = now + BLOCK_MS;
  if (failMap.size > 5000) {
    for (const [k, v] of failMap) {
      if (v.blockedUntil <= now && now - v.windowStart > FAIL_WINDOW_MS) failMap.delete(k);
      if (failMap.size <= 4000) break;
    }
  }
}

/**
 * Same-origin check against login CSRF: a cross-site form POST always carries
 * the attacker's Origin/Referer, while our own UI sends ours. Requests with
 * no Origin/Referer (curl, tests) are allowed through.
 * Compares hostnames only (not port): the Vite dev server runs on :5173 while
 * the backend is on :8081, and that split is legitimate same-origin dev use.
 *
 * Accepted hostnames:
 * - PUBLIC_ORIGIN (explicit allowlist for reverse-proxy deployments)
 * - X-Forwarded-Host when TRUST_PROXY=true (nginx may rewrite Host to the
 *   upstream target, e.g. 127.0.0.1:8081 — trusting the forwarded host keeps
 *   login working without weakening direct-exposure mode). The proxy MUST
 *   overwrite X-Forwarded-Host; never pass a client-supplied value through.
 * - the Host header
 */
function hostnameOf(value: string): string {
  const v = value.trim();
  if (v === "") return "";
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return end > 0 ? v.slice(1, end) : "";
  }
  return v.split(":")[0];
}

function loginSameOrigin(req: FastifyRequest, env: Env): boolean {
  const raw = req.headers.origin ?? req.headers.referer;
  if (!raw) return true;
  try {
    const o = new URL(Array.isArray(raw) ? raw[0] : raw);
    const candidates: string[] = [];
    if (env.trustProxy) {
      const xfh = req.headers["x-forwarded-host"];
      const first = Array.isArray(xfh) ? xfh[0] : xfh;
      if (first) candidates.push(first.split(",")[0]);
    }
    if (env.publicOrigin) {
      try {
        candidates.push(new URL(env.publicOrigin).hostname);
      } catch {
        // ignore malformed PUBLIC_ORIGIN; Host still applies
      }
    }
    if (req.headers.host) candidates.push(req.headers.host);
    const originHost = hostnameOf(o.hostname).toLowerCase();
    return candidates.some((c) => hostnameOf(c).toLowerCase() === originHost);
  } catch {
    return false;
  }
}

export async function registerSessionRoutes(app: FastifyInstance, env: Env, sessions: SessionStore): Promise<void> {
  const cookieOpts = veneerCookieOpts(env);

  // Rate-limit login: qB bans the *container* IP after 5 fails, locking out everyone.
  await app.register(import("@fastify/rate-limit"), {
    global: false,
  });

  app.post<{ Body: LoginBody }>(
    "/api/session/login",
    {
      config: { rateLimit: { max: 4, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      if (!loginSameOrigin(req, env)) {
        return reply.code(403).send({
          error:
            "Cross-site login refused. If this is your own deployment, set PUBLIC_ORIGIN to the browser-facing URL, or make the proxy send X-Forwarded-Host and enable TRUST_PROXY.",
        });
      }
      const { username = "", password = "" } = req.body ?? {};
      if (typeof username !== "string" || typeof password !== "string" || !username) {
        return reply.code(400).send({ error: "username and password strings required" });
      }
      if (failBlocked(req.ip)) {
        return reply.code(429).send({ error: "Too many failed logins from this address. Try again later." });
      }
      let result: { ok: boolean; sid?: QbSid; banned?: boolean; body?: string; status?: number };
      inflight.set(req.ip, (inflight.get(req.ip) ?? 0) + 1);
      try {
        result = await loginQb(env.qbUrl, username, password);
      } catch (err) {
        if (isTimeoutError(err)) return reply.code(504).send({ error: "qBittorrent login timed out" });
        return reply.code(502).send({ error: "qBittorrent unreachable" });
      } finally {
        const n = (inflight.get(req.ip) ?? 1) - 1;
        if (n <= 0) inflight.delete(req.ip);
        else inflight.set(req.ip, n);
      }
      if (result.banned) return reply.code(429).send({ error: "qBittorrent banned this IP after too many attempts. Wait 1h or whitelist in qB." });
      // qB server fault / redirect, not bad credentials: report 502 and do NOT
      // burn the anti-ban brake on innocent users sharing this IP.
      if (result.status !== undefined && result.status >= 500) {
        return reply.code(502).send({ error: `qBittorrent error during login (HTTP ${result.status})` });
      }
      if (result.status !== undefined && result.status >= 300 && result.status < 400) {
        return reply.code(502).send({ error: result.body ?? `qBittorrent login redirected (HTTP ${result.status}) — check QB_URL` });
      }
      // Other client errors (404 wrong subpath, 400 bad request) are config
      // faults, not wrong passwords — do not burn the shared anti-ban brake.
      if (result.status !== undefined && result.status >= 400 && result.status !== 401 && result.status !== 403) {
        return reply.code(502).send({ error: `qBittorrent login failed (HTTP ${result.status}) — check QB_URL` });
      }
      if (!result.ok) {
        failRecord(req.ip, false);
        return reply.code(401).send({ error: "Invalid qBittorrent credentials" });
      }
      if (!result.sid) {
        // Success body but no session cookie (stripped headers, qB edge):
        // server fault, NOT bad credentials — 502 without burning the brake.
        return reply.code(502).send({ error: "qBittorrent login succeeded but returned no session cookie" });
      }
      failRecord(req.ip, true);

      let webapiVersion = "2.0";
      let appVersion = "";
      let isV5 = false;
      // One retry: a transient blip must not silently mislabel a 5.x server
      // as legacy (wrong stop/start verbs until re-login). Truly old qB
      // without webapiVersion still resolves via the app/version major below.
      let v: { version: string; webapi: string } | undefined;
      // Retry once on TRANSIENT failure only (timeout/network). A 403
      // (ban/dead SID) fails fast and must not be retried — it would just add
      // latency. Non-2xx non-403 bodies (404 pages etc.) don't throw at all;
      // garbage is filtered by the version-string validation below.
      try {
        v = await qbVersion(env.qbUrl, result.sid);
      } catch (err) {
        if ((err as { status?: number } | null)?.status === 403) {
          v = undefined;
        } else {
          try {
            v = await qbVersion(env.qbUrl, result.sid);
          } catch {
            v = undefined;
          }
        }
      }
      if (v) {
        // Accept only sane version strings: a reverse-proxy error page
        // ("500 Internal Server Error" contains digit runs ≥5) must not
        // mislabel a server as V5, and must not surface as appVersion.
        if (/^\d+\.\d+/.test(v.webapi.trim())) webapiVersion = v.webapi.trim();
        const appRaw = v.version.trim();
        appVersion = /^v?\d+\.\d+/.test(appRaw) ? appRaw : "";
        const major = /^v?(\d+)\./.exec(appRaw)?.[1];
        isV5 = isWebApiV5Plus(webapiVersion) || (major !== undefined && Number(major) >= 5);
      }

      const id = sessions.create({ qbSid: result.sid, webapiVersion, isV5 });
      return reply.setCookie(env.veneerCookie, id, cookieOpts).send({ ok: true, webapiVersion, appVersion, isV5 });
    }
  );

  app.post("/api/session/logout", async (req, reply) => {
    const id = veneerIdFrom(req, env);
    const s = sessions.get(id);
    if (s) {
      try {
        await fetch(`${env.qbUrl}/api/v2/auth/logout`, {
          method: "POST",
          headers: { Cookie: `${s.qbSid.name}=${s.qbSid.value}`, Referer: `${env.qbUrl}/` },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // ignore — still clear local session
      }
    }
    sessions.delete(id);
    return reply
      .clearCookie(env.veneerCookie, { path: "/", httpOnly: true, sameSite: "lax", secure: env.cookieSecure })
      .send({ ok: true });
  });

  app.get("/api/session/status", async (req, reply) => {
    const id = veneerIdFrom(req, env);
    const s = sessions.get(id);
    if (!s) return reply.code(401).send({ loggedIn: false });
    // Ping lightweight endpoint. A 403 here is AMBIGUOUS: dead SID (qB restart /
    // logout elsewhere) or container-IP ban both yield 403 — so unlike a naive
    // handler, never delete the server session on 403. The proxy path reconciles
    // dead SIDs on next use; surviving a ban lets users log straight back in.
    try {
      const res = await fetch(`${env.qbUrl}/api/v2/app/version`, {
        headers: { Cookie: `${s.qbSid.name}=${s.qbSid.value}`, Referer: `${env.qbUrl}/` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 403) {
        await res.arrayBuffer().catch(() => undefined);
        // Deliberately 200 (not 5xx): a dead SID or container-IP ban is a
        // routine client-session event, and the message must reach the UI.
        // Slide the browser cookie too: sessions.get() above already slid the
        // server TTL, and a long ban must not desync the two.
        reply.setCookie(env.veneerCookie, id!, { ...cookieOpts });
        return reply.send({ loggedIn: false, degraded: true, error: "qBittorrent refusing requests (invalid session or server IP ban)" });
      }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        // Session preserved (transient qB fault) — slide the browser cookie
        // with the server TTL so active use doesn't expire it mid-outage.
        reply.setCookie(env.veneerCookie, id!, { ...cookieOpts });
        return reply.code(502).send({ loggedIn: false, error: `qBittorrent replied ${res.status}` });
      }
      // Refresh SID if qB rotated it
      const gsc = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
      if (typeof gsc === "function") {
        const sid = extractSid(gsc.call(res.headers));
        if (sid && id) sessions.updateSid(id, sid);
      }
      // Drain the probe body so the connection can be reused.
      await res.arrayBuffer().catch(() => undefined);
      // Slide the browser cookie alongside the sliding server-side TTL
      reply.setCookie(env.veneerCookie, id!, { ...cookieOpts });
      return reply.send({ loggedIn: true, webapiVersion: s.webapiVersion, isV5: s.isV5 });
    } catch (err) {
      if (isTimeoutError(err)) return reply.code(504).send({ loggedIn: false, error: "qBittorrent timed out" });
      return reply.code(502).send({ loggedIn: false, error: "qBittorrent unreachable" });
    }
  });
}
