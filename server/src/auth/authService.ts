/**
 * Accounts and server-side sessions.
 *
 * - Passwords: bcrypt (cost from BCRYPT_ROUNDS, default 12). bcrypt only reads the first 72 bytes,
 *   so longer passwords are rejected rather than silently truncated.
 * - Sessions: the client gets a random 256-bit token in an httpOnly cookie; the DB stores only its
 *   SHA-256. A session ends at its absolute expiry, after an idle timeout, on logout, or when revoked.
 * - No login lockout: failed attempts are not counted or limited (by product decision).
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import type { DB } from "../db/connection.js";
import { ROLES, type Role } from "./permissions.js";

export interface UserRow {
  user_id: number;
  email: string;
  display_name: string;
  role: Role;
  password_hash: string;
  created_at: string;
  password_changed_at: string;
}
export type PublicUser = Omit<UserRow, "password_hash">;

export interface SessionRow {
  session_id: string;
  user_id: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  user_agent: string | null;
  ip: string | null;
}

export class AuthError extends Error {
  constructor(
    public code: "INVALID_CREDENTIALS" | "WEAK_PASSWORD" | "INVALID_INPUT",
    message: string,
  ) {
    super(message);
  }
}

export const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_BYTES = 72;

export function validatePasswordStrength(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) throw new AuthError("WEAK_PASSWORD", `Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) throw new AuthError("WEAK_PASSWORD", `Password must be at most ${PASSWORD_MAX_BYTES} bytes`);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) throw new AuthError("WEAK_PASSWORD", "Password must mix at least three of: lowercase, uppercase, digits, symbols");
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const publicUser = ({ password_hash: _h, ...u }: UserRow): PublicUser => u;

export interface AuthOptions {
  now?: () => Date;
  bcryptRounds?: number;
  sessionTtlHours?: number;
  sessionIdleMinutes?: number;
}

export class AuthService {
  private readonly now: () => Date;
  private readonly rounds: number;
  private readonly ttlMs: number;
  private readonly idleMs: number;
  /** A real hash to compare against when the email is unknown, so timing does not reveal which emails exist. */
  private dummyHash: string | null = null;

  constructor(
    private readonly db: DB,
    opts: AuthOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.rounds = opts.bcryptRounds ?? config.auth.bcryptRounds;
    this.ttlMs = (opts.sessionTtlHours ?? config.auth.sessionTtlHours) * 3_600_000;
    this.idleMs = (opts.sessionIdleMinutes ?? config.auth.sessionIdleMinutes) * 60_000;
  }

  // --- users -----------------------------------------------------------------

  countUsers(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  createUser(input: { email: string; displayName: string; role: Role; password: string }): PublicUser {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("INVALID_INPUT", `Invalid email address: ${input.email}`);
    if (!input.displayName.trim()) throw new AuthError("INVALID_INPUT", "Display name is required");
    if (!ROLES.includes(input.role)) throw new AuthError("INVALID_INPUT", `Unknown role: ${input.role}`);
    validatePasswordStrength(input.password);
    const hash = bcrypt.hashSync(input.password, this.rounds);
    const r = this.db
      .prepare("INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)")
      .run(email, input.displayName.trim(), input.role, hash);
    return this.getUser(Number(r.lastInsertRowid))!;
  }

  getUser(userId: number): PublicUser | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as UserRow | undefined;
    return row && publicUser(row);
  }

  // --- login / logout ----------------------------------------------------------

  /** Verify credentials and open a session. Returns the raw token for the cookie. */
  async login(email: string, password: string, meta: { ip?: string; userAgent?: string } = {}): Promise<{ token: string; user: PublicUser; session: SessionRow }> {
    const normEmail = email.trim().toLowerCase();
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(normEmail) as UserRow | undefined;
    this.dummyHash ??= bcrypt.hashSync("not-a-real-password", this.rounds);
    const ok = await bcrypt.compare(password, row?.password_hash ?? this.dummyHash);
    if (!row || !ok) throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password");

    const { token, session } = this.createSession(row.user_id, meta);
    return { token, user: publicUser(row), session };
  }

  createSession(userId: number, meta: { ip?: string; userAgent?: string } = {}): { token: string; session: SessionRow } {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = this.now();
    const session: SessionRow = {
      session_id: sha256(token),
      user_id: userId,
      created_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
      revoked_at: null,
      user_agent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
    };
    this.db
      .prepare("INSERT INTO sessions (session_id, user_id, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(session.session_id, userId, session.created_at, session.last_seen_at, session.expires_at, session.user_agent, session.ip);
    return { token, session };
  }

  /** Resolve a cookie token to its user, enforcing expiry, idle timeout and revocation. Touches last_seen_at. */
  authenticate(token: string | undefined): { user: PublicUser; session: SessionRow } | null {
    if (!token || token.length > 100) return null;
    const session = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sha256(token)) as SessionRow | undefined;
    if (!session || session.revoked_at) return null;
    const now = this.now();
    if (now.getTime() >= Date.parse(session.expires_at)) return null;
    if (now.getTime() - Date.parse(session.last_seen_at) >= this.idleMs) return null;
    const user = this.getUser(session.user_id);
    if (!user) return null;
    // Throttle writes: only bump last_seen_at once a minute.
    if (now.getTime() - Date.parse(session.last_seen_at) > 60_000) {
      session.last_seen_at = now.toISOString();
      this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE session_id = ?").run(session.last_seen_at, session.session_id);
    }
    return { user, session };
  }

  revokeSession(sessionId: string, userId: number): boolean {
    const r = this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL")
      .run(this.now().toISOString(), sessionId, userId);
    return Number(r.changes) > 0;
  }

  /** Sessions still usable right now, newest first. */
  listActiveSessions(userId: number): SessionRow[] {
    const nowMs = this.now().getTime();
    return (this.db.prepare("SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(userId) as unknown as SessionRow[]).filter(
      (s) => nowMs < Date.parse(s.expires_at) && nowMs - Date.parse(s.last_seen_at) < this.idleMs,
    );
  }

  /** Change the password and revoke every other session of this user. */
  async changePassword(userId: number, currentPassword: string, newPassword: string, keepSessionId: string): Promise<void> {
    const row = this.db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as UserRow | undefined;
    if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) throw new AuthError("INVALID_CREDENTIALS", "Current password is incorrect");
    if (currentPassword === newPassword) throw new AuthError("WEAK_PASSWORD", "New password must differ from the current one");
    validatePasswordStrength(newPassword);
    const hash = bcrypt.hashSync(newPassword, this.rounds);
    const now = this.now().toISOString();
    this.db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE user_id = ?").run(hash, now, userId);
    this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND session_id != ? AND revoked_at IS NULL").run(now, userId, keepSessionId);
  }
}
