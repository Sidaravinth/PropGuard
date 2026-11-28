import { Eye, EyeOff, LoaderCircle, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { ApiRequestError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Alert } from "../components/ui";

export function LoginPage() {
  const { status, login, signOutReason } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every sign-in lands on the dashboard, whatever page the user was on before.
  if (status === "signed-in") return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not reach the server. Is the API running?");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="login-brand">
          <ShieldCheck size={28} aria-hidden />
          <span>
            PROP<strong>guard</strong>
          </span>
        </div>
        <h1 className="login-title">Sign in</h1>
        <p className="muted">Lease and maintenance operations with deterministic financial controls.</p>

        {signOutReason && !error && <Alert tone="info">{signOutReason}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}

        <form onSubmit={submit} className="form" noValidate>
          <label className="field">
            <span className="field-label">Email</span>
            <input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <span className="input-with-action">
              <input type={showPassword ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="icon-btn" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? "Hide password" : "Show password"}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </span>
          </label>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy || !email || !password}>
            {busy && <LoaderCircle size={16} className="spin" aria-hidden />}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="muted small login-footnote">Accounts are created by your administrator. There is no self-registration.</p>
      </div>
    </div>
  );
}
