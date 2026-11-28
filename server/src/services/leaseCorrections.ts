/**
 * Human corrections to extracted lease data, and linking a lease to its unit and tenant.
 *
 * Every change is validated deterministically and recorded in lease_field_corrections (who, when,
 * before, after, why). A corrected value becomes the trusted lease column that the policy engine
 * reads; the original source evidence (section, page, snippet) is kept untouched for comparison.
 */
import { ApiError } from "../api/errors.js";
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { LEASE_FIELD_NAMES, type LeaseFieldName } from "../extraction/leaseSchema.js";
import { audit, type Actor } from "./audit.js";

const COLUMN: Partial<Record<LeaseFieldName, keyof repo.LeaseRow>> = {
  start_date: "start_date",
  end_date: "end_date",
  monthly_rent: "monthly_rent_cents",
  security_deposit: "security_deposit_cents",
  notice_period_days: "notice_period_days",
  repair_deductible: "repair_deductible_cents",
};
const MONEY: readonly LeaseFieldName[] = ["monthly_rent", "security_deposit", "repair_deductible"];
const DATES: readonly LeaseFieldName[] = ["start_date", "end_date"];
const MAX_CENTS = 100_000_000; // $1,000,000

export interface CorrectionRow {
  correction_id: number;
  lease_id: number;
  field_name: string;
  previous_value_text: string | null;
  previous_status: string | null;
  new_value_text: string | null;
  new_status: string;
  reason: string;
  corrected_by: number;
  corrected_by_name?: string;
  corrected_at: string;
}

export function isLeaseField(name: string): name is LeaseFieldName {
  return (LEASE_FIELD_NAMES as string[]).includes(name);
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Validate and normalise a corrected value. Returns its canonical text (cents / YYYY-MM-DD / days / text). */
function normalise(field: LeaseFieldName, value: unknown): { text: string; typed: string | number } {
  const bad = (msg: string): never => {
    throw new ApiError(400, "VALIDATION_ERROR", `Invalid value for ${field}: ${msg}`);
  };
  if (MONEY.includes(field)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_CENTS) bad("expected integer cents between 0 and 100000000");
    return { text: String(value), typed: value as number };
  }
  if (DATES.includes(field)) {
    if (typeof value !== "string" || !isValidIsoDate(value)) bad("expected a real date as YYYY-MM-DD");
    return { text: value as string, typed: value as string };
  }
  if (field === "notice_period_days") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 730) bad("expected whole days between 0 and 730");
    return { text: String(value), typed: value as number };
  }
  if (typeof value !== "string" || !value.trim() || value.length > 200) bad("expected non-empty text (max 200 characters)");
  return { text: (value as string).trim(), typed: (value as string).trim() };
}

