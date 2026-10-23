import { useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import {
  addTags,
  deleteTorrents,
  queueBottom,
  queueDown,
  queueTop,
  queueUp,
  reannounceTorrents,
  recheckTorrents,
  removeTags,
  renameTorrent,
  setAutoManagement,
  setCategory,
  setForceStart,
  setShareLimits,
  setSuperSeeding,
  startTorrents,
  stopTorrents,
  toggleFirstLastPiece,
  toggleSequential,
} from "../lib/qbActions";
import { DEFAULT_PRESETS } from "../lib/seedPresets";
import { btn, btnSm, colors, errText, input, mutedText, select } from "../lib/theme";

export function BulkBar({
  selection,
  isV5,
  onClear,
  onDone,
  onDeleted,
  suggestedPresetId,
}: {
  selection: string[];
  isV5: boolean;
  onClear: () => void;
  onDone: () => void;
  onDeleted: (hashes: string[]) => void;
  /** Kind-matched default for the Seed dropdown (falls back to first preset). */
  suggestedPresetId?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showSeed, setShowSeed] = useState(false);
  const [presetId, setPresetId] = useState(DEFAULT_PRESETS[0].id);
  // Adopt the kind-matched suggestion whenever the selection changes and the
  // user hasn't hand-picked a preset in this session.
  const touchedPreset = useRef(false);
  useEffect(() => {
    if (suggestedPresetId && !touchedPreset.current) setPresetId(suggestedPresetId);
  }, [suggestedPresetId]);
  // Clearing the selection restarts the session: a later batch re-adopts the
  // suggestion instead of keeping a stale hand-pick forever.
  useEffect(() => {
    if (selection.length === 0) touchedPreset.current = false;
  }, [selection]);
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null);
  const [category, setCategoryInput] = useState("");
  const [tagsAdd, setTagsAdd] = useState("");
  const [tagsRemove, setTagsRemove] = useState("");
  if (selection.length === 0) return null;

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      // Session death must log out now, not linger until the next poll tick.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
      }
      setErr(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy(null);
    }
  }

  async function runQueue(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setErr("queueing disabled in qB");
      } else {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
        }
        setErr(e instanceof Error ? e.message : "action failed");
      }
    } finally {
      setBusy(null);
    }
  }

  async function applySeedPreset() {
    const preset = DEFAULT_PRESETS.find((p) => p.id === presetId) ?? DEFAULT_PRESETS[0];
    await run("seed", () =>
      setShareLimits(selection, {
        ratioLimit: preset.ratioLimit,
        seedingTimeLimit: preset.seedingTimeLimit,
        inactiveSeedingTimeLimit: preset.inactiveSeedingTimeLimit,
      }).then(() => {
        setAppliedMsg(`Applied “${preset.label}” to ${selection.length} torrent(s).`);
        setShowSeed(false);
      }),
    );
  }
  async function del() {
    // First dialog: proceed vs abort. Second: files vs metadata-only.
    if (!window.confirm(`Delete ${selection.length} torrent(s)?`)) return;
    const withFiles = window.confirm("Also delete the files from disk?\nOK = delete files, Cancel = keep files.");
    await run("delete", () => deleteTorrents(selection, withFiles).then(() => { onClear(); onDeleted(selection); }));
  }

  async function doRename() {
    if (selection.length !== 1) return;
    const name = window.prompt("New name for torrent:");
    if (name === null || name.trim() === "") return;
    await run("rename", () => renameTorrent(selection[0], name.trim()));
  }

  async function applyCategory() {
    // Empty string clears the category in qB.
    await run("category", () => setCategory(selection, category));
  }

  async function applyTagsAdd() {
    if (tagsAdd.trim() === "") return;
    await run("tags+", () => addTags(selection, tagsAdd.trim()));
  }

  async function applyTagsRemove() {
    if (tagsRemove.trim() === "") return;
    await run("tags-", () => removeTags(selection, tagsRemove.trim()));
  }

  return (
    <div className="vn-bulk" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 16px", background: colors.panelAlt, borderTop: `1px solid ${colors.border}`, position: "sticky", bottom: 0 }}>
      <style>{bulkMobileCss}</style>
      <div className="vn-bulk-row" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13, color: colors.text }}>{selection.length} selected</strong>
        <button style={btn} disabled={!!busy} onClick={() => run("start", () => startTorrents(selection, isV5))}>Start</button>
        <button style={btn} disabled={!!busy} onClick={() => run("stop", () => stopTorrents(selection, isV5))}>Stop</button>
        <button style={btn} disabled={!!busy} onClick={() => run("recheck", () => recheckTorrents(selection))}>Recheck</button>
        <button style={btn} disabled={!!busy} onClick={() => run("reannounce", () => reannounceTorrents(selection))}>Reannounce</button>
        <button style={btn} disabled={!!busy} onClick={del}>Delete…</button>
        <button style={btn} disabled={!!busy} onClick={() => { setAppliedMsg(null); setShowSeed((s) => !s); }}>Seed…</button>
        <button style={btn} disabled={!!busy || selection.length !== 1} title={selection.length !== 1 ? "Select exactly one torrent to rename" : "Rename torrent"} onClick={doRename}>Rename…</button>
        <button style={btn} title="Clear selection" onClick={onClear}>Clear</button>
        {busy && <span style={{ fontSize: 12, color: colors.muted }}>{busy}…</span>}
        {err && <span style={errText}>{err}</span>}
        {appliedMsg && <span style={{ fontSize: 12, color: colors.okLight }}>{appliedMsg}</span>}
        {showSeed && (
          <span className="vn-bulk-seed" style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={presetId}
              disabled={!!busy}
              onChange={(e) => { touchedPreset.current = true; setPresetId(e.target.value); }}
              style={{ ...select, fontSize: 13 }}
            >
              {DEFAULT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <button style={btn} disabled={!!busy} onClick={applySeedPreset}>Apply</button>
          </span>
        )}
      </div>
      <div className="vn-bulk-row" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={mutedText}>Category:</span>
        <input aria-label="Category to apply (empty clears)" style={{ ...input, width: 140 }} placeholder="category (empty clears)" value={category} disabled={!!busy} onChange={(e) => setCategoryInput(e.target.value)} />
        <button style={btnSm} disabled={!!busy} onClick={applyCategory}>Apply</button>
        <span style={{ ...mutedText, marginLeft: 8 }}>+Tags:</span>
        <input aria-label="Tags to add" style={{ ...input, width: 120 }} placeholder="tag1, tag2" value={tagsAdd} disabled={!!busy} onChange={(e) => setTagsAdd(e.target.value)} />
        <button style={btnSm} disabled={!!busy} onClick={applyTagsAdd}>Add</button>
        <span style={{ ...mutedText, marginLeft: 8 }}>−Tags:</span>
        <input aria-label="Tags to remove" style={{ ...input, width: 120 }} placeholder="tag1, tag2" value={tagsRemove} disabled={!!busy} onChange={(e) => setTagsRemove(e.target.value)} />
        <button style={btnSm} disabled={!!busy} onClick={applyTagsRemove}>Remove</button>
      </div>
      <details style={{ fontSize: 12, color: colors.muted }}>
        <summary style={{ cursor: "pointer", userSelect: "none" }}>More…</summary>
        <div className="vn-bulk-more" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
          <button style={btnSm} disabled={!!busy} title="Force-start on" onClick={() => run("fstart-on", () => setForceStart(selection, true))}>Force-start on</button>
          <button style={btnSm} disabled={!!busy} title="Force-start off" onClick={() => run("fstart-off", () => setForceStart(selection, false))}>Force-start off</button>
          <span style={{ color: colors.divider }}>|</span>
          <span style={{ fontSize: 12 }}>Queue:</span>
          <button style={btnSm} disabled={!!busy} title="Move to top of queue" onClick={() => runQueue("q-top", () => queueTop(selection))}>Top</button>
          <button style={btnSm} disabled={!!busy} title="Move up in queue" onClick={() => runQueue("q-up", () => queueUp(selection))}>Up</button>
          <button style={btnSm} disabled={!!busy} title="Move down in queue" onClick={() => runQueue("q-down", () => queueDown(selection))}>Down</button>
          <button style={btnSm} disabled={!!busy} title="Move to bottom of queue" onClick={() => runQueue("q-bottom", () => queueBottom(selection))}>Bottom</button>
          <span style={{ color: colors.divider }}>|</span>
          <button style={btnSm} disabled={!!busy} title="Toggle sequential download" onClick={() => run("seq", () => toggleSequential(selection))}>Sequential</button>
          <button style={btnSm} disabled={!!busy} title="Toggle first/last piece priority" onClick={() => run("fl", () => toggleFirstLastPiece(selection))}>First/Last</button>
          <span style={{ color: colors.divider }}>|</span>
          <button style={btnSm} disabled={!!busy} title="Enable super-seeding" onClick={() => run("ss-on", () => setSuperSeeding(selection, true))}>Super-seed on</button>
          <button style={btnSm} disabled={!!busy} title="Disable super-seeding" onClick={() => run("ss-off", () => setSuperSeeding(selection, false))}>Super-seed off</button>
          <span style={{ color: colors.divider }}>|</span>
          <button style={btnSm} disabled={!!busy} title="Enable automatic torrent management" onClick={() => run("am-on", () => setAutoManagement(selection, true))}>Auto-mgd on</button>
          <button style={btnSm} disabled={!!busy} title="Disable automatic torrent management" onClick={() => run("am-off", () => setAutoManagement(selection, false))}>Auto-mgd off</button>
        </div>
      </details>
    </div>
  );
}

