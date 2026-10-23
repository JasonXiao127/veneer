import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Env } from "./env.js";
import type { SessionStore, VeneerSession } from "./sessionStore.js";
import { isTimeoutError, qbFetchHeaders, type QbSid } from "./qbClient.js";
import { veneerIdFrom } from "./cookies.js";

/**
 * Seed-limit rules: match torrents by tracker site + private/public kind and
 * enforce per-torrent share limits (ratio / seeding time / inactive seeding
 * time) via qB's torrents/setShareLimits. Persisted as JSON on disk.
 */

export type RuleKind = "private" | "public";

export interface RuleMatch {
  kind?: RuleKind;
  site?: string;
}

export interface Rule {
  id: string;
  label: string;
  match: RuleMatch;
  ratioLimit: number;
  seedingTimeLimit: number;
  inactiveSeedingTimeLimit: number;
  enabled: boolean;
}

/** Hard cap on stored rules to bound file size and per-tick work. */
export const MAX_RULES = 200;

/** Seed-preset equivalents (see frontend lib/seedPresets.ts DEFAULT_PRESETS). */
function defaultRules(): Rule[] {
  return [
    {
      id: "private-default",
      label: "Private default (ratio 1.0, 72h)",
      match: { kind: "private" },
      ratioLimit: 1,
      seedingTimeLimit: 4320,
      inactiveSeedingTimeLimit: 1440,
      enabled: true,
    },
    {
      id: "public-default",
      label: "Public default (ratio 0.5, 24h)",
      match: { kind: "public" },
      ratioLimit: 0.5,
      seedingTimeLimit: 1440,
      inactiveSeedingTimeLimit: 1440,
      enabled: true,
    },
  ];
}

/**
 * Normalize a persisted limit against qB's domain (-2 global, -1 unlimited,
 * >= 0 explicit; time limits are whole minutes). Invalid values become -2
 * (no opinion) instead of persisting and 400ing on every enforce pass.
 */
function limitOr(v: unknown, integer: boolean): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return -2;
  if (n !== -2 && n !== -1 && !(n >= 0)) return -2;
  if (integer && n !== -2 && n !== -1 && !Number.isInteger(n)) return -2;
  return n;
}

/** Tolerant per-rule normalization for disk loads: never throws, fills gaps. */
function normalizeLoadedRule(u: unknown): Rule {
  const o = (typeof u === "object" && u !== null ? u : {}) as Record<string, unknown>;
  const mRaw = o.match;
  const m = (typeof mRaw === "object" && mRaw !== null ? mRaw : {}) as Record<string, unknown>;
  const kind = m.kind === "private" || m.kind === "public" ? m.kind : undefined;
  const siteRawRaw = typeof m.site === "string" ? m.site.trim().toLowerCase().replace(/\.+$/, "") : "";
  // "unknown" is a sentinel for unattributable trackers. Keep it verbatim so
  // the rule stays inert (ruleFor never matches it); dropping it would turn a
  // previously dead site rule into a global catch-all.
  const siteRaw = siteRawRaw === "unknown" ? "unknown" : trackerDomainMinimal(siteRawRaw);
  return {
    id: typeof o.id === "string" && o.id.trim() !== "" ? o.id.trim().slice(0, 100) : randomUUID(),
    label: typeof o.label === "string" && o.label.trim() !== "" ? o.label.trim().slice(0, 200) : "Rule",
    match: { ...(kind ? { kind } : {}), ...(siteRaw ? { site: siteRaw.slice(0, 253) } : {}) },
    // Unknown/invalid numeric → -2 (use global): a no-opinion default, never enforced.
    ratioLimit: limitOr(o.ratioLimit, false),
    seedingTimeLimit: limitOr(o.seedingTimeLimit, true),
    inactiveSeedingTimeLimit: limitOr(o.inactiveSeedingTimeLimit, true),
    enabled: typeof o.enabled === "boolean" ? o.enabled : true,
  };
}

