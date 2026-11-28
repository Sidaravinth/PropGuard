/**
 * Deterministic "has this already been decided?" checks, shared by brief generation and approval.
 * Read-only.
 */
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { addDays } from "../policy/renewalPolicy.js";

/** A ticket in one of these states has had its spend decision; it takes no further brief or approval. */
export const CLOSED_TICKET_STATUSES: readonly string[] = ["approved", "completed", "rejected"];

/** A renewal cycle (lease + the end date being renewed) is closed once any renewal of it was approved. */
export function isRenewalCycleApproved(db: DB, leaseId: number, cycle: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM decision_briefs WHERE brief_type = 'renewal' AND status = 'approved' AND lease_id = ? AND renewal_cycle = ?
         UNION ALL SELECT 1 FROM renewal_offers WHERE lease_id = ? AND new_start_date = ?`,
      )
      .get(leaseId, cycle, leaseId, addDays(cycle, 1)),
  );
}

/** Whether the cycle has any brief at all: pending, or already decided by a human. */
export function renewalCycleHasBrief(db: DB, leaseId: number, cycle: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM decision_briefs WHERE brief_type = 'renewal' AND status != 'superseded' AND lease_id = ? AND renewal_cycle = ?")
      .get(leaseId, cycle),
  );
}

/** Why a new brief or an approval for this subject must be refused, or null if it may go ahead. */
export function closedReason(db: DB, type: "renewal" | "maintenance", subjectId: number): { code: string; message: string } | null {
  if (type === "maintenance") {
    const t = repo.getTicket(db, subjectId);
    return t && CLOSED_TICKET_STATUSES.includes(t.status)
      ? { code: "TICKET_CLOSED", message: `Ticket ${subjectId} is already ${t.status}; no further brief or approval is allowed.` }
      : null;
  }
  const lease = repo.getLeaseRow(db, subjectId);
  return lease?.end_date && isRenewalCycleApproved(db, subjectId, lease.end_date)
    ? { code: "RENEWAL_ALREADY_APPROVED", message: `A renewal of lease ${subjectId} for the term ending ${lease.end_date} is already approved.` }
    : null;
}
