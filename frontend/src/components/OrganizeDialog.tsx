import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { createCategory, createTags, deleteTags, editCategory, removeCategories } from "../lib/qbActions";
import { btn, btnPrimary, card, colors, dialogTitle, errText, input, mutedText, overlay, sectionHeader } from "../lib/theme";

export function OrganizeDialog({
  categories,
  tags,
  onClose,
  onDone,
}: {
  categories: Record<string, { name: string; savePath: string }>;
  tags: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [newCat, setNewCat] = useState("");
  const [newCatPath, setNewCatPath] = useState("");
  const [newTags, setNewTags] = useState("");

  // Escape dismisses (overlay click already does; keyboard users need this).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
      }
      setErr(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  const names = Object.keys(categories);

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 520, maxHeight: "88vh" }} className="vn-dialog-card vn-org-card">
        <style>{orgMobileCss}</style>
        <h3 style={dialogTitle}>Organize</h3>

        <h4 style={sectionHeaderLg}>Categories</h4>
        {names.length === 0 && <p style={mutedPara}>No categories.</p>}
        {names.map((name) => {
          const original = categories[name]?.savePath ?? "";
          const savePath = paths[name] ?? original;
          // No-op saves are skipped: qB ≤5.1 409s unchanged edits.
          const unchanged = savePath.trim() === original.trim();
          const inputId = `org-cat-${name}`;
          return (
            <div key={name} style={row} className="vn-org-row">
              <span style={{ fontSize: 13, minWidth: 90, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
              <input
                id={inputId}
                value={savePath}
                onChange={(e) => setPaths((p) => ({ ...p, [name]: e.target.value }))}
                style={{ ...input, flex: 1, minWidth: 0 }}
                placeholder="save path"
                aria-label={`Save path for category ${name}`}
              />
              <button
                style={btn}
                disabled={busy !== null || unchanged}
                title={unchanged ? "No changes to save" : `Save path for ${name}`}
                onClick={() => run(`save:${name}`, () => editCategory(name, savePath.trim()))}
              >
                {busy === `save:${name}` ? "…" : "Save"}
              </button>
              <button
                style={btn}
                disabled={busy !== null}
                onClick={() => {
                  if (window.confirm(`Delete category "${name}"?`)) {
                    void run(`del:${name}`, () => removeCategories([name]));
                  }
                }}
              >
                {busy === `del:${name}` ? "…" : "Delete"}
              </button>
            </div>
          );
        })}
        <div style={row} className="vn-org-row">
          <input id="org-new-cat" value={newCat} onChange={(e) => setNewCat(e.target.value)} style={{ ...input, flex: 1, minWidth: 0 }} placeholder="new category name" aria-label="New category name" />
          <input id="org-new-cat-path" value={newCatPath} onChange={(e) => setNewCatPath(e.target.value)} style={{ ...input, flex: 1, minWidth: 0 }} placeholder="save path" aria-label="Save path for new category" />
          <button
            style={btnPrimary}
            disabled={busy !== null || !newCat.trim()}
            onClick={() =>
              run("createCat", async () => {
                await createCategory(newCat.trim(), newCatPath.trim());
                setNewCat("");
                setNewCatPath("");
              })
            }
          >
            {busy === "createCat" ? "…" : "Create"}
          </button>
        </div>

        <h4 style={sectionHeaderLg}>Tags</h4>
        {tags.length === 0 && <p style={mutedPara}>No tags.</p>}
        {tags.map((t) => (
          <div key={t} style={row} className="vn-org-row">
            <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{t}</span>
            <button style={btn} title={`Delete tag ${t}`} disabled={busy !== null} onClick={() => run(`tag:${t}`, () => deleteTags(t))}>
              {busy === `tag:${t}` ? "…" : "Delete"}
            </button>
          </div>
        ))}
        <div style={row} className="vn-org-row">
          <input id="org-new-tags" value={newTags} onChange={(e) => setNewTags(e.target.value)} style={{ ...input, flex: 1, minWidth: 0 }} placeholder="new tags (comma-separated)" aria-label="New tags" />
          <button
            style={btnPrimary}
            disabled={busy !== null || !newTags.trim()}
            onClick={() =>
              run("createTags", async () => {
                await createTags(newTags.trim());
                setNewTags("");
              })
            }
          >
            {busy === "createTags" ? "…" : "Create"}
          </button>
        </div>

        {err && <p style={errText}>{err}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", position: "sticky", bottom: 0, background: colors.panel, padding: "10px 0 2px", borderTop: `1px solid ${colors.border}` }} className="vn-dialog-actions">
          <button style={btn} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

const sectionHeaderLg: React.CSSProperties = { ...sectionHeader, fontSize: 14, margin: "8px 0 0" };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const mutedPara: React.CSSProperties = { ...mutedText, fontSize: 13, margin: 0 };

/**
 * Mobile-only overrides (desktop >768px never matches → desktop unchanged).
 */
const orgMobileCss = `
@media (max-width: 768px) {
  .vn-org-card {
    max-height: 92dvh !important;
    -webkit-overflow-scrolling: touch;
  }
  .vn-org-card input:not([type="checkbox"]),
  .vn-org-card select {
    font-size: 16px !important;
    min-height: 40px !important;
  }
  .vn-org-card button,
  .vn-org-card select { min-height: 40px !important; }
}
@media (max-width: 480px) {
  .vn-org-card .vn-org-row {
    flex-direction: column !important;
    align-items: stretch !important;
  }
  .vn-org-card .vn-org-row button {
    width: 100% !important;
    min-height: 44px !important;
  }
  .vn-org-card .vn-dialog-actions {
    flex-direction: column !important;
    align-items: stretch !important;
  }
  .vn-org-card .vn-dialog-actions button {
    width: 100% !important;
    min-height: 44px !important;
  }
}
`;
