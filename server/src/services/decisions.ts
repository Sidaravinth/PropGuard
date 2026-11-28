/**
 * Human decisions on Decision Briefs — the ONLY code path that changes a brief's status or executes its
 * action. Approval: verify role on the backend, re-verify every figure against the database, re-run the
 * deterministic policy check, then execute the fixed (simulated) action and audit it, in one transaction.
 * The agent module has no access to this file (enforced by tests/boundaries.test.ts).
 */
import { ApiError } from "../api/errors.js";
import type { PublicUser } from "../auth/authService.js";
import { canApproveTier } from "../auth/permissions.js";
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import type { MaintenanceAction } from "../agent/briefSchemas.js";
import { displayFor, type Figure } from "../agent/evidence.js";
import { verifyFigures } from "../agent/figures.js";
import { renderTemplate } from "../agent/grounding.js";
import { formatUsd, type ApprovalTier, type PolicyResult } from "../policy/policyEngine.js";
import { paymentReliability, renewalPlan, type RenewalOption, type RenewalOptionKey } from "../policy/renewalPolicy.js";
import { today } from "../config.js";
import { closedReason } from "./approvalGuards.js";
import { chargeDiscrepancy, tenantChargeLine } from "../agent/chargeNotice.js";
import { audit, humanActor } from "./audit.js";
import { briefView, getBriefRow, type BriefRow } from "./briefs.js";
import { reserveTenantCharge } from "./deposits.js";
import { auditRenewalEvaluation, runTicketPolicyCheck } from "./policyService.js";

export type DecisionKind = "approve" | "reject" | "request_revision";
export interface DecisionInput {
  decision: DecisionKind;
  option_key?: string | null;
  comment?: string | null;
}

const STATUS: Record<DecisionKind, BriefRow["status"]> = { approve: "approved", reject: "rejected", request_revision: "revision_requested" };
/** A charge to the tenant above the remaining deposit is a hard rule: no approver can override it. */
const DEPOSIT_BLOCKERS = ["DEPOSIT_CAP_EXCEEDED", "DEPOSIT_UNKNOWN"];

type DraftMessage = { recipient: "tenant" | "technician"; subject: string; body: string };

/** States the human's decision in words chosen by code, so a sent message can never contradict it. */
function statusLine(action: MaintenanceAction, approvedAmountCents: number | null): string {
  switch (action) {
    case "approve_at_work_order":
      return `Status: repair APPROVED at ${formatUsd(approvedAmountCents!)} (the work order amount).`;
    case "approve_at_quote":
      return `Status: repair APPROVED at ${formatUsd(approvedAmountCents!)} (the technician quote).`;
    case "request_revised_quote":
      return "Status: NOT APPROVED. A revised quote has been requested; the work is not authorised.";
    case "hold_until_balance_paid":
      return "Status: ON HOLD, NOT APPROVED. The work is not authorised while the outstanding balance is unpaid.";
  }
}

/** The approved renewal offer, stated by code from the deterministic renewal plan. */
function renewalStatusLine(offer: RenewalOption): string {
  const term = offer.new_end_date
    ? `from ${displayFor("date", offer.new_start_date)} to ${displayFor("date", offer.new_end_date)}`
    : `month-to-month from ${displayFor("date", offer.new_start_date)}`;
  return `Status: renewal offer APPROVED by management: ${offer.name} at ${formatUsd(offer.proposed_rent_cents!)} per month, ${term}.`;
}

function conflict(code: string, message: string, details?: unknown): never {
  throw new ApiError(409, code, message, details);
}

