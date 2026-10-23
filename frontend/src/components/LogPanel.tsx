import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../lib/api";
import { badgeBase, btn, btnSm, checkLabel, colors, errText, mutedText } from "../lib/theme";

interface MainLogEntry {
  id: number;
  message: string;
  timestamp: number;
  type: number;
}

interface PeerLogEntry {
  id: number;
  ip: string;
  timestamp: number;
  blocked: boolean;
  reason: string;
}

interface LogPanelProps {
  /** Max height of the scroll container. Defaults to "65vh". */
  maxHeight?: string;
}

const MAX_ROWS = 500;
const REFRESH_MS = 5000;

const LOG_TYPE_META: Record<number, { label: string; color: string; bg: string }> = {
  1: { label: "Normal", color: colors.muted, bg: "#64748b22" },
  2: { label: "Info", color: "#93c5fd", bg: "#3b82f622" },
  4: { label: "Warning", color: colors.warn, bg: "#f59e0b22" },
  8: { label: "Critical", color: colors.danger, bg: "#ef444422" },
};

function fmtTime(tsSeconds: number): string {
  if (tsSeconds == null || Number.isNaN(Number(tsSeconds))) return "—";
  return new Date(Number(tsSeconds) * 1000).toLocaleString();
}

function fail(err: unknown, setErr: (m: string | null) => void): boolean {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
    setErr("Session expired — please log in again");
    return true;
  }
  setErr(err instanceof Error ? err.message : "request failed");
  return false;
}

