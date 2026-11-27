/** Read models for maintenance tickets: names, the latest deterministic evaluation, the governing lease. */
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
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

export function ticketListItem(db: DB, t: repo.TicketRow) {
  return { ...t, ...names(db, t), latest: latestEvaluation(db, t.ticket_id) };
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
    /** Decision Briefs arrive with the AI agent (Day 2 Group C). */
    decision_briefs: [] as unknown[],
  };
}
