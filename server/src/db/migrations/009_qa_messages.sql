-- 009_qa_messages.sql: grounded Q&A chat history, kept per user and per lease. Additive only.
-- Each assistant row stores the checked answer (statements and citations) as JSON, exactly as shown.
CREATE TABLE qa_messages (
  message_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id     INTEGER NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(user_id),
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content      TEXT NOT NULL,
  answer_json  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_qa_messages_conversation ON qa_messages(lease_id, user_id, message_id);
