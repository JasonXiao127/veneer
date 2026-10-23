import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch } from "../lib/api";
import { DEFAULT_PRESETS, type SeedPreset } from "../lib/seedPresets";
import { trackerDomain } from "../lib/sites";
import {
  badgePrivate,
  badgePublic,
  badgeUnknown,
  btn,
  btnPrimary,
  btnSm,
  cellSm,
  checkLabel,
  colors,
  errText,
  fieldLabel,
  input,
  mutedText,
  okText,
  sectionHeader,
  select,
  table,
  th,
  warnText,
} from "../lib/theme";

interface Rule {
  id: string;
  label: string;
  match: { kind?: "private" | "public"; site?: string };
  ratioLimit: number;
  seedingTimeLimit: number;
  inactiveSeedingTimeLimit: number;
  enabled: boolean;
}

interface StatusEntry {
  hash: string;
  site: string;
  kind: string;
  ruleId: string | null;
  compliant: { ratioOk: boolean; timeOk: boolean; inactiveOk: boolean };
}

interface ApplyResult {
  applied: number;
  skipped: number;
  failed: number;
}

function isCompliant(s: StatusEntry): boolean {
  return s.compliant.ratioOk && s.compliant.timeOk && s.compliant.inactiveOk;
}

const NON_COMPLIANT_SHOWN = 10;

function emitUnauthorized(): void {
  window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
}

function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}

function presetToRule(p: SeedPreset): Rule {
  return {
    id: p.id,
    label: p.label,
    match: { ...p.match },
    ratioLimit: p.ratioLimit,
    seedingTimeLimit: p.seedingTimeLimit,
    inactiveSeedingTimeLimit: p.inactiveSeedingTimeLimit,
    enabled: true,
  };
}

function matchText(m: Rule["match"]): string {
  const parts: string[] = [];
  parts.push(m.kind ?? "any");
  if (m.site) parts.push(m.site);
  return parts.join(" · ");
}

function fmtLimit(v: number): string {
  if (v === -2) return "global";
  if (v === -1) return "∞";
  return String(v);
}

interface Draft {
  label: string;
  kind: "any" | "private" | "public";
  site: string;
  ratioLimit: string;
  seedingTimeLimit: string;
  inactiveSeedingTimeLimit: string;
  enabled: boolean;
}

function draftFromRule(r: Rule): Draft {
  return {
    label: r.label,
    kind: r.match.kind ?? "any",
    site: r.match.site ?? "",
    ratioLimit: String(r.ratioLimit),
    seedingTimeLimit: String(r.seedingTimeLimit),
    inactiveSeedingTimeLimit: String(r.inactiveSeedingTimeLimit),
    enabled: r.enabled,
  };
}

function draftToRule(d: Draft, id: string): { rule?: Rule; error?: string } {
  if (d.label.trim() === "") return { error: "Label is required." };
  const num = (raw: string, name: string, integer: boolean): { v?: number; error?: string } => {
    const t = raw.trim();
    const v = Number(t);
    if (t === "" || !Number.isFinite(v)) return { error: `${name} must be a number (-2 = use global, -1 = no limit).` };
    // Match the backend domain so the user gets a field error, not a 400.
    if (v !== -2 && v !== -1 && !(v >= 0)) {
      return { error: `${name} must be -2 (use global), -1 (no limit), or >= 0.` };
    }
    if (integer && v !== -2 && v !== -1 && !Number.isInteger(v)) {
      return { error: `${name} must be a whole number of minutes.` };
    }
    return { v };
  };
  const ratio = num(d.ratioLimit, "Ratio limit", false);
  if (ratio.error) return { error: ratio.error };
  const seed = num(d.seedingTimeLimit, "Seeding time", true);
  if (seed.error) return { error: seed.error };
  const inactive = num(d.inactiveSeedingTimeLimit, "Inactive seeding time", true);
  if (inactive.error) return { error: inactive.error };
  const rawSite = d.site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.+$/, "");
  if (rawSite === "unknown") return { error: 'Site "unknown" never matches — leave it blank for a global rule.' };
  const site = rawSite === "" ? "" : trackerDomain(rawSite);
  if (site !== "" && !/^[a-z0-9.-]+$/.test(site)) {
    return { error: "Site must be a hostname like example.com." };
  }
  return {
    rule: {
      id,
      label: d.label.trim(),
      match: { ...(d.kind !== "any" ? { kind: d.kind } : {}), ...(site ? { site } : {}) },
      ratioLimit: ratio.v!,
      seedingTimeLimit: seed.v!,
      inactiveSeedingTimeLimit: inactive.v!,
      enabled: d.enabled,
    },
  };
}

