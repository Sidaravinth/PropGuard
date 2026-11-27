import { KeyRound, LoaderCircle, MonitorSmartphone } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiRequestError, authApi, type SessionInfo } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Alert, Card, EmptyState, formatDateTime, PageHeader } from "../components/ui";

const PERMISSION_LABEL: Record<string, string> = {
  "records.read": "View operational records",
  "records.write": "Create and edit records, upload documents",
  "policy.run": "Run deterministic policy checks",
  "briefs.generate": "Generate AI Decision Briefs",
};
const TIER_LABEL: Record<string, string> = {
  AUTO_APPROVE: "Auto-approve eligible (≤ $200, no exceptions)",
  PROPERTY_MANAGER: "Property Manager tier ($200.01 – $1,000, or any exception)",
  REGIONAL_DIRECTOR: "Regional Director tier (> $1,000)",
};

function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setMsg({ tone: "error", text: "The new passwords do not match." });
    setBusy(true);
    setMsg(null);
    try {
      await authApi.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ tone: "success", text: "Password changed. Your other sessions have been signed out." });
    } catch (err) {
      setMsg({ tone: "error", text: err instanceof ApiRequestError ? err.message : "Could not change the password." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <label className="field">
        <span className="field-label">Current password</span>
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="field">
        <span className="field-label">New password</span>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
        <span className="field-hint">At least 12 characters, mixing three of: lowercase, uppercase, digits, symbols.</span>
      </label>
      <label className="field">
        <span className="field-label">Confirm new password</span>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      <div>
        <button className="btn btn-primary" disabled={busy || !current || !next || !confirm}>
          {busy && <LoaderCircle size={16} className="spin" aria-hidden />}
          Change password
        </button>
      </div>
    </form>
  );
}

function SessionsList() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await authApi.sessions());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not load sessions.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    try {
      await authApi.revokeSession(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not revoke the session.");
    }
  };

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!sessions) return <div className="spinner" aria-label="Loading" />;
  if (!sessions.length) return <EmptyState icon={MonitorSmartphone} title="No active sessions" />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Signed in</th>
            <th>Last active</th>
            <th>Expires</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.session_id}>
              <td>
                {describeAgent(s.user_agent)} {s.current && <span className="badge badge-success">This device</span>}
                {s.ip && <div className="muted small">{s.ip}</div>}
              </td>
              <td>{formatDateTime(s.created_at)}</td>
              <td>{formatDateTime(s.last_seen_at)}</td>
              <td>{formatDateTime(s.expires_at)}</td>
              <td className="right">
                {!s.current && (
                  <button className="btn btn-secondary btn-sm" onClick={() => void revoke(s.session_id)}>
                    Sign out
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsPage() {
  const { profile } = useAuth();
  if (!profile) return null;
  const { user } = profile;
  return (
    <>
      <PageHeader title="Settings" description="Your profile, password and active sessions." />
      <div className="grid-2">
        <Card title="Profile" subtitle="Account details are managed by your administrator">
          <dl className="details">
            <dt>Name</dt>
            <dd>{user.display_name}</dd>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>Role</dt>
            <dd>
              <span className={`badge role-${user.role}`}>{user.role_label}</span>
            </dd>
            <dt>Account created</dt>
            <dd>{formatDateTime(user.created_at)}</dd>
            <dt>Password changed</dt>
            <dd>{formatDateTime(user.password_changed_at)}</dd>
          </dl>
        </Card>
        <Card title="Permissions" subtitle="Enforced by the server on every request">
          <ul className="check-list">
            {profile.permissions.map((p) => (
              <li key={p}>{PERMISSION_LABEL[p] ?? p}</li>
            ))}
          </ul>
          <div className="field-label mt">Can approve decisions at</div>
          <ul className="check-list">
            {profile.approvalTiers.map((t) => (
              <li key={t}>{TIER_LABEL[t] ?? t}</li>
            ))}
          </ul>
          <p className="muted small">The approval tier of every decision is set by the deterministic policy engine and cannot be changed by any user.</p>
        </Card>
        <Card title="Change password" actions={<KeyRound size={18} className="muted" aria-hidden />}>
          <PasswordForm />
        </Card>
        <Card title="Application">
          <dl className="details">
            <dt>Application</dt>
            <dd>PropGuard</dd>
            <dt>Version</dt>
            <dd>0.2.0 (Day 2, Group A)</dd>
            <dt>Session expires</dt>
            <dd>{formatDateTime(profile.session.expires_at)}</dd>
            <dt>API reference</dt>
            <dd>
              <a href="/docs" target="_blank" rel="noreferrer">
                Swagger UI
              </a>
            </dd>
          </dl>
        </Card>
      </div>
      <Card title="Active sessions" subtitle="Sessions end at a fixed lifetime, after a period of inactivity, or when you sign out" className="mt">
        <SessionsList />
      </Card>
    </>
  );
}
