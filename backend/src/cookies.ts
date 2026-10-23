import type { FastifyRequest } from "fastify";
import type { Env } from "./env.js";

/**
 * Signed session cookie helpers.
 *
 * The cookie value is the opaque SessionStore UUID, signed with
 * SESSION_SECRET via @fastify/cookie. Reading goes through unsignCookie so a
 * tampered/injected cookie is rejected instead of looked up. Unsigned/corrupt
 * values are treated as "no session" (user re-logs in).
 */

export function veneerCookieOpts(env: Env) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.cookieSecure,
    path: "/",
    maxAge: Math.floor(env.sessionTtlMs / 1000),
    signed: true,
  };
}

/** Read + verify the veneer session id from the request cookie. */
export function veneerIdFrom(req: FastifyRequest, env: Env): string | undefined {
  const raw = req.cookies[env.veneerCookie];
  if (!raw) return undefined;
  // unsignCookie is provided by @fastify/cookie (registered in server.ts).
  const parsed = req.unsignCookie(raw);
  if (!parsed.valid || !parsed.value) return undefined;
  return parsed.value;
}