/**
 * Mobile-only overrides (desktop >768px never matches → desktop unchanged).
 * Rows already wrap; on phones we keep the wrapping grid, raise targets to
 * ≥40px, keep sticky bottom, and add safe-area-inset-bottom padding.
 */
const bulkMobileCss = `
@media (max-width: 768px) {
  .vn-bulk {
    position: sticky !important;
    bottom: 0 !important;
    padding-bottom: calc(8px + env(safe-area-inset-bottom)) !important;
    padding-left: calc(16px + env(safe-area-inset-left)) !important;
    padding-right: calc(16px + env(safe-area-inset-right)) !important;
  }
  .vn-bulk button {
    min-height: 40px !important;
    padding: 8px 12px !important;
  }
  .vn-bulk select,
  .vn-bulk input {
    min-height: 40px !important;
    font-size: 16px !important;
  }
  .vn-bulk summary {
    min-height: 40px !important;
    display: inline-flex !important;
    align-items: center !important;
  }
}
@media (max-width: 480px) {
  .vn-bulk {
    max-height: 50dvh !important;
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  .vn-bulk .vn-bulk-seed {
    flex-basis: 100% !important;
    display: flex !important;
    align-items: center !important;
  }
  .vn-bulk .vn-bulk-seed select {
    flex: 1 !important;
    min-width: 0 !important;
  }
}
`;
