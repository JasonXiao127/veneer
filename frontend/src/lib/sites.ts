export interface ClassifyInput {
  tracker?: string;
  isPrivate?: boolean | null;
  /**
   * qB ≥5.0 serializes the per-torrent privacy flag as `private` (the wiki's
   * `isPrivate` contradicts the source in every version). Accepted as an
   * alias; `private` wins when both are present.
   */
  private?: boolean | null;
}

export interface ClassifiedSite {
  site: string;
  siteDisplay: string;
  kind: "private" | "public" | "unknown";
  confidence: "high" | "medium" | "low";
}

export interface TrackerCandidate {
  url: string;
  tier?: number;
  status?: number;
  num_seeds?: number;
}

const PSEUDO_TRACKERS = new Set(["** [DHT] **", "** [PeX] **", "** [LSD] **"]);

/**
 * Parse an announce URL and return its lowercase hostname.
 * Returns null for empty/invalid input and for DHT/PeX/LSD pseudo-entries.
 */
export function extractTrackerHost(trackerUrl: string): string | null {
  if (typeof trackerUrl !== "string") return null;
  const trimmed = trackerUrl.trim();
  if (trimmed === "") return null;
  if (PSEUDO_TRACKERS.has(trimmed)) return null;
  // Case-insensitive match for the pseudo-entries with flexible spacing.
  if (/^\*\*\s*\[(DHT|PeX|LSD)\]\s*\*\*$/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (!u.hostname) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Reduce a hostname to a registrable-ish domain. Handles common second-level
 * suffixes (co.uk-style): tracker.a.co.uk → a.co.uk, not co.uk.
 * Single-label hosts and IPs are returned as-is (lowercased).
 */
export function trackerDomain(host: string): string {
  if (typeof host !== "string") return "";
  let h = host.trim().toLowerCase();
  // Strip trailing dots (FQDN form) and any surrounding whitespace.
  h = h.replace(/\.+$/, "");
  if (h === "") return "";
  // IPv6 (contains ':') or IPv4 (all-numeric dotted quads) → return as-is.
  if (h.includes(":")) return h;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
  const labels = h.split(".").filter((p) => p !== "");
  if (labels.length <= 2) return labels.join(".");
  // co.uk-style: 2-letter ccTLD preceded by a known second-level label.
  const [sld, tld] = labels.slice(-2);
  if (tld.length === 2 && SECOND_LEVEL_SUFFIXES.has(sld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

const SECOND_LEVEL_SUFFIXES = new Set([
  "co", "com", "org", "net", "gov", "edu", "ac", "ltd", "plc", "me", "sch",
]);

/**
 * Heuristic: true when the URL carries a credential token. Word-boundary on
 * `passkey` so paths like `/passkeyless/announce` don't false-positive.
 * NOTE: a bare `announce.php` is deliberately NOT a signal — several public
 * trackers use that path. With isPrivate present the flag decides anyway;
 * this heuristic only fires when the flag is absent (null/undefined).
 */
const PASSKEY_RE = /(?:\bpasskey\b|\bauthkey\b|\bapi[_-]?key\b|\btorrent[_-]?pass\b|[?&](?:uid|passkey|authkey)=)/i;

export function isPasskeyUrl(url: string): boolean {
  if (typeof url !== "string" || url === "") return false;
  return PASSKEY_RE.test(url);
}

/** Friendly-name overrides keyed by domain. Empty by default; edited via UI later. */
export const SITE_OVERRIDES: Record<string, string> = {};

export function siteNameFor(domain: string): string {
  if (typeof domain !== "string") return "unknown";
  const key = domain.toLowerCase();
  return SITE_OVERRIDES[key] ?? domain;
}

export function classifyTorrent(t: ClassifyInput): ClassifiedSite {
  const rawTracker = typeof t.tracker === "string" ? t.tracker.trim() : "";
  // Source-backed `private` first, wiki-named `isPrivate` as fallback.
  const isPrivate = t.private ?? t.isPrivate;

  const kindFromFlag = (): ClassifiedSite["kind"] =>
    isPrivate === true ? "private" : isPrivate === false ? "public" : "unknown";

  if (rawTracker === "") {
    const site = "unknown";
    return { site, siteDisplay: siteNameFor(site), kind: kindFromFlag(), confidence: "low" };
  }

  const host = extractTrackerHost(rawTracker);
  if (host === null) {
    // Invalid URL or DHT/PeX/LSD pseudo-entry → unknown site.
    const site = "unknown";
    return { site, siteDisplay: siteNameFor(site), kind: kindFromFlag(), confidence: "low" };
  }

  const domain = trackerDomain(host);
  const site = domain === "" ? "unknown" : domain;
  const siteDisplay = siteNameFor(site);
  const passkey = isPasskeyUrl(rawTracker);

  if (isPrivate === true) {
    return { site, siteDisplay, kind: "private", confidence: "high" };
  }
  if (isPrivate === false) {
    // Authoritative flag wins over the URL heuristic: a public torrent that
    // re-uses a private announce URL (passkey baked in) is still public.
    return { site, siteDisplay, kind: "public", confidence: "medium" };
  }
  // isPrivate null/undefined
  if (passkey) return { site, siteDisplay, kind: "private", confidence: "medium" };
  return { site, siteDisplay, kind: "unknown", confidence: "low" };
}

/**
 * Pick the best tracker URL from a list.
 * Skips DHT/PeX/LSD pseudo-entries. Sort: enabled (status !== 0) before
 * disabled, then tier asc, then working status (2 = working first per qB:
 * 0=disabled, 1=not contacted, 2=working, 3=updating, 4=not working),
 * then seed count. A disabled tier-0 tracker must not beat a working tier-1
 * one for site attribution. Returns the URL or null.
 */
export function selectBestTracker(trackers: TrackerCandidate[]): string | null {
  if (!Array.isArray(trackers) || trackers.length === 0) return null;
  const candidates = trackers.filter((t) => {
    if (!t || typeof t.url !== "string") return false;
    if (t.url.trim() === "") return false;
    // Skip pseudo-entries and anything without a parseable host.
    if (extractTrackerHost(t.url) === null) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    // Disabled trackers last regardless of tier.
    const disA = a.status === 0 ? 1 : 0;
    const disB = b.status === 0 ? 1 : 0;
    if (disA !== disB) return disA - disB;
    const tierA = typeof a.tier === "number" ? a.tier : Number.MAX_SAFE_INTEGER;
    const tierB = typeof b.tier === "number" ? b.tier : Number.MAX_SAFE_INTEGER;
    if (tierA !== tierB) return tierA - tierB;
    const workA = a.status === 2 ? 0 : 1;
    const workB = b.status === 2 ? 0 : 1;
    if (workA !== workB) return workA - workB;
    const seedsA = typeof a.num_seeds === "number" ? a.num_seeds : -1;
    const seedsB = typeof b.num_seeds === "number" ? b.num_seeds : -1;
    return seedsB - seedsA;
  });
  return sorted[0].url;
}
