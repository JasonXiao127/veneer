import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiFetch, qbPost } from "../lib/api";
import { badgeBase, btn, btnPrimary, btnSm, colors, errText, input, mutedText, sectionHeader } from "../lib/theme";

function unauthorized(e: unknown) {
  if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
    window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
    return true;
  }
  return false;
}

/** Only http(s) links from feed data are clickable — javascript:/data: XSS. */
function safeHttpUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const t = u.trim();
  if (/^https?:\/\//i.test(t)) return t;
  return null;
}

function fmtFeedDate(d: unknown): string {
  if (typeof d !== "string" || d.trim() === "") return "";
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString();
}

interface RssArticle {
  id?: string;
  title: string;
  date?: string;
  author?: string;
  description?: string;
  link?: string;
  torrentURL?: string;
  isRead?: boolean;
}

interface RssFeedData {
  uid: string;
  url: string;
  title?: string;
  lastBuildDate?: string;
  isLoading?: boolean;
  hasError?: boolean;
  articles?: RssArticle[];
}

/** rss/items value: string (no withData), feed object (uid), or folder (nested). */
type RssLeaf = string | RssFeedData;
interface RssFolder {
  [name: string]: RssLeaf | RssFolder;
}
type RssNode = RssLeaf | RssFolder;

function isFeedObject(v: RssNode): v is RssFeedData {
  return typeof v === "object" && v !== null && typeof (v as RssFeedData).uid === "string";
}

interface FlatRow {
  path: string;
  name: string;
  depth: number;
  kind: "folder" | "feed";
  unread: number;
}

function flatten(items: Record<string, RssNode>, prefix: string, depth: number, out: FlatRow[]): FlatRow[] {
  for (const [name, node] of Object.entries(items)) {
    const path = prefix ? `${prefix}\\${name}` : name;
    if (typeof node === "string" || isFeedObject(node)) {
      const articles = isFeedObject(node) ? (node.articles ?? []) : [];
      out.push({ path, name, depth, kind: "feed", unread: articles.filter((a) => !a.isRead).length });
    } else {
      // Folder: unread = sum of descendants.
      const before = out.length;
      out.push({ path, name, depth, kind: "folder", unread: 0 });
      flatten(node as Record<string, RssNode>, path, depth + 1, out);
      let sum = 0;
      for (let i = before + 1; i < out.length && out[i].depth > depth; i++) {
        if (out[i].kind === "feed") sum += out[i].unread;
      }
      out[before].unread = sum;
    }
  }
  return out;
}

function nodeAt(items: Record<string, RssNode>, path: string): RssNode | undefined {
  const parts = path.split("\\");
  let cur: RssNode | undefined = items;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null || isFeedObject(cur)) return undefined;
    cur = (cur as Record<string, RssNode>)[p];
  }
  return cur;
}

interface RuleDef {
  enabled?: boolean;
  mustContain?: string;
  mustNotContain?: string;
  useRegex?: boolean;
  episodeFilter?: string;
  smartFilter?: boolean;
  previouslyMatchedEpisodes?: unknown[];
  affectedFeeds?: string[];
  ignoreDays?: number;
  lastMatch?: string;
  addPaused?: boolean;
  assignedCategory?: string;
  savePath?: string;
  [k: string]: unknown;
}

const EMPTY_RULE: RuleDef = {
  enabled: true,
  mustContain: "",
  mustNotContain: "",
  episodeFilter: "",
  affectedFeeds: [],
  assignedCategory: "",
  addPaused: false,
};

