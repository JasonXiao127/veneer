import type { CSSProperties } from "react";

/** Shared dark-theme constants. Unifies the per-file inline styles — same palette, one source. */
export const colors = {
  bg: "#0b0e14",
  panel: "#111827",
  panelAlt: "#0f172a",
  zebra: "#0f1420",
  groupRow: "#111a2c",
  border: "#1f2937",
  borderStrong: "#374151",
  text: "#e5e7eb",
  muted: "#9ca3af",
  faint: "#6b7280",
  accent: "#3b82f6",
  accentDark: "#1d4ed8",
  danger: "#f87171",
  dangerSolid: "#ef4444",
  warn: "#f59e0b",
  ok: "#22c55e",
  okLight: "#4ade80",
  divider: "#4b5563",
  /** Row/card selection tint (translucent blue). */
  selection: "#1e3a8a33",
  /** Desktop row hover (solid, opaque over zebra). */
  hover: "#162032",
  /** Alt-speed ON state — intentionally distinct from accent. */
  altSpeed: "#7c3aed",
  /** Keyboard focus ring (lightened accent for contrast on bg). */
  focus: "#93c5fd",
  /** Text on saturated fills (alt-speed pill). */
  onFill: "#fff",
} as const;

/** Base button (BulkBar/App/SpeedBar/drawer/dialogs). */
export const btn: CSSProperties = {
  background: "#1f2937",
  color: "#e5e7eb",
  border: "1px solid #374151",
  borderRadius: 8,
  padding: "6px 10px",
  cursor: "pointer",
  fontSize: 13,
};

export const btnPrimary: CSSProperties = {
  ...btn,
  background: colors.accent,
  borderColor: colors.accent,
  color: "#fff",
  fontWeight: 600,
};

/** Compact button for dense rows (BulkBar secondary / drawer remove). */
export const btnSm: CSSProperties = {
  ...btn,
  padding: "3px 8px",
  fontSize: 12,
  borderRadius: 6,
  whiteSpace: "nowrap",
};

export const input: CSSProperties = {
  background: colors.bg,
  border: `1px solid ${colors.borderStrong}`,
  color: colors.text,
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 13,
};

/** Selects share the input style; separate export so call sites read clearly. */
export const select: CSSProperties = { ...input };

/** Field label used by dialogs + login (column layout). */
export const fieldLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 13,
};

/** Inline checkbox-row label variant. */
export const checkLabel: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
};

/* ----- badges / kind pills ----- */

export const badgeBase: CSSProperties = {
  display: "inline-block",
  borderRadius: 999,
  padding: "1px 9px",
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

export const badgePrivate: CSSProperties = {
  ...badgeBase,
  background: "#a855f722",
  color: "#d8b4fe",
  border: "1px solid #a855f766",
};

export const badgePublic: CSSProperties = {
  ...badgeBase,
  background: "#64748b22",
  color: "#a9bcd0",
  border: "1px solid #64748b66",
};

export const badgeUnknown: CSSProperties = {
  ...badgeBase,
  background: "transparent",
  color: colors.muted,
  border: `1px solid ${colors.divider}`,
};

/** Confidence dot colors for site attribution. */
export const confColor: Record<"high" | "medium" | "low", string> = {
  high: colors.ok,
  medium: colors.warn,
  low: colors.faint,
};

/* ----- modal / drawer ----- */

export const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 20,
};

export const card: CSSProperties = {
  width: 440,
  maxWidth: "92vw",
  maxHeight: "90vh",
  overflowY: "auto",
  background: colors.panel,
  color: colors.text,
  border: `1px solid ${colors.border}`,
  borderRadius: 12,
  padding: 18,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

/* ----- table ----- */

export const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
  color: colors.text,
};

export const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  color: colors.muted,
  fontWeight: 600,
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
  background: colors.bg,
  zIndex: 1,
};

export const td: CSSProperties = {
  padding: "7px 10px",
  whiteSpace: "nowrap",
  maxWidth: 420,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export const cellSm: CSSProperties = {
  padding: "6px 8px",
  borderBottom: `1px solid ${colors.panel}`,
  fontSize: 12,
  textAlign: "left",
};

/* ----- layout helpers ----- */

/** Single coherent filter/action row that wraps gracefully. */
export const toolbar: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "10px 16px",
  flexWrap: "wrap",
  alignItems: "center",
};

export const sectionHeader: CSSProperties = {
  fontSize: 12,
  color: colors.muted,
  marginBottom: 6,
};

export const dialogTitle: CSSProperties = { margin: 0 };

export const errText: CSSProperties = { color: colors.danger, fontSize: 13 };
export const warnText: CSSProperties = { color: colors.warn, fontSize: 12 };
export const mutedText: CSSProperties = { color: colors.muted, fontSize: 12 };
export const okText: CSSProperties = { color: colors.okLight, fontSize: 12 };
