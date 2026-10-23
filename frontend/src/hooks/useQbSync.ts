import { useCallback, useEffect } from "react";
import { create } from "zustand";
import type { MainDataDelta, ServerState, SiteInfo, Torrent } from "../types";
import { ApiError, apiFetch } from "../lib/api";
import { classifyTorrent, selectBestTracker } from "../lib/sites";
import { clearTrackerCache, getCachedTrackers } from "./useTrackers";

interface SyncState {
  torrents: Record<string, Torrent>;
  serverState: ServerState;
  categories: Record<string, { name: string; savePath: string }>;
  tags: string[];
  rid: number;
  syncError: string | null;
}

const defaultServerState: ServerState = {
  dl_info_speed: 0,
  up_info_speed: 0,
  dl_rate_limit: 0,
  up_rate_limit: 0,
  connection_status: "unknown",
  free_space_on_disk: 0,
  use_alt_speed_limits: false,
};

export const useSyncStore = create<SyncState>(() => ({
  torrents: {},
  serverState: defaultServerState,
  categories: {},
  tags: [],
  rid: 0,
  syncError: null,
}));

function validRid(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isFinite(v);
}

function asRecord(v: unknown): Record<string, never> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, never>) : undefined;
}

function asStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Merge a maindata delta into a snapshot.
 * Two-level per-hash merge: delta.torrents[hash] holds ONLY changed fields.
 * Pure function — unit-testable without React.
 */
export function mergeMainData(prev: SyncState, delta: MainDataDelta): SyncState {
  const rid = validRid(delta.rid) ? delta.rid : prev.rid;
  if (delta.full_update) {
    const torrents: Record<string, Torrent> = {};
    for (const [hash, t] of Object.entries(asRecord(delta.torrents) ?? {})) {
      torrents[hash] = { ...(t as Torrent), hash };
    }
    return {
      torrents,
      serverState: { ...defaultServerState, ...(asRecord(delta.server_state) ?? {}) } as ServerState,
      categories: { ...((asRecord(delta.categories) ?? {}) as SyncState["categories"]) },
      tags: asStrings(delta.tags),
      rid,
      syncError: prev.syncError,
    };
  }
  const torrents = { ...prev.torrents };
  for (const [hash, patch] of Object.entries(asRecord(delta.torrents) ?? {})) {
    torrents[hash] = { ...torrents[hash], ...(patch as Partial<Torrent>), hash } as Torrent;
  }
  for (const h of asStrings(delta.torrents_removed)) delete torrents[h];

  const categories = { ...prev.categories, ...((asRecord(delta.categories) ?? {}) as SyncState["categories"]) };
  for (const c of asStrings(delta.categories_removed)) delete categories[c];

  const tagSet = new Set(prev.tags);
  for (const t of asStrings(delta.tags)) tagSet.add(t);
  for (const t of asStrings(delta.tags_removed)) tagSet.delete(t);

  return {
    torrents,
    serverState: { ...prev.serverState, ...(asRecord(delta.server_state) ?? {}) },
    categories,
    tags: [...tagSet],
    rid,
    syncError: prev.syncError,
  };
}

/**
 * Module-level poll cursor + generation. Single Shell instance owns polling,
 * so refs would work — but resetSyncState() (logout/expiry) must also reset
 * the cursor and invalidate in-flight merges, which hook-local refs cannot do.
 */
let lastRid = 0;
let pollFails = 0;
let syncGen = 0;

export function resetSyncState(): void {
  syncGen++;
  lastRid = 0;
  pollFails = 0;
  siteInfoCache.clear();
  lastTrackerByHash.clear();
  clearTrackerCache();
  useSyncStore.setState({ torrents: {}, serverState: defaultServerState, categories: {}, tags: [], rid: 0, syncError: null });
}

/**
 * Site attribution for a single torrent, memoized per
 * hash+tracker+isPrivate. Module-level Map cache capped at 5000 entries
 * (oldest evicted first). Pure w.r.t. classifyTorrent — no React.
 *
 * When maindata carries no tracker string (delta updates), consult the
 * tracker prefetch cache: a previously fetched tracker list still attributes
 * the torrent instead of a stale `unknown`. The cached best URL joins the
 * cache key, so tracker add/remove flows naturally invalidate.
 */
const siteInfoCache = new Map<string, SiteInfo>();
const SITE_INFO_CACHE_CAP = 5000;
// Last successfully resolved tracker per hash. The tracker prefetch cache is
// TTL-limited; without this, a 5-minute idle window makes rows fall back to
// "unknown" until a prefetch re-warms the same top rows.
const lastTrackerByHash = new Map<string, string>();

