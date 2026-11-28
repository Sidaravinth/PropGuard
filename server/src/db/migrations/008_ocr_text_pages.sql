-- 008_ocr_text_pages.sql: OCR-first extraction. Additive only; no row is removed.

-- Where an upload is while it is processed (status stays 'processing' meanwhile), and what was found
-- when it was inspected. NULL for rows created before this migration.
ALTER TABLE documents ADD COLUMN processing_stage TEXT
  CHECK (processing_stage IN ('uploaded', 'text_extraction', 'ocr', 'ai_extraction'));
ALTER TABLE documents ADD COLUMN page_count INTEGER CHECK (page_count >= 1);
ALTER TABLE documents ADD COLUMN text_method TEXT CHECK (text_method IN ('text', 'ocr', 'mixed'));

-- How each page's text was obtained. source_documents.raw_text still holds the text itself
-- (pages joined with '\f'), so every existing reader and citation keeps working.
CREATE TABLE source_document_pages (
  doc_id          INTEGER NOT NULL REFERENCES source_documents(doc_id) ON DELETE CASCADE,
  page            INTEGER NOT NULL CHECK (page >= 1),
  method          TEXT NOT NULL CHECK (method IN ('text', 'ocr')),
  ocr_confidence  REAL CHECK (ocr_confidence IS NULL OR (ocr_confidence >= 0 AND ocr_confidence <= 100)),
  PRIMARY KEY (doc_id, page)
);

-- New clause types: termination conditions and payment terms. SQLite cannot alter a CHECK
-- constraint, so the table is rebuilt (no other table references lease_clauses).
CREATE TABLE lease_clauses_new (
  clause_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id       INTEGER NOT NULL REFERENCES leases(lease_id) ON DELETE CASCADE,
  clause_type    TEXT NOT NULL CHECK (clause_type IN ('rent', 'deposit', 'repair', 'pet', 'notice', 'renewal', 'late_fee', 'termination', 'payment', 'other')),
  extracted_text TEXT NOT NULL,
  section_ref    TEXT,
  page           INTEGER,
  verified       INTEGER NOT NULL CHECK (verified IN (0, 1))
);
INSERT INTO lease_clauses_new (clause_id, lease_id, clause_type, extracted_text, section_ref, page, verified)
  SELECT clause_id, lease_id, clause_type, extracted_text, section_ref, page, verified FROM lease_clauses;
DROP TABLE lease_clauses;
ALTER TABLE lease_clauses_new RENAME TO lease_clauses;
CREATE INDEX idx_clauses_lease ON lease_clauses(lease_id);
