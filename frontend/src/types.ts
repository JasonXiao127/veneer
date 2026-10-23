export interface Torrent {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  state: string;
  category: string;
  tags: string;
  added_on: number;
  completion_on: number;
  ratio: number;
  num_seeds: number;
  num_leechs: number;
  save_path: string;
  tracker?: string;
  isPrivate?: boolean | null;
  /** qB ≥5.0 serializes the privacy flag as `private` (see sites.ts). */
  private?: boolean | null;
  magnet_uri?: string;
  [k: string]: unknown;
}

export interface SiteInfo {
  site: string;
  siteDisplay: string;
  kind: "private" | "public" | "unknown";
  confidence: "high" | "medium" | "low";
}

export interface TrackerEntry {
  url: string;
  tier: number;
  status: number;
  num_peers: number;
  num_seeds: number;
  num_leeches: number;
  num_downloaded: number;
  msg: string;
}

export interface ServerState {
  dl_info_speed: number;
  up_info_speed: number;
  dl_rate_limit: number;
  up_rate_limit: number;
  connection_status: string;
  free_space_on_disk: number;
  use_alt_speed_limits: boolean;
  [k: string]: unknown;
}

export interface MainDataDelta {
  rid: number;
  full_update?: boolean;
  torrents?: Record<string, Partial<Torrent>>;
  torrents_removed?: string[];
  categories?: Record<string, { name: string; savePath: string }>;
  categories_removed?: string[];
  tags?: string[];
  tags_removed?: string[];
  server_state?: Partial<ServerState>;
}
