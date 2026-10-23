import { useEffect, useMemo, useRef, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Row,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SiteInfo, Torrent } from "../types";
import { fmtEta, fmtSize, fmtSpeed } from "../lib/api";
import { classifyTorrent } from "../lib/sites";
import { prefetchTrackers } from "../hooks/useVisiblePrefetch";
import { badgePrivate, badgePublic, badgeUnknown, colors, confColor, input, select, table as tblStyle, td as tdStyle, th as thStyle, toolbar } from "../lib/theme";

type SiteOf = (t: Torrent) => SiteInfo;

const SORT_LABELS: Record<string, string> = {
  name: "Name",
  site: "Site",
  type: "Type",
  size: "Size",
  progress: "Progress",
  dlspeed: "DL speed",
  upspeed: "UL speed",
  eta: "ETA",
  state: "State",
  added_on: "Added",
  num_seeds: "Seeds",
  num_leechs: "Leeches",
  ratio: "Ratio",
};

const col = createColumnHelper<Torrent>();

/**
 * Fallback site attribution when no siteOf prop is provided. Delegates to the
 * canonical classifyTorrent so fallback and App-wired paths never diverge.
 */
function localSiteOf(t: Torrent): SiteInfo {
  return classifyTorrent({ tracker: t.tracker, isPrivate: t.isPrivate ?? null, private: t.private ?? null });
}

function normalizeSite(s: SiteInfo): SiteInfo {
  const site = typeof (s as Partial<SiteInfo>)?.site === "string" && (s as Partial<SiteInfo>).site!.trim()
    ? (s.site as string).trim()
    : (s?.siteDisplay?.trim() || "unknown");
  const siteDisplay = s?.siteDisplay?.trim() || site || "unknown";
  const kind: SiteInfo["kind"] = s?.kind === "private" || s?.kind === "public" ? s.kind : "unknown";
  const confidence: SiteInfo["confidence"] =
    s?.confidence === "high" || s?.confidence === "medium" ? s.confidence : "low";
  return { site, siteDisplay, kind, confidence };
}

function TypeBadge({ kind }: { kind: SiteInfo["kind"] }) {
  if (kind === "private") return <span style={badgePrivate}>private</span>;
  if (kind === "public") return <span style={badgePublic}>public</span>;
  return <span style={badgeUnknown}>unknown</span>;
}

/**
 * Mobile breakpoint hook (matchMedia-gated responsive rendering).
 * Desktop rendering never reads this — all mobile branches are conditional
 * on its return, so base (desktop) styles stay byte-identical in effect.
 */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 768px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

const NUMERIC = new Set(["size", "progress", "num_seeds", "num_leechs", "ratio", "dlspeed", "upspeed", "eta"]);