export function loadRules(file: string): Rule[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { rules?: unknown };
    if (!parsed || !Array.isArray(parsed.rules)) {
      // Corrupt shape: enforce NOTHING rather than silently applying seed
      // defaults to every session.
      console.error(`rules: ${file} has no rules array — ignoring it (no enforcement)`);
      return [];
    }
    const seen = new Set<string>();
    const out: Rule[] = [];
    for (const u of parsed.rules.slice(0, MAX_RULES)) {
      const r = normalizeLoadedRule(u);
      if (seen.has(r.id)) r.id = randomUUID();
      seen.add(r.id);
      out.push(r);
    }
    return out;
  } catch (err) {
    // First boot (missing file) is the only case that seeds defaults. A
    // parse/read failure must not swap in different rules behind the user's
    // back — log and enforce nothing.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultRules();
    console.error(`rules: failed to load ${file} — no rules enforced`, err);
    return [];
  }
}

export function saveRules(file: string, rules: Rule[]): void {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const payload = `${JSON.stringify({ version: 1, rules }, null, 2)}\n`;
  // Atomic write: crash mid-write must not leave truncated JSON that
  // loadRules would silently replace with seed defaults.
  const tmp = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, "utf8");
    try {
      fs.renameSync(tmp, resolved);
    } catch {
      // rename() fails with EBUSY/EXDEV when RULES_FILE is itself a bind
      // mount (single-file -v rules.json:/app/data/rules.json). Copy over the
      // mount point instead; still safer than truncating the live file first.
      fs.copyFileSync(tmp, resolved);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // the update succeeded; a stray tmp file is harmless
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // tmp may not exist
    }
    throw err;
  }
}

/** Strict validation for POST /api/rules (replace whole array). */
export function validatePostedRule(u: unknown): { rule?: Rule; error?: string } {
  if (typeof u !== "object" || u === null || Array.isArray(u)) return { error: "each rule must be an object" };
  const o = u as Record<string, unknown>;
  if (typeof o.label !== "string" || o.label.trim() === "") return { error: "rule.label must be a non-empty string" };
  const mRaw: unknown = o.match ?? {};
  if (typeof mRaw !== "object" || mRaw === null || Array.isArray(mRaw)) return { error: "rule.match must be an object" };
  const m = mRaw as Record<string, unknown>;
  let kind: RuleKind | undefined;
  if (m.kind !== undefined) {
    if (m.kind !== "private" && m.kind !== "public") return { error: 'rule.match.kind must be "private" or "public"' };
    kind = m.kind;
  }
  let site: string | undefined;
  if (m.site !== undefined) {
    if (typeof m.site !== "string") return { error: "rule.match.site must be a string" };
    const rawSite = m.site.trim().toLowerCase().replace(/\.+$/, "");
    if (rawSite === "unknown") return { error: 'rule.match.site "unknown" never matches (unknown trackers are not matchable)' };
    if (rawSite !== "") {
      // Matching uses the registrable domain (tracker.example.com → example.com),
      // so normalize here or a full-host rule would be silently dead.
      const normalized = trackerDomainMinimal(rawSite);
      if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.startsWith(".") || normalized.endsWith(".")) {
        return { error: "rule.match.site must be a hostname like example.com" };
      }
      site = normalized.slice(0, 253);
    }
  }
  for (const k of ["ratioLimit", "seedingTimeLimit", "inactiveSeedingTimeLimit"] as const) {
    if (typeof o[k] !== "number" || !Number.isFinite(o[k])) return { error: `rule.${k} must be a finite number` };
    const v = o[k] as number;
    // qB domain: -2 = use global, -1 = unlimited, else >= 0. -0.5/-3 would
    // persist then 400 forever at enforce time.
    if (v !== -2 && v !== -1 && !(v >= 0)) return { error: `rule.${k} must be -2 (global), -1 (unlimited), or >= 0` };
    if (k !== "ratioLimit" && !Number.isInteger(v) && v !== -2 && v !== -1) {
      return { error: `rule.${k} must be an integer number of minutes (-2/-1 allowed)` };
    }
  }
  let id: string;
  if (o.id === undefined) id = randomUUID();
  else if (typeof o.id !== "string" || o.id.trim() === "") return { error: "rule.id must be a non-empty string" };
  else id = o.id.trim().slice(0, 100);
  if (o.enabled !== undefined && typeof o.enabled !== "boolean") {
    return { error: "rule.enabled must be a boolean" };
  }
  return {
    rule: {
      id,
      label: o.label.trim().slice(0, 200),
      match: { ...(kind ? { kind } : {}), ...(site ? { site } : {}) },
      ratioLimit: o.ratioLimit as number,
      seedingTimeLimit: o.seedingTimeLimit as number,
      inactiveSeedingTimeLimit: o.inactiveSeedingTimeLimit as number,
      enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    },
  };
}

