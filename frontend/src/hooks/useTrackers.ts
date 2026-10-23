import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { selectBestTracker } from "../lib/sites";
import type { TrackerEntry } from "../types";

export type { TrackerEntry };

export const TRACKER_CACHE_TTL_MS = 5 * 60 * 1000;
// Bound the cache: tracker arrays are large and expiry only sweeps on read,
// so cap entries FIFO (Map preserves insertion order).
const TRACKER_CACHE_MAX = 1000;

const cache = new Map<string, { at: number; entries: TrackerEntry[] }>();

/** Drop every cached tracker list (logout / different qB instance). */
export function clearTrackerCache(): void {
  cache.clear();
}

/** Write-through helper so prefetch + queryFn share one cache. */
export function setCachedTrackers(hash: string, entries: TrackerEntry[]): void {
  if (cache.has(hash)) cache.delete(hash);
  else {
    while (cache.size >= TRACKER_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  cache.set(hash, { at: Date.now(), entries });
}

/** Sync read for table cells that shouldn't suspend. TTL-expired = miss. */
export function getCachedTrackers(hash: string): TrackerEntry[] | undefined {
  const hit = cache.get(hash);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TRACKER_CACHE_TTL_MS) {
    cache.delete(hash);
    return undefined;
  }
  return hit.entries;
}

// selectBestTracker lives in ../lib/sites (canonical). Re-exported here so
// table cells + prefetch share one implementation.
export { selectBestTracker };

/** Best tracker URL from cache only — never fetches. Cache miss = null. */
export function bestTrackerUrl(hash: string): string | null {
  const entries = getCachedTrackers(hash);
  if (!entries) return null;
  return selectBestTracker(entries);
}

/**
 * Opt-in per-torrent tracker fetch (drawer + visible-row prefetch only).
 * Never call this per table row unconditionally — table cells must use
 * getCachedTrackers()/bestTrackerUrl() so rows don't each fire a request.
 */
export function useTrackerFor(hash: string | undefined, enabled: boolean) {
  const q = useQuery({
    queryKey: ["trackers", hash],
    queryFn: async (): Promise<TrackerEntry[]> => {
      const data = await apiFetch<TrackerEntry[]>(`/api/qb/torrents/trackers?hash=${hash}`);
      const entries = Array.isArray(data) ? data : [];
      if (hash) setCachedTrackers(hash, entries);
      return entries;
    },
    enabled: Boolean(hash) && enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    retry: 1,
  });
  return { data: q.data, isLoading: q.isLoading, error: q.error };
}