export function RulesPanel({ maxHeight }: { maxHeight?: number | string }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<StatusEntry[]>([]);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [applying, setApplying] = useState(false);

  const loadRules = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await apiFetch<{ rules: Rule[] }>("/api/rules");
      setRules(Array.isArray(res.rules) ? res.rules : []);
    } catch (e) {
      if (isAuthError(e)) emitUnauthorized();
      setErr(e instanceof Error ? e.message : "failed to load rules");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusErr(null);
    try {
      const res = await apiFetch<{ torrents: StatusEntry[] }>("/api/rules/status");
      setStatus(Array.isArray(res.torrents) ? res.torrents : []);
    } catch (e) {
      if (isAuthError(e)) emitUnauthorized();
      setStatusErr(e instanceof Error ? e.message : "failed to load status");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function persist(next: Rule[]): Promise<boolean> {
    setSaving(true);
    setErr(null);
    try {
      const res = await apiFetch<{ rules: Rule[] }>("/api/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: next }),
      });
      setRules(Array.isArray(res.rules) ? res.rules : next);
      return true;
    } catch (e) {
      if (isAuthError(e)) emitUnauthorized();
      setErr(e instanceof Error ? e.message : "failed to save rules");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function openAdd(): void {
    const p = DEFAULT_PRESETS[0];
    setDraft({
      label: "",
      kind: "any",
      site: "",
      ratioLimit: String(p.ratioLimit),
      seedingTimeLimit: String(p.seedingTimeLimit),
      inactiveSeedingTimeLimit: String(p.inactiveSeedingTimeLimit),
      enabled: true,
    });
    setEditingId(null);
    setFormErr(null);
    setShowForm(true);
  }

  function openEdit(r: Rule): void {
    setDraft(draftFromRule(r));
    setEditingId(r.id);
    setFormErr(null);
    setShowForm(true);
  }

  async function saveForm(): Promise<void> {
    if (!draft) return;
    const id = editingId ?? `rule-${Date.now().toString(36)}`;
    const parsed = draftToRule(draft, id);
    if (parsed.error || !parsed.rule) {
      setFormErr(parsed.error ?? "invalid rule");
      return;
    }
    const next =
      editingId === null ? [...rules, parsed.rule] : rules.map((r) => (r.id === editingId ? parsed.rule! : r));
    const ok = await persist(next);
    if (ok) {
      setShowForm(false);
      setDraft(null);
      setEditingId(null);
    }
  }

  async function toggleEnabled(r: Rule): Promise<void> {
    await persist(rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)));
  }

  async function deleteRule(r: Rule): Promise<void> {
    if (!window.confirm(`Delete rule "${r.label}"?`)) return;
    await persist(rules.filter((x) => x.id !== r.id));
  }

  async function resetDefaults(): Promise<void> {
    if (!window.confirm("Replace all rules with the seed-preset defaults?")) return;
    await persist(DEFAULT_PRESETS.map(presetToRule));
  }

  async function applyNow(): Promise<void> {
    setApplying(true);
    setErr(null);
    setApplyResult(null);
    try {
      const res = await apiFetch<ApplyResult>("/api/rules/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      setApplyResult({ applied: res.applied, skipped: res.skipped, failed: res.failed ?? 0 });
      void loadStatus();
    } catch (e) {
      if (isAuthError(e)) emitUnauthorized();
      setErr(e instanceof Error ? e.message : "apply failed");
    } finally {
      setApplying(false);
    }
  }

  const bySite = new Map<string, { total: number; bad: number }>();
  for (const s of status) {
    const e = bySite.get(s.site) ?? { total: 0, bad: 0 };
    e.total++;
    if (!isCompliant(s)) e.bad++;
    bySite.set(s.site, e);
  }
  const nonCompliant = status.filter((s) => !isCompliant(s));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight, overflowY: maxHeight ? "auto" : undefined }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Seed rules</h3>
        <span style={{ ...mutedText, flex: 1 }}>Auto-enforce checks every few minutes while sessions are active.</span>
        <button style={btnSm} disabled={saving || applying} onClick={() => void applyNow()} title="Enforce enabled rules on all torrents now">
          {applying ? "Applying…" : "Apply now"}
        </button>
        <button style={btnSm} disabled={saving} onClick={openAdd}>
          Add rule
        </button>
        <button style={btnSm} disabled={saving} onClick={() => void resetDefaults()} title="Replace all rules with the seed-preset defaults">
          Reset to defaults
        </button>
      </div>

      {err && <p style={errText}>{err}</p>}
      {applyResult && (
        <p style={applyResult.failed > 0 ? errText : okText}>
          Applied {applyResult.applied}, skipped {applyResult.skipped}
          {applyResult.failed > 0 ? `, ${applyResult.failed} failed — retry or check qB.` : "."}
        </p>
      )}

      {loading ? (
        <p style={mutedText}>Loading rules…</p>
      ) : rules.length === 0 ? (
        <p style={mutedText}>No rules yet. Add one, or reset to the seed-preset defaults.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Rule</th>
                <th style={th}>Match</th>
                <th style={th}>Ratio</th>
                <th style={th}>Seed time (min)</th>
                <th style={th}>Inactive (min)</th>
                <th style={th}>On</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td style={cellSm}>{r.label}</td>
                  <td style={cellSm}>
                    <span style={r.match.kind === "private" ? badgePrivate : r.match.kind === "public" ? badgePublic : badgeUnknown}>
                      {matchText(r.match)}
                    </span>
                  </td>
                  <td style={cellSm}>{fmtLimit(r.ratioLimit)}</td>
                  <td style={cellSm}>{fmtLimit(r.seedingTimeLimit)}</td>
                  <td style={cellSm}>{fmtLimit(r.inactiveSeedingTimeLimit)}</td>
                  <td style={cellSm}>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      disabled={saving}
                      onChange={() => void toggleEnabled(r)}
                      aria-label={`Enable rule ${r.label}`}
                    />
                  </td>
                  <td style={cellSm}>
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button style={btnSm} disabled={saving} onClick={() => openEdit(r)}>
                        Edit
                      </button>
                      <button style={btnSm} disabled={saving} onClick={() => void deleteRule(r)}>
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && draft && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <h4 style={{ ...sectionHeader, fontSize: 13, margin: 0 }}>{editingId === null ? "Add rule" : "Edit rule"}</h4>
          <label style={fieldLabel}>
            Label
            <input style={input} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. Private default" aria-label="Rule label" />
          </label>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ ...fieldLabel, flex: "1 1 140px" }}>
              Kind
              <select
                style={select}
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft["kind"] })}
                aria-label="Match kind"
              >
                <option value="any">any</option>
                <option value="private">private</option>
                <option value="public">public</option>
              </select>
            </label>
            <label style={{ ...fieldLabel, flex: "2 1 180px" }}>
              Site (optional, e.g. example.com)
              <input
                style={input}
                value={draft.site}
                onChange={(e) => setDraft({ ...draft, site: e.target.value })}
                placeholder="leave empty to match any site"
                aria-label="Match site"
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ ...fieldLabel, flex: "1 1 140px" }}>
              Ratio limit
              <input
                style={input}
                value={draft.ratioLimit}
                onChange={(e) => setDraft({ ...draft, ratioLimit: e.target.value })}
                inputMode="decimal"
                aria-label="Ratio limit"
              />
            </label>
            <label style={{ ...fieldLabel, flex: "1 1 140px" }}>
              Seeding time (min)
              <input
                style={input}
                value={draft.seedingTimeLimit}
                onChange={(e) => setDraft({ ...draft, seedingTimeLimit: e.target.value })}
                inputMode="numeric"
                aria-label="Seeding time limit in minutes"
              />
            </label>
            <label style={{ ...fieldLabel, flex: "1 1 140px" }}>
              Inactive (min)
              <input
                style={input}
                value={draft.inactiveSeedingTimeLimit}
                onChange={(e) => setDraft({ ...draft, inactiveSeedingTimeLimit: e.target.value })}
                inputMode="numeric"
                aria-label="Inactive seeding time limit in minutes"
              />
            </label>
          </div>
          <p style={mutedText}>Limits: -2 = use global qB setting, -1 = no limit. Times are in minutes.</p>
          <label style={checkLabel}>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Enabled
          </label>
          {formErr && <p style={errText}>{formErr}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              style={btn}
              onClick={() => {
                setShowForm(false);
                setDraft(null);
                setEditingId(null);
              }}
            >
              Cancel
            </button>
            <button style={btnPrimary} disabled={saving} onClick={() => void saveForm()}>
              {saving ? "Saving…" : "Save rule"}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Compliance</h3>
        <button style={btnSm} disabled={statusLoading} onClick={() => void loadStatus()}>
          {statusLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {statusErr && <p style={errText}>{statusErr}</p>}
      {!statusErr && !statusLoading && status.length === 0 && <p style={mutedText}>No torrents.</p>}
      {bySite.size > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[...bySite.entries()].map(([site, c]) => (
            <span
              key={site}
              style={{
                border: `1px solid ${c.bad > 0 ? colors.warn : colors.border}`,
                borderRadius: 8,
                padding: "4px 10px",
                fontSize: 12,
                color: colors.text,
              }}
            >
              {site}: {c.total - c.bad}/{c.total} compliant
            </span>
          ))}
        </div>
      )}
      {nonCompliant.length > 0 && (
        <div>
          <p style={warnText}>
            {nonCompliant.length} non-compliant torrent{nonCompliant.length === 1 ? "" : "s"}
            {nonCompliant.length > NON_COMPLIANT_SHOWN ? ` (first ${NON_COMPLIANT_SHOWN} shown)` : ""}:
          </p>
          <ul style={{ margin: "4px 0", paddingLeft: 20, fontSize: 12, color: colors.muted, fontFamily: "monospace" }}>
            {nonCompliant.slice(0, NON_COMPLIANT_SHOWN).map((s) => (
              <li key={s.hash} title={s.hash}>
                {s.hash.slice(0, 12)}… ({s.site}
                {!s.compliant.ratioOk ? ", ratio" : ""}
                {!s.compliant.timeOk ? ", time" : ""}
                {!s.compliant.inactiveOk ? ", inactive" : ""})
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
