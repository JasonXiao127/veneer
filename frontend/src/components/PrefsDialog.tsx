import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../lib/api";
import { getPreferences, setPreferences } from "../lib/qbActions";
import {
  overlay,
  card,
  dialogTitle,
  fieldLabel,
  input,
  select,
  btn,
  btnPrimary,
  errText,
  sectionHeader,
  checkLabel,
  colors,
  mutedText,
} from "../lib/theme";

const TEXT_FIELDS = ["save_path", "temp_path"] as const;
const INT_FIELDS = [
  "max_active_downloads",
  "max_active_uploads",
  "max_active_torrents",
  "max_seeding_time",
  "dl_limit",
  "up_limit",
  "alt_dl_limit",
  "alt_up_limit",
  "schedule_from_hour",
  "schedule_to_hour",
  "listen_port",
  "max_connec",
  "max_connec_per_torrent",
  "max_uploads",
  "max_uploads_per_torrent",
] as const;
const FLOAT_FIELDS = ["max_ratio"] as const;
/** Selects are stored as strings in the form and parsed to int on save. */
const SELECT_FIELDS = ["max_ratio_act", "encryption"] as const;
const BOOL_FIELDS = [
  "temp_path_enabled",
  "create_subfolder_enabled",
  "start_paused_enabled",
  "preallocate_all",
  "incomplete_files_ext",
  "auto_tmm_enabled",
  "queueing_enabled",
  "dont_count_slow_torrents",
  "max_ratio_enabled",
  "max_seeding_time_enabled",
  "scheduler_enabled",
  "upnp",
  "dht",
  "pex",
  "lsd",
  "anonymous_mode",
  "add_trackers_enabled",
] as const;

const ALL_STR_FIELDS = [
  ...TEXT_FIELDS,
  ...INT_FIELDS,
  ...FLOAT_FIELDS,
  ...SELECT_FIELDS,
  "add_trackers",
] as const;

