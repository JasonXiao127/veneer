import { useEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { Torrent, TrackerEntry } from "../types";
import { ApiError, apiFetch, fmtSize, fmtSpeed, qbPost } from "../lib/api";
import { addPeers, addWebSeed, banPeers, editTracker, removeWebSeeds, renameFile } from "../lib/qbActions";
import { setCachedTrackers } from "../hooks/useTrackers";
import { badgeBase, btn, btnPrimary, btnSm, cellSm, colors, errText, input, mutedText, sectionHeader, table } from "../lib/theme";

type Tab = "properties" | "trackers" | "peers" | "files" | "webseeds";

function notifyUnauthorized() {
  window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
}

function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

export function DetailDrawer({ torrent, onClose }: { torrent: Torrent | null; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("properties");
  const [data, setData] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = () => setRefreshTick((t) => t + 1);

  useEffect(() => {
    setTab("properties");
    setData(null);
    setErr(null);
  }, [torrent?.hash]);

  // Escape closes the drawer (✕ button already does; keyboard users need this).
  useEffect(() => {
    if (!torrent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [torrent, onClose]);

  // Fetch only the ACTIVE tab — files on 5k-file torrents is huge.
  // Deps key on hash (not object identity): the live store mints a new object
  // per poll for changed torrents, which must not retrigger this fetch.
  const hash = torrent?.hash;
  useEffect(() => {
    if (!hash) return;
    let alive = true;
    setData(null);
    setErr(null);
    const url =
      tab === "properties"
        ? `/api/qb/torrents/properties?hash=${hash}`
        : tab === "trackers"
          ? `/api/qb/torrents/trackers?hash=${hash}`
          : tab === "peers"
            ? `/api/qb/sync/torrentPeers?hash=${hash}&rid=0`
            : tab === "webseeds"
              ? `/api/qb/torrents/webseeds?hash=${hash}`
              : `/api/qb/torrents/files?hash=${hash}`;
    apiFetch(url)
      .then((d) => {
        if (!alive) return;
        // Feed the shared tracker cache so site attribution (which may only
        // have an empty maindata tracker string) picks up the real trackers.
        if (tab === "trackers" && Array.isArray(d)) setCachedTrackers(hash, d as TrackerEntry[]);
        setData(d);
      })
      .catch((e) => {
        if (!alive) return;
        if (isAuthError(e)) notifyUnauthorized();
        setErr(e instanceof Error ? e.message : "fetch failed");
      });
    return () => {
      alive = false;
    };
  }, [hash, tab, refreshTick]);

  if (!torrent) return null;
  return (
    <aside className="vn-drawer" style={styles.aside}>
      <style>{drawerMobileCss}</style>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{torrent.name}</strong>
        <span style={{ flex: 1 }} />
        <button className="vn-drawer-close" style={styles.btn} title="Close details" onClick={onClose}>✕</button>
      </div>
      <HeaderActions torrent={torrent} />
      <div className="vn-drawer-tabs" style={{ display: "flex", gap: 6, margin: "10px 0", flexWrap: "wrap" }}>
        {(["properties", "trackers", "peers", "files", "webseeds"] as Tab[]).map((t) => (
          <button
            key={t}
            title={`Show ${t}`}
            style={tab === t ? { ...btnSm, ...tabActive } : btnSm}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {err && <p style={errText}>{err}</p>}
      {!data && !err && <p style={mutedText}>Loading {tab}…</p>}
      {data != null && tab === "properties" && <PropertiesView propsData={data} torrent={torrent} />}
      {data != null && tab === "trackers" && hash && (
        <TrackersTable trackers={data as TrackerEntry[]} hash={hash} onChanged={refresh} />
      )}
      {data != null && tab === "peers" && hash && (
        <PeersTable payload={data} hash={hash} onChanged={refresh} />
      )}
      {data != null && tab === "files" && hash && (
        <FilesList files={data} hash={hash} onChanged={refresh} />
      )}
      {data != null && tab === "webseeds" && hash && (
        <WebseedsTable seeds={data} hash={hash} onChanged={refresh} />
      )}
    </aside>
  );
}

/* ---------- shared defensive helpers ---------- */

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** qB durations are seconds → "3h 12m" / "45m". */
function fmtDurSecs(v: unknown): string {
  const n = num(v);
  if (n == null || n < 0) return "—";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** qB dates are unix seconds; -1 / 0 means unset. */
function fmtQbDate(v: unknown): string {
  const n = num(v);
  if (n == null || n <= 0) return "—";
  return new Date(n * 1000).toLocaleString();
}

/** Speed limits: qB uses <= 0 for unlimited. */
function fmtLimit(v: unknown): string {
  const n = num(v);
  if (n == null) return "—";
  if (n <= 0) return "unlimited";
  return fmtSpeed(n);
}

/** Share limits: -2 = global, -1 = no limit (qB convention). */
function fmtShareRatio(v: unknown): string {
  const n = num(v);
  if (n == null) return "—";
  if (n === -2) return "global";
  if (n === -1) return "∞ (no limit)";
  return n.toFixed(2);
}

function fmtShareTime(v: unknown): string {
  const n = num(v);
  if (n == null) return "—";
  if (n === -2) return "global";
  if (n === -1) return "∞ (no limit)";
  // setShareLimits seedingTimeLimit unit is MINUTES (not seconds like the
  // elapsed seeding_time) — a writer/reader mix-up here under-reports 60x.
  return fmtDurSecs(n * 60);
}

/* ---------- Header actions: export .torrent + copy magnet ---------- */

/** Prefer RFC 5987 filename* then plain filename; null when absent/unparseable. */
function filenameFromContentDisposition(cd: string | null): string | null {
  if (!cd) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to plain filename */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : null;
}

function HeaderActions({ torrent }: { torrent: Torrent }) {
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const magnet = str(torrent.magnet_uri);

  // Raw fetch on purpose: apiFetch parses bodies as text/JSON, which would
  // corrupt the binary .torrent payload. The qb proxy forwards qB's
  // content-disposition (and 401/403 auth semantics) untouched.
  async function doExport() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    setFailed(false);
    try {
      const res = await fetch(`/api/qb/torrents/export?hash=${encodeURIComponent(torrent.hash)}`, {
        credentials: "same-origin",
      });
      if (res.status === 401 || res.status === 403) {
        notifyUnauthorized();
        throw new ApiError(res.status, "Not logged in");
      }
      if (!res.ok) throw new ApiError(res.status, res.statusText || `Export failed (${res.status})`);
      const blob = await res.blob();
      const fallbackName = /\.torrent$/i.test(torrent.name) ? torrent.name : `${torrent.name}.torrent`;
      const filename = filenameFromContentDisposition(res.headers.get("content-disposition")) ?? fallbackName;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus(`Exported ${filename}`);
    } catch (e) {
      setFailed(true);
      setStatus(e instanceof Error ? e.message : "export failed");
    } finally {
      setBusy(false);
    }
  }

  async function copyMagnet() {
    if (!magnet) return;
    setStatus(null);
    setFailed(false);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(magnet);
      } else {
        throw new Error("clipboard API unavailable");
      }
      setStatus("Magnet link copied");
    } catch {
      // Fallback for non-secure contexts / denied clipboard permission.
      try {
        const ta = document.createElement("textarea");
        ta.value = magnet;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) throw new Error("copy failed");
        setStatus("Magnet link copied");
      } catch (e) {
        setFailed(true);
        setStatus(e instanceof Error ? e.message : "copy failed");
      }
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button style={styles.btnSm} title="Download the .torrent file from qBittorrent" disabled={busy} onClick={() => void doExport()}>
          {busy ? "Exporting…" : "Export .torrent"}
        </button>
        {magnet && (
          <button style={styles.btnSm} title="Copy magnet link" onClick={() => void copyMagnet()}>
            Copy magnet
          </button>
        )}
      </div>
      {status && <p style={failed ? errText : mutedText}>{status}</p>}
    </div>
  );
}

/* ---------- Properties: parsed General view ---------- */

function PropertiesView({ propsData, torrent }: { propsData: unknown; torrent: Torrent }) {
  const p =
    propsData && typeof propsData === "object" ? (propsData as Record<string, unknown>) : {};
  // /torrents/properties lacks share-limit and flag fields (verified against qB
  // master propertiesAction); those live on /torrents/info, already in the sync
  // store — prefer the live torrent for them.
  const t = torrent as unknown as Record<string, unknown>;
  const fromInfo = (k: string): unknown => (t[k] !== undefined && t[k] !== null ? t[k] : p[k]);
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (p[k] !== undefined && p[k] !== null) return p[k];
    return null;
  };

  const dlSession = num(p.total_downloaded_session);
  const ulSession = num(p.total_uploaded_session);
  const dlTotal = num(p.total_downloaded);
  const ulTotal = num(p.total_uploaded);
  const downloaded =
    dlTotal == null
      ? "—"
      : dlSession != null
        ? `${fmtSize(dlTotal)} (session ${fmtSize(dlSession)})`
        : fmtSize(dlTotal);
  const uploaded =
    ulTotal == null
      ? "—"
      : ulSession != null
        ? `${fmtSize(ulTotal)} (session ${fmtSize(ulSession)})`
        : fmtSize(ulTotal);

  const ratioRaw = num(pick("share_ratio", "ratio"));
  // qB serializes unknown ratio as -1; official WebUI shows ∞ for that.
  const ratioText = ratioRaw == null ? "—" : ratioRaw < 0 ? "∞" : ratioRaw.toFixed(2);
  const stateRaw = str(fromInfo("state"));
  const rows: Array<[string, string]> = [
    ["State", stateRaw ?? "—"],
    ["Save path", str(p.save_path) ?? "—"],
    ["Total size", num(pick("total_size", "size")) != null ? fmtSize(num(pick("total_size", "size")) as number) : "—"],
    ["Downloaded", downloaded],
    ["Uploaded", uploaded],
    ["Ratio", ratioText],
    ["Seeding time", fmtDurSecs(pick("seeding_time", "time_active", "time_elapsed"))],
    ["Added on", fmtQbDate(pick("addition_date", "added_on"))],
    ["Completed on", fmtQbDate(pick("completion_date", "completion_on"))],
    ["Max ratio", fmtShareRatio(fromInfo("max_ratio"))],
    ["Max seeding time", fmtShareTime(fromInfo("max_seeding_time"))],
    ["DL limit", fmtLimit(p.dl_limit)],
    ["UP limit", fmtLimit(p.up_limit)],
  ];

  const createdBy = str(p.created_by);
  const comment = str(p.comment);
  if (createdBy) rows.splice(1, 0, ["Created by", createdBy]);
  if (comment) rows.splice(1, 0, ["Comment", comment]);

  const flags: Array<[string, unknown]> = [
    ["Sequential", fromInfo("seq_dl")],
    ["First/last piece priority", fromInfo("f_l_piece_prio")],
    ["Super seeding", fromInfo("super_seeding")],
    ["Force start", fromInfo("force_start")],
    ["Auto TMM", fromInfo("auto_tmm")],
  ];

  return (
    <div>
      <dl style={styles.dl}>
        {rows.map(([k, v]) => (
          <div key={k} className="vn-dl-row" style={styles.dlRow}>
            <dt style={styles.dt}>{k}</dt>
            <dd style={styles.dd}>{v}</dd>
          </div>
        ))}
      </dl>
      <div style={{ marginTop: 10 }}>
        <div style={sectionHeader}>Flags</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {flags.map(([label, v]) => {
            const b = bool(v);
            const on = b === true;
            return (
              <span
                key={label}
                title={b == null ? "unknown" : on ? "on" : "off"}
                style={{
                  ...styles.pill,
                  background: on ? colors.accentDark : colors.border,
                  color: b == null ? colors.muted : colors.text,
                }}
              >
                {on ? "✓ " : b === false ? "○ " : "? "}
                {label}
              </span>
            );
          })}
        </div>
      </div>
      <details style={{ marginTop: 10, fontSize: 12, color: colors.muted }}>
        <summary style={{ cursor: "pointer" }}>Raw</summary>
        <pre style={styles.pre}>{JSON.stringify(propsData, null, 2)}</pre>
      </details>
    </div>
  );
}

/* ---------- Peers ---------- */

interface PeerRow {
  ip?: unknown;
  port?: unknown;
  client?: unknown;
  progress?: unknown;
  dl_speed?: unknown;
  up_speed?: unknown;
  flags?: unknown;
}

function normalizePeers(payload: unknown): PeerRow[] {
  if (Array.isArray(payload)) return payload as PeerRow[];
  if (payload && typeof payload === "object") {
    const peers = (payload as Record<string, unknown>).peers;
    if (Array.isArray(peers)) return peers as PeerRow[];
    if (peers && typeof peers === "object") {
      return Object.values(peers as Record<string, unknown>) as PeerRow[];
    }
  }
  return [];
}

/** qB uses -1 for unknown counters (e.g. pre-announce) — render em dash. */
function fmtCount(v: unknown): string {
  const n = num(v);
  if (n == null || n < 0) return "—";
  return String(n);
}

function PeersTable({ payload, hash, onChanged }: { payload: unknown; hash: string; onChanged: () => void }) {
  const rows = normalizePeers(payload);
  const [newPeer, setNewPeer] = useState("");
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const cell = cellSm;

  async function mutate(kind: "add" | "ban", peer: string) {
    if (busy) return;
    setBusy(true);
    setLocalErr(null);
    try {
      if (kind === "add") {
        await addPeers(hash, peer);
        setNewPeer("");
      } else {
        await banPeers(peer);
      }
      onChanged();
    } catch (e) {
      if (isAuthError(e)) notifyUnauthorized();
      setLocalErr(e instanceof Error ? e.message : "peer update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form
        style={{ display: "flex", gap: 6, marginBottom: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          const p = newPeer.trim();
          if (p && !busy) void mutate("add", p);
        }}
      >
        <input
          value={newPeer}
          onChange={(e) => setNewPeer(e.target.value)}
          placeholder="Add peer host:port…"
          aria-label="Add peer host:port"
          style={{ ...styles.inp, flex: 1, minWidth: 0 }}
          disabled={busy}
        />
        <button type="submit" style={styles.btn} disabled={busy || !newPeer.trim()}>
          {busy ? "…" : "Add peer"}
        </button>
      </form>
      {localErr && <p style={errText}>{localErr}</p>}
      {rows.length === 0 ? (
        <p style={mutedText}>No peers.</p>
      ) : (
      <div className="vn-table-wrap" style={styles.tableWrap}>
      <table style={{ ...table, fontSize: 12 }}>
        <thead>
          <tr style={{ background: colors.panel }}>
            {["IP", "Port", "Client", "Progress", "DL", "UL", "Flags", ""].map((h, i) => (
              <th key={`${h}-${i}`} style={styles.tableHead}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const prog = num(r.progress);
            const ip = str(r.ip);
            const port = num(r.port);
            // IPv6 needs [brackets] for unambiguous host:port (qB expects host:port).
            const host = ip && ip.includes(":") && !(ip.startsWith("[") && ip.endsWith("]")) ? `[${ip}]` : ip;
            const id = host && port != null && port > 0 ? `${host}:${port}` : null;
            return (
              <tr key={`${String(r.ip)}-${port ?? "?"}-${i}`}>
                <td style={cell}>{ip ?? "—"}</td>
                <td style={cell}>{fmtCount(r.port)}</td>
                <td title={str(r.client) ?? ""} style={{ ...cell, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {str(r.client) ?? "—"}
                </td>
                <td style={cell}>{prog != null && prog >= 0 ? `${(prog * 100).toFixed(1)}%` : "—"}</td>
                <td style={cell}>{(() => { const v = num(r.dl_speed); return v == null || v < 0 ? "—" : fmtSpeed(v); })()}</td>
                <td style={cell}>{(() => { const v = num(r.up_speed); return v == null || v < 0 ? "—" : fmtSpeed(v); })()}</td>
                <td style={cell}>{str(r.flags) ?? "—"}</td>
                <td style={cell}>
                  <button
                    style={styles.btnSm}
                    title={id ? `Ban peer ${id} (global)` : "Ban peer"}
                    disabled={busy || !id}
                    onClick={() => {
                      if (!id) return;
                      if (window.confirm(`Ban peer ${id}? This blocks it globally, not just for this torrent.`)) {
                        void mutate("ban", id);
                      }
                    }}
                  >
                    Ban
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      )}
    </div>
  );
}

/* ---------- Trackers (table + add/remove) ---------- */

/**
 * Humanize qB tracker status.
 * Per qB source: 0 = disabled (DHT/PeX/LSD pseudo-entries), 1 = not
 * contacted yet, 2 = working, 3 = updating (removed in 5.2 in favor of a
 * separate `updating` bool — pass it to keep the label accurate there),
 * 4 = not working, 5 = tracker error, 6 = unreachable (both predate 5.0).
 * Unknown values fall back to the raw number.
 */
function trackerStatusLabel(status: number, updating?: unknown): string {
  if (status === 2 && updating === true) return "updating";
  switch (status) {
    case 0:
      return "disabled";
    case 1:
      return "not contacted";
    case 2:
      return "working";
    case 3:
      return "updating";
    case 4:
      return "not working";
    case 5:
      return "tracker error";
    case 6:
      return "unreachable";
    default:
      return `status ${status}`;
  }
}

/** qB injects DHT/PeX/LSD as pseudo-tracker rows (e.g. "** [DHT] **" or "DHT"). */
function isPeerSource(url: string): boolean {
  const norm = (url ?? "").replace(/[^a-z]/gi, "").toUpperCase();
  return norm === "DHT" || norm === "PEX" || norm === "LSD";
}

function peerSourceLabel(url: string): string {
  const norm = (url ?? "").replace(/[^a-z]/gi, "").toUpperCase();
  if (norm === "DHT") return "DHT";
  if (norm === "PEX") return "PeX";
  if (norm === "LSD") return "LSD";
  return url;
}

function TrackersTable({ trackers, hash, onChanged }: { trackers: TrackerEntry[]; hash: string; onChanged: () => void }) {
  const rows = Array.isArray(trackers) ? trackers : [];
  const peerSources = rows.filter((t) => isPeerSource(t.url ?? ""));
  const real = rows.filter((t) => !isPeerSource(t.url ?? ""));
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const cell = cellSm;

  async function mutate(kind: "add" | "remove" | "edit", urls: string, newUrl?: string) {
    setBusy(true);
    setLocalErr(null);
    try {
      if (kind === "add") {
        await qbPost("/api/qb/torrents/addTrackers", { hash, urls });
        setNewUrl("");
      } else if (kind === "remove") {
        await qbPost("/api/qb/torrents/removeTrackers", { hash, urls });
      } else {
        await editTracker(hash, urls, newUrl ?? "");
      }
      onChanged();
    } catch (e) {
      if (isAuthError(e)) notifyUnauthorized();
      setLocalErr(e instanceof Error ? e.message : "tracker update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form
        style={{ display: "flex", gap: 6, marginBottom: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          const u = newUrl.trim();
          if (u && !busy) void mutate("add", u);
        }}
      >
        <input
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="Add tracker URL…"
          aria-label="Add tracker URL"
          style={{ ...styles.inp, flex: 1, minWidth: 0 }}
          disabled={busy}
        />
        <button type="submit" style={styles.btn} disabled={busy || !newUrl.trim()}>
          {busy ? "…" : "Add"}
        </button>
      </form>
      {localErr && <p style={errText}>{localErr}</p>}
      <div className="vn-table-wrap" style={styles.tableWrap}>
        <table style={{ ...table, fontSize: 12 }}>
          <thead>
            <tr style={{ background: colors.panel }}>
              {["URL", "Tier", "Status", "Seeds", "Leeches", "Downloaded", "Msg", ""].map((h, i) => (
                <th key={`${h}-${i}`} style={styles.tableHead}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {real.map((t, i) => (
              <tr key={`${t.url}-${t.tier}-${i}`}>
                <td title={t.url} style={{ ...cell, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.url}</td>
                <td style={cell}>{t.tier}</td>
                <td style={cell}>{trackerStatusLabel(t.status, (t as { updating?: unknown }).updating)}</td>
                <td style={cell}>{typeof t.num_seeds === "number" && t.num_seeds >= 0 ? t.num_seeds : "—"}</td>
                <td style={cell}>{typeof t.num_leeches === "number" && t.num_leeches >= 0 ? t.num_leeches : "—"}</td>
                <td style={cell}>{typeof t.num_downloaded === "number" && t.num_downloaded >= 0 ? t.num_downloaded : "—"}</td>
                <td title={t.msg ?? ""} style={{ ...cell, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.msg || "—"}</td>
                <td style={cell}>
                  <span style={{ display: "inline-flex", gap: 4 }}>
                    <button
                      style={styles.btnSm}
                      title={`Edit tracker ${t.url}`}
                      disabled={busy}
                      onClick={() => {
                        const next = window.prompt(`New URL for tracker:\n${t.url}`, t.url);
                        if (next == null) return;
                        const trimmed = next.trim();
                        if (!trimmed || trimmed === t.url) return;
                        void mutate("edit", t.url, trimmed);
                      }}
                    >
                      Edit
                    </button>
                    <button style={styles.btnSm} title={`Remove tracker ${t.url}`} disabled={busy} onClick={() => void mutate("remove", t.url)}>
                      Remove
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {real.length === 0 && (
              <tr><td colSpan={8} style={{ ...cell, color: colors.muted }}>No trackers.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {peerSources.length > 0 && (
        <details style={{ marginTop: 8, fontSize: 12, color: colors.muted }}>
          <summary style={{ cursor: "pointer" }}>Peer sources ({peerSources.length})</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {peerSources.map((t, i) => {
              const label = peerSourceLabel(t.url ?? "");
              const disabled = t.status === 0 || /disabl/i.test(t.msg ?? "");
              return (
                <li key={`${t.url}-${i}`}>
                  {label} {disabled ? "disabled — consistent with private" : `enabled${t.msg ? ` — ${t.msg}` : ""}`}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ---------- Web seeds (qB 5.0+; GET exists on older qB, mutations 404 there) ---------- */

interface WebSeedRow {
  url?: unknown;
}

function WebseedsTable({ seeds, hash, onChanged }: { seeds: unknown; hash: string; onChanged: () => void }) {
  const list = Array.isArray(seeds) ? (seeds as WebSeedRow[]) : [];
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const cell = cellSm;

  async function mutate(kind: "add" | "remove", url: string) {
    if (busy) return;
    setBusy(true);
    setLocalErr(null);
    try {
      if (kind === "add") {
        await addWebSeed(hash, url);
        setNewUrl("");
      } else {
        await removeWebSeeds(hash, url);
      }
      onChanged();
    } catch (e) {
      if (isAuthError(e)) notifyUnauthorized();
      // qB < 5.0 has no webseed mutation endpoints — surface that plainly.
      setLocalErr(
        e instanceof ApiError && e.status === 404
          ? "Web seed editing needs qBittorrent 5.0+ (endpoint not found)."
          : e instanceof Error
            ? e.message
            : "web seed update failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form
        style={{ display: "flex", gap: 6, marginBottom: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          const u = newUrl.trim();
          if (u && !busy) void mutate("add", u);
        }}
      >
        <input
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="Add web seed URL…"
          aria-label="Add web seed URL"
          style={{ ...styles.inp, flex: 1, minWidth: 0 }}
          disabled={busy}
        />
        <button type="submit" style={styles.btn} disabled={busy || !newUrl.trim()}>
          {busy ? "…" : "Add"}
        </button>
      </form>
      {localErr && <p style={errText}>{localErr}</p>}
      <div className="vn-table-wrap" style={styles.tableWrap}>
        <table style={{ ...table, fontSize: 12 }}>
          <thead>
            <tr style={{ background: colors.panel }}>
              {["URL", ""].map((h, i) => (
                <th key={`${h}-${i}`} style={styles.tableHead}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((s, i) => {
              const url = str(s.url) ?? "";
              return (
                <tr key={`${url}-${i}`}>
                  <td title={url} style={{ ...cell, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {url || "—"}
                  </td>
                  <td style={cell}>
                    <button style={styles.btnSm} title={`Remove web seed ${url}`} disabled={busy || !url} onClick={() => void mutate("remove", url)}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr><td colSpan={2} style={{ ...cell, color: colors.muted }}>No web seeds.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- Files (size + priority, bulk setter) ---------- */

const PRIO_LABELS: Record<number, string> = {
  0: "Don't download",
  1: "Normal",
  6: "High",
  7: "Max",
};

function prioLabel(v: unknown): string {
  const n = num(v);
  if (n == null) return "—";
  return PRIO_LABELS[n] ?? `priority ${n}`;
}

interface FileRow {
  name?: unknown;
  size?: unknown;
  progress?: unknown;
  priority?: unknown;
  index?: unknown;
}

function FilesList({ files, hash, onChanged }: { files: unknown; hash: string; onChanged: () => void }) {
  const list = Array.isArray(files) ? (files as FileRow[]) : [];
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [prio, setPrio] = useState("1");
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: list.length, getScrollElement: () => parentRef.current, estimateSize: () => 25, overscan: 10 });

  useEffect(() => {
    setSelected(new Set());
    setLocalErr(null);
  }, [hash]);

  // Positional selection must not survive a data refresh: indices can point
  // at different files after renames or external changes. `files` identity
  // only changes on refetch, so this fires exactly then.
  useEffect(() => {
    setSelected(new Set());
  }, [files]);

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function applyPrio() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setLocalErr(null);
    try {
      const ids = [...selected].sort((a, b) => a - b).join("|");
      await qbPost("/api/qb/torrents/filePrio", { hash, id: ids, priority: prio });
      setSelected(new Set());
      onChanged();
    } catch (e) {
      if (isAuthError(e)) notifyUnauthorized();
      setLocalErr(e instanceof Error ? e.message : "file priority update failed");
    } finally {
      setBusy(false);
    }
  }

  // oldPath is the file's full `name` from /torrents/files (folder prefixes
  // included). A bare new name stays in the same folder; a value containing
  // "/" is used verbatim as the new full path.
  async function doRename(oldPath: string) {
    if (busy) return;
    const base = oldPath.includes("/") ? oldPath.slice(oldPath.lastIndexOf("/") + 1) : oldPath;
    const dir = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/") + 1) : "";
    const input = window.prompt(`Rename file:\n${oldPath}`, base);
    if (input == null) return;
    const trimmed = input.trim();
    if (!trimmed) return;
    const newPath = trimmed.includes("/") ? trimmed : dir + trimmed;
    if (newPath === oldPath) return;
    setBusy(true);
    setLocalErr(null);
    try {
      await renameFile(hash, oldPath, newPath);
      onChanged();
    } catch (e) {
      if (isAuthError(e)) notifyUnauthorized();
      setLocalErr(e instanceof Error ? e.message : "file rename failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8, fontSize: 12, color: colors.muted, flexWrap: "wrap" }}>
        <span>
          {list.length} files{selected.size > 0 ? `, ${selected.size} selected` : ""}
        </span>
        <span style={{ flex: 1 }} />
        <select value={prio} onChange={(e) => setPrio(e.target.value)} aria-label="File priority" style={styles.inp} disabled={busy}>
          {Object.entries(PRIO_LABELS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <button style={styles.btn} disabled={busy || selected.size === 0} onClick={applyPrio}>
          {busy ? "…" : "Set priority"}
        </button>
      </div>
      {localErr && <p style={errText}>{localErr}</p>}
      {list.length === 0 ? (
        <p style={mutedText}>No files (metadata not available yet).</p>
      ) : (
      <div ref={parentRef} style={{ overflowY: "auto", maxHeight: "60vh", border: `1px solid ${colors.border}`, borderRadius: 8 }}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((vi) => {
            const f = list[vi.index] ?? {};
            const pct = typeof f.progress === "number" && Number.isFinite(f.progress) ? (f.progress * 100).toFixed(0) : "—";
            const size = num(f.size);
            const checked = selected.has(vi.index);
            const fname = typeof f.name === "string" ? f.name : "";
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={v.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)`, display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", fontSize: 12, borderBottom: `1px solid ${colors.panel}` }}
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(vi.index)} title={`Select file ${vi.index}`} />
                <span style={{ color: colors.muted, minWidth: 36 }}>{pct}%</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fname}>
                  {fname || "?"}
                </span>
                <span style={{ color: colors.muted, whiteSpace: "nowrap" }}>{size != null ? fmtSize(size) : "—"}</span>
                <button
                  style={styles.renameBtn}
                  title={fname ? `Rename ${fname}` : "Rename file"}
                  disabled={busy || !fname}
                  onClick={() => {
                    if (fname) void doRename(fname);
                  }}
                >
                  Rename
                </button>
                <span style={styles.prioPill} title={`Priority: ${prioLabel(f.priority)}`}>{prioLabel(f.priority)}</span>
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}

const tabActive: React.CSSProperties = {
  ...btnPrimary,
  padding: "3px 8px",
  fontSize: 12,
  borderRadius: 6,
  whiteSpace: "nowrap",
};

const styles: Record<string, React.CSSProperties> = {
  aside: { position: "fixed", right: 0, top: 0, bottom: 0, width: "min(480px, 100vw)", background: colors.bg, color: colors.text, borderLeft: `1px solid ${colors.border}`, padding: 16, overflowY: "auto", zIndex: 10 },
  btn,
  btnSm,
  inp: input,
  pre: { background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 12, fontSize: 12, overflow: "auto", maxHeight: "60vh" },
  dl: { margin: 0, border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden" },
  dlRow: { display: "grid", gridTemplateColumns: "130px 1fr", gap: 8, padding: "6px 10px", borderBottom: `1px solid ${colors.panel}`, fontSize: 12 },
  dt: { color: colors.muted, margin: 0 },
  dd: { margin: 0, overflowWrap: "anywhere" },
  pill: { ...badgeBase, padding: "2px 10px", fontSize: 11, border: `1px solid ${colors.borderStrong}` },
  prioPill: { fontSize: 11, color: colors.muted, border: `1px solid ${colors.borderStrong}`, borderRadius: 999, padding: "0 8px", whiteSpace: "nowrap" },
  renameBtn: { ...btnSm, padding: "0 6px", fontSize: 11, lineHeight: 1.6 },
  tableWrap: { overflowX: "auto", border: `1px solid ${colors.border}`, borderRadius: 8 },
  tableHead: { ...cellSm, color: colors.muted, fontWeight: 600, borderBottom: `1px solid ${colors.border}` },
};

/**
 * Mobile-only overrides. Desktop (>768px) never matches, so desktop
 * rendering is byte-identical. `!important` beats the inline styles above.
 */
const drawerMobileCss = `
@media (max-width: 768px) {
  .vn-drawer {
    width: 100vw !important;
    max-width: 100vw !important;
    padding-top: calc(16px + env(safe-area-inset-top)) !important;
    padding-bottom: calc(16px + env(safe-area-inset-bottom)) !important;
    padding-left: calc(16px + env(safe-area-inset-left)) !important;
    padding-right: calc(16px + env(safe-area-inset-right)) !important;
    overflow-x: hidden !important;
    -webkit-overflow-scrolling: touch;
  }
  .vn-drawer-tabs { row-gap: 8px !important; }
  .vn-drawer-tabs button {
    min-height: 40px !important;
    padding: 8px 12px !important;
  }
  .vn-drawer-close {
    min-width: 44px !important;
    min-height: 44px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-size: 16px !important;
  }
  .vn-drawer .vn-table-wrap {
    max-width: 100% !important;
    -webkit-overflow-scrolling: touch;
  }
  .vn-drawer button { min-height: 40px !important; }
  .vn-drawer select,
  .vn-drawer input:not([type="checkbox"]) {
    min-height: 40px !important;
    font-size: 16px !important;
  }
  .vn-drawer input[type="checkbox"] {
    width: 22px !important;
    height: 22px !important;
    flex: none !important;
  }
  .vn-dl-row {
    grid-template-columns: 1fr !important;
    gap: 2px !important;
    padding: 8px 10px !important;
  }
}
`;
