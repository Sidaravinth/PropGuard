-- 003_documents_corrections.sql — Day 2 Group B: user uploads, original-file storage, extraction corrections.

-- One row per uploaded file. The original bytes live in the document store (data/uploads by default),
-- addressed by storage_key; only metadata is kept here. A row exists even when extraction fails, so the
-- original is never lost and extraction can be retried.
CREATE TABLE documents (
  document_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL CHECK (kind IN ('lease', 'tenant_import', 'ledger_import')),
  doc_name          TEXT NOT NULL UNIQUE,            -- unique display name; equals source_documents.doc_name once text is extracted
  original_filename TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256            TEXT NOT NULL UNIQUE,            -- duplicate-upload prevention
  storage_key       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('processing', 'extracted', 'needs_review', 'failed')),
  error_code        TEXT,
  error_message     TEXT,
  lease_id          INTEGER REFERENCES leases(lease_id) ON DELETE SET NULL,
  uploaded_by       INTEGER REFERENCES users(user_id),
  uploaded_at       TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at      TEXT
);
CREATE INDEX idx_documents_lease ON documents(lease_id);

-- Allow a human-corrected field status. SQLite cannot alter a CHECK constraint, so the table is rebuilt.
CREATE TABLE lease_field_sources_new (
  lease_id         INTEGER NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  field_name       TEXT NOT NULL,
  value_text       TEXT,
  status           TEXT NOT NULL CHECK (status IN ('extracted', 'missing', 'needs_review', 'corrected')),
  section_ref      TEXT,
  page             INTEGER,
  verbatim_snippet TEXT,
  note             TEXT,
  PRIMARY KEY (lease_id, field_name)
);
INSERT INTO lease_field_sources_new SELECT lease_id, field_name, value_text, status, section_ref, page, verbatim_snippet, note FROM lease_field_sources;
DROP TABLE lease_field_sources;
ALTER TABLE lease_field_sources_new RENAME TO lease_field_sources;

-- Record of every human correction to extracted lease data (field values and unit/tenant links).
-- Rows can never be edited. They are removed only together with their lease (re-ingesting a document).
CREATE TABLE lease_field_corrections (
  correction_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id             INTEGER NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  field_name           TEXT NOT NULL,               -- a lease field, or 'unit_link' / 'tenant_link'
  previous_value_text  TEXT,
  previous_status      TEXT,
  new_value_text       TEXT,
  new_status           TEXT NOT NULL,
  reason               TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  corrected_by         INTEGER NOT NULL REFERENCES users(user_id),
  corrected_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_corrections_lease ON lease_field_corrections(lease_id);
CREATE TRIGGER lease_field_corrections_no_update BEFORE UPDATE ON lease_field_corrections
BEGIN
  SELECT RAISE(ABORT, 'lease_field_corrections is append-only');
END;