export function siteInfoFor(t: Torrent): SiteInfo {
  let tracker = t.tracker;
  if (!tracker) {
    // Distinguish a cache HIT that is empty (all trackers removed) from a MISS
    // (TTL/unwarmed): an empty list must clear attribution, not resurrect the
    // last known URL.
    const cached = getCachedTrackers(t.hash);
    if (cached) {
      tracker = selectBestTracker(cached) ?? undefined;
      // Known-empty (all trackers removed): forget the last-known URL too, or
      // a later TTL miss would resurrect it.
      if (!tracker) lastTrackerByHash.delete(t.hash);
    } else {
      tracker = lastTrackerByHash.get(t.hash);
    }
  }
  if (tracker) {
    if (lastTrackerByHash.size >= SITE_INFO_CACHE_CAP && !lastTrackerByHash.has(t.hash)) {
      const oldest = lastTrackerByHash.keys().next();
      if (!oldest.done) lastTrackerByHash.delete(oldest.value);
    }
    lastTrackerByHash.set(t.hash, tracker);
  }
  // Key on the EFFECTIVE tracker (not raw + cached separately): the same
  // torrent resolves to one entry however the tracker was learned.
  const key = `${t.hash}|${tracker ?? ""}|${String(t.private ?? t.isPrivate)}`;
  const hit = siteInfoCache.get(key);
  if (hit) return hit;
  const info = classifyTorrent({ tracker, isPrivate: t.isPrivate ?? null, private: t.private ?? null });
  if (siteInfoCache.size >= SITE_INFO_CACHE_CAP) {
    const oldest = siteInfoCache.keys().next();
    if (!oldest.done) siteInfoCache.delete(oldest.value);
  }
  siteInfoCache.set(key, info);
  return info;
}

export interface SitesSummary {
  bySite: Map<string, Torrent[]>;
  siteCounts: Record<string, number>;
  kinds: Record<"private" | "public" | "unknown", number>;
}

/**
 * Group torrents by attributed site. Pure function (no hooks) despite the
 * `use` prefix — kept as a plain helper so tests can call it directly.
 */
export function useSites(torrents: Torrent[]): SitesSummary {
  const bySite = new Map<string, Torrent[]>();
  const siteCounts: Record<string, number> = {};
  const kinds: Record<"private" | "public" | "unknown", number> = {
    private: 0,
    public: 0,
    unknown: 0,
  };
  for (const t of torrents) {
    const info = siteInfoFor(t);
    const list = bySite.get(info.site);
    if (list) list.push(t);
    else bySite.set(info.site, [t]);
    siteCounts[info.site] = (siteCounts[info.site] ?? 0) + 1;
    kinds[info.kind]++;
  }
  return { bySite, siteCounts, kinds };
}

/** Hidden tabs poll slower; consecutive failures back off exponentially. */
function nextPollDelay(): number {
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const base = hidden ? 10_000 : 2000;
  if (pollFails <= 0) return base;
  return Math.min(base * 2 ** Math.min(pollFails, 4), 60_000);
}

export function useQbSync(paused: boolean) {
  const refetch = useCallback(async () => {
    const gen = syncGen;
    try {
      const delta = await apiFetch<MainDataDelta>(`/api/qb/sync/maindata?rid=${lastRid}`);
      if (gen !== syncGen) return; // superseded by logout/reset — drop stale merge
      // Guard cursor poisoning: a non-JSON 200 (login page, empty body) parses
      // to a string or rid-less object; applying it would wedge polling on
      // ?rid=undefined with no error shown.
      if (!delta || typeof delta !== "object" || !validRid(delta.rid)) {
        throw new Error("Bad sync payload from server");
      }
      // Merge BEFORE committing the cursor: a malformed collection must throw
      // here so the delta is retried, not skipped forever.
      const merged = mergeMainData(useSyncStore.getState(), delta);
      if (gen !== syncGen) return;
      lastRid = delta.rid;
      pollFails = 0;
      useSyncStore.setState({ ...merged, syncError: null });
    } catch (e) {
      if (gen !== syncGen) return;
      // 401 = logged out, 403 = qB refusing (dead SID or IP ban): both end the session.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) throw e;
      pollFails++;
      // Always show the latest failure (a persistent outage changes causes);
      // cleared on the next success above.
      const msg = e instanceof Error ? e.message : "sync failed";
      useSyncStore.setState({ syncError: msg.slice(0, 200) });
    }
  }, []);

  const refetchSoon = useCallback(() => {
    // 401/403 here means the session died mid-mutation: log out now instead of
    // waiting for the next 2s poll tick.
    const onAuthLost = (e: unknown) => {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
      }
    };
    void refetch().catch(onAuthLost);
    setTimeout(() => void refetch().catch(onAuthLost), 400);
  }, [refetch]);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    const tick = async () => {
      try {
        await refetch();
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
          return;
        }
      }
      if (alive) timer = setTimeout(tick, nextPollDelay());
    };
    let timer = setTimeout(tick, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [paused, refetch]);

  const s = useSyncStore();
  return { ...s, torrentList: Object.values(s.torrents), error: s.syncError, refetch: refetchSoon };
}
