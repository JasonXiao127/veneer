import { apiFetch, ApiError } from "../lib/api";
import { getCachedTrackers, setCachedTrackers } from "./useTrackers";
import type { TrackerEntry } from "../types";

/**
 * Fire-and-forget prefetch for visible table rows. Plain function, no React:
 * fetches up to `limit` hashes missing from the module cache and warms it.
 * Failures are swallowed (Promise.allSettled) — prefetch must never break render.
 * In-flight dedup: hashes already being fetched are skipped so poll-driven
 * reorders don't double-request the same hash.
 * Auth death (401/403) IS surfaced via veneer:unauthorized so a dead session
 * during prefetch still logs out promptly instead of waiting for the poll tick.
 */
const inflight = new Set<string>();

export function prefetchTrackers(hashes: string[], limit = 6): void {
  const missing = hashes.filter((h) => h && !inflight.has(h) && !getCachedTrackers(h)).slice(0, limit);
  if (missing.length === 0) return;
  for (const h of missing) inflight.add(h);
  void Promise.allSettled(
    missing.map(async (hash) => {
      try {
        const data = await apiFetch<TrackerEntry[]>(`/api/qb/torrents/trackers?hash=${hash}`);
        if (Array.isArray(data)) setCachedTrackers(hash, data);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
        }
      } finally {
        inflight.delete(hash);
      }
    }),
  );
}
