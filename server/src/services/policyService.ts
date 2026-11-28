/**
 * Glue between the database and the pure policy engine: gathers numeric facts for a ticket (with the
 * record IDs they came from), runs the engine, persists the evaluation, and updates ticket status.
 */
import { today } from "../config.js";
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { ENGINE_VERSION, evaluateTicket, type PolicyResult, type TicketFacts } from "../policy/policyEngine.js";
import { isRenewalCandidate, RENEWAL_RULES, type PaymentReliability, type RenewalPlan } from "../policy/renewalPolicy.js";
import { audit, POLICY_ENGINE, type Actor } from "./audit.js";

const RENEWAL_RULES_ACTOR: Actor = { type: "system", id: "renewal-rules" };

export interface FactSources {
  ticket_id: number;
  lease_id: number | null;
  lease_source_doc: string | null;
  /** Provenance of the deductible: the lease_field_sources row it was read from. */
  deductible_source: { section_ref: string | null; page: number | null; verbatim_snippet: string | null } | null;
  ledger_entry_ids: number[];
  as_of_month: string;
}

export interface TicketPolicyEvaluation {
  evaluation_id: number;
  ticket_id: number;
  facts: TicketFacts;
  sources: FactSources;
  result: PolicyResult;
  ticket_status: string;
}

export class NotFoundError extends Error {}

export function gatherTicketFacts(db: DB, ticketId: number): { facts: TicketFacts; sources: FactSources } {
  const ticket = repo.getTicket(db, ticketId);
  if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found`);

  const lease = repo.findGoverningLease(db, ticket.unit_id, ticket.tenant_id);
  const tenantId = ticket.tenant_id ?? lease?.tenant_id ?? null;
  const asOfMonth = today().slice(0, 7);
  const ledger = tenantId ? repo.getLedger(db, tenantId) : [];
  const deductibleSource = lease
    ? repo.getFieldSources(db, lease.lease_id).find((s) => s.field_name === "repair_deductible") ?? null
    : null;

  const facts: TicketFacts = {
    workOrderCents: ticket.work_order_amount_cents,
    quoteCents: ticket.technician_quote_amount_cents,
    leaseFound: lease !== undefined,
    // Only verified ("extracted") values reach the lease columns, so a needs_review deductible is null here.
    deductibleCents: lease?.repair_deductible_cents ?? null,
    unpaidBalanceCents: tenantId ? repo.unpaidBalanceCents(db, tenantId, asOfMonth) : 0,
    // Other tickets' reserved and collected charges reduce what is available; this ticket's own does not.
    remainingDepositCents: lease ? repo.remainingDepositCents(db, lease.lease_id, ticket.ticket_id) : null,
    proposedTenantChargeCents: ticket.proposed_tenant_charge_cents,
  };

  return {
    facts,
    sources: {
      ticket_id: ticket.ticket_id,
      lease_id: lease?.lease_id ?? null,
      lease_source_doc: lease?.source_doc_name ?? null,
      deductible_source: deductibleSource
        ? { section_ref: deductibleSource.section_ref, page: deductibleSource.page, verbatim_snippet: deductibleSource.verbatim_snippet }
        : null,
      ledger_entry_ids: ledger.filter((e) => e.month <= asOfMonth && e.amount_due_cents > e.amount_paid_cents).map((e) => e.entry_id),
      as_of_month: asOfMonth,
    },
  };
}

/**
 * Record one run of the deterministic renewal rules (policy/renewalPolicy.ts) in the audit trail:
 * input values, each rule applied and the approver required. It changes no data.
 */
export function auditRenewalEvaluation(
  db: DB,
  leaseId: number,
  evaluation: { triggeredBy: string; asOf: string; daysUntilEnd: number | null; plan: RenewalPlan; reliability: PaymentReliability | null; needsReview: boolean; briefId?: number },
): void {
  const lease = repo.getLeaseRow(db, leaseId)!;
  const { plan, reliability } = evaluation;
  const inWindow = isRenewalCandidate(evaluation.daysUntilEnd, lease.notice_period_days);
  audit(db, {
    event_type: "policy_evaluation",
    actor: RENEWAL_RULES_ACTOR,
    subject: { type: "lease", id: leaseId },
    brief_id: evaluation.briefId ?? null,
    payload: {
      rule_set: "renewal",
      triggered_by: evaluation.triggeredBy,
      input: { start_date: lease.start_date, end_date: lease.end_date, monthly_rent_cents: lease.monthly_rent_cents, notice_period_days: lease.notice_period_days, as_of: evaluation.asOf },
      rule_trace: [
        { rule: "RENEWAL_WINDOW", passed: inWindow, detail: `${evaluation.daysUntilEnd} days to lease end; window ${RENEWAL_RULES.WINDOW_DAYS} days or the notice period if longer` },
        { rule: "SOURCE_DATA_COMPLETE", passed: !plan.missing.length, detail: plan.missing.length ? `missing: ${plan.missing.join(", ")}` : "all pricing inputs present" },
        { rule: "RENEWAL_PRICING", passed: plan.options.every((o) => o.proposed_rent_cents !== null), detail: plan.options.map((o) => `${o.key}=${o.proposed_rent_cents ?? "not priced"}`).join(", ") },
        { rule: "PAYMENT_RELIABILITY", passed: reliability?.rating !== "at_risk", detail: reliability ? `${reliability.rating}; ${reliability.paid_on_time}/${reliability.months_on_record} on time; outstanding ${reliability.outstanding_cents} cents` : "no tenant linked" },
      ],
      approver_required: RENEWAL_RULES.REQUIRED_APPROVER,
      needs_review: evaluation.needsReview,
    },
  });
}

/**
 * Run the deterministic policy check for a ticket and record it. Ticket status only moves between
 * open <-> flagged here; approval states are reserved for the (Day 2) human approval endpoint.
 */
export function runTicketPolicyCheck(db: DB, ticketId: number, opts: { triggeredBy?: Actor } = {}): TicketPolicyEvaluation {
  return tx(db, () => {
    const { facts, sources } = gatherTicketFacts(db, ticketId);
    const result = evaluateTicket(facts);

    const ins = db
      .prepare("INSERT INTO policy_evaluations (ticket_id, input_json, result_json, engine_version) VALUES (?, ?, ?, ?)")
      .run(ticketId, JSON.stringify({ facts, sources }), JSON.stringify(result), ENGINE_VERSION);

    const ticket = repo.getTicket(db, ticketId)!;
    let status = ticket.status;
    if (status === "open" || status === "flagged") {
      status = result.verdict === "EXCEPTION" ? "flagged" : "open";
      repo.setTicketStatus(db, ticketId, status);
    }
    const evaluationId = Number(ins.lastInsertRowid);

    // Every deterministic evaluation is audited: exact inputs, rules triggered, verdict and approver.
    audit(db, {
      event_type: "policy_evaluation",
      actor: POLICY_ENGINE,
      subject: { type: "ticket", id: ticketId },
      payload: {
        evaluation_id: evaluationId,
        triggered_by: opts.triggeredBy?.id ?? "system",
        input: facts,
        sources,
        verdict: result.verdict,
        approver_required: result.approverRequired,
        auto_approve_eligible: result.autoApproveEligible,
        exceptions: result.exceptions.map((e) => e.code),
        rule_trace: result.ruleTrace,
        ticket_status: { before: ticket.status, after: status },
      },
    });

    return { evaluation_id: evaluationId, ticket_id: ticketId, facts, sources, result, ticket_status: status };
  });
}
