/** Parse "2.11.4" safely — never parseFloat / string-compare (2.9 > 2.11 lexicographically). */
export function isV5Plus(version: string): boolean {
  const parts = version.trim().split(".").map(Number);
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return false;
  // WebAPI 3.x (if it ever exists) keeps the stop/start API.
  return parts[0] > 2 || (parts[0] === 2 && parts[1] >= 11);
}

export function stopEndpoint(isV5: boolean): string {
  return isV5 ? "/api/qb/torrents/stop" : "/api/qb/torrents/pause";
}

export function startEndpoint(isV5: boolean): string {
  return isV5 ? "/api/qb/torrents/start" : "/api/qb/torrents/resume";
}
