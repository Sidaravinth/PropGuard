-- 004_records.sql — Day 2 Group B: properties, tenant contact details, spreadsheet imports.

-- Properties become first-class records. units.property_name is kept as a synchronised copy so
-- lease linking (property name + unit number) and existing queries keep working.
CREATE TABLE properties (
  property_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  address     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO properties (name) SELECT property_name FROM units GROUP BY lower(property_name) ORDER BY MIN(rowid);

ALTER TABLE units ADD COLUMN property_id INTEGER REFERENCES properties(property_id);
UPDATE units SET property_id = (SELECT p.property_id FROM properties p WHERE p.name = units.property_name COLLATE NOCASE);
CREATE INDEX idx_units_property ON units(property_id);

-- Any unit inserted with only a property name (older code paths, sample seed) gets its property.
CREATE TRIGGER units_assign_property AFTER INSERT ON units WHEN NEW.property_id IS NULL
BEGIN
  INSERT INTO properties (name) SELECT NEW.property_name WHERE NOT EXISTS (SELECT 1 FROM properties WHERE name = NEW.property_name COLLATE NOCASE);
  UPDATE units SET property_id = (SELECT property_id FROM properties WHERE name = NEW.property_name COLLATE NOCASE) WHERE unit_id = NEW.unit_id;
END;

-- Renaming a property renames it on its units.
CREATE TRIGGER properties_sync_name AFTER UPDATE OF name ON properties
BEGIN
  UPDATE units SET property_name = NEW.name WHERE property_id = NEW.property_id;
END;

-- Moving a unit to another property keeps the copy in step.
CREATE TRIGGER units_sync_property_name AFTER UPDATE OF property_id ON units WHEN NEW.property_id IS NOT NULL
BEGIN
  UPDATE units SET property_name = (SELECT name FROM properties WHERE property_id = NEW.property_id) WHERE unit_id = NEW.unit_id;
END;

-- Spreadsheet imports are documents too: allow an 'imported' status and record the outcome.
CREATE TABLE documents_new (
  document_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL CHECK (kind IN ('lease', 'tenant_import', 'ledger_import')),
  doc_name          TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256            TEXT NOT NULL UNIQUE,
  storage_key       TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('processing', 'extracted', 'needs_review', 'failed', 'imported')),
  error_code        TEXT,
  error_message     TEXT,
  lease_id          INTEGER REFERENCES leases(lease_id) ON DELETE SET NULL,
  rows_imported     INTEGER,
  rows_skipped      INTEGER,
  uploaded_by       INTEGER REFERENCES users(user_id),
  uploaded_at       TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at      TEXT
);
INSERT INTO documents_new (document_id, kind, doc_name, original_filename, mime_type, size_bytes, sha256, storage_key, status, error_code,
                           error_message, lease_id, uploaded_by, uploaded_at, processed_at)
  SELECT document_id, kind, doc_name, original_filename, mime_type, size_bytes, sha256, storage_key, status, error_code,
         error_message, lease_id, uploaded_by, uploaded_at, processed_at FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE INDEX idx_documents_lease ON documents(lease_id);

-- Tenant contact details and provenance of imported records.
ALTER TABLE tenants ADD COLUMN phone TEXT;
ALTER TABLE tenants ADD COLUMN source_document_id INTEGER REFERENCES documents(document_id);
ALTER TABLE payment_ledger ADD COLUMN source_document_id INTEGER REFERENCES documents(document_id);
CREATE INDEX idx_ledger_tenant ON payment_ledger(tenant_id);
CREATE INDEX idx_tenants_unit ON tenants(unit_id);
