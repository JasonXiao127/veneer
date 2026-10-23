import { apiFetch, qbPost } from "./api";
import { startEndpoint, stopEndpoint } from "./version";

export function hashesParam(hashes: string[]): string {
  return hashes.includes("all") ? "all" : hashes.join("|");
}

export async function stopTorrents(hashes: string[], isV5: boolean): Promise<string> {
  return qbPost(stopEndpoint(isV5), { hashes: hashesParam(hashes) });
}

export async function startTorrents(hashes: string[], isV5: boolean): Promise<string> {
  return qbPost(startEndpoint(isV5), { hashes: hashesParam(hashes) });
}

/** deleteFiles is REQUIRED by qB even when false — omitting returns 400. */
export async function deleteTorrents(hashes: string[], deleteFiles: boolean): Promise<string> {
  return qbPost("/api/qb/torrents/delete", { hashes: hashesParam(hashes), deleteFiles: String(deleteFiles) });
}

export async function recheckTorrents(hashes: string[]): Promise<string> {
  return qbPost("/api/qb/torrents/recheck", { hashes: hashesParam(hashes) });
}

export async function reannounceTorrents(hashes: string[]): Promise<string> {
  return qbPost("/api/qb/torrents/reannounce", { hashes: hashesParam(hashes) });
}

export async function renameTorrent(hash: string, name: string): Promise<string> {
  return qbPost("/api/qb/torrents/rename", { hash, name });
}

export async function setCategory(hashes: string[], category: string): Promise<string> {
  return qbPost("/api/qb/torrents/setCategory", { hashes: hashesParam(hashes), category });
}

export async function addTags(hashes: string[], tags: string): Promise<string> {
  return qbPost("/api/qb/torrents/addTags", { hashes: hashesParam(hashes), tags });
}

export async function removeTags(hashes: string[], tags: string): Promise<string> {
  return qbPost("/api/qb/torrents/removeTags", { hashes: hashesParam(hashes), tags });
}

/**
 * Set per-torrent share (seeding) limits.
 * qB convention: -2 = use global limit, -1 = no (unlimited) limit.
 * seedingTimeLimit and inactiveSeedingTimeLimit are in MINUTES.
 * All three limit fields are ALWAYS sent (defaulting to -2/global): qB
 * requireParams() 400s when any is missing — there is no partial update.
 * shareLimitAction is required since qB 5.2 (missing → 400) and ignored by
 * older versions; "Default" applies the limits above with the global action.
 */
export async function setShareLimits(
  hashes: string[],
  opts: { ratioLimit?: number; seedingTimeLimit?: number; inactiveSeedingTimeLimit?: number; shareLimitAction?: string },
): Promise<string> {
  const params: Record<string, string> = {
    hashes: hashesParam(hashes),
    ratioLimit: String(opts.ratioLimit ?? -2),
    seedingTimeLimit: String(opts.seedingTimeLimit ?? -2),
    inactiveSeedingTimeLimit: String(opts.inactiveSeedingTimeLimit ?? -2),
    shareLimitAction: opts.shareLimitAction ?? "Default",
  };
  return qbPost("/api/qb/torrents/setShareLimits", params);
}

export async function getPreferences(): Promise<Record<string, unknown>> {
  return apiFetch<Record<string, unknown>>("/api/qb/app/preferences");
}

/** Partial preferences update. qB accepts a subset of keys via form field `json`. */
export async function setPreferences(patch: Record<string, unknown>): Promise<string> {
  return qbPost("/api/qb/app/setPreferences", { json: JSON.stringify(patch) });
}

/**
 * Force-start torrents. qB convention: value is "true"/"false" (String(boolean)).
 */
export async function setForceStart(hashes: string[], value: boolean): Promise<string> {
  return qbPost("/api/qb/torrents/setForceStart", { hashes: hashesParam(hashes), value: String(value) });
}

/**
 * Queue management. qB convention: returns 409 Conflict when torrent queueing
 * is disabled in qB preferences ("Torrent Queueing" unchecked). Callers should
 * swallow 409 and surface "queueing disabled in qB".
 */
export async function queueTop(hashes: string[]): Promise<string> {
  return qbPost("/api/qb/torrents/topPrio", { hashes: hashesParam(hashes) });
}

export async function queueUp(hashes: string[]): Promise<string> {
  return qbPost("/api/qb/torrents/increasePrio", { hashes: hashesParam(hashes) });
}

export async function queueDown(hashes: string[]): Promise<string> {
  return qbPost("/api/qb/torrents/decreasePrio", { hashes: hashesParam(hashes) });
}

export async function queueBottom(hashes: string[]): Promise<string> {
  return qbPost("/api/qb/torrents/bottomPrio", { hashes: hashesParam(hashes) });
}

/** Toggles sequential download for the given torrents (no value param — flip). */
export async function toggleSequential(hashes: string[]): Promise<string> {
  return qbPost("/api/qb/torrents/toggleSequentialDownload", { hashes: hashesParam(hashes) });
}

/** Toggles first/last piece priority (no value param — flip). */
export async function toggleFirstLastPiece(hashes: string[]): Promise<string> {
  return qbPost("/api/qb/torrents/toggleFirstLastPiecePrio", { hashes: hashesParam(hashes) });
}