function record(db: DB, c: Omit<CorrectionRow, "correction_id" | "corrected_at">): void {
  db.prepare(
    `INSERT INTO lease_field_corrections (lease_id, field_name, previous_value_text, previous_status, new_value_text, new_status, reason, corrected_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.lease_id, c.field_name, c.previous_value_text, c.previous_status, c.new_value_text, c.new_status, c.reason.trim(), c.corrected_by);
}

/** extraction_status follows the data: complete only when no gaps remain. */
function refreshStatus(db: DB, leaseId: number): void {
  const lease = repo.getLeaseRow(db, leaseId)!;
  const status = repo.leaseSummary(db, lease).gaps.length === 0 ? "complete" : "needs_review";
  db.prepare("UPDATE leases SET extraction_status = ? WHERE lease_id = ?").run(status, leaseId);
  db.prepare("UPDATE documents SET status = ? WHERE lease_id = ? AND status IN ('extracted', 'needs_review')").run(
    status === "complete" ? "extracted" : "needs_review", leaseId,
  );
}

/**
 * Correct (or confirm) one extracted field. `value: null` records that the value is genuinely not in
 * the lease: the field stays "missing" and remains flagged (nothing is invented).
 */
export function correctLeaseField(db: DB, leaseId: number, field: string, value: unknown, reason: string, userId: number) {
  if (!isLeaseField(field)) throw new ApiError(404, "NOT_FOUND", `Unknown lease field "${field}"`);
  const lease = repo.getLeaseRow(db, leaseId);
  if (!lease) throw new ApiError(404, "NOT_FOUND", `Lease ${leaseId} not found`);
  if (!reason?.trim()) throw new ApiError(400, "VALIDATION_ERROR", "A reason for the correction is required");

  const norm = value === null ? null : normalise(field, value);

  // Cross-field rule: the term must end after it starts.
  if (field === "start_date" || field === "end_date") {
    const start = field === "start_date" ? (norm?.text ?? null) : lease.start_date;
    const end = field === "end_date" ? (norm?.text ?? null) : lease.end_date;
    if (start && end && end <= start) throw new ApiError(422, "INVALID_TERM", `End date ${end} must be after start date ${start}`);
  }

  return tx(db, () => {
    const before = db.prepare("SELECT value_text, status FROM lease_field_sources WHERE lease_id = ? AND field_name = ?").get(leaseId, field) as
      | { value_text: string | null; status: string }
      | undefined;
    const newStatus = norm ? "corrected" : "missing";
    if (before) {
      db.prepare("UPDATE lease_field_sources SET value_text = ?, status = ?, note = ? WHERE lease_id = ? AND field_name = ?").run(
        norm?.text ?? null, newStatus, norm ? `Corrected by reviewer: ${reason.trim()}` : `Confirmed not in document: ${reason.trim()}`, leaseId, field,
      );
    } else {
      db.prepare("INSERT INTO lease_field_sources (lease_id, field_name, value_text, status, note) VALUES (?, ?, ?, ?, ?)").run(
        leaseId, field, norm?.text ?? null, newStatus, `Corrected by reviewer: ${reason.trim()}`,
      );
    }

    const column = COLUMN[field];
    if (column) db.prepare(`UPDATE leases SET ${column} = ? WHERE lease_id = ?`).run(norm?.typed ?? null, leaseId);

    // The deposit held follows the corrected deposit; deductions already taken are kept.
    if (field === "security_deposit") {
      db.prepare("DELETE FROM deposit_ledger WHERE lease_id = ? AND entry_type = 'held'").run(leaseId);
      if (norm && (norm.typed as number) > 0) {
        db.prepare("INSERT INTO deposit_ledger (lease_id, entry_type, amount_cents, note) VALUES (?, 'held', ?, ?)").run(
          leaseId, norm.typed, `Security deposit (corrected): ${reason.trim()}`,
        );
      }
    }

    record(db, {
      lease_id: leaseId, field_name: field, previous_value_text: before?.value_text ?? null, previous_status: before?.status ?? null,
      new_value_text: norm?.text ?? null, new_status: newStatus, reason, corrected_by: userId,
    });
    refreshStatus(db, leaseId);
    // A confirmed rent on a linked lease also becomes the unit's base rent.
    return field === "monthly_rent" ? repo.syncUnitRentFromLease(db, leaseId) : null;
  });
}

/** Link (or re-link) a lease to an existing unit and, optionally, a tenant assigned to that unit. */
/** Record a base-rent change made to match a lease, in the same shape as a manual unit edit. */
export function auditUnitRentSync(db: DB, change: repo.UnitRentChange | null, actor: Actor, why: string): void {
  if (!change) return;
  audit(db, {
    event_type: "unit_updated",
    actor,
    subject: { type: "unit", id: change.unit_id },
    payload: {
      changes: { base_rent_cents: { from: change.from_cents, to: change.to_cents } },
      reason: why,
      lease_id: change.lease_id,
    },
  });
}

export function linkLease(db: DB, leaseId: number, unitId: string, tenantId: string | null, reason: string, userId: number) {
  const lease = repo.getLeaseRow(db, leaseId);
  if (!lease) throw new ApiError(404, "NOT_FOUND", `Lease ${leaseId} not found`);
  if (!repo.getUnit(db, unitId)) throw new ApiError(422, "UNKNOWN_UNIT", `Unit ${unitId} does not exist`);
  if (tenantId) {
    const t = repo.getTenant(db, tenantId);
    if (!t) throw new ApiError(422, "UNKNOWN_TENANT", `Tenant ${tenantId} does not exist`);
    if (t.unit_id !== unitId) throw new ApiError(422, "TENANT_UNIT_MISMATCH", `Tenant ${tenantId} is not assigned to unit ${unitId}`);
  }
  const why = reason?.trim() || "Linked by reviewer";
  return tx(db, (): repo.UnitRentChange | null => {
    db.prepare("UPDATE leases SET unit_id = ?, tenant_id = ? WHERE lease_id = ?").run(unitId, tenantId, leaseId);
    if (lease.unit_id !== unitId) {
      record(db, { lease_id: leaseId, field_name: "unit_link", previous_value_text: lease.unit_id, previous_status: null, new_value_text: unitId, new_status: "linked", reason: why, corrected_by: userId });
    }
    if (lease.tenant_id !== tenantId) {
      record(db, { lease_id: leaseId, field_name: "tenant_link", previous_value_text: lease.tenant_id, previous_status: null, new_value_text: tenantId, new_status: tenantId ? "linked" : "unlinked", reason: why, corrected_by: userId });
    }
    refreshStatus(db, leaseId);
    // The unit's base rent follows the agreement now linked to it.
    return repo.syncUnitRentFromLease(db, leaseId);
  });
}

export function listCorrections(db: DB, leaseId: number): CorrectionRow[] {
  return db
    .prepare(
      `SELECT c.*, u.display_name AS corrected_by_name FROM lease_field_corrections c JOIN users u ON u.user_id = c.corrected_by
        WHERE c.lease_id = ? ORDER BY c.correction_id DESC`,
    )
    .all(leaseId) as unknown as CorrectionRow[];
}
