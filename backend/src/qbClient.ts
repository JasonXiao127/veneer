const QB_ORIGIN_HEADERS = ["origin", "referer", "cookie", "host", "content-length"] as const;

export interface QbSid {
  /** Cookie name as set by qB: "SID" (<5.2) or "QBT_SID_<port>" (5.2+); 5.1 also allows a custom name. */
  name: string;
  value: string;
}

export function qbFetchHeaders(qbUrl: string, sid: QbSid, incomingContentType?: string): Headers {
  const origin = new URL(qbUrl).origin;
  const h = new Headers();
  h.set("Origin", origin);
  h.set("Referer", `${qbUrl}/`);
  h.set("Cookie", `${sid.name}=${sid.value}`);
  if (incomingContentType) h.set("Content-Type", incomingContentType);
  return h;
}

/**
 * Extract session name+value from Set-Cookie headers.
 * Prefers qB's own cookies (SID, QBT_SID_<port>, custom 5.1 names containing
 * "sid"), explicitly de-prioritizing common foreign session cookies that also
 * contain "sid" (PHPSESSID, JSESSIONID, connect.sid) injected by an auth proxy.
 * With allowFallback (login only), falls back to the first cookie pair.
 * Rotation paths must NOT fall back: a stray non-session cookie would
 * otherwise clobber the good SID in the store and wedge the session.
 */
const FOREIGN_SID_COOKIES = new Set(["phpsessid", "jsessionid", "connect.sid", "laravel_session", "sessionid"]);

export function extractSid(setCookies: string[], allowFallback = false): QbSid | undefined {
  let fallback: QbSid | undefined;
  let containsSid: QbSid | undefined;
  for (const c of setCookies) {
    const first = c.split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name || !value) continue;
    const lower = name.toLowerCase();
    // qB's real session cookies win outright.
    if (lower === "sid" || lower.startsWith("qbt_sid")) return { name, value };
    fallback ??= { name, value };
    if (!containsSid && lower.includes("sid") && !FOREIGN_SID_COOKIES.has(lower)) {
      containsSid = { name, value };
    }
  }
  if (containsSid) return containsSid;
  return allowFallback ? fallback : undefined;
}

/** Upstream timeout for qB calls (ms). Prevents a wedged qB from pinning proxy sockets. */
export const QB_TIMEOUT_MS = 15_000;

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(QB_TIMEOUT_MS);
}

/**
 * Login to qB. Returns { ok, sid?, banned? }.
 * Version quirks:
 * - <5.2: bad creds => 200 "Fails." with NO cookie (not 401); success 200 "Ok." + SID cookie.
 * - 5.2+: success => 204 empty body + QBT_SID_<port> cookie; bad creds => 401.
 * - 403 on /auth/login => client IP banned (any version).
 */
export async function loginQb(
  qbUrl: string,
  username: string,
  password: string
): Promise<{ ok: boolean; sid?: QbSid; banned?: boolean; body?: string; status?: number }> {
  const origin = new URL(qbUrl).origin;
  const res = await fetch(`${qbUrl}/api/v2/auth/login`, {
    method: "POST",
    signal: timeoutSignal(),
    // Do NOT follow redirects: a 301/302 would turn the POST into a GET,
    // drop credentials, and masquerade as "invalid credentials" while burning
    // the anti-ban brake. Surface redirects as a config error instead.
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
      Referer: `${qbUrl}/`,
    },
    body: new URLSearchParams({ username, password }).toString(),
  });
  if (res.status === 403) return { ok: false, banned: true, status: 403 };
  if (res.status === 401) return { ok: false, body: "Unauthorized", status: 401 };
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, body: `qBittorrent login redirected (${res.status}) — check QB_URL for trailing-slash/subpath/HTTP->HTTPS`, status: res.status };
  }
  const body = (await res.text()).trim();
  // Node 18+: getSetCookie() returns string[]; fallback to single header
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(res.headers) : [];
  const sid = extractSid(setCookies, true);
  if (res.ok && (body === "Ok." || body === "")) {
    // Success body WITHOUT a session cookie (stripped proxy headers, qB edge):
    // report ok WITHOUT sid so the caller returns 502 (server fault), not 401,
    // and does not burn the anti-ban brake on correct credentials.
    if (!sid) return { ok: true, body, status: res.status };
    return { ok: true, sid, body, status: res.status };
  }
  return { ok: false, body, status: res.status };
}

export async function qbVersion(qbUrl: string, sid: QbSid): Promise<{ version: string; webapi: string }> {
  const h = qbFetchHeaders(qbUrl, sid);
  const signal = timeoutSignal();
  const [vRes, wRes] = await Promise.all([
    fetch(`${qbUrl}/api/v2/app/version`, { headers: h, signal }),
    fetch(`${qbUrl}/api/v2/app/webapiVersion`, { headers: h, signal }),
  ]);
  if (vRes.status === 403 || wRes.status === 403) {
    // Drain both bodies so undici can reuse the connection.
    await Promise.all([vRes.arrayBuffer().catch(() => undefined), wRes.arrayBuffer().catch(() => undefined)]);
    throw Object.assign(new Error("qb forbidden"), { status: 403 });
  }
  const version = (await vRes.text()).trim();
  const webapi = (await wRes.text()).trim();
  return { version, webapi };
}

/** True for fetch aborts caused by AbortSignal.timeout() (DOMException "TimeoutError") or manual abort. */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export { QB_ORIGIN_HEADERS };
