import { useEffect, useState } from "react";
import { btn, btnPrimary, card, checkLabel, colors, dialogTitle, errText, fieldLabel, input, overlay, select } from "../lib/theme";

export function AddDialog({
  categories,
  isV5,
  onClose,
  onDone,
}: {
  categories: Record<string, { name: string; savePath: string }>;
  isV5: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [urls, setUrls] = useState("");
  const [category, setCategory] = useState("");
  const [stopped, setStopped] = useState(false);
  const [files, setFiles] = useState<FileList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Escape dismisses (overlay click already does; keyboard users need this).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Optional fields (More options)
  const [savepath, setSavepath] = useState("");
  const [tags, setTags] = useState("");
  const [sequentialDownload, setSequentialDownload] = useState(false);
  const [firstLastPiecePrio, setFirstLastPiecePrio] = useState(false);
  const [contentLayout, setContentLayout] = useState("");
  const [skipChecking, setSkipChecking] = useState(false);
  const [autoTMM, setAutoTMM] = useState(true);
  const [ratioLimit, setRatioLimit] = useState("");
  const [seedingTimeLimit, setSeedingTimeLimit] = useState("");
  const [dlLimit, setDlLimit] = useState("");
  const [upLimit, setUpLimit] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      if (urls.trim()) form.append("urls", urls.trim());
      if (files) for (const f of Array.from(files)) form.append("torrents", f, f.name);
      if (category) form.append("category", category);
      // qB 5.x renamed paused -> stopped
      form.append(isV5 ? "stopped" : "paused", String(stopped));
      // Optional fields: only send when set (non-empty / true / non-default).
      if (savepath.trim()) form.append("savepath", savepath.trim());
      if (tags.trim()) form.append("tags", tags.trim());
      if (sequentialDownload) form.append("sequentialDownload", "true");
      if (firstLastPiecePrio) form.append("firstLastPiecePrio", "true");
      if (contentLayout) form.append("contentLayout", contentLayout);
      // skip_checking (≤5.2) was replaced by seedMode on master/5.3+; send
      // both — each generation ignores the unknown key.
      if (skipChecking) {
        form.append("skip_checking", "true");
        form.append("seedMode", "true");
      }
      if (!autoTMM) form.append("autoTMM", "false");
      // Numeric optionals are validated client-side so typos surface inline
      // instead of silently falling back to qB defaults server-side
      // (addAction never 400s on unparsable numbers — it just ignores them).
      // ratioLimit is a float (-2 = global, -1 = unlimited); the rest are
      // non-negative integers.
      const numOpt = (raw: string, label: string, float: boolean): string | null => {
        const v = raw.trim();
        if (!v) return null;
        const ok = float ? /^-?\d+(\.\d+)?$/.test(v) : /^\d+$/.test(v);
        if (!ok || (!float && !Number.isSafeInteger(Number(v)))) throw new Error(`${label} must be a number`);
        return v;
      };
      const rl = numOpt(ratioLimit, "Ratio limit", true);
      const stl = numOpt(seedingTimeLimit, "Seeding time", false);
      const dll = numOpt(dlLimit, "DL limit", false);
      const upl = numOpt(upLimit, "UL limit", false);
      if (rl !== null) form.append("ratioLimit", rl);
      if (stl !== null) form.append("seedingTimeLimit", stl);
      if (dll !== null) form.append("dlLimit", dll);
      if (upl !== null) form.append("upLimit", upl);
      const res = await fetch("/api/qb/torrents/add", { method: "POST", credentials: "same-origin", body: form });
      if (res.status === 401 || res.status === 403) {
        window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
        throw new Error("Session expired — please log in again");
      }
      if (!res.ok) throw new Error(await res.text().catch(() => `add failed (${res.status})`));
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "add failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} style={card} className="vn-dialog-card vn-add-card">
        <style>{addMobileCss}</style>
        <h3 style={dialogTitle}>Add torrents</h3>
        <label htmlFor="add-urls" style={fieldLabel}>
          Magnet / URL (one per line)
          <textarea id="add-urls" value={urls} onChange={(e) => setUrls(e.target.value)} rows={3} style={input} placeholder="magnet:?xt=…" />
        </label>
        <label htmlFor="add-files" style={fieldLabel}>
          .torrent files
          <input id="add-files" type="file" multiple accept=".torrent,application/x-bittorrent" onChange={(e) => setFiles(e.target.files)} />
        </label>
        <label htmlFor="add-category" style={fieldLabel}>
          Category
          <select id="add-category" value={category} onChange={(e) => setCategory(e.target.value)} style={select}>
            <option value="">(none)</option>
            {Object.keys(categories).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label htmlFor="add-stopped" style={checkLabel}>
          <input id="add-stopped" type="checkbox" checked={stopped} onChange={(e) => setStopped(e.target.checked)} /> Add stopped
        </label>
        <details style={detailsStyle}>
          <summary style={{ cursor: "pointer", fontSize: 13, color: colors.muted }}>More options</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
            <label htmlFor="add-savepath" style={fieldLabel}>
              Save path
              <input id="add-savepath" value={savepath} onChange={(e) => setSavepath(e.target.value)} style={input} placeholder="/downloads/…" />
            </label>
            <label htmlFor="add-tags" style={fieldLabel}>
              Tags (comma-separated)
              <input id="add-tags" value={tags} onChange={(e) => setTags(e.target.value)} style={input} placeholder="tag1, tag2" />
            </label>
            <label htmlFor="add-layout" style={fieldLabel}>
              Content layout
              <select id="add-layout" value={contentLayout} onChange={(e) => setContentLayout(e.target.value)} style={select}>
                <option value="">Default</option>
                <option value="Original">Original</option>
                <option value="Subfolder">Subfolder</option>
                <option value="NoSubfolder">NoSubfolder</option>
              </select>
            </label>
            <label htmlFor="add-seq" style={checkLabel}>
              <input id="add-seq" type="checkbox" checked={sequentialDownload} onChange={(e) => setSequentialDownload(e.target.checked)} /> Sequential download
            </label>
            <label htmlFor="add-fl" style={checkLabel}>
              <input id="add-fl" type="checkbox" checked={firstLastPiecePrio} onChange={(e) => setFirstLastPiecePrio(e.target.checked)} /> First/last piece priority
            </label>
            <label htmlFor="add-skip" style={checkLabel}>
              <input id="add-skip" type="checkbox" checked={skipChecking} onChange={(e) => setSkipChecking(e.target.checked)} /> Skip hash checking
            </label>
            <label htmlFor="add-tmm" style={checkLabel}>
              <input id="add-tmm" type="checkbox" checked={autoTMM} onChange={(e) => setAutoTMM(e.target.checked)} /> Automatic torrent management
            </label>
            <label htmlFor="add-ratio" style={fieldLabel}>
              Ratio limit (empty = unset, -2 = global, -1 = unlimited)
              <input id="add-ratio" value={ratioLimit} onChange={(e) => setRatioLimit(e.target.value)} style={input} inputMode="decimal" placeholder="" />
            </label>
            <label htmlFor="add-stl" style={fieldLabel}>
              Seeding time limit, minutes (empty = unset)
              <input id="add-stl" value={seedingTimeLimit} onChange={(e) => setSeedingTimeLimit(e.target.value)} style={input} inputMode="numeric" placeholder="" />
            </label>
            <label htmlFor="add-dll" style={fieldLabel}>
              Download limit, bytes/s (empty = unset)
              <input id="add-dll" value={dlLimit} onChange={(e) => setDlLimit(e.target.value)} style={input} inputMode="numeric" placeholder="" />
            </label>
            <label htmlFor="add-upl" style={fieldLabel}>
              Upload limit, bytes/s (empty = unset)
              <input id="add-upl" value={upLimit} onChange={(e) => setUpLimit(e.target.value)} style={input} inputMode="numeric" placeholder="" />
            </label>
          </div>
        </details>
        {err && <p style={errText}>{err}</p>}
        <div className="vn-dialog-actions" style={{ display: "flex", gap: 8, justifyContent: "flex-end", position: "sticky", bottom: 0, background: colors.panel, padding: "10px 0 2px", borderTop: `1px solid ${colors.border}` }}>
          <button type="button" style={btn} onClick={onClose}>Cancel</button>
          <button type="submit" style={btnPrimary} disabled={busy}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}

const detailsStyle: React.CSSProperties = { border: `1px solid ${colors.border}`, borderRadius: 8, padding: "8px 10px" };

/**
 * Mobile-only overrides (desktop >768px never matches → desktop unchanged).
 */
const addMobileCss = `
@media (max-width: 768px) {
  .vn-add-card {
    max-height: 92dvh !important;
    -webkit-overflow-scrolling: touch;
  }
  .vn-add-card input:not([type="checkbox"]):not([type="file"]),
  .vn-add-card select,
  .vn-add-card textarea {
    font-size: 16px !important;
    min-height: 40px !important;
  }
  .vn-add-card input[type="checkbox"] {
    width: 22px !important;
    height: 22px !important;
  }
  .vn-add-card button { min-height: 40px !important; }
  .vn-add-card select { min-height: 40px !important; }
}
@media (max-width: 480px) {
  .vn-add-card .vn-dialog-actions {
    flex-direction: column !important;
    align-items: stretch !important;
  }
  .vn-add-card .vn-dialog-actions button {
    width: 100% !important;
    min-height: 44px !important;
  }
}
`;
