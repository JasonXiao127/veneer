import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, fmtSize, qbPost } from "../lib/api";
import {
  btn,
  btnPrimary,
  btnSm,
  colors,
  errText,
  input,
  mutedText,
  okText,
  select,
  table,
  td,
  th,
} from "../lib/theme";

interface SearchJob {
  id: number;
  status: string;
  total: number;
}

interface SearchResult {
  descrLink: string;
  fileName: string;
  fileSize: number;
  fileUrl: string;
  nbLeechers: number;
  nbSeeders: number;
  siteUrl: string;
}

interface ResultsPayload {
  results: SearchResult[];
  status: string;
  total: number;
}

interface SearchPluginCategory {
  id: string;
  name: string;
}

interface SearchPlugin {
  enabled: boolean;
  fullName: string;
  name: string;
  supportedCategories: SearchPluginCategory[];
  url: string;
  version: string;
}

const PAGE_SIZE = 25;
const POLL_MS = 2000;

/**
 * Category is free-text, not a fixed enum: per the WebUI API docs the
 * available categories depend on the installed plugins ("all" is the only
 * guaranteed value). The datalist below offers common values seen in
 * plugin `supportedCategories` (anime/books/games/movies/music/tv/…).
 */
const COMMON_CATEGORIES = ["all", "anime", "books", "games", "movies", "music", "pictures", "software", "tv"];

function emitUnauthorized(e: unknown): boolean {
  if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
    window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
    return true;
  }
  return false;
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** Only http(s) links from server data are clickable — javascript:/data: XSS. */
export function safeHttpUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const t = u.trim();
  if (/^https?:\/\//i.test(t)) return t;
  return null;
}

/** qbPost returns raw text; search/start replies with JSON {"id": n}. */
function parseStartId(raw: string): number {
  const body = JSON.parse(raw) as { id?: unknown };
  if (typeof body?.id !== "number") throw new Error("unexpected response from search/start");
  return body.id;
}

