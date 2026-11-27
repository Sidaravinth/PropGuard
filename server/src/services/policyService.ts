/**
 * Glue between the database and the pure policy engine: gathers numeric facts for a ticket (with the
 * record IDs they came from), runs the engine, persists the evaluation, and updates ticket status.
 */
import { today } from "../config.js";
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { ENGINE_VERSION, evaluateTicket, type PolicyResult, type TicketFacts } from "../policy/policyEngine.js";

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
    remainingDepositCents: lease ? repo.remainingDepositCents(db, lease.lease_id) : null,
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
 * Run the deterministic policy check for a ticket and record it. Ticket status only moves between
 * open <-> flagged here; approval states are reserved for the (Day 2) human approval endpoint.
 */
export function runTicketPolicyCheck(db: DB, ticketId: number): TicketPolicyEvaluation {
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

    return { evaluation_id: Number(ins.lastInsertRowid), ticket_id: ticketId, facts, sources, result, ticket_status: status };
  });
}
