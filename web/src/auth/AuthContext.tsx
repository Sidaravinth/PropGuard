import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, authApi, onUnauthorized, type Permission, type Profile } from "../api/client";

type Status = "loading" | "signed-in" | "signed-out";

interface AuthValue {
  status: Status;
  profile: Profile | null;
  /** Why the user was signed out, shown on the login page. */
  signOutReason: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** UI hint only: the backend enforces every permission. */
  can: (p: Permission) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [signOutReason, setSignOutReason] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProfile(await authApi.me());
      setStatus("signed-in");
    } catch (e) {
      if (!(e instanceof ApiRequestError && e.status === 401)) console.error(e);
      setProfile(null);
      setStatus("signed-out");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any 401 from the API means the session has ended (expired, revoked, or signed out elsewhere).
  const signedInRef = useRef(false);
  signedInRef.current = profile !== null;
  useEffect(
    () =>
      onUnauthorized(() => {
        if (signedInRef.current) setSignOutReason("Your session has expired. Please sign in again.");
        setProfile(null);
        setStatus("signed-out");
      }),
    [],
  );

  // Proactively end the session in the UI when its absolute lifetime runs out.
  useEffect(() => {
    if (!profile) return;
    const ms = Date.parse(profile.session.expires_at) - Date.now();
    const t = setTimeout(() => void refresh(), Math.max(ms + 1000, 1000));
    return () => clearTimeout(t);
  }, [profile, refresh]);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      profile,
      signOutReason,
      login: async (email, password) => {
        const p = await authApi.login(email, password);
        setSignOutReason(null);
        setProfile(p);
        setStatus("signed-in");
      },
      logout: async () => {
        try {
          await authApi.logout();
        } finally {
          setSignOutReason(null);
          setProfile(null);
          setStatus("signed-out");
        }
      },
      refresh,
      can: (p) => profile?.permissions.includes(p) ?? false,
    }),
    [status, profile, signOutReason, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