export function LogPanel({ maxHeight = "65vh" }: LogPanelProps) {
  const [tab, setTab] = useState<"main" | "peers">("main");
  const [paused, setPaused] = useState(false);
  const [filters, setFilters] = useState({ normal: true, info: true, warning: true, critical: true });
  const [mainRows, setMainRows] = useState<MainLogEntry[]>([]);
  const [peerRows, setPeerRows] = useState<PeerLogEntry[]>([]);
  const [mainErr, setMainErr] = useState<string | null>(null);
  const [peerErr, setPeerErr] = useState<string | null>(null);

  const mainLastId = useRef(-1);
  const peerLastId = useRef(-1);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const fetchMain = useCallback(async (): Promise<boolean> => {
    try {
      // Fetch all levels; level checkboxes filter client-side so toggling a
      // level back on still shows history already in the cache.
      const data = await apiFetch<MainLogEntry[]>(
        `/api/qb/log/main?normal=true&info=true&warning=true&critical=true&last_known_id=${mainLastId.current}`,
      );
      if (Array.isArray(data) && data.length > 0) {
        let max = mainLastId.current;
        for (const e of data) if (typeof e.id === "number" && e.id > max) max = e.id;
        mainLastId.current = max;
        setMainRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          const merged = [...data.filter((r) => !seen.has(r.id)), ...prev];
          merged.sort((a, b) => b.id - a.id);
          return merged.slice(0, MAX_ROWS);
        });
      }
      setMainErr(null);
      return false;
    } catch (e) {
      return fail(e, setMainErr);
    }
  }, []);

  const fetchPeers = useCallback(async (): Promise<boolean> => {
    try {
      const data = await apiFetch<PeerLogEntry[]>(`/api/qb/log/peers?last_known_id=${peerLastId.current}`);
      if (Array.isArray(data) && data.length > 0) {
        let max = peerLastId.current;
        for (const e of data) if (typeof e.id === "number" && e.id > max) max = e.id;
        peerLastId.current = max;
        setPeerRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          const merged = [...data.filter((r) => !seen.has(r.id)), ...prev];
          merged.sort((a, b) => b.id - a.id);
          return merged.slice(0, MAX_ROWS);
        });
      }
      setPeerErr(null);
      return false;
    } catch (e) {
      return fail(e, setPeerErr);
    }
  }, []);

  const authDead = useRef(false);

  // Poll the active tab every 5s. Interval is cleaned up on unmount / tab / pause change.
  // Auth failure stops polling (app shell handles re-login) instead of
  // dispatching veneer:unauthorized every 5s forever.
  useEffect(() => {
    if (paused || authDead.current) return;
    if (tab === "main") void fetchMain().then((dead) => { if (dead) authDead.current = true; });
    else void fetchPeers().then((dead) => { if (dead) authDead.current = true; });
    const t = window.setInterval(() => {
      if (authDead.current) {
        window.clearInterval(t);
        return;
      }
      if (tabRef.current === "main") void fetchMain().then((dead) => { if (dead) { authDead.current = true; window.clearInterval(t); } });
      else void fetchPeers().then((dead) => { if (dead) { authDead.current = true; window.clearInterval(t); } });
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [tab, paused, fetchMain, fetchPeers]);

  function clearView() {
    // Local only: drop cached rows but keep last_known_id so cleared entries
    // do not reappear on the next poll.
    if (tabRef.current === "main") {
      setMainRows([]);
      setMainErr(null);
    } else {
      setPeerRows([]);
      setPeerErr(null);
    }
  }

  const visibleMain = mainRows.filter((r) => {
    if (r.type === 1) return filters.normal;
    if (r.type === 2) return filters.info;
    if (r.type === 4) return filters.warning;
    if (r.type === 8) return filters.critical;
    return true;
  });

  const err = tab === "main" ? mainErr : peerErr;

  return (
    <section aria-label="qBittorrent logs" style={styles.root}>
      <div style={styles.tabRow} role="tablist" aria-label="Log type">
        <button
          role="tab"
          aria-selected={tab === "main"}
          style={tab === "main" ? styles.tabOn : styles.tabOff}
          onClick={() => setTab("main")}
        >
          Main
        </button>
        <button
          role="tab"
          aria-selected={tab === "peers"}
          style={tab === "peers" ? styles.tabOn : styles.tabOff}
          onClick={() => setTab("peers")}
        >
          Blocked peers
        </button>
        <span style={{ flex: 1 }} />
        <button
          style={btnSm}
          onClick={() => setPaused((p) => !p)}
          aria-pressed={paused}
          title={paused ? "Resume auto-refresh" : "Pause auto-refresh"}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button style={btnSm} onClick={clearView} title="Clear the displayed rows (local view only)">
          Clear view
        </button>
      </div>

      {tab === "main" && (
        <div style={styles.filters}>
          {(
            [
              ["normal", "Normal"],
              ["info", "Info"],
              ["warning", "Warning"],
              ["critical", "Critical"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} style={checkLabel}>
              <input
                type="checkbox"
                checked={filters[key]}
                onChange={() => setFilters((f) => ({ ...f, [key]: !f[key] }))}
              />
              {label}
            </label>
          ))}
        </div>
      )}

      {err && (
        <div style={errText} role="alert">
          {err}
        </div>
      )}

      <div style={{ ...styles.scroll, maxHeight }} role="tabpanel">
        {tab === "main" ? (
          visibleMain.length === 0 ? (
            <p style={mutedText}>No log entries.</p>
          ) : (
            <ul style={styles.list}>
              {visibleMain.map((r) => {
                const meta = LOG_TYPE_META[r.type] ?? { label: `Type ${r.type}`, color: colors.muted, bg: "transparent" };
                return (
                  <li key={r.id} style={styles.row}>
                    <span
                      style={{
                        ...badgeBase,
                        color: meta.color,
                        background: meta.bg,
                        border: `1px solid ${meta.color}66`,
                      }}
                    >
                      {meta.label}
                    </span>
                    <span style={styles.time}>{fmtTime(r.timestamp)}</span>
                    <span style={styles.msg}>{r.message}</span>
                  </li>
                );
              })}
            </ul>
          )
        ) : peerRows.length === 0 ? (
          <p style={mutedText}>No log entries.</p>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>IP</th>
                  <th style={styles.th}>Blocked</th>
                  <th style={styles.th}>Reason</th>
                  <th style={styles.th}>Time</th>
                </tr>
              </thead>
              <tbody>
                {peerRows.map((r) => (
                  <tr key={r.id}>
                    <td style={styles.td}>{r.ip}</td>
                    <td style={styles.td}>{r.blocked ? "yes" : "no"}</td>
                    <td style={{ ...styles.td, ...styles.reason }}>{r.reason || "—"}</td>
                    <td style={styles.td}>{fmtTime(r.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    background: colors.panel,
    color: colors.text,
    border: `1px solid ${colors.border}`,
    borderRadius: 12,
    padding: 12,
    minWidth: 0,
  },
  tabRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  tabOn: { ...btn, borderColor: colors.accent, color: "#fff", background: colors.accent, fontWeight: 600 },
  tabOff: { ...btn },
  filters: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" },
  scroll: { overflowY: "auto", overflowX: "hidden", minHeight: 120, minWidth: 0 },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 },
  row: {
    display: "flex",
    gap: 8,
    alignItems: "baseline",
    flexWrap: "wrap",
    padding: "6px 8px",
    background: colors.zebra,
    borderRadius: 8,
    fontSize: 13,
    minWidth: 0,
  },
  time: { color: colors.faint, fontSize: 12, whiteSpace: "nowrap" },
  msg: { overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0, flex: "1 1 200px" },
  tableWrap: { overflowX: "auto", minWidth: 0 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13, color: colors.text },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    color: colors.muted,
    fontWeight: 600,
    whiteSpace: "nowrap",
    position: "sticky",
    top: 0,
    background: colors.panel,
    zIndex: 1,
  },
  td: { padding: "7px 10px", borderBottom: `1px solid ${colors.border}`, verticalAlign: "top" },
  reason: { overflowWrap: "anywhere", wordBreak: "break-word", whiteSpace: "normal" },
};
