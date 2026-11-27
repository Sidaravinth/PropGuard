/** Thin fetch wrapper. The session lives in an httpOnly cookie, so no token handling happens here. */

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Called whenever an API request comes back 401 (session expired or revoked). */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export function notifyUnauthorized(): void {
  unauthorizedListeners.forEach((fn) => fn());
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body?.error;
    // Every PropGuard API error has a JSON body; a bare error means something else answered (e.g. a dev server without the /api proxy).
    if (!err && !res.headers.get("content-type")?.includes("application/json")) {
      throw new ApiRequestError(res.status, "API_UNREACHABLE", `The PropGuard API did not answer (HTTP ${res.status}). Make sure the API is running (npm run dev) and open the app via npm run dev:web.`);
    }
    if (res.status === 401 && !path.startsWith("/auth/login")) unauthorizedListeners.forEach((fn) => fn());
    throw new ApiRequestError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return body as T;
}

// --- auth types ------------------------------------------------------------------

export type Role = "property_manager" | "regional_director";
export type ApprovalTier = "AUTO_APPROVE" | "PROPERTY_MANAGER" | "REGIONAL_DIRECTOR";
export type Permission = "records.read" | "records.write" | "policy.run" | "briefs.generate";

export interface Profile {
  user: { user_id: number; email: string; display_name: string; role: Role; role_label: string; created_at: string; password_changed_at: string };
  permissions: Permission[];
  approvalTiers: ApprovalTier[];
  session: { created_at: string; expires_at: string };
}

export interface SessionInfo {
  session_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
  current: boolean;
}

export const authApi = {
  me: () => api<{ data: Profile }>("/auth/me").then((r) => r.data),
  login: (email: string, password: string) => api<{ data: Profile }>("/auth/login", { method: "POST", json: { email, password } }).then((r) => r.data),
  logout: () => api<void>("/auth/logout", { method: "POST" }),
  changePassword: (current_password: string, new_password: string) => api<unknown>("/auth/change-password", { method: "POST", json: { current_password, new_password } }),
  sessions: () => api<{ data: SessionInfo[] }>("/auth/sessions").then((r) => r.data),
  revokeSession: (id: string) => api<void>(`/auth/sessions/${id}`, { method: "DELETE" }),
};
