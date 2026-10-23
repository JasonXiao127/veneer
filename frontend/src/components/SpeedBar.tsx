import { useEffect, useRef, useState } from "react";
import type { ServerState } from "../types";
import { ApiError, fmtSize, fmtSpeed, qbPost } from "../lib/api";
import { btn, colors, errText } from "../lib/theme";

export function SpeedBar({ s, onLogout }: { s: ServerState; onLogout: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  // Responsive only: desktop path ignores these (base styles untouched).
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 768px)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function showError(msg: string) {
    setErr(msg);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setErr(null), 4000);
  }

  function fail(e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
    }
    showError(e instanceof Error ? e.message : "request failed");
  }

  async function toggleAlt() {
    if (busy) return;
    setBusy("alt");
    setErr(null);
    try {
      await qbPost("/api/qb/transfer/toggleSpeedLimitsMode", {});
      // Display follows server_state.use_alt_speed_limits on the next sync poll.
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function setLimit(kind: "dl" | "ul") {
    if (busy) return;
    const current = kind === "dl" ? Number(s.dl_rate_limit ?? 0) : Number(s.up_rate_limit ?? 0);
    const input = window.prompt(
      `Global ${kind === "dl" ? "download" : "upload"} limit in bytes/s (0 = unlimited):`,
      String(current || 0),
    );
    if (input === null) return; // cancelled
    const t = input.trim();
    if (!/^\d+$/.test(t)) {
      showError("Enter a non-negative integer (bytes/s); 0 = unlimited.");
      return;
    }
    setBusy(kind);
    setErr(null);
    try {
      await qbPost(
        kind === "dl" ? "/api/qb/transfer/setDownloadLimit" : "/api/qb/transfer/setUploadLimit",
        { limit: String(Number(t)) },
      );
      // New caps arrive via server_state on the next sync poll.
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  const dot = s.connection_status === "connected" ? colors.ok : s.connection_status === "disconnected" ? colors.dangerSolid : colors.warn;
  const dlCap = Number(s.dl_rate_limit ?? 0);
  const upCap = Number(s.up_rate_limit ?? 0);

  return (
    <header style={isMobile ? { ...styles.bar, rowGap: 8 } : styles.bar}>
      <strong>Veneer</strong>
      <button
        style={isMobile ? { ...styles.speed, padding: "10px 8px", minHeight: 44, minWidth: 44 } : styles.speed}
        title={dlCap > 0 ? `Download speed (cap ${fmtSpeed(dlCap)}) — click to set global limit` : "Download speed — click to set global limit"}
        aria-label={dlCap > 0 ? `Download speed, capped at ${fmtSpeed(dlCap)}. Activate to set global download limit.` : "Download speed. Activate to set global download limit."}
        onClick={() => void setLimit("dl")}
        disabled={busy !== null}
      >
        ↓ {fmtSpeed(s.dl_info_speed)}{dlCap > 0 ? ` / cap ${fmtSpeed(dlCap)}` : ""}
      </button>
      <button
        style={isMobile ? { ...styles.speed, padding: "10px 8px", minHeight: 44, minWidth: 44 } : styles.speed}
        title={upCap > 0 ? `Upload speed (cap ${fmtSpeed(upCap)}) — click to set global limit` : "Upload speed — click to set global limit"}
        aria-label={upCap > 0 ? `Upload speed, capped at ${fmtSpeed(upCap)}. Activate to set global upload limit.` : "Upload speed. Activate to set global upload limit."}
        onClick={() => void setLimit("ul")}
        disabled={busy !== null}
      >
        ↑ {fmtSpeed(s.up_info_speed)}{upCap > 0 ? ` / cap ${fmtSpeed(upCap)}` : ""}
      </button>
      <span title="free disk">⛁ {fmtSize(Number(s.free_space_on_disk ?? 0))}</span>
      <span title={String(s.connection_status)}>
        <i style={{ ...styles.dot, background: dot }} /> {String(s.connection_status)}
      </span>
      <button
        style={isMobile ? { ...(s.use_alt_speed_limits ? styles.altOn : styles.altOff), padding: "8px 12px", minHeight: 40, minWidth: 44, fontSize: 13 } : s.use_alt_speed_limits ? styles.altOn : styles.altOff}
        title={s.use_alt_speed_limits ? "Alternative speed limits ON — click to turn off" : "Alternative speed limits OFF — click to turn on"}
        onClick={() => void toggleAlt()}
        disabled={busy !== null}
      >
        🐢 ALT {s.use_alt_speed_limits ? "ON" : "OFF"}
      </button>
      {busy && <span style={{ fontSize: 11, color: colors.muted }}>…</span>}
      {err && <span style={errText}>{err}</span>}
      <span style={{ flex: 1 }} />
      <button style={isMobile ? { ...btn, padding: "10px 16px", minHeight: 44, minWidth: 44 } : { ...btn, padding: "5px 10px" }} onClick={onLogout}>Logout</button>
    </header>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: { display: "flex", gap: 14, alignItems: "center", padding: "10px 16px", background: colors.panel, color: colors.text, borderBottom: `1px solid ${colors.border}`, fontSize: 13, position: "sticky", top: 0, zIndex: 5, flexWrap: "wrap" },
  dot: { display: "inline-block", width: 8, height: 8, borderRadius: 999, marginRight: 4 },
  speed: { background: "transparent", color: colors.text, border: 0, padding: 0, fontSize: 13, cursor: "pointer" },
  altOn: { background: colors.altSpeed, color: colors.onFill, border: `1px solid ${colors.altSpeed}`, borderRadius: 4, padding: "1px 6px", fontSize: 11, cursor: "pointer" },
  altOff: { background: "transparent", color: colors.muted, border: `1px solid ${colors.borderStrong}`, borderRadius: 4, padding: "1px 6px", fontSize: 11, cursor: "pointer" },
};
