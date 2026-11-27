import { Router, type CookieOptions, type Request } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/authService.js";
import { requireAuth, SESSION_COOKIE } from "../auth/middleware.js";
import { permissionsFor, ROLE_LABEL } from "../auth/permissions.js";
import { config } from "../config.js";
import { ApiError, notFound, parseOr400 } from "./errors.js";

const LoginBody = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(200) }).strict();
const ChangePasswordBody = z.object({ current_password: z.string().min(1).max(200), new_password: z.string().min(1).max(200) }).strict();

function cookieOptions(expiresAt: string): CookieOptions {
  return { httpOnly: true, sameSite: "strict", secure: config.auth.secureCookies, path: "/", expires: new Date(expiresAt) };
}

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

function profile(req: Request) {
  const { user, session } = req.auth!;
  return {
    user: { ...user, role_label: ROLE_LABEL[user.role] },
    ...permissionsFor(user.role),
    session: { created_at: session.created_at, expires_at: session.expires_at },
  };
}

/** Mounted at /api/auth. Only /login is reachable without a session. */
export function createAuthRouter(auth: AuthService): Router {
  const r = Router();

  r.post("/login", async (req, res) => {
    const body = parseOr400(LoginBody, req.body, "login");
    const { token, user, session } = await auth.login(body.email, body.password, meta(req));
    res.cookie(SESSION_COOKIE, token, cookieOptions(session.expires_at));
    req.auth = { user, session };
    res.json({ data: profile(req) });
  });

  r.use(requireAuth);

  r.post("/logout", (req, res) => {
    auth.revokeSession(req.auth!.session.session_id, req.auth!.user.user_id);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.status(204).end();
  });

  r.get("/me", (req, res) => {
    res.json({ data: profile(req) });
  });

  r.post("/change-password", async (req, res) => {
    const body = parseOr400(ChangePasswordBody, req.body, "password change");
    await auth.changePassword(req.auth!.user.user_id, body.current_password, body.new_password, req.auth!.session.session_id);
    res.json({ data: { changed: true, other_sessions_revoked: true } });
  });

  r.get("/sessions", (req, res) => {
    const current = req.auth!.session.session_id;
    res.json({
      data: auth.listActiveSessions(req.auth!.user.user_id).map((s) => ({
        session_id: s.session_id,
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        expires_at: s.expires_at,
        user_agent: s.user_agent,
        ip: s.ip,
        current: s.session_id === current,
      })),
    });
  });

  r.delete("/sessions/:id", (req, res) => {
    const id = parseOr400(z.string().regex(/^[0-9a-f]{64}$/), req.params.id, "session id");
    if (id === req.auth!.session.session_id) throw new ApiError(400, "USE_LOGOUT", "Use POST /api/auth/logout to end the current session");
    if (!auth.revokeSession(id, req.auth!.user.user_id)) throw notFound("Session");
    res.status(204).end();
  });

  return r;
}
