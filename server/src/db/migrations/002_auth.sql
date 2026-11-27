-- 002_auth.sql — Day 2 Group A: user accounts and server-side sessions.
-- There is no registration endpoint: rows are created only by the bootstrap step (src/auth/bootstrap.ts)
-- from environment variables, and only while this table is empty.

CREATE TABLE users (
  user_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('property_manager', 'regional_director')),
  password_hash       TEXT NOT NULL,                -- bcrypt
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  password_changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The cookie holds a random token; only its SHA-256 is stored, so a leaked DB row cannot be replayed.
CREATE TABLE sessions (
  session_id    TEXT PRIMARY KEY,                   -- sha256(token), hex
  user_id       INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,                      -- ISO-8601 UTC
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,                      -- absolute expiry; idle timeout is checked against last_seen_at
  revoked_at    TEXT,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
