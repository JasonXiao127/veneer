export interface Env {
  qbUrl: string;
  port: number;
  host: string;
  sessionSecret: string;
  logLevel: string;
  trustProxy: boolean;
  // NEVER enable on a directly exposed socket: clients can rotate
  // X-Forwarded-For per request and walk around the login brake.
  cookieSecure: boolean;
  veneerCookie: string;
  sessionTtlMs: number;
  rulesFile: string;
  rulesIntervalMin: number;
  /** Optional absolute public origin, e.g. https://veneer.example.com (login CSRF allowlist). */
  publicOrigin: string;
}

/** Publicly-known placeholder — refused at boot. Keep in sync with .env.example. */
export const DEFAULT_SESSION_SECRET = "change-me-to-32-random-chars";

function str(v: string | undefined, dflt: string): string {
  const t = (v ?? "").trim();
  return t === "" ? dflt : t;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return v === "1" || v.toLowerCase() === "true";
}

function ttlMs(v: string | undefined): number {
  const n = Number(v ?? 24);
  // Guard operator error: NaN/non-positive/absurd values fall back to 24h
  // instead of silently disabling expiry.
  if (!Number.isFinite(n) || n <= 0 || n > 720) return 24 * 3600 * 1000;
  return n * 3600 * 1000;
}

function port(v: string | undefined): number {
  const n = Number(v ?? 8081);
  // Guard typos: NaN, empty (0 = random port!), out-of-range fall back to 8081
  // instead of crashing boot or listening somewhere surprising. The caller
  // logs a warning when the raw value was non-empty but did not parse.
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 8081;
  return n;
}

const PINO_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

function logLevel(v: string | undefined): string {
  const l = str(v, "info").toLowerCase();
  // A logging typo (LOG_LEVEL=verbose/http) must not crash Fastify's pino
  // constructor before the listener starts.
  return PINO_LEVELS.has(l) ? l : "info";
}

function rulesIntervalMin(v: string | undefined): number {
  const raw = (v ?? "").trim();
  if (raw === "") return 5;
  const n = Number(raw);
  // 0 disables the auto-enforce ticker; anything outside 0..1440 falls back to 5.
  if (!Number.isInteger(n) || n < 0 || n > 1440) return 5;
  return n;
}

function endSlash(v: string): string {
  return v.replace(/\/+$/, "");
}

export function loadEnv(): Env {
  // Empty (docker -e VAR=) is treated as unset, like every other knob.
  const qbUrl = endSlash(str(process.env.QB_URL, "http://localhost:8080"));
  const rawRulesFile = (process.env.RULES_FILE ?? "").trim();
  const rawPublic = (process.env.PUBLIC_ORIGIN ?? "").trim();
  const publicOrigin = rawPublic === ""
    ? ""
    : endSlash(/^https?:\/\//i.test(rawPublic) ? rawPublic : `https://${rawPublic}`);
  return {
    qbUrl,
    port: port(process.env.PORT),
    host: str(process.env.HOST, "0.0.0.0"),
    sessionSecret: str(process.env.SESSION_SECRET, DEFAULT_SESSION_SECRET),
    logLevel: logLevel(process.env.LOG_LEVEL),
    trustProxy: bool(process.env.TRUST_PROXY, false),
    cookieSecure: bool(process.env.COOKIE_SECURE, false),
    veneerCookie: str(process.env.VENEER_COOKIE, "veneer_sid"),
    sessionTtlMs: ttlMs(process.env.SESSION_TTL_HOURS),
    rulesFile: rawRulesFile === "" ? "./data/rules.json" : rawRulesFile,
    rulesIntervalMin: rulesIntervalMin(process.env.RULES_INTERVAL_MIN),
    publicOrigin,
  };
}

/** Parse "2.11.4" safely. Never use parseFloat / string compare (2.9 > 2.11 lexicographically). */
export function isWebApiV5Plus(version: string): boolean {
  const parts = version.trim().split(".").map(Number);
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return false;
  // WebAPI 3.x (if it ever exists) keeps the stop/start API.
  return parts[0] > 2 || (parts[0] === 2 && parts[1] >= 11);
}