export function SearchPanel({ maxHeight = "65vh" }: { maxHeight?: string }) {
  // New-search form
  const [pattern, setPattern] = useState("");
  const [category, setCategory] = useState("all");
  const [scope, setScope] = useState("enabled");
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);

  // Searches
  const [jobs, setJobs] = useState<SearchJob[]>([]);
  const [jobsErr, setJobsErr] = useState<string | null>(null);
  const [jobBusy, setJobBusy] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Results
  const [results, setResults] = useState<SearchResult[]>([]);
  const [resultsTotal, setResultsTotal] = useState(0);
  const [resultsStatus, setResultsStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [resultsErr, setResultsErr] = useState<string | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  // Plugins
  const [plugins, setPlugins] = useState<SearchPlugin[]>([]);
  const [pluginsErr, setPluginsErr] = useState<string | null>(null);
  const [pluginsUnavailable, setPluginsUnavailable] = useState(false);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const [sources, setSources] = useState("");

  async function fetchStatus(): Promise<SearchJob[] | null> {
    try {
      const data = await apiFetch<SearchJob[]>("/api/qb/search/status");
      const list = Array.isArray(data) ? data : [];
      setJobs(list);
      setJobsErr(null);
      return list;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        // Stop the poll loop; the app shell handles re-login.
        authDead.current = true;
        emitUnauthorized(e);
        setJobsErr("Session expired — please log in again");
        return null;
      }
      setJobsErr(errMsg(e, "status failed"));
      return null;
    }
  }

  async function fetchResults(id: number, off: number, silent = false): Promise<void> {
    // Sequence guard: a slow poll response must not overwrite a newer page.
    // Silent polls share the current sequence instead of bumping it, so they
    // cannot cancel an in-flight user page load.
    const seq = silent ? fetchSeq.current : ++fetchSeq.current;
    // Counter (not a boolean) so overlapping non-silent loads cannot leave
    // the spinner stuck when an older response loses the sequence race.
    if (!silent) {
      loadingCount.current++;
      setResultsLoading(true);
    }
    try {
      const data = await apiFetch<ResultsPayload>(
        `/api/qb/search/results?id=${id}&limit=${PAGE_SIZE}&offset=${off}`,
      );
      if (seq !== fetchSeq.current) return;
      // A poll that lands while a user page load is running must not replace
      // that page's result.
      if (silent && loadingCount.current > 0) return;
      setResults(Array.isArray(data.results) ? data.results : []);
      setResultsTotal(typeof data.total === "number" ? data.total : 0);
      setResultsStatus(typeof data.status === "string" ? data.status : "");
      setResultsErr(null);
    } catch (e) {
      if (seq !== fetchSeq.current) return;
      if (silent && loadingCount.current > 0) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        // Auth failure: stop polling (effect checks authDead) and surface once.
        authDead.current = true;
        emitUnauthorized(e);
        setResultsErr("Session expired — please log in again");
        return;
      }
      setResultsErr(errMsg(e, "results failed"));
    } finally {
      if (!silent) {
        loadingCount.current = Math.max(0, loadingCount.current - 1);
        if (loadingCount.current === 0) setResultsLoading(false);
      }
    }
  }

  async function fetchPlugins(): Promise<void> {
    setPluginsLoading(true);
    try {
      const data = await apiFetch<SearchPlugin[]>("/api/qb/search/plugins");
      setPlugins(Array.isArray(data) ? data : []);
      setPluginsErr(null);
      setPluginsUnavailable(false);
    } catch (e) {
      // Search plugins are optional in qB builds — 404 means unsupported,
      // not a failure. Show a note instead of an error.
      if (e instanceof ApiError && e.status === 404) {
        setPluginsUnavailable(true);
        setPluginsErr(null);
      } else {
        emitUnauthorized(e);
        setPluginsErr(errMsg(e, "plugins failed"));
      }
    } finally {
      setPluginsLoading(false);
    }
  }

  // Latest selection/offset for the poll loop (avoids stale closures).
  const selRef = useRef<{ id: number | null; offset: number }>({ id: null, offset: 0 });
  selRef.current = { id: selectedId, offset };
  const fetchSeq = useRef(0);
  const authDead = useRef(false);
  const loadingCount = useRef(0);
  const jobsRef = useRef<SearchJob[]>([]);
  jobsRef.current = jobs;

  // Initial status + plugin load; poll status every 2s only while a search runs.
  useEffect(() => {
    let cancelled = false;
    void fetchStatus();
    void fetchPlugins();
    const t = window.setInterval(() => {
      if (cancelled || authDead.current) return;
      // Idle backoff: nothing to watch unless a known search is running. The
      // initial load above still discovers externally-started searches.
      if (!jobsRef.current.some((j) => j.status === "Running")) return;
      void fetchStatus().then((list) => {
        if (cancelled || !list || authDead.current) return;
        if (!list.some((j) => j.status === "Running")) return;
        const sel = selRef.current;
        if (sel.id === null) return;
        const job = list.find((j) => j.id === sel.id);
        if (job && job.status === "Running") void fetchResults(sel.id, sel.offset, true);
      });
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
    // fetchStatus/fetchPlugins/fetchResults are stable-by-construction
    // (args + setState only); mount-only effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load results when the selection or page changes.
  useEffect(() => {
    if (selectedId === null) {
      setResults([]);
      setResultsTotal(0);
      setResultsStatus("");
      setResultsErr(null);
      return;
    }
    void fetchResults(selectedId, offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, offset]);

  async function startSearch() {
    const q = pattern.trim();
    if (!q) return;
    setStarting(true);
    setStartErr(null);
    try {
      const raw = await qbPost("/api/qb/search/start", {
        pattern: q,
        plugins: scope,
        category: category.trim() || "all",
      });
      const id = parseStartId(raw);
      setPattern("");
      setSelectedId(id);
      setOffset(0);
      await fetchStatus();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setStartErr("qB already has the maximum number of running searches (5). Stop one first.");
      } else {
        emitUnauthorized(e);
        setStartErr(errMsg(e, "start failed"));
      }
    } finally {
      setStarting(false);
    }
  }

  async function stopSearch(id: number) {
    setJobBusy(`stop-${id}`);
    setJobsErr(null);
    try {
      await qbPost("/api/qb/search/stop", { id: String(id) });
      await fetchStatus();
    } catch (e) {
      emitUnauthorized(e);
      setJobsErr(errMsg(e, "stop failed"));
    } finally {
      setJobBusy(null);
    }
  }

  async function deleteSearch(id: number) {
    if (!window.confirm(`Delete search #${id}?`)) return;
    setJobBusy(`del-${id}`);
    setJobsErr(null);
    try {
      await qbPost("/api/qb/search/delete", { id: String(id) });
      if (selectedId === id) {
        setSelectedId(null);
        setOffset(0);
      }
      await fetchStatus();
    } catch (e) {
      emitUnauthorized(e);
      setJobsErr(errMsg(e, "delete failed"));
    } finally {
      setJobBusy(null);
    }
  }

  async function downloadResult(r: SearchResult) {
    if (!r.fileUrl) return;
    if (!window.confirm(`Download "${r.fileName}"?`)) return;
    setDownloading(r.fileUrl);
    setDownloadMsg(null);
    setDownloadErr(null);
    try {
      // torrents/add expects multipart (see AddDialog) — qbPost's
      // urlencoded body is not reliable here, so post FormData directly.
      const form = new FormData();
      form.append("urls", r.fileUrl);
      const res = await fetch("/api/qb/torrents/add", { method: "POST", credentials: "same-origin", body: form });
      if (res.status === 401 || res.status === 403) {
        window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
        throw new Error("Session expired — please log in again");
      }
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `add failed (${res.status})`);
      setDownloadMsg(`Sent "${r.fileName}" to qBittorrent.`);
    } catch (e) {
      setDownloadErr(errMsg(e, "download failed"));
    } finally {
      setDownloading(null);
    }
  }

  async function togglePlugin(p: SearchPlugin) {
    setPluginBusy(p.name);
    setPluginsErr(null);
    try {
      await qbPost("/api/qb/search/enablePlugin", { names: p.name, enable: String(!p.enabled) });
      await fetchPlugins();
    } catch (e) {
      emitUnauthorized(e);
      setPluginsErr(errMsg(e, "toggle failed"));
    } finally {
      setPluginBusy(null);
    }
  }

  async function uninstallPlugin(p: SearchPlugin) {
    if (!window.confirm(`Uninstall search plugin "${p.name}"?`)) return;
    setPluginBusy(p.name);
    setPluginsErr(null);
    try {
      await qbPost("/api/qb/search/uninstallPlugin", { names: p.name });
      await fetchPlugins();
    } catch (e) {
      emitUnauthorized(e);
      setPluginsErr(errMsg(e, "uninstall failed"));
    } finally {
      setPluginBusy(null);
    }
  }

  async function installPlugins() {
    const s = sources.trim();
    if (!s) return;
    setPluginBusy("install");
    setPluginsErr(null);
    try {
      // Multiple sources are "|" separated per the API docs.
      await qbPost("/api/qb/search/installPlugin", { sources: s });
      setSources("");
      await fetchPlugins();
    } catch (e) {
      emitUnauthorized(e);
      setPluginsErr(errMsg(e, "install failed"));
    } finally {
      setPluginBusy(null);
    }
  }

  async function updatePlugins() {
    setPluginBusy("update");
    setPluginsErr(null);
    try {
      await qbPost("/api/qb/search/updatePlugins", {});
      await fetchPlugins();
    } catch (e) {
      emitUnauthorized(e);
      setPluginsErr(errMsg(e, "update failed"));
    } finally {
      setPluginBusy(null);
    }
  }

  const selectedJob = jobs.find((j) => j.id === selectedId) ?? null;
  const pageFrom = resultsTotal === 0 ? 0 : offset + 1;
  const pageTo = Math.min(offset + PAGE_SIZE, resultsTotal);

  return (
    <div className="vn-search" style={{ display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", maxHeight }}>
      <style>{searchMobileCss}</style>

      <section>
        <h3 style={{ margin: 0, fontSize: 14 }}>New search</h3>
        <div className="vn-search-bar" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <input
            aria-label="Search pattern"
            style={{ ...input, flex: "2 1 180px" }}
            placeholder="Pattern, e.g. Ubuntu 22.04"
            value={pattern}
            disabled={starting}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void startSearch();
            }}
          />
          <input
            aria-label="Category (default all; depends on plugins)"
            style={{ ...input, flex: "1 1 130px" }}
            placeholder="Category (all)"
            list="vn-search-cats"
            value={category}
            disabled={starting}
            onChange={(e) => setCategory(e.target.value)}
          />
          <datalist id="vn-search-cats">
            {COMMON_CATEGORIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <select
            aria-label="Plugin scope"
            style={{ ...select, flex: "0 1 auto" }}
            value={scope}
            disabled={starting}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="enabled">Enabled plugins</option>
            <option value="all">All plugins</option>
          </select>
          <button style={btnPrimary} disabled={starting || !pattern.trim()} onClick={() => void startSearch()}>
            {starting ? "Starting…" : "Start"}
          </button>
        </div>
        {startErr && <p style={errText}>{startErr}</p>}
      </section>

      <section>
        <h3 style={{ margin: 0, fontSize: 14 }}>Searches</h3>
        {jobsErr && <p style={errText}>{jobsErr}</p>}
        {jobs.length === 0 ? (
          <p style={mutedText}>No searches yet.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {jobs.map((j) => (
              <li
                key={j.id}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                  background: selectedId === j.id ? colors.selection : colors.panelAlt,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: "6px 10px",
                  fontSize: 13,
                }}
              >
                <button
                  style={btnSm}
                  title="Show results"
                  onClick={() => {
                    setSelectedId(j.id);
                    setOffset(0);
                  }}
                >
                  #{j.id}
                </button>
                <span
                  style={{
                    fontWeight: 600,
                    color: j.status === "Running" ? colors.okLight : colors.muted,
                  }}
                >
                  {j.status}
                </span>
                <span style={mutedText}>{j.total} result{j.total === 1 ? "" : "s"}</span>
                <span style={{ flex: 1 }} />
                {j.status === "Running" && (
                  <button style={btnSm} disabled={jobBusy === `stop-${j.id}`} onClick={() => void stopSearch(j.id)}>
                    Stop
                  </button>
                )}
                <button style={btnSm} disabled={jobBusy === `del-${j.id}`} onClick={() => void deleteSearch(j.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 style={{ margin: 0, fontSize: 14 }}>
          Results{selectedId !== null ? ` — #${selectedId}` : ""}
          {resultsStatus ? ` (${resultsStatus})` : ""}
        </h3>
        {selectedId === null ? (
          <p style={mutedText}>Select a search to view its results.</p>
        ) : (
          <>
            {resultsErr && (
              <p style={errText}>
                {resultsErr}{" "}
                {offset > 0 && (
                  <button style={btnSm} onClick={() => setOffset(0)}>
                    Back to first page
                  </button>
                )}
              </p>
            )}
            {downloadMsg && <p style={okText}>{downloadMsg}</p>}
            {downloadErr && <p style={errText}>{downloadErr}</p>}
            {!resultsLoading && results.length === 0 && !resultsErr ? (
              <p style={mutedText}>
                {selectedJob?.status === "Running" ? "No results yet — still searching…" : "No results."}
              </p>
            ) : (
              <div className="vn-search-table-wrap" style={{ overflowX: "auto" }}>
                <table style={table}>
                  <thead>
                    <tr>
                      <th style={th}>Name</th>
                      <th style={th}>Size</th>
                      <th style={th}>Seeders</th>
                      <th style={th}>Leechers</th>
                      <th style={th}>Site</th>
                      <th style={th}> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r, i) => (
                      <tr key={`${r.fileUrl}-${i}`} style={{ borderTop: `1px solid ${colors.border}` }}>
                        <td style={{ ...td, whiteSpace: "normal", minWidth: 200 }}>
                          {safeHttpUrl(r.descrLink) ? (
                            <a href={safeHttpUrl(r.descrLink) as string} target="_blank" rel="noreferrer" style={{ color: colors.text }}>
                              {r.fileName}
                            </a>
                          ) : (
                            r.fileName
                          )}
                        </td>
                        <td style={td}>{r.fileSize < 0 ? "unknown" : fmtSize(r.fileSize)}</td>
                        <td style={td}>{r.nbSeeders < 0 ? "—" : r.nbSeeders}</td>
                        <td style={td}>{r.nbLeechers < 0 ? "—" : r.nbLeechers}</td>
                        <td style={{ ...td, maxWidth: 180 }}>{r.siteUrl}</td>
                        <td style={td}>
                          <button
                            style={btnSm}
                            disabled={downloading === r.fileUrl || !r.fileUrl}
                            onClick={() => void downloadResult(r)}
                          >
                            {downloading === r.fileUrl ? "Sending…" : "Download"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
              <button style={btnSm} disabled={offset === 0 || resultsLoading} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>
                Prev
              </button>
              <button
                style={btnSm}
                disabled={resultsLoading || offset + PAGE_SIZE >= resultsTotal}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                Next
              </button>
              <span style={mutedText}>
                {pageFrom}–{pageTo} of {resultsTotal}
              </span>
              {resultsLoading && <span style={mutedText}>Loading…</span>}
            </div>
          </>
        )}
      </section>

      <section>
        <h3 style={{ margin: 0, fontSize: 14 }}>Search plugins</h3>
        {pluginsUnavailable ? (
          <p style={mutedText}>Search plugins unavailable on this qBittorrent build (search plugin support is optional).</p>
        ) : (
          <>
            {pluginsErr && <p style={errText}>{pluginsErr}</p>}
            {pluginsLoading && plugins.length === 0 ? (
              <p style={mutedText}>Loading plugins…</p>
            ) : plugins.length === 0 ? (
              <p style={mutedText}>No search plugins installed.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                {plugins.map((p) => (
                  <li
                    key={p.name}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      flexWrap: "wrap",
                      background: colors.panelAlt,
                      border: `1px solid ${colors.border}`,
                      borderRadius: 8,
                      padding: "6px 10px",
                      fontSize: 13,
                    }}
                  >
                    <strong style={{ color: colors.text }}>{p.fullName || p.name}</strong>
                    <span style={mutedText}>
                      {p.name} · v{p.version}
                    </span>
                    <span style={{ color: p.enabled ? colors.okLight : colors.faint, fontSize: 12 }}>
                      {p.enabled ? "enabled" : "disabled"}
                    </span>
                    <span style={{ flex: 1 }} />
                    <button style={btnSm} disabled={pluginBusy === p.name} onClick={() => void togglePlugin(p)}>
                      {p.enabled ? "Disable" : "Enable"}
                    </button>
                    <button style={btnSm} disabled={pluginBusy === p.name} onClick={() => void uninstallPlugin(p)}>
                      Uninstall
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="vn-search-bar" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
              <input
                aria-label="Plugin source URLs (| separated)"
                style={{ ...input, flex: "1 1 200px" }}
                placeholder="Plugin URL(s), | separated"
                value={sources}
                disabled={pluginBusy === "install"}
                onChange={(e) => setSources(e.target.value)}
              />
              <button style={btn} disabled={pluginBusy === "install" || !sources.trim()} onClick={() => void installPlugins()}>
                Install
              </button>
              <button style={btn} disabled={pluginBusy === "update"} onClick={() => void updatePlugins()}>
                Update all
              </button>
            </div>
            <p style={{ ...mutedText, margin: "6px 0 0" }}>Install accepts one or more plugin URLs separated by |.</p>
          </>
        )}
      </section>
    </div>
  );
}

const searchMobileCss = `
@media (max-width: 768px) {
  .vn-search .vn-search-bar {
    flex-direction: column !important;
    align-items: stretch !important;
  }
  .vn-search .vn-search-bar input,
  .vn-search .vn-search-bar select,
  .vn-search .vn-search-bar button {
    width: 100% !important;
    min-height: 40px !important;
    font-size: 16px !important;
  }
  .vn-search button {
    min-height: 40px !important;
  }
  .vn-search .vn-search-table-wrap {
    -webkit-overflow-scrolling: touch;
  }
}
`;
