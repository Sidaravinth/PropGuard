-- 007_block_replace.sql — close an append-only loophole.
-- SQLite's INSERT OR REPLACE (REPLACE INTO) removes the conflicting row WITHOUT firing DELETE triggers
-- (unless the connection sets recursive_triggers), so the append-only triggers alone did not stop a rewrite.
-- A BEFORE INSERT trigger runs before the conflict is resolved, for every connection. No data changes.

CREATE TRIGGER audit_logs_no_replace BEFORE INSERT ON audit_logs
WHEN EXISTS (SELECT 1 FROM audit_logs WHERE audit_id = NEW.audit_id OR hash = NEW.hash)
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

-- The same loophole applied to deposit reservations: a replacement could erase a settled or active row.
CREATE TRIGGER deposit_reservations_no_replace BEFORE INSERT ON deposit_reservations
WHEN EXISTS (SELECT 1 FROM deposit_reservations
              WHERE reservation_id = NEW.reservation_id
                 OR (NEW.status IN ('reserved', 'collected') AND ticket_id = NEW.ticket_id AND status IN ('reserved', 'collected'))
                 OR (NEW.deduction_entry_id IS NOT NULL AND deduction_entry_id = NEW.deduction_entry_id))
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: a deposit reservation cannot be duplicated or replaced');
END;
