-- 001_init.sql — Day 1 core schema.
-- Conventions:
--   * All money columns are INTEGER cents (suffix _cents) so policy math never touches floats.
--   * Dates are ISO-8601 TEXT (YYYY-MM-DD); months are YYYY-MM.
--   * Nullable lease terms mean "not found in source document" — the reason lives in lease_field_sources.

CREATE TABLE units (
  unit_id         TEXT PRIMARY KEY,                 -- e.g. 'U101'
  property_name   TEXT NOT NULL,
  unit_number     TEXT NOT NULL,                    -- as written on leases ('101'); used to link ingested docs
  base_rent_cents INTEGER NOT NULL CHECK (base_rent_cents >= 0),
  UNIQUE (property_name, unit_number)
);

CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY,                       -- e.g. 'T001'
  name      TEXT NOT NULL,
  email     TEXT,                                   -- nullable: tenants created from an ingested lease may lack one
  unit_id   TEXT REFERENCES units(unit_id),
  status    TEXT NOT NULL CHECK (status IN ('active', 'notice_given', 'holdover', 'former', 'pending'))
);

-- Raw source of every ingested document: the ground truth that every citation points back to.
CREATE TABLE source_documents (
  doc_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_name    TEXT NOT NULL UNIQUE,
  sha256      TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  page_count  INTEGER NOT NULL CHECK (page_count >= 1),
  raw_text    TEXT NOT NULL,                        -- pages joined with '\f'
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE leases (
  lease_id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id                TEXT REFERENCES tenants(tenant_id),   -- NULL only when the doc could not be linked
  unit_id                  TEXT REFERENCES units(unit_id),       -- (flagged needs_review)
  start_date               TEXT,
  end_date                 TEXT,
  monthly_rent_cents       INTEGER CHECK (monthly_rent_cents >= 0),
  security_deposit_cents   INTEGER CHECK (security_deposit_cents >= 0),
  notice_period_days       INTEGER CHECK (notice_period_days >= 0),
  repair_deductible_cents  INTEGER CHECK (repair_deductible_cents >= 0),
  source_doc_name          TEXT NOT NULL UNIQUE REFERENCES source_documents(doc_name) ON DELETE CASCADE,
  extraction_status        TEXT NOT NULL CHECK (extraction_status IN ('complete', 'needs_review')),
  extraction_model         TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leases_tenant ON leases(tenant_id);
CREATE INDEX idx_leases_unit ON leases(unit_id);

-- Per-field provenance: value as found, where it was found, and whether it is trustworthy.
CREATE TABLE lease_field_sources (
  lease_id         INTEGER NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  field_name       TEXT NOT NULL,
  value_text       TEXT,
  status           TEXT NOT NULL CHECK (status IN ('extracted', 'missing', 'needs_review')),
  section_ref      TEXT,
  page             INTEGER,
  verbatim_snippet TEXT,
  note             TEXT,
  PRIMARY KEY (lease_id, field_name)
);

CREATE TABLE lease_clauses (
  clause_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id       INTEGER NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  clause_type    TEXT NOT NULL CHECK (clause_type IN ('rent', 'deposit', 'repair', 'pet', 'notice', 'renewal', 'late_fee', 'other')),
  extracted_text TEXT NOT NULL,                     -- verbatim excerpt from the source document
  section_ref    TEXT,
  page           INTEGER,
  verified       INTEGER NOT NULL CHECK (verified IN (0, 1))  -- 1 = excerpt found verbatim in source text
);
CREATE INDEX idx_clauses_lease ON lease_clauses(lease_id);

-- Deposit movements. Remaining deposit = SUM(held) - SUM(deduction); never stored as a mutable balance.
CREATE TABLE deposit_ledger (
  entry_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id     INTEGER NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  entry_type   TEXT NOT NULL CHECK (entry_type IN ('held', 'deduction')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE maintenance_tickets (
  ticket_id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id                        TEXT NOT NULL REFERENCES units(unit_id),
  tenant_id                      TEXT REFERENCES tenants(tenant_id),
  issue_summary                  TEXT NOT NULL,     -- free text; NEVER read by the policy engine
  work_order_amount_cents        INTEGER NOT NULL CHECK (work_order_amount_cents >= 0),
  technician_quote_amount_cents  INTEGER NOT NULL CHECK (technician_quote_amount_cents >= 0),
  proposed_tenant_charge_cents   INTEGER CHECK (proposed_tenant_charge_cents >= 0),
  status                         TEXT NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('open', 'flagged', 'pending_approval', 'approved', 'rejected', 'completed')),
  created_at                     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tickets_unit ON maintenance_tickets(unit_id);

CREATE TABLE payment_ledger (
  entry_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id),
  month             TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  amount_due_cents  INTEGER NOT NULL CHECK (amount_due_cents >= 0),
  amount_paid_cents INTEGER NOT NULL CHECK (amount_paid_cents >= 0),
  status            TEXT NOT NULL CHECK (status IN ('paid', 'partial', 'unpaid', 'late_paid')),
  UNIQUE (tenant_id, month)
);

-- Every deterministic policy run, with its exact inputs, so verdicts are reproducible.
CREATE TABLE policy_evaluations (
  evaluation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL REFERENCES maintenance_tickets(ticket_id) ON DELETE CASCADE,
  input_json    TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  evaluated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
