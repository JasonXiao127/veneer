import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Env } from "./env.js";
import type { SessionStore } from "./sessionStore.js";
import { extractSid, isTimeoutError, qbFetchHeaders } from "./qbClient.js";
import { veneerCookieOpts, veneerIdFrom } from "./cookies.js";

/**
 * Raw passthrough proxy: /api/qb/* -> QB_URL/api/v2/*.
 * Encapsulated plugin with raw Buffer parsing so multipart boundaries survive
 * untouched. NOTE: bodyLimit MUST be a route option — Fastify ignores it as a
 * register() option, so it is set on scoped.route() below.
 */

/**
 * Path remainder taken from the RAW url, preserving percent-encoding.
 * The wildcard route param is already decoded by the router; re-embedding it
 * raw would turn %2F into / (route escape) and break encoded segments.
 */
function rawRest(req: FastifyRequest): string {
  const rawUrl = req.raw.url ?? req.url;
  const qIdx = rawUrl.indexOf("?");
  const rawPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const prefix = "/api/qb/";
  if (rawPath.startsWith(prefix)) return rawPath.slice(prefix.length);
  return (req.params as { "*": string })["*"] ?? "";
}

function rawQuery(req: FastifyRequest): string {
  const rawUrl = req.raw.url ?? req.url;
  const qIdx = rawUrl.indexOf("?");
  return qIdx >= 0 ? rawUrl.slice(qIdx) : "";
}

/**
 * Scope guard: fetch() normalizes dot-segments (even %2e spellings) and treats
 * backslash as a separator on http(s) URLs, which would let a crafted path
 * escape /api/v2. Real qB endpoint names are plain [A-Za-z0-9._~-] segments;
 * % is allowed so encoded segments (e.g. %2F) pass through untouched — safety
 * comes from the decoded dot/backslash checks below, not from banning %.
 */
function restInScope(rest: string): boolean {
  // Iterative decode: single decode leaves %252e as "%2e" (still encoded on
  // the wire, harmless) — but decode fully for the safety check so no
  // multi-encoded dot/backslash slips past it.
  let dec = rest;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(dec);
      if (next === dec) break;
      dec = next;
    } catch {
      return false;
    }
  }
  if (dec.includes("\0") || dec.includes("\\")) return false;
  if (rest !== "" && !/^[A-Za-z0-9._~/%-]+$/.test(rest)) return false;
  // Dot-segments (literal or %2e-encoded) would be normalized by fetch() and
  // escape /api/v2 — real endpoint names never contain them.
  return !/(^|\/)\.\.?(\/|$)/.test(dec);
}

export async function registerQbProxy(app: FastifyInstance, env: Env, sessions: SessionStore): Promise<void> {
  await app.register(async (scoped: FastifyInstance) => {
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    // bodyLimit is a ROUTE option (register() ignores it) — without this the
    // 1MiB default rejects real .torrent uploads with 413.
    scoped.route({
      method: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
      url: "/api/qb/*",
      bodyLimit: 25 * 1024 * 1024,
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const veneerId = veneerIdFrom(req, env);
        const sess = sessions.get(veneerId);
        if (!sess) return reply.code(401).send({ error: "Not logged in" });

        const rest = rawRest(req);
        if (!restInScope(rest)) return reply.code(400).send({ error: "Path outside API scope" });
        const target = `${env.qbUrl}/api/v2/${rest}${rawQuery(req)}`;

        const incomingCt = req.headers["content-type"];
        const headers = qbFetchHeaders(env.qbUrl, sess.qbSid, incomingCt);

        // Preserve raw body bytes; GET/HEAD have no body
        let body: Buffer | undefined;
        if (req.method !== "GET" && req.method !== "HEAD") {
          const b = req.body as Buffer | undefined;
          body = b && b.length > 0 ? b : undefined;
        }

        let upstream: Response;
        try {
          upstream = await fetch(target, {
            method: req.method,
            headers,
            body: body as unknown as BodyInit | undefined,
            redirect: "manual",
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          req.log.error({ err, target }, "qB unreachable");
          const code = isTimeoutError(err) ? 504 : 502;
          return reply.code(code).send({ error: code === 504 ? "qBittorrent timed out" : "qBittorrent unreachable" });
        }

        if (upstream.status === 403) {
          // 403 = dead SID OR container-IP ban (indistinguishable). Preserve the
          // server session (a ban must not wipe everyone); the client re-logs in.
          // Slide the browser cookie with the server TTL (sessions.get above
          // already slid server-side) so a long ban doesn't desync the two.
          if (veneerId) {
            reply.setCookie(env.veneerCookie, veneerId, veneerCookieOpts(env));
          }
          return reply.code(403).send({
            error: "qBittorrent refused the request (session expired or server IP banned). Please log in again; if login reports a ban, wait or whitelist the container IP in qB.",
          });
        }

        const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
        let buf: Buffer;
        try {
          // NOTE: buffered, not streamed — fine for API payloads; revisit if
          // very large lists cause memory pressure.
          buf = Buffer.from(await upstream.arrayBuffer());
        } catch (err) {
          const code = isTimeoutError(err) ? 504 : 502;
          return reply.code(code).send({ error: code === 504 ? "qBittorrent timed out" : "qBittorrent unreachable" });
        }
        // Forward SID rotation if qB set a new cookie (name-agnostic: 5.2 uses QBT_SID_<port>)
        const gsc = (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
        if (typeof gsc === "function") {
          const sid = extractSid(gsc.call(upstream.headers));
          if (sid && veneerId) sessions.updateSid(veneerId, sid);
        }
        reply.code(upstream.status).header("content-type", ct);
        const cd = upstream.headers.get("content-disposition");
        if (cd) reply.header("content-disposition", cd);
        // Rewrite qB-internal redirect targets to our own namespace; drop
        // absolute URLs that would leak QB_URL's host to the browser.
        const loc = upstream.headers.get("location");
        if (loc) {
          if (loc.startsWith("/api/v2/")) reply.header("location", `/api/qb/${loc.slice("/api/v2/".length)}`);
          else if (loc.startsWith("/") && !loc.startsWith("//")) reply.header("location", loc);
        }
        // Slide the veneer cookie: server TTL slides on every access, so the
        // browser cookie must too, or long sessions die at login+24h.
        if (veneerId) {
          reply.setCookie(env.veneerCookie, veneerId, veneerCookieOpts(env));
        }
        return reply.send(buf);
      },
    });
  });
}