export function TorrentTable({
  torrents,
  selection,
  onSelection,
  onOpen,
  siteOf,
  loading,
  syncError,
  isV5,
}: {
  torrents: Torrent[];
  selection: string[];
  onSelection: (hashes: string[]) => void;
  onOpen: (t: Torrent) => void;
  siteOf?: SiteOf;
  loading?: boolean;
  /** Active sync failure: suppresses the misleading "no torrents yet" CTA. */
  syncError?: string | null;
  /** qB <5.0 reports pausedDL/pausedUP; 5.x reports stoppedDL/stoppedUP. */
  isV5?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [siteFilter, setSiteFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [groupBySite, setGroupBySite] = useState(false);
  // Deterministic secondary sort prevents row-jumping on live dlspeed/eta polls
  const [sorting, setSorting] = useState<SortingState>([{ id: "added_on", desc: true }]);
  // Responsive only: desktop path never reads this value.
  const isMobile = useIsMobile();

  const resolveSite = useMemo<(t: Torrent) => SiteInfo>(() => {
    if (siteOf) return (t) => normalizeSite(siteOf(t));
    return (t) => localSiteOf(t);
  }, [siteOf]);

  const siteCache = useMemo(() => {
    const m = new Map<string, SiteInfo>();
    for (const t of torrents) {
      if (!m.has(t.hash)) m.set(t.hash, resolveSite(t));
    }
    return m;
  }, [torrents, resolveSite]);

  const siteOfHash = (t: Torrent): SiteInfo =>
    siteCache.get(t.hash) ?? { site: "unknown", siteDisplay: "unknown", kind: "unknown", confidence: "low" };

  const siteOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of torrents) {
      const s = siteOfHash(t).siteDisplay;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [torrents, siteCache]);

  // A controlled <select> whose value no longer exists in its options renders
  // blank and leaves the filter stuck. Reset when the chosen site disappears.
  useEffect(() => {
    // Keep the filter across transient empty snapshots (logout/reset/reconnect);
    // only reset when the library is present and the chosen site is gone.
    if (siteFilter === "all" || torrents.length === 0) return;
    if (!siteOptions.some(([site]) => site === siteFilter)) setSiteFilter("all");
  }, [siteFilter, siteOptions, torrents.length]);

  const columns = useMemo(
    () => [
      col.display({ id: "select", header: () => null, cell: () => null }),
      col.accessor("name", {
        header: "Name",
        cell: (c) => <span title={String(c.getValue())}>{String(c.getValue())}</span>,
      }),
      col.accessor((t) => siteOfHash(t).siteDisplay, {
        id: "site",
        header: "Site",
        cell: (c) => {
          const info = siteOfHash(c.row.original);
          return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                title={`confidence: ${info.confidence}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: confColor[info.confidence],
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              {info.siteDisplay}
            </span>
          );
        },
      }),
      col.accessor((t) => siteOfHash(t).kind, {
        id: "type",
        header: "Type",
        cell: (c) => <TypeBadge kind={c.getValue() as SiteInfo["kind"]} />,
      }),
      col.accessor("size", { header: "Size", cell: (c) => fmtSize(c.getValue() as number) }),
      col.accessor("progress", {
        header: "%",
        cell: (c) => {
          const p = c.getValue();
          // null is a real "unknown" state; Number(null) would render 0.0%.
          if (typeof p !== "number" || !Number.isFinite(p)) return "—";
          return `${(Math.max(0, Math.min(1, p)) * 100).toFixed(1)}%`;
        },
      }),
      col.accessor("num_seeds", { header: "Seeds", cell: (c) => String(c.getValue() ?? 0) }),
      col.accessor("num_leechs", { header: "Leeches", cell: (c) => String(c.getValue() ?? 0) }),
      col.accessor("ratio", {
        header: "Ratio",
        // qB serializes unknown ratio as -1; official WebUI shows ∞ for that.
        cell: (c) => (typeof c.getValue() === "number" ? ((c.getValue() as number) < 0 ? "∞" : (c.getValue() as number).toFixed(2)) : "—"),
      }),
      col.accessor("dlspeed", { header: "DL", cell: (c) => fmtSpeed(c.getValue() as number) }),
      col.accessor("upspeed", { header: "UL", cell: (c) => fmtSpeed(c.getValue() as number) }),
      col.accessor("eta", { header: "ETA", cell: (c) => fmtEta(c.getValue() as number) }),
      col.accessor("state", { header: "State" }),
      col.accessor("added_on", {
        header: "Added",
        cell: (c) => {
          const v = c.getValue() as number;
          return v > 0 ? new Date(v * 1000).toLocaleDateString() : "—";
        },
      }),
      col.accessor("category", { header: "Cat" }),
      col.accessor("tags", { header: "Tags" }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [siteCache]
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return torrents.filter((t) => {
      if (stateFilter !== "all" && t.state !== stateFilter) return false;
      if (siteFilter !== "all" && siteOfHash(t).siteDisplay !== siteFilter) return false;
      if (typeFilter !== "all" && siteOfHash(t).kind !== typeFilter) return false;
      if (q && !String(t.name).toLowerCase().includes(q)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [torrents, query, stateFilter, siteFilter, typeFilter, siteCache]);

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.hash,
  });

  const sortedRows = table.getRowModel().rows;

  // Visible-row tracker prefetch (warms site attribution for drawer/cells).
  // Guarded: top-12 hash key only — speed/ETA polls mint new row objects
  // every 2s but the key stays stable, so no refetch storm. Debounced 250ms
  // and capped to 6 uncached hashes inside prefetchTrackers.
  const visibleHashKey = useMemo(
    () => sortedRows.slice(0, 12).map((r) => r.original.hash).join(","),
    [sortedRows],
  );
  useEffect(() => {
    if (!visibleHashKey) return;
    const hashes = visibleHashKey.split(",").filter(Boolean);
    if (hashes.length === 0) return;
    const t = setTimeout(() => prefetchTrackers(hashes, 6), 250);
    return () => clearTimeout(t);
  }, [visibleHashKey]);

  type Item =
    | { kind: "row"; row: Row<Torrent> }
    | {
        kind: "header";
        site: string;
        count: number;
        dl: number;
        ul: number;
        avgRatio: number | null;
      };

  const items = useMemo<Item[]>(() => {
    if (!groupBySite) return sortedRows.map((row) => ({ kind: "row" as const, row }));
    const groups = new Map<string, Row<Torrent>[]>();
    for (const r of sortedRows) {
      const s = siteOfHash(r.original).siteDisplay;
      const g = groups.get(s);
      if (g) g.push(r);
      else groups.set(s, [r]);
    }
    const out: Item[] = [];
    for (const [site, rows] of groups) {
      let dl = 0,
        ul = 0,
        ratioSum = 0,
        ratioN = 0;
      for (const r of rows) {
        dl += Number(r.original.dlspeed ?? 0);
        ul += Number(r.original.upspeed ?? 0);
        if (typeof r.original.ratio === "number" && r.original.ratio >= 0) {
          ratioSum += r.original.ratio;
          ratioN++;
        }
      }
      out.push({ kind: "header", site, count: rows.length, dl, ul, avgRatio: ratioN ? ratioSum / ratioN : null });
      for (const row of rows) out.push({ kind: "row", row });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedRows, groupBySite, siteCache]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 20,
  });
  // Mobile card list is virtualized too (headers ~44px, cards ~150px) so
  // large libraries don't mount thousands of cards on phones.
  const mobileVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index]?.kind === "header" ? 44 : 150),
    overscan: 8,
  });
  // Only compute the active branch's window: with one scroll container mounted,
  // the idle virtualizer has no scroll element and would otherwise walk the
  // full item list every render.
  const virtuals = isMobile ? [] : virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const padTop = virtuals.length > 0 ? virtuals[0].start : 0;
  const padBottom = virtuals.length > 0 ? totalSize - virtuals[virtuals.length - 1].end : 0;
  const mobileVirtuals = isMobile ? mobileVirtualizer.getVirtualItems() : [];
  const mobileTotal = mobileVirtualizer.getTotalSize();
  const mPadTop = mobileVirtuals.length > 0 ? mobileVirtuals[0].start : 0;
  const mPadBottom = mobileVirtuals.length > 0 ? mobileTotal - mobileVirtuals[mobileVirtuals.length - 1].end : 0;

  const sel = new Set(selection);
  const colSpan = columns.length;

  const emptyHint =
    loading === true ? (
      <p style={{ color: colors.muted, fontSize: 13, padding: "12px 16px" }}>Loading torrents…</p>
    ) : torrents.length === 0 && syncError ? (
      <p style={{ color: colors.muted, fontSize: 13, padding: "12px 16px" }}>Couldn't load torrents — check the connection above.</p>
    ) : torrents.length === 0 ? (
      <p style={{ color: colors.muted, fontSize: 13, padding: "12px 16px" }}>No torrents yet — add one with + Add.</p>
    ) : (
      <p style={{ color: colors.muted, fontSize: 13, padding: "12px 16px" }}>No torrents match the filters.</p>
    );

  // Keyboard access: rows/cards are focusable (Enter/Space opens). Guard the
  // event target: Space/Enter on an INNER control (row checkbox, card
  // checkbox) must only drive that control — without this, Space both
  // toggles selection and opens the drawer.
  const openOnKey = (t: Torrent) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target as HTMLElement | null;
    if (el && ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(el.tagName)) return;
    e.preventDefault();
    onOpen(t);
  };

  const toggle = (hash: string, checked: boolean) => {
    onSelection(checked ? [...selection, hash] : selection.filter((x) => x !== hash));
  };

  return (
    <div>
      <div style={isMobile ? { ...toolbar, flexDirection: "column", alignItems: "stretch" } : toolbar}>
        <input
          placeholder="Filter by name…"
          aria-label="Filter by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={isMobile ? { ...input, width: "100%", boxSizing: "border-box" } : input}
        />
        <select aria-label="Filter by state" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} style={isMobile ? { ...select, width: "100%", boxSizing: "border-box" } : select}>
          <option value="all">all states</option>
          <option value="downloading">downloading</option>
          <option value="uploading">uploading</option>
          <option value="stalledDL">stalledDL</option>
          <option value="stalledUP">stalledUP</option>
          {isV5 === false ? (
            <>
              <option value="pausedDL">pausedDL</option>
              <option value="pausedUP">pausedUP</option>
            </>
          ) : (
            <>
              <option value="stoppedDL">stoppedDL</option>
              <option value="stoppedUP">stoppedUP</option>
            </>
          )}
          <option value="queuedDL">queuedDL</option>
          <option value="queuedUP">queuedUP</option>
          <option value="checkingDL">checkingDL</option>
          <option value="checkingUP">checkingUP</option>
          <option value="error">error</option>
        </select>
        <select aria-label="Filter by site" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} style={isMobile ? { ...select, width: "100%", boxSizing: "border-box" } : select}>
          <option value="all">all sites</option>
          {siteOptions.map(([site, n]) => (
            <option key={site} value={site}>
              {site} ({n})
            </option>
          ))}
        </select>
        <select aria-label="Filter by type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={isMobile ? { ...select, width: "100%", boxSizing: "border-box" } : select}>
          <option value="all">all types</option>
          <option value="private">private</option>
          <option value="public">public</option>
          <option value="unknown">unknown</option>
        </select>
        <label style={isMobile ? { display: "inline-flex", alignItems: "center", gap: 6, color: colors.text, fontSize: 13, minHeight: 44 } : { display: "inline-flex", alignItems: "center", gap: 6, color: colors.text, fontSize: 13 }}>
          <input type="checkbox" checked={groupBySite} onChange={(e) => setGroupBySite(e.target.checked)} style={isMobile ? { width: 22, height: 22 } : undefined} />
          Group by site
        </label>
        {isMobile && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <select
              aria-label="Sort by"
              value={sorting[0]?.id ?? "added_on"}
              onChange={(e) => setSorting([{ id: e.target.value, desc: sorting[0]?.desc ?? true }])}
              style={{ ...select, flex: 1, minHeight: 44, boxSizing: "border-box" }}
            >
              {["name", "site", "type", "size", "progress", "dlspeed", "upspeed", "eta", "state", "added_on", "num_seeds", "num_leechs", "ratio"].map((id) => (
                <option key={id} value={id}>{SORT_LABELS[id] ?? id}</option>
              ))}
            </select>
            <button
              aria-label={sorting[0]?.desc ? "Sort ascending" : "Sort descending"}
              onClick={() => setSorting([{ id: sorting[0]?.id ?? "added_on", desc: !(sorting[0]?.desc ?? true) }])}
              style={{ ...select, minHeight: 44, minWidth: 48, cursor: "pointer" }}
            >
              {sorting[0]?.desc ? "↓" : "↑"}
            </button>
          </span>
        )}
        <span style={isMobile ? { color: colors.muted, fontSize: 12, alignSelf: "flex-start" } : { marginLeft: "auto", color: colors.muted, fontSize: 12, alignSelf: "center" }}>
          showing {filtered.length} of {torrents.length} torrents
        </span>
      </div>
      {isMobile ? (
        <div ref={scrollRef} style={{ overflow: "auto", maxHeight: "65vh", padding: "0 12px 12px" }}>
          {mPadTop > 0 && <div style={{ height: mPadTop }} />}
          {mobileVirtuals.map((v) => {
            const item = items[v.index];
            if (!item) return null;
            if (item.kind === "header") {
              return (
                <div key={`g-${item.site}`} data-index={v.index} ref={mobileVirtualizer.measureElement} style={{ background: colors.groupRow, borderTop: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: "8px 12px", fontWeight: 700, color: colors.text, fontSize: 13, marginBottom: 8 }}>
                  {item.site}
                  <span style={{ color: colors.muted, fontWeight: 400, marginLeft: 8 }}>
                    {item.count} · ↓ {fmtSpeed(item.dl)} · ↑ {fmtSpeed(item.ul)} · avg ratio{" "}
                    {item.avgRatio == null ? "—" : item.avgRatio.toFixed(2)}
                  </span>
                </div>
              );
            }
            const t = item.row.original;
            const info = siteOfHash(t);
            const pct = Math.max(0, Math.min(1, Number(t.progress ?? 0)));
            const selected = sel.has(t.hash);
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={mobileVirtualizer.measureElement}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(t)}
                onKeyDown={openOnKey(t)}
                aria-label={`${String(t.name)} — ${String(t.state ?? "unknown")}`}
                style={{
                  background: selected ? colors.selection : colors.panel,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 10,
                  padding: 12,
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  cursor: "pointer",
                  marginBottom: 8,
                }}
              >
                <span
                  onClick={(e) => {
                    // Whole 44px target toggles; the input's own click is
                    // stopPropagation'd below so it never double-toggles.
                    e.stopPropagation();
                    toggle(t.hash, !selected);
                  }}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44, flexShrink: 0, margin: -8 }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${t.name}`}
                    checked={selected}
                    onChange={(e) => toggle(t.hash, e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: 22, height: 22 }}
                  />
                </span>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ color: colors.text, fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }} title={String(t.name)}>
                    {String(t.name)}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: colors.muted, fontSize: 12 }}>
                      <span
                        title={`confidence: ${info.confidence}`}
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: confColor[info.confidence],
                          display: "inline-block",
                          flexShrink: 0,
                        }}
                      />
                      {info.siteDisplay}
                    </span>
                    <TypeBadge kind={info.kind} />
                  </div>
                  <div style={{ height: 6, borderRadius: 999, background: colors.border, overflow: "hidden" }} title={`${(pct * 100).toFixed(1)}%`}>
                    <div style={{ width: `${(pct * 100).toFixed(1)}%`, height: "100%", background: colors.accent }} />
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", color: colors.muted, fontSize: 12 }}>
                    <span>{(pct * 100).toFixed(1)}%</span>
                    <span>{String(t.state ?? "—")}</span>
                    <span>↓ {fmtSpeed(Number(t.dlspeed ?? 0))}</span>
                    <span>↑ {fmtSpeed(Number(t.upspeed ?? 0))}</span>
                    <span>{fmtSize(Number(t.size ?? 0))}</span>
                    <span>ETA {fmtEta(Number(t.eta ?? -1))}</span>
                  </div>
                </div>
              </div>
            );
          })}
          {mPadBottom > 0 && <div style={{ height: mPadBottom }} />}
          {items.length === 0 && emptyHint}
        </div>
      ) : (
      <div ref={scrollRef} style={{ overflow: "auto", maxHeight: "65vh" }}>
        <table style={tblStyle}>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h, i) => (
                  <th
                    key={h.id}
                    style={{
                      ...thStyle,
                      cursor: h.id === "select" ? undefined : "pointer",
                      textAlign: i === 0 ? "left" : NUMERIC.has(h.id) ? "right" : "left",
                    }}
                    onClick={h.id === "select" ? undefined : h.column.getToggleSortingHandler()}
                    aria-sort={
                      h.id === "select" || h.column.getIsSorted() === false
                        ? undefined
                        : h.column.getIsSorted() === "asc"
                          ? "ascending"
                          : "descending"
                    }
                  >
                    {i === 0
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                    {h.column.getIsSorted() === "asc" ? " ▲" : h.column.getIsSorted() === "desc" ? " ▼" : ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr>
                <td colSpan={colSpan} style={{ height: padTop, padding: 0, border: 0 }} />
              </tr>
            )}
            {virtuals.map((v) => {
              const item = items[v.index];
              if (!item) return null;
              if (item.kind === "header") {
                return (
                  <tr key={`g-${item.site}`} style={{ background: colors.groupRow, borderTop: `1px solid ${colors.borderStrong}` }}>
                    <td colSpan={colSpan} style={{ ...tdStyle, fontWeight: 700, color: colors.text }}>
                      {item.site}
                      <span style={{ color: colors.muted, fontWeight: 400, marginLeft: 8 }}>
                        {item.count} · ↓ {fmtSpeed(item.dl)} · ↑ {fmtSpeed(item.ul)} · avg ratio{" "}
                        {item.avgRatio == null ? "—" : item.avgRatio.toFixed(2)}
                      </span>
                    </td>
                  </tr>
                );
              }
              const r = item.row;
              const zebra = v.index % 2 === 1;
              const selected = sel.has(r.original.hash);
              return (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => onOpen(r.original)}
                  onKeyDown={openOnKey(r.original)}
                  aria-label={`${String(r.original.name)} — ${String(r.original.state ?? "unknown")}`}
                  style={{
                    borderTop: `1px solid ${colors.border}`,
                    background: selected ? colors.selection : zebra ? colors.zebra : undefined,
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    if (!sel.has(r.original.hash)) (e.currentTarget as HTMLTableRowElement).style.background = colors.hover;
                  }}
                  onMouseLeave={(e) => {
                    if (!sel.has(r.original.hash)) (e.currentTarget as HTMLTableRowElement).style.background = zebra ? colors.zebra : "";
                  }}
                >
                  <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={sel.has(r.original.hash)}
                      onChange={(e) => toggle(r.original.hash, e.target.checked)}
                    />
                  </td>
                  {r.getVisibleCells().slice(1).map((c) => (
                    <td
                      key={c.id}
                      style={{ ...tdStyle, textAlign: NUMERIC.has(c.column.id) ? "right" : "left" }}
                    >
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr>
                <td colSpan={colSpan} style={{ height: padBottom, padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
        {items.length === 0 && emptyHint}
      </div>
      )}
    </div>
  );
}