function recordMessage(db: DB, briefId: number, msg: { recipient_type: "tenant" | "technician"; name: string | null; email: string | null; subject: string; body: string }) {
  const id = Number(
    db
      .prepare("INSERT INTO outbound_messages (brief_id, recipient_type, recipient_name, recipient_email, subject, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(briefId, msg.recipient_type, msg.name, msg.email, msg.subject, msg.body).lastInsertRowid,
  );
  return { message_id: id, recipient_type: msg.recipient_type, recipient_name: msg.name, recipient_email: msg.email, subject: msg.subject, status: "simulated_sent" };
}

class RoleDenied extends Error {
  constructor(
    readonly tier: ApprovalTier,
    readonly optionKey: string,
  ) {
    super("role denied");
  }
}

export function decideBrief(db: DB, briefId: number, user: PublicUser, input: DecisionInput) {
  const actor = humanActor(user);
  try {
    return decideInTx(db, briefId, user, input);
  } catch (err) {
    if (!(err instanceof RoleDenied)) throw err;
    // Recorded outside the rolled-back transaction so refused approvals are always in the audit trail.
    audit(db, {
      event_type: "approval_denied",
      actor,
      subject: { type: "brief", id: briefId },
      brief_id: briefId,
      payload: { required_approver: err.tier, approver_role: user.role, option_key: err.optionKey },
    });
    throw new ApiError(403, "APPROVER_ROLE_REQUIRED", `This decision requires ${err.tier === "REGIONAL_DIRECTOR" ? "a Regional Director" : "a Property Manager"} (your role: ${user.role}).`);
  }
}

/**
 * A human decision on a ticket that has NO policy exception but is over the auto-approval limit.
 * The Day 1 engine, run now, decides whether that is so and which role may decide; no AI is involved.
 * Tickets with exceptions are decided through their Decision Brief. Ticket text is never read here.
 */
export function decideTicket(db: DB, ticketId: number, user: PublicUser, input: { decision: "approve" | "reject"; comment?: string | null }) {
  const actor = humanActor(user);
  const closed = closedReason(db, "maintenance", ticketId);
  if (closed) conflict(closed.code, closed.message);
  // Committed on its own, so that if exceptions have appeared the ticket shows as flagged afterwards.
  const ev = runTicketPolicyCheck(db, ticketId, { triggeredBy: actor });
  const { result } = ev;
  if (result.verdict !== "PASS") conflict("TICKET_HAS_EXCEPTIONS", "This ticket has policy exceptions; decide it through a Decision Brief.", result.exceptions.map((e) => e.code));
  if (result.approverRequired === "AUTO_APPROVE") conflict("APPROVAL_NOT_REQUIRED", "This repair is within the auto-approval limit and has no exceptions; it needs no manager approval.");
  const tier = result.approverRequired;
  // Approving or rejecting closes the ticket, so both need the tier's authority.
  if (!canApproveTier(user.role, tier)) {
    audit(db, { event_type: "approval_denied", actor, subject: { type: "ticket", id: ticketId }, payload: { action: `${input.decision}_ticket`, required_approver: tier, approver_role: user.role, evaluation_id: ev.evaluation_id } });
    throw new ApiError(403, "APPROVER_ROLE_REQUIRED", `This decision requires ${tier === "REGIONAL_DIRECTOR" ? "a Regional Director" : "a Property Manager"} (your role: ${user.role}).`);
  }

  return tx(db, () => {
    const ticket = repo.getTicket(db, ticketId)!;
    if (ticket.status !== "open") conflict("TICKET_NOT_OPEN", `Ticket ${ticketId} is ${ticket.status}.`);
    const status = input.decision === "approve" ? "approved" : "rejected";
    // The approved amount is the cost basis: the amount the approval tier was checked against.
    const approvedAmount = input.decision === "approve" ? result.costBasisCents : null;
    repo.setTicketStatus(db, ticketId, status);
    const reservation = input.decision === "approve" ? reserveTenantCharge(db, ticketId, { tier, user, briefId: null }) : null;
    audit(db, { event_type: "ticket_status_changed", actor, subject: { type: "ticket", id: ticketId }, payload: { from: ticket.status, to: status, approved_amount_cents: approvedAmount, action: `${input.decision}_ticket` } });
    audit(db, {
      event_type: "human_decision",
      actor,
      subject: { type: "ticket", id: ticketId },
      payload: {
        decision: input.decision,
        approver_role: user.role,
        required_approver: tier,
        approved_amount_cents: approvedAmount,
        comment: input.comment?.trim() || null,
        evaluation_id: ev.evaluation_id,
        deposit_reservation_id: reservation?.reservation_id ?? null,
      },
    });
    return { ticket: repo.getTicket(db, ticketId)!, evaluation_id: ev.evaluation_id, required_approver: tier, approved_amount_cents: approvedAmount, deposit_reservation: reservation };
  });
}

function decideInTx(db: DB, briefId: number, user: PublicUser, input: DecisionInput) {
  const actor = humanActor(user);
  return tx(db, () => {
    const b = getBriefRow(db, briefId);
    if (!b) throw new ApiError(404, "NOT_FOUND", `Brief ${briefId} not found`);
    if (b.status !== "pending") conflict("BRIEF_NOT_PENDING", `Brief ${briefId} is already ${b.status}`);
    const comment = input.comment?.trim() || null;

    if (input.decision !== "approve") {
      db.prepare("UPDATE decision_briefs SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_comment = ? WHERE brief_id = ?").run(
        STATUS[input.decision], user.user_id, comment, briefId,
      );
      audit(db, {
        event_type: "human_decision",
        actor,
        subject: { type: "brief", id: briefId },
        brief_id: briefId,
        payload: { decision: input.decision, approver_role: user.role, comment, brief_type: b.brief_type, lease_id: b.lease_id, ticket_id: b.ticket_id },
      });
      return briefView(db, getBriefRow(db, briefId)!);
    }

    // ---- approval guards (all deterministic, all on the server) ----
    const content = JSON.parse(b.content_json) as { options: { key: string; action?: MaintenanceAction; message?: DraftMessage; email?: { subject: string; body: string } }[] };
    const figures = JSON.parse(b.figures_json) as Figure[];
    const grounding = JSON.parse(b.grounding_json) as { passed: boolean };
    const option = content.options.find((o) => o.key === input.option_key);
    if (!option) throw new ApiError(400, "OPTION_REQUIRED", `Select one of the brief's options: ${content.options.map((o) => o.key).join(", ")}`);
    // Older briefs have one shared message or email that may not match the chosen option. Never send it.
    if (b.brief_type === "maintenance" ? !option.message : !option.email) {
      conflict("BRIEF_OUTDATED_FORMAT", "This brief was drafted before each option had its own message. Regenerate it before approving.");
    }
    if (!grounding.passed) conflict("GROUNDING_FAILED", "This brief contains figures that could not be matched to the database. Reject it or request a revision.");
    if (b.needs_review) conflict("NEEDS_DATA_REVIEW", "Source data is missing for this lease; correct it in Lease Management and regenerate the brief before approving.");
    // Spend is approved at most once per ticket, and a renewal at most once per lease cycle.
    const closed = closedReason(db, b.brief_type, (b.brief_type === "renewal" ? b.lease_id : b.ticket_id)!);
    if (closed) conflict(closed.code, closed.message);

    const fresh = verifyFigures(db, figures);
    if (!fresh.ok) conflict("STALE_BRIEF", "The records behind this brief changed since it was generated; regenerate it.", fresh.mismatches);

    let tier: ApprovalTier = b.required_approver;
    let policyCheck: { evaluation_id: number; verdict: string; approver_required: string; exceptions: string[] } | null = null;
    let runPolicy: PolicyResult | null = null;
    if (b.brief_type === "maintenance") {
      // Re-run the deterministic engine now; its tier, not the brief's, decides who may approve.
      const ev = runTicketPolicyCheck(db, b.ticket_id!, { triggeredBy: actor });
      runPolicy = ev.result;
      const codes = ev.result.exceptions.map((e) => e.code);
      policyCheck = { evaluation_id: ev.evaluation_id, verdict: ev.result.verdict, approver_required: ev.result.approverRequired, exceptions: codes };
      const before = (JSON.parse(b.policy_json!) as { exceptions: { code: string }[] }).exceptions.map((e) => e.code);
      if (before.sort().join() !== [...codes].sort().join()) conflict("STALE_BRIEF", "The policy result changed since this brief was generated; regenerate it.", { before, now: codes });
      // Figures that came from the brief's stored evaluation must also hold in the evaluation made just now:
      // amounts can change (a part payment, say) while the exception codes stay the same.
      const restated = verifyFigures(db, figures.map((f) => (f.source.kind === "evaluation" ? { ...f, source: { ...f.source, evaluation_id: ev.evaluation_id } } : f)));
      if (!restated.ok) conflict("STALE_BRIEF", "Amounts behind this brief changed since it was generated; regenerate it.", restated.mismatches);
      if (ev.result.approverRequired !== b.required_approver) {
        conflict("STALE_BRIEF", "The required approver changed since this brief was generated; regenerate it.", { before: b.required_approver, now: ev.result.approverRequired });
      }
      tier = ev.result.approverRequired;
      if (option.action?.startsWith("approve_") && codes.some((c) => DEPOSIT_BLOCKERS.includes(c))) {
        conflict("POLICY_BLOCKED", "The proposed tenant charge exceeds the remaining security deposit (or no deposit is recorded). Approving spend is blocked until the charge is corrected.");
      }
    }
    if (!canApproveTier(user.role, tier)) throw new RoleDenied(tier, option.key);

    // ---- execute the fixed, simulated action ----
    let execution: Record<string, unknown>;
    if (b.brief_type === "renewal") {
      const lease = repo.getLeaseRow(db, b.lease_id!)!;
      const renewal = renewalPlan(lease);
      const plan = renewal.options.find((o) => o.key === (option.key as RenewalOptionKey))!;
      if (plan.proposed_rent_cents === null || !plan.new_start_date) conflict("OPTION_NOT_PRICED", `Option ${option.key} has no price because source data is missing.`);
      // The rules are run again at approval; that evaluation is logged with the decision it supports.
      auditRenewalEvaluation(db, lease.lease_id, {
        triggeredBy: actor.id, asOf: today(), daysUntilEnd: repo.leaseSummary(db, lease).days_until_end, plan: renewal, needsReview: renewal.missing.length > 0, briefId,
        reliability: lease.tenant_id ? paymentReliability(repo.getLedger(db, lease.tenant_id), today().slice(0, 7)) : null,
      });
      const offerId = Number(
        db
          .prepare(
            `INSERT INTO renewal_offers (lease_id, brief_id, option_key, term_months, proposed_rent_cents, new_start_date, new_end_date, approved_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(lease.lease_id, briefId, option.key, plan.term_months, plan.proposed_rent_cents, plan.new_start_date, plan.new_end_date, user.user_id).lastInsertRowid,
      );
      const tenant = lease.tenant_id ? repo.getTenant(db, lease.tenant_id) : undefined;
      const message = recordMessage(db, briefId, {
        recipient_type: "tenant", name: tenant?.name ?? null, email: tenant?.email ?? null,
        // Only the approved option's notice, under a first line that code writes from the offer just recorded.
        subject: renderTemplate(option.email!.subject, figures), body: `${renewalStatusLine(plan)}\n\n${renderTemplate(option.email!.body, figures)}`,
      });
      execution = {
        action: "renewal_notice_sent",
        renewal_offer: { offer_id: offerId, option_key: option.key, term_months: plan.term_months, proposed_rent_cents: plan.proposed_rent_cents, new_start_date: plan.new_start_date, new_end_date: plan.new_end_date },
        message,
      };
      audit(db, { event_type: "renewal_offer_sent", actor, subject: { type: "lease", id: lease.lease_id }, brief_id: briefId, payload: execution });
    } else {
      const ticket = repo.getTicket(db, b.ticket_id!)!;
      const action = option.action!;
      const approvedAmount = action === "approve_at_work_order" ? ticket.work_order_amount_cents : action === "approve_at_quote" ? ticket.technician_quote_amount_cents : null;
      const newStatus = approvedAmount !== null ? "approved" : ticket.status;
      if (newStatus !== ticket.status) {
        repo.setTicketStatus(db, ticket.ticket_id, newStatus);
        audit(db, {
          event_type: "ticket_status_changed",
          actor,
          subject: { type: "ticket", id: ticket.ticket_id },
          brief_id: briefId,
          payload: { from: ticket.status, to: newStatus, approved_amount_cents: approvedAmount, action },
        });
      }
      // Approving spend holds the proposed tenant charge against the deposit in this same transaction.
      const reservation = approvedAmount !== null ? reserveTenantCharge(db, ticket.ticket_id, { tier, user, briefId }) : null;
      const msg = option.message!;
      // A message to the tenant states, in code, what this decision actually reserves.
      const chargeLine =
        msg.recipient === "tenant"
          ? `\n${tenantChargeLine(reservation?.amount_cents ?? null, chargeDiscrepancy(runPolicy))}`
          : "";
      const tenant = ticket.tenant_id ? repo.getTenant(db, ticket.tenant_id) : undefined;
      const message = recordMessage(db, briefId, {
        recipient_type: msg.recipient,
        name: msg.recipient === "tenant" ? tenant?.name ?? null : "Assigned technician",
        email: msg.recipient === "tenant" ? tenant?.email ?? null : null,
        subject: renderTemplate(msg.subject, figures),
        body: `${statusLine(action, approvedAmount)}${chargeLine}\n\n${renderTemplate(msg.body, figures)}`,
      });
      const deposit_reservation = reservation ? { reservation_id: reservation.reservation_id, amount_cents: reservation.amount_cents, status: reservation.status } : null;
      execution = { action, ticket_status: { from: ticket.status, to: newStatus }, approved_amount_cents: approvedAmount, policy_check: policyCheck, message, deposit_reservation };
    }
    audit(db, { event_type: "message_sent", actor, subject: { type: "brief", id: briefId }, brief_id: briefId, payload: { simulated: true, ...(execution.message as object) } });

    db.prepare(
      "UPDATE decision_briefs SET status = 'approved', decided_by = ?, decided_at = datetime('now'), selected_option = ?, decision_comment = ?, execution_json = ? WHERE brief_id = ?",
    ).run(user.user_id, option.key, comment, JSON.stringify(execution), briefId);
    audit(db, {
      event_type: "human_decision",
      actor,
      subject: { type: "brief", id: briefId },
      brief_id: briefId,
      payload: { decision: "approve", approver_role: user.role, required_approver: tier, selected_option: option.key, comment, figures_reverified: figures.length, execution },
    });
    return briefView(db, getBriefRow(db, briefId)!);
  });
}
