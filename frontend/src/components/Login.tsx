import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { btnPrimary, card, colors, errText, fieldLabel, input, warnText } from "../lib/theme";

export function Login({ notice, onDone }: { notice?: string | null; onDone: (info: { webapiVersion: string; isV5: boolean }) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Probing: don't flash the form while checking for a preserved session.
  const [probing, setProbing] = useState(true);

  // A preserved cookie+session (e.g. after an IP ban lifts) is still valid —
  // re-enter without asking for credentials again. Deps intentionally empty:
  // the parent passes an inline callback that changes every render.
  useEffect(() => {
    let alive = true;
    apiFetch<{ loggedIn: boolean; webapiVersion: string; isV5: boolean }>("/api/session/status")
      .then((s) => {
        if (alive && s.loggedIn) onDone(s);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch<{ webapiVersion: string; isV5: boolean }>("/api/session/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      onDone(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.wrap}>
      {probing ? (
        <p role="status" style={{ color: colors.muted, fontSize: 14 }}>Checking session…</p>
      ) : (
      <form onSubmit={submit} style={{ ...card, width: 320, padding: 24 }} className="vn-dialog-card vn-login-card">
        <style>{loginMobileCss}</style>
        <h1 style={{ margin: "0 0 4px", fontSize: 20 }}>Veneer</h1>
        <p style={{ margin: "0 0 16px", color: colors.muted, fontSize: 13 }}>Log in with your qBittorrent credentials</p>
        {notice && <p style={warnText}>{notice}</p>}
        <label htmlFor="login-username" style={fieldLabel}>
          Username
          <input id="login-username" style={input} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label htmlFor="login-password" style={fieldLabel}>
          Password
          <input
            id="login-password"
            style={input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {err && <p style={errText}>{err}</p>}
        <button style={{ ...btnPrimary, marginTop: 8, padding: "9px 12px" }} disabled={busy} type="submit">
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: colors.bg, color: colors.text },
};

/**
 * Mobile-only overrides (desktop >768px never matches → desktop unchanged).
 */
const loginMobileCss = `
@media (max-width: 768px) {
  .vn-login-card {
    max-height: 92dvh !important;
    overflow-y: auto !important;
    -webkit-overflow-scrolling: touch;
  }
  .vn-login-card input,
  .vn-login-card select {
    font-size: 16px !important;
    min-height: 40px !important;
  }
  .vn-login-card button {
    min-height: 44px !important;
    width: 100% !important;
  }
}
@media (max-width: 480px) {
  .vn-login-card {
    width: 100% !important;
  }
}
`;