/** qB convention: value is "true"/"false". */
export async function setSuperSeeding(hashes: string[], value: boolean): Promise<string> {
  return qbPost("/api/qb/torrents/setSuperSeeding", { hashes: hashesParam(hashes), value: String(value) });
}

/** qB convention: enable is "true"/"false". */
export async function setAutoManagement(hashes: string[], enable: boolean): Promise<string> {
  return qbPost("/api/qb/torrents/setAutoManagement", { hashes: hashesParam(hashes), enable: String(enable) });
}

/**
 * Per-torrent speed limits in bytes/sec.
 * qB convention: 0 = unlimited.
 */
export async function setTorrentDownloadLimit(hashes: string[], limitBytes: number): Promise<string> {
  return qbPost("/api/qb/torrents/setDownloadLimit", { hashes: hashesParam(hashes), limit: String(limitBytes) });
}

export async function setTorrentUploadLimit(hashes: string[], limitBytes: number): Promise<string> {
  return qbPost("/api/qb/torrents/setUploadLimit", { hashes: hashesParam(hashes), limit: String(limitBytes) });
}

/** Move torrent storage location. qB expects the absolute path in `location`. */
export async function setTorrentLocation(hashes: string[], location: string): Promise<string> {
  return qbPost("/api/qb/torrents/setLocation", { hashes: hashesParam(hashes), location });
}

// --- BEGIN OrganizeDialog additions (category/tag management) ---
export async function createCategory(name: string, savePath: string): Promise<string> {
  return qbPost("/api/qb/torrents/createCategory", { category: name, savePath });
}

export async function editCategory(name: string, savePath: string): Promise<string> {
  return qbPost("/api/qb/torrents/editCategory", { category: name, savePath });
}

export async function removeCategories(names: string[]): Promise<string> {
  return qbPost("/api/qb/torrents/removeCategories", { categories: names.join("\n") });
}

export async function createTags(tags: string): Promise<string> {
  return qbPost("/api/qb/torrents/createTags", { tags });
}

export async function deleteTags(tags: string): Promise<string> {
  return qbPost("/api/qb/torrents/deleteTags", { tags });
}
// --- END OrganizeDialog additions ---

// --- BEGIN DetailDrawer additions (file/tracker/webseed/peer mutations) ---
// Shapes verified against qBittorrent WebUI API docs + qB source
// (src/webui/api/torrentscontroller.cpp; webseed mutations added in qB 5.0 via
// PR #21043 — the wiki documents only `webseeds` GET, not the mutations):
// - addWebSeeds/removeWebSeeds take `urls` PIPE-separated (unlike addTrackers,
//   which is newline-separated). Only http/https/ftp schemes are accepted.
// - editWebSeed takes `origUrl` (not `url`) + `newUrl`.
// - editTracker takes `url` + `newUrl`; removeTrackers `urls` is |-separated.
// - addPeers takes `hashes` (plural, |-separated) + `peers` (host:port, |-sep).
// - banPeers (transfer scope, bans GLOBALLY) takes `peers` (host:port, |-sep).

/** Rename a single file. oldPath is the file's full `name` from /torrents/files. */
export async function renameFile(hash: string, oldPath: string, newPath: string): Promise<string> {
  return qbPost("/api/qb/torrents/renameFile", { hash, oldPath, newPath });
}

/** Rename a folder. oldPath is the folder path prefix as seen in /torrents/files. */
export async function renameFolder(hash: string, oldPath: string, newPath: string): Promise<string> {
  return qbPost("/api/qb/torrents/renameFolder", { hash, oldPath, newPath });
}

/** Replace tracker `url` with `newUrl` on one torrent. */
export async function editTracker(hash: string, url: string, newUrl: string): Promise<string> {
  return qbPost("/api/qb/torrents/editTracker", { hash, url, newUrl });
}

/** Add web seeds. Multiple URLs are PIPE-separated in `urls`. Requires qB 5.0+. */
export async function addWebSeed(hash: string, urls: string): Promise<string> {
  return qbPost("/api/qb/torrents/addWebSeeds", { hash, urls });
}

/** Replace web seed `origUrl` with `newUrl`. NB: param is `origUrl`, not `url`. Requires qB 5.0+. */
export async function editWebSeed(hash: string, origUrl: string, newUrl: string): Promise<string> {
  return qbPost("/api/qb/torrents/editWebSeed", { hash, origUrl, newUrl });
}

/** Remove web seeds. Multiple URLs are PIPE-separated in `urls`. Requires qB 5.0+. */
export async function removeWebSeeds(hash: string, urls: string): Promise<string> {
  return qbPost("/api/qb/torrents/removeWebSeeds", { hash, urls });
}

/** Add peers (colon-separated host:port, |-separated multiples) to one torrent. */
export async function addPeers(hash: string, peers: string): Promise<string> {
  return qbPost("/api/qb/torrents/addPeers", { hashes: hash, peers });
}

/** Ban peers GLOBALLY (transfer scope, not per-torrent). Peers are host:port, |-separated. */
export async function banPeers(peers: string): Promise<string> {
  return qbPost("/api/qb/transfer/banPeers", { peers });
}
// --- END DetailDrawer additions ---
