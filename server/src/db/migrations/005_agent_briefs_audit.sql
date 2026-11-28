-- 005_agent_briefs_audit.sql — Day 2: immutable audit log, AI agent runs, Decision Briefs, simulated actions.
-- Additive only: no Day 1 table changes.

-- Safety: older development databases may contain empty draft versions of three tables below.
-- They are replaced only if empty; the migration aborts (and rolls back) if any holds data.
CREATE TABLE IF NOT EXISTS decision_briefs (brief_id INTEGER);
CREATE TABLE IF NOT EXISTS lease_renewal_offers (offer_id INTEGER);
CREATE TABLE IF NOT EXISTS outbound_messages (message_id INTEGER);
CREATE TEMP TABLE _empty_guard (row_count INTEGER CHECK (row_count = 0));
INSERT INTO _empty_guard SELECT COUNT(*) FROM decision_briefs;
INSERT INTO _empty_guard SELECT COUNT(*) FROM lease_renewal_offers;
INSERT INTO _empty_guard SELECT COUNT(*) FROM outbound_messages;
DROP TABLE _empty_guard;
DROP TABLE outbound_messages;
DROP TABLE lease_renewal_offers;
DROP TABLE decision_briefs;

-- Append-only, hash-chained audit log. hash = sha256(JSON.stringify([prev_hash, occurred_at, event_type,
-- actor_type, actor_id, subject_type, subject_id, brief_id, payload_json])); the first prev_hash is 64 zeros.
-- Any edit breaks the chain (GET /api/audit/verify); the triggers make edits and deletes impossible.
-- No foreign keys on purpose: audit rows must outlive the records they describe.
CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at   TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('agent', 'system', 'human')),
  actor_id      TEXT NOT NULL,          -- model name, 'policy-engine@x.y.z', 'system', or 'ROLE:name'
  subject_type  TEXT,                   -- lease | ticket | brief | document | import
  subject_id    TEXT,
  brief_id      INTEGER,
  payload_json  TEXT NOT NULL,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_brief ON audit_logs(brief_id);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_logs(subject_type, subject_id);

-- One row per agent workflow execution, with every tool call it made.
CREATE TABLE agent_runs (
  run_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow        TEXT NOT NULL CHECK (workflow IN ('lease_renewal', 'maintenance_exception')),
  subject_type    TEXT NOT NULL CHECK (subject_type IN ('lease', 'ticket')),
  subject_id      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  model           TEXT,
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  error           TEXT,
  brief_id        INTEGER,
  triggered_by    INTEGER REFERENCES users(user_id),
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT
);

-- An AI-drafted, evidence-backed proposal awaiting a human decision.
-- Numbers live in figures_json (computed in code from tool outputs); the model's prose references them
-- by key, so no figure in a brief is model-generated. Only POST /api/briefs/:id/decision changes status.
CREATE TABLE decision_briefs (
  brief_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_type          TEXT NOT NULL CHECK (brief_type IN ('renewal', 'maintenance')),
  status              TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revision_requested', 'superseded')),
  priority            TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  required_approver   TEXT NOT NULL CHECK (required_approver IN ('AUTO_APPROVE', 'PROPERTY_MANAGER', 'REGIONAL_DIRECTOR')),
  lease_id            INTEGER REFERENCES leases(lease_id) ON DELETE SET NULL,
  ticket_id           INTEGER REFERENCES maintenance_tickets(ticket_id) ON DELETE SET NULL,
  tenant_id           TEXT REFERENCES tenants(tenant_id) ON DELETE SET NULL,
  unit_id             TEXT REFERENCES units(unit_id) ON DELETE SET NULL,
  agent_run_id        INTEGER REFERENCES agent_runs(run_id),
  title               TEXT NOT NULL,
  content_json        TEXT NOT NULL,    -- model output (validated): summary, options, risks, drafted message
  figures_json        TEXT NOT NULL,    -- deterministic figures with evidence ids
  evidence_json       TEXT NOT NULL,    -- citations: record ids, clause snippets, source document, section/page
  policy_json         TEXT,             -- deterministic policy result snapshot (maintenance briefs)
  grounding_json      TEXT NOT NULL,    -- grounding check report
  needs_review        INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),  -- source data missing: no prices
  model               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by          INTEGER REFERENCES users(user_id),
  decided_at          TEXT,
  selected_option     TEXT,
  decision_comment    TEXT,
  execution_json      TEXT,
  supersedes_brief_id INTEGER REFERENCES decision_briefs(brief_id)
);
CREATE INDEX idx_briefs_status ON decision_briefs(status);
CREATE INDEX idx_briefs_lease ON decision_briefs(lease_id);
CREATE INDEX idx_briefs_ticket ON decision_briefs(ticket_id);

-- Simulated action of an approved renewal brief: the renewal offer whose notice was "sent".
CREATE TABLE renewal_offers (
  offer_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id            INTEGER NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  brief_id            INTEGER NOT NULL REFERENCES decision_briefs(brief_id),
  option_key          TEXT NOT NULL,
  term_months         INTEGER,
  proposed_rent_cents INTEGER NOT NULL CHECK (proposed_rent_cents >= 0),
  new_start_date      TEXT NOT NULL,
  new_end_date        TEXT,
  notice_sent_at      TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by         INTEGER NOT NULL REFERENCES users(user_id)
);

-- Simulated outbound messages (renewal notices, technician/tenant follow-ups). Nothing is actually sent.
CREATE TABLE outbound_messages (
  message_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id        INTEGER NOT NULL REFERENCES decision_briefs(brief_id),
  recipient_type  TEXT NOT NULL CHECK (recipient_type IN ('tenant', 'technician')),
  recipient_name  TEXT,
  recipient_email TEXT,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'simulated_sent',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
