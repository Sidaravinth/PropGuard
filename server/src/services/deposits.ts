/**
 * Approved tenant charges against a security deposit: reserve on approval, then collect or release.
 * Human-only; the agent module has no access to this file (enforced by tests/boundaries and agent tests).
 */
import { ApiError } from "../api/errors.js";
import type { PublicUser } from "../auth/authService.js";
import { canApproveTier } from "../auth/permissions.js";
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { formatUsd, type ApprovalTier } from "../policy/policyEngine.js";
import { audit, humanActor } from "./audit.js";

export interface ReservationRow {
  reservation_id: number;
  lease_id: number;
  ticket_id: number;
  brief_id: number | null;
  amount_cents: number;
  required_tier: ApprovalTier;
  status: "reserved" | "collected" | "released";
  reserved_by: number;
  reserved_at: string;
  resolved_by: number | null;
  resolved_at: string | null;
  release_reason: string | null;
  deduction_entry_id: number | null;
}

const getReservation = (db: DB, id: number) =>
  db.prepare("SELECT * FROM deposit_reservations WHERE reservation_id = ?").get(id) as unknown as ReservationRow | undefined;

export function listReservations(db: DB, ticketId: number) {
  return db
    .prepare(
      `SELECT r.*, a.display_name AS reserved_by_name, b.display_name AS resolved_by_name
         FROM deposit_reservations r JOIN users a ON a.user_id = r.reserved_by LEFT JOIN users b ON b.user_id = r.resolved_by
        WHERE r.ticket_id = ? ORDER BY r.reservation_id DESC`,
    )
    .all(ticketId) as unknown as (ReservationRow & { reserved_by_name: string; resolved_by_name: string | null })[];
}

/**
 * Reserve a ticket's proposed tenant charge. Call inside the approval's transaction, after the policy engine
 * has passed the charge; the amount is checked once more here so a reservation can never exceed the deposit.
 * Returns null when the ticket proposes no charge.
 */
export function reserveTenantCharge(db: DB, ticketId: number, opts: { tier: ApprovalTier; user: PublicUser; briefId: number | null }): ReservationRow | null {
  const ticket = repo.getTicket(db, ticketId)!;
  const amount = ticket.proposed_tenant_charge_cents;
  if (!amount) return null;
  const lease = repo.findGoverningLease(db, ticket.unit_id, ticket.tenant_id);
  const available = lease ? repo.remainingDepositCents(db, lease.lease_id) : null;
  if (!lease || available === null || amount > available) {
    throw new ApiError(409, "POLICY_BLOCKED", `The proposed tenant charge ${formatUsd(amount)} exceeds the available security deposit (${available === null ? "none recorded" : formatUsd(available)}).`);
  }
  const id = Number(
    db
      .prepare("INSERT INTO deposit_reservations (lease_id, ticket_id, brief_id, amount_cents, required_tier, reserved_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(lease.lease_id, ticketId, opts.briefId, amount, opts.tier, opts.user.user_id).lastInsertRowid,
  );
  audit(db, {
    event_type: "deposit_reserved",
    actor: humanActor(opts.user),
    subject: { type: "ticket", id: ticketId },
    brief_id: opts.briefId,
    payload: { reservation_id: id, lease_id: lease.lease_id, amount_cents: amount, deposit: repo.depositPosition(db, lease.lease_id) },
  });
  return getReservation(db, id)!;
}

type Resolution = { to: "collected" } | { to: "released"; reason: string };

function resolve(db: DB, reservationId: number, user: PublicUser, how: Resolution): ReservationRow {
  const found = getReservation(db, reservationId);
  if (!found) throw new ApiError(404, "NOT_FOUND", `Reservation ${reservationId} not found`);
  if (!canApproveTier(user.role, found.required_tier)) {
    audit(db, {
      event_type: "approval_denied",
      actor: humanActor(user),
      subject: { type: "ticket", id: found.ticket_id },
      brief_id: found.brief_id,
      payload: { action: how.to === "collected" ? "collect_deposit_charge" : "release_deposit_charge", reservation_id: reservationId, required_approver: found.required_tier, approver_role: user.role },
    });
    throw new ApiError(403, "APPROVER_ROLE_REQUIRED", `This charge requires ${found.required_tier === "REGIONAL_DIRECTOR" ? "a Regional Director" : "a Property Manager"} (your role: ${user.role}).`);
  }
  return tx(db, () => {
    const r = getReservation(db, reservationId)!;
    if (r.status !== "reserved") throw new ApiError(409, "RESERVATION_NOT_ACTIVE", `Reservation ${reservationId} is already ${r.status}.`);
    let entryId: number | null = null;
    if (how.to === "collected") {
      // The recorded deposit may have been corrected downward since approval: never collect more than is held.
      const position = repo.depositPosition(db, r.lease_id);
      if (!position || r.amount_cents > position.held_cents - position.collected_cents) {
        throw new ApiError(409, "DEPOSIT_INSUFFICIENT", "The recorded security deposit no longer covers this charge; correct the lease or release the reservation.");
      }
      // The deduction and the status change commit together: the charge moves from reserved to collected.
      entryId = Number(
        db
          .prepare("INSERT INTO deposit_ledger (lease_id, entry_type, amount_cents, note) VALUES (?, 'deduction', ?, ?)")
          .run(r.lease_id, r.amount_cents, `Tenant charge for ticket ${r.ticket_id} (reservation ${reservationId})`).lastInsertRowid,
      );
    }
    db.prepare(
      "UPDATE deposit_reservations SET status = ?, resolved_by = ?, resolved_at = datetime('now'), release_reason = ?, deduction_entry_id = ? WHERE reservation_id = ?",
    ).run(how.to, user.user_id, how.to === "released" ? how.reason : null, entryId, reservationId);
    audit(db, {
      event_type: how.to === "collected" ? "deposit_collected" : "deposit_released",
      actor: humanActor(user),
      subject: { type: "ticket", id: r.ticket_id },
      brief_id: r.brief_id,
      payload: {
        reservation_id: reservationId,
        lease_id: r.lease_id,
        amount_cents: r.amount_cents,
        ...(how.to === "released" ? { reason: how.reason } : { deduction_entry_id: entryId }),
        deposit: repo.depositPosition(db, r.lease_id),
      },
    });
    return getReservation(db, reservationId)!;
  });
}

export const collectReservation = (db: DB, id: number, user: PublicUser) => resolve(db, id, user, { to: "collected" });
export const releaseReservation = (db: DB, id: number, user: PublicUser, reason: string) => resolve(db, id, user, { to: "released", reason: reason.trim() });
