-- 006_approval_integrity.sql — approval safety: one renewal decision per lease cycle (and, below, deposit reservations).
-- Additive: no existing column is changed or removed and no row is deleted.

-- A renewal cycle is a lease plus the end date it is renewing from.
ALTER TABLE decision_briefs ADD COLUMN renewal_cycle TEXT;

-- Existing renewal briefs: take the cycle from the lease_end figure stored with each brief.
UPDATE decision_briefs
   SET renewal_cycle = (SELECT json_extract(f.value, '$.value') FROM json_each(decision_briefs.figures_json) AS f
                         WHERE json_extract(f.value, '$.key') = 'lease_end')
 WHERE brief_type = 'renewal';

-- Only undecided duplicates are superseded (the newest stays pending). Human decisions are never touched.
UPDATE decision_briefs SET status = 'superseded'
 WHERE brief_type = 'renewal' AND status = 'pending'
   AND EXISTS (SELECT 1 FROM decision_briefs AS n
                WHERE n.brief_type = 'renewal' AND n.status = 'pending' AND n.lease_id = decision_briefs.lease_id
                  AND n.renewal_cycle = decision_briefs.renewal_cycle AND n.brief_id > decision_briefs.brief_id);

CREATE UNIQUE INDEX ux_briefs_pending_renewal_cycle ON decision_briefs(lease_id, renewal_cycle)
  WHERE brief_type = 'renewal' AND status = 'pending';

-- Approved tenant charges against a security deposit.
--   reserved  -> holds part of the deposit from the moment of approval
--   collected -> moved into deposit_ledger as exactly one 'deduction' (no longer counted as reserved)
--   released  -> cancelled; holds nothing
-- Available deposit = held - deductions - reserved, so a charge is only ever counted once.
-- RESTRICT: a lease or ticket with this history cannot be deleted from under it.
CREATE TABLE deposit_reservations (
  reservation_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id           INTEGER NOT NULL REFERENCES leases(lease_id) ON DELETE RESTRICT,
  ticket_id          INTEGER NOT NULL REFERENCES maintenance_tickets(ticket_id) ON DELETE RESTRICT,
  brief_id           INTEGER REFERENCES decision_briefs(brief_id),
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  required_tier      TEXT NOT NULL CHECK (required_tier IN ('AUTO_APPROVE', 'PROPERTY_MANAGER', 'REGIONAL_DIRECTOR')),
  status             TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'collected', 'released')),
  reserved_by        INTEGER NOT NULL REFERENCES users(user_id),
  reserved_at        TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_by        INTEGER REFERENCES users(user_id),
  resolved_at        TEXT,
  release_reason     TEXT,
  deduction_entry_id INTEGER UNIQUE REFERENCES deposit_ledger(entry_id),
  CHECK ((status = 'collected') = (deduction_entry_id IS NOT NULL)),
  CHECK (status != 'released' OR length(trim(release_reason)) > 0)
);
CREATE UNIQUE INDEX ux_reservation_active_ticket ON deposit_reservations(ticket_id) WHERE status IN ('reserved', 'collected');
CREATE INDEX idx_reservations_lease ON deposit_reservations(lease_id, status);

-- Collected and released are final, and the amount and subject of a reservation never change.
CREATE TRIGGER deposit_reservations_final BEFORE UPDATE ON deposit_reservations
WHEN OLD.status != 'reserved' OR NEW.amount_cents != OLD.amount_cents OR NEW.lease_id != OLD.lease_id OR NEW.ticket_id != OLD.ticket_id
BEGIN
  SELECT RAISE(ABORT, 'constraint failed: deposit reservation is final');
END;
CREATE TRIGGER deposit_reservations_no_delete BEFORE DELETE ON deposit_reservations
BEGIN
  SELECT RAISE(ABORT, 'constraint failed: deposit reservations cannot be deleted');
END;