/* ----- torrent classification (minimal, backend-local) ----- */

const SECOND_LEVEL_SUFFIXES = new Set([
  "co", "com", "org", "net", "gov", "edu", "ac", "ltd", "plc", "me", "sch",
]);

/** Last-2-labels domain, co.uk-aware (tracker.a.co.uk → a.co.uk). IPs returned as-is. */
export function trackerDomainMinimal(host: string): string {
  let h = host.trim().toLowerCase().replace(/\.+$/, "");
  if (h === "") return "";
  if (h.includes(":")) return h;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
  const labels = h.split(".").filter((p) => p !== "");
  if (labels.length <= 2) return labels.join(".");
  const [sld, tld] = labels.slice(-2);
  if (tld.length === 2 && SECOND_LEVEL_SUFFIXES.has(sld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

export function siteOfTracker(tracker: unknown): string {
  if (typeof tracker !== "string" || tracker.trim() === "") return "unknown";
  try {
    const u = new URL(tracker.trim());
    if (!u.hostname) return "unknown";
    return trackerDomainMinimal(u.hostname) || "unknown";
  } catch {
    return "unknown";
  }
}

export type TorrentKind = "private" | "public" | "unknown";

/** qB ≥5.0 serializes the privacy flag as `private`; accept `isPrivate` as fallback. */
export function kindOfTorrent(t: { private?: unknown; isPrivate?: unknown }): TorrentKind {
  const v = t.private ?? t.isPrivate;
  return v === true ? "private" : v === false ? "public" : "unknown";
}

/** First-match-wins over enabled rules: site-exact, then kind, then global catch-all. */
export function ruleFor(rules: Rule[], kind: TorrentKind, site: string): Rule | undefined {
  const enabled = rules.filter((r) => r.enabled);
  const siteNorm = site.toLowerCase();
  if (siteNorm !== "" && siteNorm !== "unknown") {
    const bySite = enabled.find(
      (r) => (r.match.site ?? "").toLowerCase() === siteNorm && (!r.match.kind || r.match.kind === kind)
    );
    if (bySite) return bySite;
  }
  if (kind === "private" || kind === "public") {
    const byKind = enabled.find((r) => !r.match.site && r.match.kind === kind);
    if (byKind) return byKind;
  }
  return enabled.find((r) => !r.match.site && !r.match.kind);
}

/**
 * Dimension compliance. A torrent value of -2 means "use the global limit";
 * a rule value of -2 means "set use-global". So -2 only counts as compliant
 * when the rule also asks for -2 — otherwise it is drift and gets enforced.
 * Unknown/missing values are treated as compliant (never mass-rewrite on a
 * partially serialized qB response).
 */
function dimOk(current: unknown, want: number): boolean {
  const c = typeof current === "string" ? Number(current) : current;
  if (typeof c !== "number" || !Number.isFinite(c)) return true;
  // Epsilon compare handles ratio floats; -2 only matches -2.
  return Math.abs(c - want) < 1e-9;
}

export interface QbTorrentInfo {
  hash?: unknown;
  tracker?: unknown;
  private?: unknown;
  isPrivate?: unknown;
  max_ratio?: unknown;
  max_seeding_time?: unknown;
  max_inactive_seeding_time?: unknown;
}

export function complianceOf(
  info: QbTorrentInfo,
  rule: Rule | undefined
): { ratioOk: boolean; timeOk: boolean; inactiveOk: boolean } {
  if (!rule) return { ratioOk: true, timeOk: true, inactiveOk: true };
  return {
    ratioOk: dimOk(info.max_ratio, rule.ratioLimit),
    timeOk: dimOk(info.max_seeding_time, rule.seedingTimeLimit),
    inactiveOk: dimOk(info.max_inactive_seeding_time, rule.inactiveSeedingTimeLimit),
  };
}

/* ----- qB enforcement ----- */

async function fetchTorrentsInfo(qbUrl: string, sid: QbSid): Promise<{ status: number; list?: QbTorrentInfo[] }> {
  const res = await fetch(`${qbUrl}/api/v2/torrents/info`, {
    headers: qbFetchHeaders(qbUrl, sid),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403) {
    await res.arrayBuffer().catch(() => undefined);
    return { status: 403 };
  }
  if (!res.ok) {
    // Drain so undici can reuse the socket on repeated failures.
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status };
  }
  const list = (await res.json()) as QbTorrentInfo[];
  return { status: 200, list: Array.isArray(list) ? list : [] };
}

export interface EnforceResult {
  applied: number;
  skipped: number;
  failed: number;
  /** Torrents that passed the optional hash filter (0 when the filter matched nothing). */
  matched: number;
  /** qB refused (dead SID or IP ban): caller must skip the session, never delete it. */
  forbidden: boolean;
  qbStatus?: number;
}

/**
 * Apply enabled rules to one qB session. Drifted torrents get setShareLimits
 * (all three limit fields + shareLimitAction=Default, urlencoded). Throws on
 * network/timeout errors so routes can map to 502/504.
 */
export async function enforceSession(opts: {
  qbUrl: string;
  sid: QbSid;
  rules: Rule[];
  hashes?: Set<string>;
}): Promise<EnforceResult> {
  const { qbUrl, sid, rules, hashes } = opts;
  const fetched = await fetchTorrentsInfo(qbUrl, sid);
  if (fetched.status === 403) return { applied: 0, skipped: 0, failed: 0, matched: 0, forbidden: true };
  if (!fetched.list) return { applied: 0, skipped: 0, failed: 0, matched: 0, forbidden: false, qbStatus: fetched.status };
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  let matched = 0;
  // Group drifted torrents by identical target limits so one setShareLimits
  // call covers a whole group (qB accepts |-separated hashes). Without this,
  // 1000 drifted torrents = 1000 sequential POSTs per tick.
  const groups = new Map<string, { rule: Rule; hashes: string[] }>();
  for (const t of fetched.list) {
    if (typeof t.hash !== "string" || t.hash === "") {
      skipped++;
      continue;
    }
    const h = t.hash.toLowerCase();
    if (hashes && !hashes.has(h) && !hashes.has(t.hash)) continue;
    matched++;
    const site = siteOfTracker(t.tracker);
    const kind = kindOfTorrent(t);
    const rule = ruleFor(rules, kind, site);
    if (!rule) {
      skipped++;
      continue;
    }
    const c = complianceOf(t, rule);
    if (c.ratioOk && c.timeOk && c.inactiveOk) {
      skipped++;
      continue;
    }
    const key = `${rule.ratioLimit}|${rule.seedingTimeLimit}|${rule.inactiveSeedingTimeLimit}`;
    const g = groups.get(key);
    if (g) g.hashes.push(t.hash);
    else groups.set(key, { rule, hashes: [t.hash] });
  }
  let consecutiveFails = 0;
  for (const { rule, hashes: hs } of groups.values()) {
    try {
      const res = await fetch(`${qbUrl}/api/v2/torrents/setShareLimits`, {
        method: "POST",
        headers: qbFetchHeaders(qbUrl, sid, "application/x-www-form-urlencoded"),
        body: new URLSearchParams({
          hashes: hs.join("|"),
          ratioLimit: String(rule.ratioLimit),
          seedingTimeLimit: String(rule.seedingTimeLimit),
          inactiveSeedingTimeLimit: String(rule.inactiveSeedingTimeLimit),
          shareLimitAction: "Default",
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      // 403 mid-pass = SID died or container got banned: stop, keep the session.
      if (res.status === 403) {
        await res.arrayBuffer().catch(() => undefined);
        return { applied, skipped, failed, matched, forbidden: true };
      }
      // Drain the body so the socket can be reused.
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok) {
        failed += hs.length;
        consecutiveFails++;
      } else {
        applied += hs.length;
        consecutiveFails = 0;
      }
    } catch {
      failed += hs.length;
      consecutiveFails++;
    }
    // Abort a wedged pass: qB down/hanging must not pin the ticker for hours
    // (15s x N). The overlap guard would then silently drop later ticks.
    if (consecutiveFails >= 3) {
      failed += [...groups.values()].reduce((n, g) => n + g.hashes.length, 0) - applied - failed;
      break;
    }
  }
  return { applied, skipped, failed, matched, forbidden: false };
}

/* ----- routes ----- */

function requireSession(req: FastifyRequest, env: Env, sessions: SessionStore): VeneerSession | undefined {
  return sessions.get(veneerIdFrom(req, env));
}

export async function registerRulesRoutes(app: FastifyInstance, env: Env, sessions: SessionStore): Promise<void> {
  app.get("/api/rules", async (req, reply) => {
    if (!requireSession(req, env, sessions)) return reply.code(401).send({ error: "Not logged in" });
    return { version: 1, rules: loadRules(env.rulesFile) };
  });

  app.post("/api/rules", async (req, reply) => {
    if (!requireSession(req, env, sessions)) return reply.code(401).send({ error: "Not logged in" });
    const body = req.body as unknown;
    const arr = Array.isArray(body) ? body : (typeof body === "object" && body !== null ? (body as { rules?: unknown }).rules : undefined);
    if (!Array.isArray(arr)) return reply.code(400).send({ error: "body must be a rules array or {rules: [...]}" });
    if (arr.length > MAX_RULES) return reply.code(400).send({ error: `too many rules (max ${MAX_RULES})` });
    const seen = new Set<string>();
    const out: Rule[] = [];
    for (const u of arr) {
      const v = validatePostedRule(u);
      if (v.error || !v.rule) return reply.code(400).send({ error: v.error ?? "invalid rule" });
      const id = v.rule.id;
      if (seen.has(id)) return reply.code(400).send({ error: `duplicate rule id "${id}"` });
      seen.add(id);
      out.push(v.rule);
    }
    try {
      saveRules(env.rulesFile, out);
    } catch (err) {
      req.log.error({ err }, "rules: save failed");
      return reply.code(500).send({ error: "failed to save rules" });
    }
    return { ok: true, rules: out };
  });

  app.get("/api/rules/status", async (req, reply) => {
    const sess = requireSession(req, env, sessions);
    if (!sess) return reply.code(401).send({ error: "Not logged in" });
    let fetched: { status: number; list?: QbTorrentInfo[] };
    try {
      fetched = await fetchTorrentsInfo(env.qbUrl, sess.qbSid);
    } catch (err) {
      const code = isTimeoutError(err) ? 504 : 502;
      return reply.code(code).send({ error: code === 504 ? "qBittorrent timed out" : "qBittorrent unreachable" });
    }
    // 403 = dead SID or container-IP ban: report, never delete the session.
    if (fetched.status === 403) {
      return reply.code(403).send({ error: "qBittorrent refused the request (session expired or server IP banned)" });
    }
    if (!fetched.list) return reply.code(502).send({ error: `qBittorrent replied ${fetched.status}` });
    const rules = loadRules(env.rulesFile);
    const torrents = fetched.list
      .filter((t) => typeof t.hash === "string" && t.hash !== "")
      .map((t) => {
        const site = siteOfTracker(t.tracker);
        const kind = kindOfTorrent(t);
        const rule = ruleFor(rules, kind, site);
        const c = complianceOf(t, rule);
        return {
          hash: t.hash as string,
          site,
          kind,
          ruleId: rule ? rule.id : null,
          compliant: { ratioOk: c.ratioOk, timeOk: c.timeOk, inactiveOk: c.inactiveOk },
        };
      });
    return { torrents };
  });

  app.post("/api/rules/apply", async (req, reply) => {
    const sess = requireSession(req, env, sessions);
    if (!sess) return reply.code(401).send({ error: "Not logged in" });
    const body = (req.body ?? {}) as { hashes?: unknown };
    let only: Set<string> | undefined;
    if (body.hashes !== undefined) {
      if (!Array.isArray(body.hashes) || body.hashes.some((h) => typeof h !== "string")) {
        return reply.code(400).send({ error: "hashes must be an array of strings" });
      }
      // Empty filter enforces nothing — reject so callers can distinguish
      // "filter matched nothing" from "everything compliant".
      if ((body.hashes as string[]).length === 0) {
        return reply.code(400).send({ error: "hashes must be non-empty when provided (omit to enforce all)" });
      }
      const cleaned = (body.hashes as string[]).map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
      if (cleaned.length === 0) {
        return reply.code(400).send({ error: "hashes contains only empty strings" });
      }
      only = new Set(cleaned);
    }
    const rules = loadRules(env.rulesFile);
    let result: EnforceResult;
    try {
      result = await enforceSession({ qbUrl: env.qbUrl, sid: sess.qbSid, rules, hashes: only });
    } catch (err) {
      const code = isTimeoutError(err) ? 504 : 502;
      return reply.code(code).send({ error: code === 504 ? "qBittorrent timed out" : "qBittorrent unreachable" });
    }
    if (result.forbidden) {
      return reply.code(403).send({ error: "qBittorrent refused the request (session expired or server IP banned)" });
    }
    if (result.qbStatus !== undefined) {
      return reply.code(502).send({ error: `qBittorrent replied ${result.qbStatus}` });
    }
    return { applied: result.applied, skipped: result.skipped, failed: result.failed, matched: result.matched };
  });
}

/* ----- auto-enforce ticker ----- */

/**
 * Every rulesIntervalMin minutes, enforce enabled rules on every active
 * session. Skipped entirely when the interval is 0. Sessions that 403 are
 * skipped (never deleted). Logs counts only — no torrent names at info level.
 */
export function startRulesTicker(app: FastifyInstance, env: Env, sessions: SessionStore): void {
  if (env.rulesIntervalMin <= 0) {
    app.log.info("rules ticker disabled (RULES_INTERVAL_MIN=0)");
    return;
  }
  const ms = env.rulesIntervalMin * 60 * 1000;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      app.log.warn("rules ticker: previous pass still running, skipping tick");
      return;
    }
    running = true;
    try {
      const rules = loadRules(env.rulesFile);
      if (!rules.some((r) => r.enabled)) return;
      sessions.prune();
      let checked = 0;
      let applied = 0;
      let skipped = 0;
      let failed = 0;
      let forbidden = 0;
      let qbErrors = 0;
      let sessionErrors = 0;
      for (const { id, session } of sessions.entries()) {
        try {
          const r = await enforceSession({ qbUrl: env.qbUrl, sid: session.qbSid, rules });
          // Count partial work even when the pass aborts or qB errors — a
          // summary of zeros used to hide real enforcement.
          applied += r.applied;
          skipped += r.skipped;
          failed += r.failed;
          if (r.forbidden) {
            forbidden++;
            continue;
          }
          if (r.qbStatus !== undefined) {
            qbErrors++;
            app.log.warn({ sessionId: id, qbStatus: r.qbStatus }, "rules ticker: qB error for a session");
            continue;
          }
          checked++;
        } catch (err) {
          // Session-level failure (timeout/network), not a torrent failure:
          // keep the units separate in the summary.
          sessionErrors++;
          app.log.warn({ err, sessionId: id }, "rules ticker: qB request failed for a session");
        }
      }
      app.log.info({ checked, applied, skipped, failed, forbidden, qbErrors, sessionErrors }, "rules ticker pass");
    } catch (err) {
      app.log.warn({ err }, "rules ticker pass failed");
    } finally {
      running = false;
    }
  };
  setInterval(() => {
    void tick();
  }, ms).unref();
  // Enforce promptly on boot instead of waiting a full interval with drift.
  void tick();
  app.log.info(`rules ticker every ${env.rulesIntervalMin} min`);
}
