import type { Request, RequestHandler } from "express";
import { ApiError } from "../api/errors.js";
import type { AuthService, PublicUser, SessionRow } from "./authService.js";
import { hasPermission, type Permission } from "./permissions.js";

export const SESSION_COOKIE = "pg_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { user: PublicUser; session: SessionRow };
    }
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Attaches req.auth when the request carries a valid session cookie. Never rejects on its own. */
export function sessionMiddleware(auth: AuthService): RequestHandler {
  return (req, _res, next) => {
    const resolved = auth.authenticate(readCookie(req, SESSION_COOKIE));
    if (resolved) req.auth = resolved;
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(new ApiError(401, "UNAUTHENTICATED", "Sign in required (session missing or expired)"));
  next();
};

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new ApiError(401, "UNAUTHENTICATED", "Sign in required (session missing or expired)"));
    if (!hasPermission(req.auth.user.role, permission)) {
      return next(new ApiError(403, "FORBIDDEN", `Your role (${req.auth.user.role}) does not have the "${permission}" permission`));
    }
    next();
  };
}

/**
 * Defence in depth against CSRF on top of the SameSite=Strict cookie: a state-changing request that
 * carries an Origin header must come from this same host.
 */
export const sameOriginWrites: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return next(new ApiError(403, "BAD_ORIGIN", "Malformed Origin header"));
  }
  const expected = req.headers["x-forwarded-host"] ?? req.headers.host;
  if (host !== expected) return next(new ApiError(403, "BAD_ORIGIN", "Cross-origin request rejected"));
  next();
};
