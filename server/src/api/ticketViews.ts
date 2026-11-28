/** Read models for maintenance tickets: names, the latest deterministic evaluation, the governing lease. */
import { chargeDiscrepancy } from "../agent/chargeNotice.js";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { listReservations } from "../services/deposits.js";
import { leaseListItem } from "./leaseViews.js";

export function latestEvaluation(db: DB, ticketId: number) {
  const e = repo.listPolicyEvaluations(db, ticketId)[0];
  if (!e) return null;
  return {
    evaluation_id: e.evaluation_id,
    evaluated_at: e.evaluated_at,
    verdict: e.result.verdict as string,
    approver_required: e.result.approverRequired as string,
    auto_approve_eligible: e.result.autoApproveEligible as boolean,
    exception_codes: (e.result.exceptions as { code: string }[]).map((x) => x.code),
  };
}

function names(db: DB, t: repo.TicketRow) {
  const unit = repo.getUnit(db, t.unit_id);
  const tenant = t.tenant_id ? repo.getTenant(db, t.tenant_id) : undefined;
  return {
    unit: unit ? { unit_id: unit.unit_id, property_name: unit.property_name, unit_number: unit.unit_number } : null,
    tenant: tenant ? { tenant_id: tenant.tenant_id, name: tenant.name } : null,
  };
}

/**
 * A flagged ticket whose latest brief a person rejected or sent back. Declining an AI proposal decides
 * nothing about the repair: the ticket stays flagged and still needs a resolution.
 */
function unresolvedBrief(db: DB, t: repo.TicketRow) {
  if (t.status !== "flagged") return null;
  const b = db
    .prepare(
      `SELECT b.brief_id, b.status, b.decision_comment AS comment, b.decided_at, u.display_name AS decided_by
         FROM decision_briefs b LEFT JOIN users u ON u.user_id = b.decided_by
        WHERE b.ticket_id = ? AND b.status != 'superseded' ORDER BY b.brief_id DESC LIMIT 1`,
    )
    .get(t.ticket_id) as { brief_id: number; status: string; comment: string | null; decided_at: string | null; decided_by: string | null } | undefined;
  return b && (b.status === "rejected" || b.status === "revision_requested") ? b : null;
}

export function ticketListItem(db: DB, t: repo.TicketRow) {
  return { ...t, ...names(db, t), latest: latestEvaluation(db, t.ticket_id), unresolved_brief: unresolvedBrief(db, t) };
}

/** The decision made on the ticket itself (not through a brief), as recorded in the audit trail. */
function directDecision(db: DB, ticketId: number) {
  const row = db
    .prepare("SELECT occurred_at, actor_id, payload_json FROM audit_logs WHERE event_type = 'human_decision' AND subject_type = 'ticket' AND subject_id = ? ORDER BY audit_id DESC LIMIT 1")
    .get(String(ticketId)) as { occurred_at: string; actor_id: string; payload_json: string } | undefined;
  if (!row) return null;
  const p = JSON.parse(row.payload_json) as { decision: "approve" | "reject"; approved_amount_cents: number | null; comment: string | null };
  return { decision: p.decision, approved_amount_cents: p.approved_amount_cents, comment: p.comment, decided_by: row.actor_id, decided_at: row.occurred_at };
}

export function ticketDetail(db: DB, ticketId: number) {
  const t = repo.getTicket(db, ticketId)!;
  const lease = repo.findGoverningLease(db, t.unit_id, t.tenant_id);
  const evaluations = repo.listPolicyEvaluations(db, ticketId);
  return {
    ...t,
    ...names(db, t),
    latest_policy_evaluation: evaluations[0] ?? null,
    policy_evaluations: evaluations,
    lease: lease ? leaseListItem(db, lease) : null,
    deposit_reservations: listReservations(db, ticketId),
    direct_decision: directDecision(db, ticketId),
    unresolved_brief: unresolvedBrief(db, t),
    charge_notice: chargeDiscrepancy(evaluations[0]?.result),
    decision_briefs: db
      .prepare("SELECT brief_id, status, priority, required_approver, title, created_at FROM decision_briefs WHERE ticket_id = ? ORDER BY brief_id DESC")
      .all(ticketId),
  };
}
