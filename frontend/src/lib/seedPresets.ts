export interface SeedPreset {
  id: string;
  label: string;
  match: { kind?: "private" | "public"; site?: string };
  ratioLimit: number;
  /** Minutes (qB seedingTimeLimit unit). */
  seedingTimeLimit: number;
  /** Minutes (qB inactiveSeedingTimeLimit unit). */
  inactiveSeedingTimeLimit: number;
}

export const DEFAULT_PRESETS: SeedPreset[] = [
  {
    id: "private-default",
    label: "Private default (ratio 1.0, 72h)",
    match: { kind: "private" },
    ratioLimit: 1,
    seedingTimeLimit: 4320, // 72h in minutes
    inactiveSeedingTimeLimit: 1440, // 24h in minutes
  },
  {
    id: "public-default",
    label: "Public default (ratio 0.5, 24h)",
    match: { kind: "public" },
    ratioLimit: 0.5,
    seedingTimeLimit: 1440, // 24h in minutes
    inactiveSeedingTimeLimit: 1440,
  },
  {
    id: "long-private",
    label: "Long seed private (ratio 2.0, 168h)",
    match: { kind: "private" },
    ratioLimit: 2,
    seedingTimeLimit: 10080, // 168h in minutes
    inactiveSeedingTimeLimit: 2880, // 48h in minutes
  },
];

/**
 * Pick a preset: site-exact match first, then kind match (no-site presets),
 * then global fallback (first preset).
 */
export function presetFor(kind?: "private" | "public" | string, site?: string): SeedPreset {
  const fallback = DEFAULT_PRESETS[0];
  const siteNorm = (site ?? "").trim().toLowerCase();
  if (siteNorm) {
    const bySite = DEFAULT_PRESETS.find((p) => (p.match.site ?? "").toLowerCase() === siteNorm);
    if (bySite) return bySite;
  }
  if (kind === "private" || kind === "public") {
    const byKind = DEFAULT_PRESETS.find((p) => !p.match.site && p.match.kind === kind);
    if (byKind) return byKind;
  }
  return fallback;
}