function strOf(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function unauthorized(): void {
  window.dispatchEvent(new CustomEvent("veneer:unauthorized"));
}

export function PrefsDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [orig, setOrig] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advJson, setAdvJson] = useState("");
  const [advErr, setAdvErr] = useState<string | null>(null);

  // Escape dismisses (overlay click already does; keyboard users need this).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadErr(null);
      try {
        const prefs = await getPreferences();
        if (cancelled) return;
        setOrig(prefs);
        const f: Record<string, string> = {};
        for (const k of ALL_STR_FIELDS) f[k] = strOf(prefs[k]);
        setForm(f);
        const c: Record<string, boolean> = {};
        for (const k of BOOL_FIELDS) c[k] = Boolean(prefs[k]);
        setChecks(c);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) unauthorized();
        setLoadErr(e instanceof Error ? e.message : "failed to load preferences");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const setF = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const setC = (key: string, value: boolean) => setChecks((c) => ({ ...c, [key]: value }));

  const isDirty = useMemo(() => {
    if (!orig) return false;
    if (advJson.trim() !== "") return true;
    for (const k of [...TEXT_FIELDS, "add_trackers" as const]) {
      if ((form[k] ?? "") !== strOf(orig[k])) return true;
    }
    for (const k of [...INT_FIELDS, ...FLOAT_FIELDS, ...SELECT_FIELDS]) {
      const raw = (form[k] ?? "").trim();
      if (raw === "") continue; // empty = skip, never dirty
      if (raw !== strOf(orig[k])) return true;
    }
    for (const k of BOOL_FIELDS) {
      if ((checks[k] ?? false) !== Boolean(orig[k])) return true;
    }
    return false;
  }, [orig, form, checks, advJson]);

  async function save() {
    if (!orig || busy) return;
    setErr(null);
    setAdvErr(null);
    let adv: Record<string, unknown> = {};
    if (advJson.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(advJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Advanced JSON must be an object");
        }
        adv = parsed as Record<string, unknown>;
      } catch (e) {
        setAdvErr(e instanceof Error ? e.message : "invalid JSON");
        return;
      }
    }
    const patch: Record<string, unknown> = {};
    try {
      for (const k of [...TEXT_FIELDS, "add_trackers" as const]) {
        const cur = form[k] ?? "";
        if (cur !== strOf(orig[k])) patch[k] = cur;
      }
      for (const k of INT_FIELDS) {
        const raw = (form[k] ?? "").trim();
        if (raw === "") continue; // empty = skip
        if (raw !== strOf(orig[k])) {
          if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${k} must be an integer`);
          patch[k] = parseInt(raw, 10);
        }
      }
      for (const k of SELECT_FIELDS) {
        const raw = (form[k] ?? "").trim();
        if (raw === "") continue;
        if (raw !== strOf(orig[k])) {
          if (!/^-?\d+$/.test(raw)) throw new Error(`${k} must be an integer`);
          patch[k] = parseInt(raw, 10);
        }
      }
      for (const k of FLOAT_FIELDS) {
        const raw = (form[k] ?? "").trim();
        if (raw === "") continue;
        if (raw !== strOf(orig[k])) {
          if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`${k} must be a number`);
          patch[k] = Number(raw);
        }
      }
      for (const k of BOOL_FIELDS) {
        const cur = checks[k] ?? false;
        if (cur !== Boolean(orig[k])) patch[k] = cur;
      }
      for (const [k, v] of Object.entries(adv)) patch[k] = v;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "invalid value");
      return;
    }
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    setBusy(true);
    try {
      await setPreferences(patch);
      // Rebase the dirty baseline on what was just saved (plus clear the
      // advanced box): the dialog stays open, Save disables until the next
      // real edit, and later diffs stay minimal.
      setOrig((o) => (o ? { ...o, ...patch } : o));
      setAdvJson("");
      onDone();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) unauthorized();
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  const dis = busy || loading;

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: 560, maxHeight: "88vh" }} className="vn-dialog-card vn-prefs-card">
        <style>{prefsMobileCss}</style>
        <h3 style={dialogTitle}>Preferences</h3>
        {loading && <p style={mutedPara}>Loading preferences…</p>}
        {loadErr && (
          <>
            <p style={errText}>{loadErr}</p>
            <div style={actionsStyle}>
              <button style={btn} onClick={onClose}>Close</button>
              <button
                style={btnPrimary}
                onClick={() => {
                  setLoading(true);
                  setLoadErr(null);
                  getPreferences()
                    .then((prefs) => {
                      setOrig(prefs);
                      const f: Record<string, string> = {};
                      for (const k of ALL_STR_FIELDS) f[k] = strOf(prefs[k]);
                      setForm(f);
                      const c: Record<string, boolean> = {};
                      for (const k of BOOL_FIELDS) c[k] = Boolean(prefs[k]);
                      setChecks(c);
                    })
                    .catch((e: unknown) => {
                      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) unauthorized();
                      setLoadErr(e instanceof Error ? e.message : "failed to load preferences");
                    })
                    .finally(() => setLoading(false));
                }}
              >
                Retry
              </button>
            </div>
          </>
        )}
        {!loading && !loadErr && orig && (
          <>
            <h4 style={sectionHeaderLg}>Downloads</h4>
            <label htmlFor="prefs-save_path" style={fieldLabel}>
              Save path
              <input id="prefs-save_path" type="text" value={form["save_path"] ?? ""} onChange={(e) => setF("save_path", e.target.value)} style={input} disabled={dis} />
            </label>
            <label htmlFor="prefs-temp_path_enabled" style={checkLabel}>
              <input id="prefs-temp_path_enabled" type="checkbox" checked={checks["temp_path_enabled"] ?? false} onChange={(e) => setC("temp_path_enabled", e.target.checked)} disabled={dis} /> Keep incomplete torrents in temp path
            </label>
            <label htmlFor="prefs-temp_path" style={fieldLabel}>
              Temp path
              <input id="prefs-temp_path" type="text" value={form["temp_path"] ?? ""} onChange={(e) => setF("temp_path", e.target.value)} style={input} disabled={dis} />
            </label>
            <label htmlFor="prefs-create_subfolder_enabled" style={checkLabel}>
              <input id="prefs-create_subfolder_enabled" type="checkbox" checked={checks["create_subfolder_enabled"] ?? false} onChange={(e) => setC("create_subfolder_enabled", e.target.checked)} disabled={dis} /> Create subfolder
            </label>
            <label htmlFor="prefs-start_paused_enabled" style={checkLabel}>
              <input id="prefs-start_paused_enabled" type="checkbox" checked={checks["start_paused_enabled"] ?? false} onChange={(e) => setC("start_paused_enabled", e.target.checked)} disabled={dis} /> Start paused
            </label>
            <label htmlFor="prefs-preallocate_all" style={checkLabel}>
              <input id="prefs-preallocate_all" type="checkbox" checked={checks["preallocate_all"] ?? false} onChange={(e) => setC("preallocate_all", e.target.checked)} disabled={dis} /> Preallocate files
            </label>
            <label htmlFor="prefs-incomplete_files_ext" style={checkLabel}>
              <input id="prefs-incomplete_files_ext" type="checkbox" checked={checks["incomplete_files_ext"] ?? false} onChange={(e) => setC("incomplete_files_ext", e.target.checked)} disabled={dis} /> Append .!qB extension to incomplete files
            </label>
            <label htmlFor="prefs-auto_tmm_enabled" style={checkLabel}>
              <input id="prefs-auto_tmm_enabled" type="checkbox" checked={checks["auto_tmm_enabled"] ?? false} onChange={(e) => setC("auto_tmm_enabled", e.target.checked)} disabled={dis} /> Automatic torrent management
            </label>

            <h4 style={sectionHeaderLg}>Queueing</h4>
            <label htmlFor="prefs-queueing_enabled" style={checkLabel}>
              <input id="prefs-queueing_enabled" type="checkbox" checked={checks["queueing_enabled"] ?? false} onChange={(e) => setC("queueing_enabled", e.target.checked)} disabled={dis} /> Torrent queueing enabled
            </label>
            <label htmlFor="prefs-max_active_downloads" style={fieldLabel}>
              Max active downloads
              <input id="prefs-max_active_downloads" type="number" value={form["max_active_downloads"] ?? ""} onChange={(e) => setF("max_active_downloads", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-max_active_uploads" style={fieldLabel}>
              Max active uploads
              <input id="prefs-max_active_uploads" type="number" value={form["max_active_uploads"] ?? ""} onChange={(e) => setF("max_active_uploads", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-max_active_torrents" style={fieldLabel}>
              Max active torrents
              <input id="prefs-max_active_torrents" type="number" value={form["max_active_torrents"] ?? ""} onChange={(e) => setF("max_active_torrents", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-dont_count_slow_torrents" style={checkLabel}>
              <input id="prefs-dont_count_slow_torrents" type="checkbox" checked={checks["dont_count_slow_torrents"] ?? false} onChange={(e) => setC("dont_count_slow_torrents", e.target.checked)} disabled={dis} /> Don&apos;t count slow torrents
            </label>

            <h4 style={sectionHeaderLg}>Seeding</h4>
            <label htmlFor="prefs-max_ratio_enabled" style={checkLabel}>
              <input id="prefs-max_ratio_enabled" type="checkbox" checked={checks["max_ratio_enabled"] ?? false} onChange={(e) => setC("max_ratio_enabled", e.target.checked)} disabled={dis} /> Seed until ratio reaches
            </label>
            <label htmlFor="prefs-max_ratio" style={fieldLabel}>
              Max ratio
              <input id="prefs-max_ratio" type="number" step="any" value={form["max_ratio"] ?? ""} onChange={(e) => setF("max_ratio", e.target.value)} style={input} inputMode="decimal" disabled={dis} />
            </label>
            <label htmlFor="prefs-max_ratio_act" style={fieldLabel}>
              When ratio reached
              <select id="prefs-max_ratio_act" value={form["max_ratio_act"] ?? ""} onChange={(e) => setF("max_ratio_act", e.target.value)} style={select} disabled={dis}>
                <option value="0">Pause</option>
                <option value="1">Remove</option>
              </select>
            </label>
            <label htmlFor="prefs-max_seeding_time_enabled" style={checkLabel}>
              <input id="prefs-max_seeding_time_enabled" type="checkbox" checked={checks["max_seeding_time_enabled"] ?? false} onChange={(e) => setC("max_seeding_time_enabled", e.target.checked)} disabled={dis} /> Seed until time reaches (minutes)
            </label>
            <label htmlFor="prefs-max_seeding_time" style={fieldLabel}>
              Max seeding time, minutes
              <input id="prefs-max_seeding_time" type="number" value={form["max_seeding_time"] ?? ""} onChange={(e) => setF("max_seeding_time", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>

            <h4 style={sectionHeaderLg}>Speed</h4>
            <label htmlFor="prefs-dl_limit" style={fieldLabel}>
              Download limit, bytes/s (0 = unlimited)
              <input id="prefs-dl_limit" type="number" value={form["dl_limit"] ?? ""} onChange={(e) => setF("dl_limit", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-up_limit" style={fieldLabel}>
              Upload limit, bytes/s (0 = unlimited)
              <input id="prefs-up_limit" type="number" value={form["up_limit"] ?? ""} onChange={(e) => setF("up_limit", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-alt_dl_limit" style={fieldLabel}>
              Alternative download limit, bytes/s
              <input id="prefs-alt_dl_limit" type="number" value={form["alt_dl_limit"] ?? ""} onChange={(e) => setF("alt_dl_limit", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-alt_up_limit" style={fieldLabel}>
              Alternative upload limit, bytes/s
              <input id="prefs-alt_up_limit" type="number" value={form["alt_up_limit"] ?? ""} onChange={(e) => setF("alt_up_limit", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-scheduler_enabled" style={checkLabel}>
              <input id="prefs-scheduler_enabled" type="checkbox" checked={checks["scheduler_enabled"] ?? false} onChange={(e) => setC("scheduler_enabled", e.target.checked)} disabled={dis} /> Schedule alternative limits
            </label>
            <div style={row}>
              <label htmlFor="prefs-schedule_from_hour" style={{ ...fieldLabel, flex: 1 }}>
                From hour (0–23)
                <input id="prefs-schedule_from_hour" type="number" min={0} max={23} value={form["schedule_from_hour"] ?? ""} onChange={(e) => setF("schedule_from_hour", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
              </label>
              <label htmlFor="prefs-schedule_to_hour" style={{ ...fieldLabel, flex: 1 }}>
                To hour (0–23)
                <input id="prefs-schedule_to_hour" type="number" min={0} max={23} value={form["schedule_to_hour"] ?? ""} onChange={(e) => setF("schedule_to_hour", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
              </label>
            </div>

            <h4 style={sectionHeaderLg}>Connection</h4>
            <label htmlFor="prefs-listen_port" style={fieldLabel}>
              Listen port
              <input id="prefs-listen_port" type="number" value={form["listen_port"] ?? ""} onChange={(e) => setF("listen_port", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-upnp" style={checkLabel}>
              <input id="prefs-upnp" type="checkbox" checked={checks["upnp"] ?? false} onChange={(e) => setC("upnp", e.target.checked)} disabled={dis} /> UPnP / NAT-PMP
            </label>
            <label htmlFor="prefs-max_connec" style={fieldLabel}>
              Max connections
              <input id="prefs-max_connec" type="number" value={form["max_connec"] ?? ""} onChange={(e) => setF("max_connec", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-max_connec_per_torrent" style={fieldLabel}>
              Max connections per torrent
              <input id="prefs-max_connec_per_torrent" type="number" value={form["max_connec_per_torrent"] ?? ""} onChange={(e) => setF("max_connec_per_torrent", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-max_uploads" style={fieldLabel}>
              Max upload slots
              <input id="prefs-max_uploads" type="number" value={form["max_uploads"] ?? ""} onChange={(e) => setF("max_uploads", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-max_uploads_per_torrent" style={fieldLabel}>
              Max upload slots per torrent
              <input id="prefs-max_uploads_per_torrent" type="number" value={form["max_uploads_per_torrent"] ?? ""} onChange={(e) => setF("max_uploads_per_torrent", e.target.value)} style={input} inputMode="numeric" disabled={dis} />
            </label>
            <label htmlFor="prefs-dht" style={checkLabel}>
              <input id="prefs-dht" type="checkbox" checked={checks["dht"] ?? false} onChange={(e) => setC("dht", e.target.checked)} disabled={dis} /> DHT
            </label>
            <label htmlFor="prefs-pex" style={checkLabel}>
              <input id="prefs-pex" type="checkbox" checked={checks["pex"] ?? false} onChange={(e) => setC("pex", e.target.checked)} disabled={dis} /> PEX
            </label>
            <label htmlFor="prefs-lsd" style={checkLabel}>
              <input id="prefs-lsd" type="checkbox" checked={checks["lsd"] ?? false} onChange={(e) => setC("lsd", e.target.checked)} disabled={dis} /> Local service discovery
            </label>
            <label htmlFor="prefs-encryption" style={fieldLabel}>
              Encryption
              <select id="prefs-encryption" value={form["encryption"] ?? ""} onChange={(e) => setF("encryption", e.target.value)} style={select} disabled={dis}>
                <option value="0">Allow encryption</option>
                <option value="1">Require encryption</option>
                <option value="2">Disable encryption</option>
              </select>
            </label>
            <label htmlFor="prefs-anonymous_mode" style={checkLabel}>
              <input id="prefs-anonymous_mode" type="checkbox" checked={checks["anonymous_mode"] ?? false} onChange={(e) => setC("anonymous_mode", e.target.checked)} disabled={dis} /> Anonymous mode
            </label>

            <h4 style={sectionHeaderLg}>BitTorrent</h4>
            <label htmlFor="prefs-add_trackers_enabled" style={checkLabel}>
              <input id="prefs-add_trackers_enabled" type="checkbox" checked={checks["add_trackers_enabled"] ?? false} onChange={(e) => setC("add_trackers_enabled", e.target.checked)} disabled={dis} /> Automatically add trackers
            </label>
            <label htmlFor="prefs-add_trackers" style={fieldLabel}>
              Trackers (one per line)
              <textarea id="prefs-add_trackers" value={form["add_trackers"] ?? ""} onChange={(e) => setF("add_trackers", e.target.value)} rows={3} style={input} disabled={dis} />
            </label>

            <h4 style={sectionHeaderLg}>Advanced JSON patch</h4>
            <label htmlFor="prefs-adv-json" style={fieldLabel}>
              Any other key (merged into the save)
              <textarea
                id="prefs-adv-json"
                value={advJson}
                onChange={(e) => setAdvJson(e.target.value)}
                rows={4}
                style={input}
                placeholder='{"locale": "en", "web_ui_port": 8080}'
                disabled={dis}
              />
            </label>
            {advErr && <p style={errText}>{advErr}</p>}

            {err && <p style={errText}>{err}</p>}
            <div style={actionsStyle} className="vn-dialog-actions">
              <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={btnPrimary} onClick={() => void save()} disabled={busy || !isDirty}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
        {!loading && !loadErr && !orig && (
          <div style={actionsStyle}>
            <button style={btn} onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

const sectionHeaderLg: React.CSSProperties = { ...sectionHeader, fontSize: 14, margin: "8px 0 0" };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "flex-start" };
const mutedPara: React.CSSProperties = { ...mutedText, fontSize: 13, margin: 0 };
const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  position: "sticky",
  bottom: 0,
  background: colors.panel,
  padding: "10px 0 2px",
  borderTop: `1px solid ${colors.border}`,
};

/**
 * Mobile-only overrides (desktop >768px never matches → desktop unchanged).
 */
const prefsMobileCss = `
@media (max-width: 768px) {
  .vn-prefs-card {
    max-height: 92dvh !important;
    -webkit-overflow-scrolling: touch;
  }
  .vn-prefs-card input:not([type="checkbox"]),
  .vn-prefs-card select,
  .vn-prefs-card textarea {
    font-size: 16px !important;
    min-height: 40px !important;
  }
  .vn-prefs-card input[type="checkbox"] {
    width: 22px !important;
    height: 22px !important;
  }
  .vn-prefs-card button { min-height: 40px !important; }
  .vn-prefs-card select { min-height: 40px !important; }
}
@media (max-width: 480px) {
  .vn-prefs-card .vn-dialog-actions {
    flex-direction: column !important;
    align-items: stretch !important;
  }
  .vn-prefs-card .vn-dialog-actions button {
    width: 100% !important;
    min-height: 44px !important;
  }
}
`;