export function RssPanel({ maxHeight = "65vh" }: { maxHeight?: string }) {
  const [items, setItems] = useState<Record<string, RssNode>>({});
  const [itemsErr, setItemsErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mutErr, setMutErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [feedUrl, setFeedUrl] = useState("");
  const [feedPath, setFeedPath] = useState("");
  const [folderPath, setFolderPath] = useState("");

  const [rules, setRules] = useState<Record<string, RuleDef>>({});
  const [rulesErr, setRulesErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editForm, setEditForm] = useState<RuleDef>({ ...EMPTY_RULE });
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [matches, setMatches] = useState<Record<string, string[]> | null>(null);
  const [matchesFor, setMatchesFor] = useState<string | null>(null);
  const [matchesErr, setMatchesErr] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    try {
      const data = await apiFetch<Record<string, RssNode>>("/api/qb/rss/items?withData=true");
      setItems(data ?? {});
      setItemsErr(null);
    } catch (e) {
      if (!unauthorized(e)) setItemsErr(e instanceof Error ? e.message : "failed to load feeds");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRules = useCallback(async () => {
    try {
      const data = await apiFetch<Record<string, RuleDef>>("/api/qb/rss/rules");
      setRules(data ?? {});
      setRulesErr(null);
    } catch (e) {
      if (!unauthorized(e)) setRulesErr(e instanceof Error ? e.message : "failed to load rules");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void loadItems();
    void loadRules();
  }, [loadItems, loadRules]);

  // 60s auto-refresh, pausable; cleanup on unmount.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!pausedRef.current) {
        void loadItems();
      }
    }, 60000);
    return () => window.clearInterval(t);
  }, [loadItems]);

  async function mutate(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setMutErr(null);
    try {
      await fn();
      await loadItems();
    } catch (e) {
      if (!unauthorized(e)) setMutErr(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  const rows = useMemo(() => flatten(items, "", 0, []), [items]);

  const selectedArticles: RssArticle[] = useMemo(() => {
    if (!selected) return [];
    const node = nodeAt(items, selected);
    if (node && isFeedObject(node)) return node.articles ?? [];
    return [];
  }, [items, selected]);

  function startEdit(name: string | null) {
    if (name === null) {
      setEditing("__new__");
      setEditName("");
      setEditForm({ ...EMPTY_RULE });
    } else {
      setEditing(name);
      setEditName(name);
      const r = rules[name] ?? {};
      setEditForm({ ...EMPTY_RULE, ...r });
    }
  }

  async function saveRule() {
    const name = editName.trim();
    if (!name) {
      setRulesErr("Rule name is required");
      return;
    }
    const prevName = editing && editing !== "__new__" ? editing : null;
    // setRule keys on ruleName; a New-rule save with an existing name would
    // silently replace that rule.
    if (!prevName && Object.prototype.hasOwnProperty.call(rules, name)) {
      if (!window.confirm(`A rule named "${name}" already exists. Overwrite it?`)) return;
    }
    setBusy("rule:save");
    setRulesErr(null);
    try {
      const prev = prevName ? (rules[prevName] ?? {}) : {};
      // qB's setRule keys only on ruleName — editing the Name field without
      // renaming first would create a second rule and leave the old one.
      if (prevName && prevName !== name) {
        await qbPost("/api/qb/rss/renameRule", { ruleName: prevName, newRuleName: name });
      }
      const ruleDef: RuleDef = {
        ...prev,
        enabled: editForm.enabled ?? true,
        mustContain: editForm.mustContain ?? "",
        mustNotContain: editForm.mustNotContain ?? "",
        episodeFilter: editForm.episodeFilter ?? "",
        affectedFeeds: editForm.affectedFeeds ?? [],
        assignedCategory: editForm.assignedCategory ?? "",
        addPaused: editForm.addPaused ?? false,
      };
      await qbPost("/api/qb/rss/setRule", { ruleName: name, ruleDef: JSON.stringify(ruleDef) });
      // The matching-articles panel is a snapshot of the old definition.
      if (matchesFor === prevName || matchesFor === name) {
        setMatchesFor(null);
        setMatches(null);
      }
      setEditing(null);
      await loadRules();
    } catch (e) {
      if (!unauthorized(e)) setRulesErr(e instanceof Error ? e.message : "failed to save rule");
    } finally {
      setBusy(null);
    }
  }

  async function viewMatches(ruleName: string) {
    setBusy(`matches:${ruleName}`);
    setMatchesErr(null);
    try {
      const data = await apiFetch<Record<string, string[]>>(`/api/qb/rss/matchingArticles?ruleName=${encodeURIComponent(ruleName)}`);
      setMatches(data ?? {});
      setMatchesFor(ruleName);
    } catch (e) {
      if (!unauthorized(e)) setMatchesErr(e instanceof Error ? e.message : "failed to load matching articles");
    } finally {
      setBusy(null);
    }
  }

  const ruleNames = Object.keys(rules);

  return (
    <div className="vn-rss" style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight, overflowY: maxHeight ? "auto" : undefined }}>
      <style>{rssCss}</style>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button style={btnSm} disabled={loading} onClick={() => void loadItems()}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <button style={btnSm} onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          {paused ? "Resume auto-refresh" : "Pause auto-refresh"}
        </button>
        {paused && <span style={mutedText}>auto-refresh paused</span>}
      </div>
      {itemsErr && <p style={errText}>{itemsErr}</p>}

      <div className="vn-rss-cols" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        {/* Left: tree */}
        <div className="vn-rss-tree" style={{ flex: "1 1 280px", minWidth: 0, maxHeight, overflowY: "auto", border: `1px solid ${colors.border}`, borderRadius: 8, padding: 8 }}>
          <h4 style={sectionHeader}>Feeds</h4>
          {rows.length === 0 && !loading && <p style={emptyPara}>No feeds. Add a folder or feed below.</p>}
          {rows.map((r) => (
            <div key={r.path} style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: r.depth * 14, paddingTop: 2, paddingBottom: 2 }}>
              <button
                style={{
                  ...btnSm,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  textAlign: "left",
                  fontWeight: r.kind === "folder" ? 700 : 400,
                  borderColor: selected === r.path ? colors.accent : colors.borderStrong,
                }}
                title={r.path}
                onClick={() => setSelected(r.kind === "feed" ? r.path : null)}
              >
                {r.kind === "folder" ? "📁 " : "📰 "}
                {r.name}
              </button>
              {r.unread > 0 && (
                <span style={{ ...badgeBase, background: "#3b82f622", color: "#93c5fd", border: "1px solid #3b82f666" }}>{r.unread}</span>
              )}
              <span style={{ display: "flex", gap: 4 }}>
                <button
                  style={btnSm}
                  title={`Refresh ${r.path}`}
                  disabled={busy !== null}
                  onClick={() => void mutate(`refresh:${r.path}`, () => qbPost("/api/qb/rss/refreshItem", { itemPath: r.path }))}
                >
                  ⟳
                </button>
                <button
                  style={btnSm}
                  title={`Mark ${r.path} as read`}
                  disabled={busy !== null}
                  onClick={() => void mutate(`read:${r.path}`, () => qbPost("/api/qb/rss/markAsRead", { itemPath: r.path }))}
                >
                  ✓
                </button>
                <button
                  style={btnSm}
                  title={`Move ${r.path}`}
                  disabled={busy !== null}
                  onClick={() => {
                    const dest = window.prompt(`Move "${r.path}" to (new full path):`, r.path);
                    if (dest && dest !== r.path) {
                      void mutate(`move:${r.path}`, () => qbPost("/api/qb/rss/moveItem", { itemPath: r.path, destPath: dest }));
                    }
                  }}
                >
                  ⇄
                </button>
                <button
                  style={btnSm}
                  title={`Remove ${r.path}`}
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm(`Remove "${r.path}"?`)) {
                      const p = r.path;
                      if (selected === p) setSelected(null);
                      void mutate(`del:${p}`, () => qbPost("/api/qb/rss/removeItem", { path: p }));
                    }
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}

          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} placeholder="feed URL" aria-label="Feed URL" style={{ ...input, flex: 1, minWidth: 0 }} />
              <input value={feedPath} onChange={(e) => setFeedPath(e.target.value)} placeholder="path (optional)" aria-label="Feed path" style={{ ...input, flex: 1, minWidth: 0 }} />
              <button
                style={btnPrimary}
                disabled={busy !== null || !feedUrl.trim()}
                onClick={() =>
                  void mutate("addFeed", async () => {
                    const params: Record<string, string> = { url: feedUrl.trim() };
                    if (feedPath.trim()) params.path = feedPath.trim();
                    await qbPost("/api/qb/rss/addFeed", params);
                    setFeedUrl("");
                    setFeedPath("");
                  })
                }
              >
                {busy === "addFeed" ? "…" : "Add feed"}
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <input value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="folder path" aria-label="Folder path" style={{ ...input, flex: 1, minWidth: 0 }} />
              <button
                style={btn}
                disabled={busy !== null || !folderPath.trim()}
                onClick={() =>
                  void mutate("addFolder", async () => {
                    await qbPost("/api/qb/rss/addFolder", { path: folderPath.trim() });
                    setFolderPath("");
                  })
                }
              >
                {busy === "addFolder" ? "…" : "Add folder"}
              </button>
            </div>
          </div>
          {mutErr && <p style={errText}>{mutErr}</p>}
        </div>

        {/* Right: articles */}
        <div className="vn-rss-articles" style={{ flex: "2 1 360px", minWidth: 0, maxHeight, overflowY: "auto", border: `1px solid ${colors.border}`, borderRadius: 8, padding: 8 }}>
          <h4 style={sectionHeader}>{selected ? `Articles — ${selected}` : "Articles"}</h4>
          {!selected && <p style={emptyPara}>Select a feed to view its articles.</p>}
          {selected && selectedArticles.length === 0 && <p style={emptyPara}>No articles for this feed.</p>}
          {selectedArticles.map((a, i) => (
            <div key={a.id ?? `${a.title}-${i}`} style={{ padding: "6px 4px", borderBottom: `1px solid ${colors.border}` }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontSize: 13, fontWeight: a.isRead ? 400 : 700, color: a.isRead ? colors.muted : colors.text, flex: 1, minWidth: 0 }}>
                  {safeHttpUrl(a.link) ? (
                    <a href={safeHttpUrl(a.link) as string} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                      {a.title}
                    </a>
                  ) : (
                    a.title
                  )}
                </span>
                {!a.isRead && selected && (
                  <button
                    style={btnSm}
                    disabled={busy !== null || !a.id}
                    title={!a.id ? "This article has no id — use feed-level Mark read" : "Mark read"}
                    onClick={() =>
                      void mutate(`readArt:${a.id}`, () =>
                        qbPost("/api/qb/rss/markAsRead", a.id ? { itemPath: selected, articleId: a.id } : { itemPath: selected }),
                      )
                    }
                  >
                    Mark read
                  </button>
                )}
              </div>
              <div style={mutedText}>
                {[fmtFeedDate(a.date), a.author].filter(Boolean).join(" · ")}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Rules */}
      <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <h4 style={{ ...sectionHeader, marginBottom: 0 }}>Auto-download rules</h4>
          <button style={btnSm} onClick={() => void loadRules()}>
            Refresh rules
          </button>
          <button style={btnSm} onClick={() => startEdit(null)}>
            New rule
          </button>
        </div>
        {rulesErr && <p style={errText}>{rulesErr}</p>}
        {ruleNames.length === 0 && <p style={emptyPara}>No rules.</p>}
        {ruleNames.map((name) => (
          <div key={name} style={{ padding: "6px 4px", borderBottom: `1px solid ${colors.border}` }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 120 }}>{name}</span>
              <span style={mutedText}>{rules[name]?.enabled === false ? "disabled" : "enabled"}</span>
              <button style={btnSm} disabled={busy !== null} onClick={() => startEdit(name)}>
                Edit
              </button>
              <button
                style={btnSm}
                disabled={busy !== null}
                onClick={() => {
                  setRenameFor(name);
                  setRenameTo(name);
                }}
              >
                Rename
              </button>
              <button style={btnSm} disabled={busy !== null} onClick={() => void viewMatches(name)}>
                {busy === `matches:${name}` ? "…" : "Matches"}
              </button>
              <button
                style={btnSm}
                disabled={busy !== null}
                onClick={() => {
                  if (window.confirm(`Delete rule "${name}"?`)) {
                    setBusy(`delRule:${name}`);
                    setRulesErr(null);
                    qbPost("/api/qb/rss/removeRule", { ruleName: name })
                      .then(() => {
                        if (matchesFor === name) {
                          setMatchesFor(null);
                          setMatches(null);
                        }
                        if (renameFor === name) setRenameFor(null);
                        return loadRules();
                      })
                      .catch((e: unknown) => {
                        if (!unauthorized(e)) setRulesErr(e instanceof Error ? e.message : "failed to delete rule");
                      })
                      .finally(() => setBusy(null));
                  }
                }}
              >
                Delete
              </button>
            </div>
            {renameFor === name && (
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} placeholder="new rule name" aria-label="New rule name" style={{ ...input, flex: 1, minWidth: 0 }} />
                <button
                  style={btnSm}
                  disabled={busy !== null || !renameTo.trim()}
                  onClick={() => {
                    setBusy(`rename:${name}`);
                    setRulesErr(null);
                    qbPost("/api/qb/rss/renameRule", { ruleName: name, newRuleName: renameTo.trim() })
                      .then(() => {
                        if (matchesFor === name) {
                          setMatchesFor(null);
                          setMatches(null);
                        }
                        setRenameFor(null);
                        return loadRules();
                      })
                      .catch((e: unknown) => {
                        if (!unauthorized(e)) setRulesErr(e instanceof Error ? e.message : "failed to rename rule");
                      })
                      .finally(() => setBusy(null));
                  }}
                >
                  Apply
                </button>
                <button style={btnSm} onClick={() => setRenameFor(null)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}

        {editing !== null && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8, background: colors.panelAlt, borderRadius: 8, padding: 8 }}>
            <h4 style={{ ...sectionHeader, marginBottom: 0 }}>{editing === "__new__" ? "New rule" : `Edit rule — ${editing}`}</h4>
            <label style={labelCol}>
              Name
              <input value={editName} onChange={(e) => setEditName(e.target.value)} style={input} aria-label="Rule name" />
            </label>
            <label style={labelCol}>
              Must contain
              <input
                value={editForm.mustContain ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, mustContain: e.target.value }))}
                style={input}
                aria-label="Must contain"
              />
            </label>
            <label style={labelCol}>
              Must not contain
              <input
                value={editForm.mustNotContain ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, mustNotContain: e.target.value }))}
                style={input}
                aria-label="Must not contain"
              />
            </label>
            <label style={labelCol}>
              Episode filter
              <input
                value={editForm.episodeFilter ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, episodeFilter: e.target.value }))}
                style={input}
                aria-label="Episode filter"
                placeholder="e.g. 1x01-;"
              />
            </label>
            <label style={labelCol}>
              Affected feeds (feed URLs, comma-separated)
              <input
                value={(editForm.affectedFeeds ?? []).join(", ")}
                onChange={(e) =>
                  setEditForm((f) => ({
                    ...f,
                    affectedFeeds: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }))
                }
                style={input}
                aria-label="Affected feeds"
              />
            </label>
            <label style={labelCol}>
              Assigned category
              <input
                value={editForm.assignedCategory ?? ""}
                onChange={(e) => setEditForm((f) => ({ ...f, assignedCategory: e.target.value }))}
                style={input}
                aria-label="Assigned category"
              />
            </label>
            <label style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={editForm.addPaused ?? false}
                  onChange={(e) => setEditForm((f) => ({ ...f, addPaused: e.target.checked }))}
                  aria-label="Add paused"
                />
                Add paused
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={editForm.enabled ?? true}
                  onChange={(e) => setEditForm((f) => ({ ...f, enabled: e.target.checked }))}
                  aria-label="Rule enabled"
                />
                Enabled
              </span>
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={btnPrimary} disabled={busy !== null} onClick={() => void saveRule()}>
                {busy === "rule:save" ? "…" : "Save rule"}
              </button>
              <button style={btn} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {matchesFor !== null && (
          <div style={{ marginTop: 8 }}>
            <h4 style={sectionHeader}>Matching articles — {matchesFor}</h4>
            {matchesErr && <p style={errText}>{matchesErr}</p>}
            {matches !== null && Object.keys(matches).length === 0 && <p style={emptyPara}>No matching articles.</p>}
            {matches !== null &&
              Object.entries(matches).map(([feed, arts]) => (
                <div key={feed} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{feed}</div>
                  {arts.length === 0 && <p style={emptyPara}>No matches in this feed.</p>}
                  {arts.map((t) => (
                    <div key={t} style={{ fontSize: 13, color: colors.muted, paddingLeft: 12 }}>
                      {t}
                    </div>
                  ))}
                </div>
              ))}
            <button style={btnSm} onClick={() => setMatchesFor(null)}>
              Close matches
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const labelCol: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13 };
const emptyPara: React.CSSProperties = { ...mutedText, fontSize: 13, margin: "4px 0" };

/** Stack the tree/articles columns under 768px; desktop layout unchanged. */
const rssCss = `
@media (max-width: 768px) {
  .vn-rss .vn-rss-cols { flex-direction: column !important; align-items: stretch !important; }
  .vn-rss .vn-rss-tree, .vn-rss .vn-rss-articles { flex: 1 1 auto !important; max-height: none !important; }
  .vn-rss input:not([type="checkbox"]), .vn-rss select { font-size: 16px !important; min-height: 40px !important; }
  .vn-rss button { min-height: 40px !important; }
}
`;
