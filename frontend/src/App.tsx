import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Login } from "./components/Login";
import { SpeedBar } from "./components/SpeedBar";
import { TorrentTable } from "./components/TorrentTable";
import { BulkBar } from "./components/BulkBar";
import { DetailDrawer } from "./components/DetailDrawer";
import { AddDialog } from "./components/AddDialog";
import { OrganizeDialog } from "./components/OrganizeDialog";
import { PrefsDialog } from "./components/PrefsDialog";
import { SearchPanel } from "./components/SearchPanel";
import { RssPanel } from "./components/RssPanel";
import { LogPanel } from "./components/LogPanel";
import { RulesPanel } from "./components/RulesPanel";
import { useQbSync, resetSyncState, siteInfoFor } from "./hooks/useQbSync";
import { presetFor } from "./lib/seedPresets";
import { apiFetch } from "./lib/api";
import { btnPrimary, btn, colors } from "./lib/theme";
import type { Torrent } from "./types";

const qc = new QueryClient();

function Shell() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [isV5, setIsV5] = useState(true);
  const [selection, setSelection] = useState<string[]>([]);
  const [open, setOpen] = useState<Torrent | null>(null);
  const [adding, setAdding] = useState(false);
  const [showOrganize, setShowOrganize] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [view, setView] = useState<"torrents" | "search" | "rss" | "logs" | "rules">("torrents");
  const [notice, setNotice] = useState<string | null>(null);
  // Responsive only: desktop path ignores this (base styles untouched).
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

  const check = useCallback(async () => {
    try {
      const s = await apiFetch<{ loggedIn: boolean; isV5?: boolean; degraded?: boolean; error?: string }>("/api/session/status");
      setAuthed(s.loggedIn);
      setNotice(s.loggedIn ? null : (s.error ?? null));
      if (s.isV5 !== undefined) setIsV5(s.isV5);
    } catch {
      setAuthed(false);
      setNotice(null);
    }
  }, []);

  // Whether any sync payload has arrived this session. Distinguishes
  // externally-removed torrents (close drawer/prune selection) from the
  // not-yet-loaded first poll. O(1) memory — a prior Set-of-all-hashes design
  // grew with history and re-scanned every 2s poll.
  const loadedOnce = useRef(false);

  useEffect(() => {
    void check();
    const h = () => {
      loadedOnce.current = false;
      setAuthed(false);
      setOpen(null);
      setAdding(false);
      setShowOrganize(false);
      setShowPrefs(false);
      setView("torrents");
      setSelection([]);
      setNotice("Session expired — please log in again.");
      resetSyncState();
    };
    window.addEventListener("veneer:unauthorized", h);
    return () => window.removeEventListener("veneer:unauthorized", h);
  }, [check]);

  const sync = useQbSync(!authed);

  useEffect(() => {
    const torrents = sync.torrents;
    if (Object.keys(torrents).length > 0) loadedOnce.current = true;
    if (!loadedOnce.current) return;
    if (open && !torrents[open.hash]) setOpen(null);
    setSelection((sel) => {
      if (sel.length === 0) return sel;
      const pruned = sel.filter((h) => torrents[h]);
      return pruned.length === sel.length ? sel : pruned;
    });
  }, [sync.torrents, open]);

  // Re-resolve the open torrent from the live store each poll so the drawer
  // header never shows a stale snapshot taken at click time.
  const openLive = open ? (sync.torrents[open.hash] ?? open) : null;

  // Kind-matched seed preset default: majority kind across the selection
  // (unknowns don't vote). Recomputed per render — cheap over selections.
  const suggestedPresetId = (() => {
    if (selection.length === 0) return undefined;
    let priv = 0,
      pub = 0;
    for (const h of selection) {
      const t = sync.torrents[h];
      if (!t) continue;
      const k = siteInfoFor(t).kind;
      if (k === "private") priv++;
      else if (k === "public") pub++;
    }
    if (priv === 0 && pub === 0) return undefined;
    return presetFor(priv >= pub ? "private" : "public").id;
  })();

  async function logout() {
    await apiFetch("/api/session/logout", { method: "POST" }).catch(() => undefined);
    loadedOnce.current = false;
    setAuthed(false);
    setOpen(null);
    setAdding(false);
    setShowOrganize(false);
    setShowPrefs(false);
    setView("torrents");
    setSelection([]);
    resetSyncState();
  }

  if (authed === null) return <p style={{ color: colors.muted, padding: 24 }}>Loading…</p>;
  if (!authed) return <Login notice={notice} onDone={(info) => { setIsV5(info.isV5); setNotice(null); setAuthed(true); }} />;

  return (
    <div style={{ background: colors.bg, minHeight: "100vh", overflowX: "clip", maxWidth: "100vw" }}>
      <SpeedBar s={sync.serverState} onLogout={logout} />
      <nav aria-label="Views" style={isMobile ? { padding: "8px 12px 0", display: "flex", flexWrap: "wrap", gap: 8 } : { padding: "8px 16px 0", display: "flex", flexWrap: "wrap", gap: 8 }}>
        {(["torrents", "search", "rss", "logs", "rules"] as const).map((v) => (
          <button
            key={v}
            aria-pressed={view === v}
            onClick={() => setView(v)}
            style={isMobile ? { ...(view === v ? btnPrimary : btn), margin: 0, minHeight: 44, padding: "8px 14px", textTransform: "capitalize" } : { ...(view === v ? btnPrimary : btn), margin: 0, textTransform: "capitalize" }}
          >
            {v}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button style={isMobile ? { ...btn, margin: 0, minHeight: 44, padding: "8px 14px" } : { ...btn, margin: 0 }} onClick={() => setShowPrefs(true)}>Preferences</button>
        {view === "torrents" && (
          <>
            <button style={isMobile ? { ...btn, margin: 0, minHeight: 44, padding: "8px 14px" } : { ...btn, margin: 0 }} onClick={() => setShowOrganize(true)}>Organize…</button>
            <button style={isMobile ? { ...btnPrimary, margin: 0, minHeight: 44, padding: "8px 14px" } : { ...btnPrimary, margin: 0 }} onClick={() => setAdding(true)}>+ Add</button>
          </>
        )}
      </nav>
      {sync.error && <p style={{ color: colors.warn, fontSize: 12, padding: "8px 16px 0" }}>sync: {sync.error}</p>}
      {view === "torrents" && (
        <>
          <TorrentTable torrents={sync.torrentList} selection={selection} onSelection={setSelection} onOpen={setOpen} siteOf={(t) => siteInfoFor(t)} loading={sync.rid === 0 && sync.torrentList.length === 0 && !sync.error} syncError={sync.error} isV5={isV5} />
          <BulkBar
            selection={selection}
            isV5={isV5}
            onClear={() => setSelection([])}
            onDone={sync.refetch}
            onDeleted={(hashes) => setOpen((o) => (o && hashes.includes(o.hash) ? null : o))}
            suggestedPresetId={suggestedPresetId}
          />
          <DetailDrawer torrent={openLive} onClose={() => setOpen(null)} />
        </>
      )}
      {view === "search" && (
        <div style={{ padding: isMobile ? "8px 12px" : "8px 16px" }}>
          <SearchPanel maxHeight="70vh" />
        </div>
      )}
      {view === "rss" && (
        <div style={{ padding: isMobile ? "8px 12px" : "8px 16px" }}>
          <RssPanel maxHeight="70vh" />
        </div>
      )}
      {view === "logs" && (
        <div style={{ padding: isMobile ? "8px 12px" : "8px 16px" }}>
          <LogPanel maxHeight="70vh" />
        </div>
      )}
      {view === "rules" && (
        <div style={{ padding: isMobile ? "8px 12px" : "8px 16px" }}>
          <RulesPanel maxHeight="70vh" />
        </div>
      )}
      {adding && (
        <AddDialog categories={sync.categories} isV5={isV5} onClose={() => setAdding(false)} onDone={sync.refetch} />
      )}
      {showOrganize && (
        <OrganizeDialog categories={sync.categories} tags={sync.tags} onClose={() => setShowOrganize(false)} onDone={sync.refetch} />
      )}
      {showPrefs && (
        <PrefsDialog onClose={() => setShowPrefs(false)} onDone={sync.refetch} />
      )}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  );
}
