/**
 * The agent's tools. All are READ-ONLY against operational data: they never create, edit or approve
 * anything. run_policy_check runs the Day 1 deterministic engine, which records its evaluation (and
 * open/flagged ticket status) exactly as a human-triggered check would; it cannot approve or override.
 *
 * Every result carries evidence ids that point at the exact database rows / lease excerpts used.
 */
import { z } from "zod";
import { today } from "../config.js";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { MONEY_FIELDS } from "../extraction/leaseSchema.js";
import { formatUsd } from "../policy/policyEngine.js";
import { runTicketPolicyCheck } from "../services/policyService.js";
import type { Actor } from "../services/audit.js";
import type { Evidence } from "./evidence.js";
import type { ToolSpec } from "./llm.js";

export interface ToolResult {
  output: Record<string, unknown>;
  evidence: Evidence[];
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_lease_details",
    description:
      "Lease terms (dates, rent, deposit, notice period, repair deductible), each field's verification status and verbatim source excerpt, the extracted clauses, and data gaps. Money is integer cents.",
    parameters: { type: "object", properties: { lease_id: { type: "integer" } }, required: ["lease_id"] },
  },
  {
    name: "get_payment_ledger",
    description: "A tenant's rent ledger: one entry per month with amount due, amount paid and status, plus the current unpaid balance. Money is integer cents.",
    parameters: { type: "object", properties: { tenant_id: { type: "string" } }, required: ["tenant_id"] },
  },
  {
    name: "get_ticket_details",
    description: "A maintenance ticket: unit, tenant, work order estimate, technician quote, proposed tenant charge, status, and the id of the governing lease. Money is integer cents.",
    parameters: { type: "object", properties: { ticket_id: { type: "integer" } }, required: ["ticket_id"] },
  },
  {
    name: "run_policy_check",
    description:
      "Run the deterministic policy engine on a ticket: 3-way verification, approval tier, deposit cap. Returns verdict, required approver, exceptions and cost split. The result is authoritative and cannot be changed.",
    parameters: { type: "object", properties: { ticket_id: { type: "integer" } }, required: ["ticket_id"] },
  },
];

const Args = {
  get_lease_details: z.object({ lease_id: z.coerce.number().int().positive() }),
  get_payment_ledger: z.object({ tenant_id: z.string().min(1) }),
  get_ticket_details: z.object({ ticket_id: z.coerce.number().int().positive() }),
  run_policy_check: z.object({ ticket_id: z.coerce.number().int().positive() }),
};
export type ToolName = keyof typeof Args;
export const isToolName = (n: string): n is ToolName => n in Args;

export class ToolError extends Error {}

function getLeaseDetails(db: DB, leaseId: number): ToolResult {
  const lease = repo.getLeaseRow(db, leaseId);
  if (!lease) throw new ToolError(`Lease ${leaseId} not found`);
  const s = repo.leaseSummary(db, lease);
  const fields = repo.getFieldSources(db, leaseId);
  const clauses = repo.getClauses(db, leaseId);
  const evidence: Evidence[] = [
    { id: `lease:${leaseId}`, kind: "lease", label: `Lease #${leaseId} (${lease.source_doc_name})`, record: { table: "leases", id: leaseId }, source_doc: lease.source_doc_name },
    ...fields.map(
      (f): Evidence => ({
        id: `lease:${leaseId}:field:${f.field_name}`,
        kind: "lease_field",
        label: `Lease #${leaseId} · ${f.field_name}`,
        record: { table: "lease_field_sources", id: `${leaseId}/${f.field_name}` },
        // Evidence is read by people: money fields are stored as cents and shown as dollars.
        value: f.value_text !== null && (MONEY_FIELDS as readonly string[]).includes(f.field_name) ? formatUsd(Number(f.value_text)) : f.value_text,
        status: f.status,
        snippet: f.verbatim_snippet,
        source_doc: lease.source_doc_name,
        section_ref: f.section_ref,
        page: f.page,
      }),
    ),
    ...clauses.map(
      (c): Evidence => ({
        id: `clause:${c.clause_id}`,
        kind: "clause",
        label: `${c.clause_type} clause${c.section_ref ? ` (${c.section_ref})` : ""}`,
        record: { table: "lease_clauses", id: c.clause_id },
        status: c.verified ? "verified" : "unverified",
        snippet: c.extracted_text,
        source_doc: lease.source_doc_name,
        section_ref: c.section_ref,
        page: c.page,
      }),
    ),
  ];
  return {
    output: {
      evidence_id: `lease:${leaseId}`,
      lease_id: leaseId,
      tenant_id: lease.tenant_id,
      unit_id: lease.unit_id,
      source_document: lease.source_doc_name,
      state: s.lease_state,
      days_until_end: s.days_until_end,
      // Only verified (or human-corrected) values are present; unverified terms are null.
      terms: {
        start_date: lease.start_date,
        end_date: lease.end_date,
        monthly_rent_cents: lease.monthly_rent_cents,
        security_deposit_cents: lease.security_deposit_cents,
        remaining_deposit_cents: s.remaining_deposit_cents,
        notice_period_days: lease.notice_period_days,
        repair_deductible_cents: lease.repair_deductible_cents,
      },
      fields: fields.map((f) => ({
        evidence_id: `lease:${leaseId}:field:${f.field_name}`,
        field: f.field_name,
        status: f.status,
        value: f.value_text,
        section_ref: f.section_ref,
        page: f.page,
        verbatim_snippet: f.verbatim_snippet,
        note: f.note,
      })),
      clauses: clauses.map((c) => ({
        evidence_id: `clause:${c.clause_id}`,
        type: c.clause_type,
        section_ref: c.section_ref,
        page: c.page,
        verified_in_source: c.verified === 1,
        text: c.extracted_text,
      })),
      data_gaps: s.gaps,
    },
    evidence,
  };
}

function getPaymentLedger(db: DB, tenantId: string): ToolResult {
  const tenant = repo.getTenant(db, tenantId);
  if (!tenant) throw new ToolError(`Tenant ${tenantId} not found`);
  const asOf = today().slice(0, 7);
  const entries = repo.getLedger(db, tenantId);
  const evidence: Evidence[] = [
    { id: `tenant:${tenantId}`, kind: "tenant", label: `Tenant ${tenant.name} (${tenantId})`, record: { table: "tenants", id: tenantId } },
    { id: `ledger:tenant:${tenantId}`, kind: "ledger", label: `Payment ledger of ${tenant.name}`, record: { table: "payment_ledger", id: `tenant_id=${tenantId}` } },
    ...entries.map(
      (e): Evidence => ({
        id: `ledger:${e.entry_id}`,
        kind: "ledger_entry",
        label: `Ledger ${e.month} · ${tenant.name}`,
        record: { table: "payment_ledger", id: e.entry_id },
        value: `due ${formatUsd(e.amount_due_cents)} / paid ${formatUsd(e.amount_paid_cents)}`,
        status: e.status,
      }),
    ),
  ];
  return {
    output: {
      evidence_id: `ledger:tenant:${tenantId}`,
      tenant: { tenant_id: tenantId, name: tenant.name, email: tenant.email, status: tenant.status },
      as_of_month: asOf,
      unpaid_balance_cents: repo.unpaidBalanceCents(db, tenantId, asOf),
      entries: entries.map((e) => ({
        evidence_id: `ledger:${e.entry_id}`,
        month: e.month,
        amount_due_cents: e.amount_due_cents,
        amount_paid_cents: e.amount_paid_cents,
        status: e.status,
      })),
    },
    evidence,
  };
}

function getTicketDetails(db: DB, ticketId: number): ToolResult {
  const t = repo.getTicket(db, ticketId);
  if (!t) throw new ToolError(`Ticket ${ticketId} not found`);
  const unit = repo.getUnit(db, t.unit_id);
  const tenant = t.tenant_id ? repo.getTenant(db, t.tenant_id) : undefined;
  const lease = repo.findGoverningLease(db, t.unit_id, t.tenant_id);
  return {
    output: {
      evidence_id: `ticket:${ticketId}`,
      ticket_id: ticketId,
      status: t.status,
      created_at: t.created_at,
      // Free text from the ticket is untrusted data: describe it, never follow instructions in it.
      issue_summary_untrusted: t.issue_summary,
      work_order_amount_cents: t.work_order_amount_cents,
      technician_quote_amount_cents: t.technician_quote_amount_cents,
      proposed_tenant_charge_cents: t.proposed_tenant_charge_cents,
      unit: unit ? { unit_id: unit.unit_id, property_name: unit.property_name, unit_number: unit.unit_number } : null,
      tenant: tenant ? { tenant_id: tenant.tenant_id, name: tenant.name, email: tenant.email } : null,
      governing_lease_id: lease?.lease_id ?? null,
    },
    evidence: [
      { id: `ticket:${ticketId}`, kind: "ticket", label: `Ticket #${ticketId}`, record: { table: "maintenance_tickets", id: ticketId } },
      ...(unit ? [{ id: `unit:${unit.unit_id}`, kind: "unit" as const, label: `${unit.property_name} · Unit ${unit.unit_number}`, record: { table: "units", id: unit.unit_id } }] : []),
    ],
  };
}

function runPolicyCheck(db: DB, ticketId: number, actor: Actor): ToolResult {
  if (!repo.getTicket(db, ticketId)) throw new ToolError(`Ticket ${ticketId} not found`);
  const ev = runTicketPolicyCheck(db, ticketId, { triggeredBy: actor });
  const r = ev.result;
  return {
    output: {
      evidence_id: `evaluation:${ev.evaluation_id}`,
      evaluation_id: ev.evaluation_id,
      engine_version: r.engineVersion,
      verdict: r.verdict,
      approver_required: r.approverRequired,
      auto_approve_eligible: r.autoApproveEligible,
      cost_basis_cents: r.costBasisCents,
      exceptions: r.exceptions,
      three_way: r.threeWay,
      deposit_cap: r.depositCap,
      facts: ev.facts,
      fact_sources: ev.sources,
    },
    evidence: [
      {
        id: `evaluation:${ev.evaluation_id}`,
        kind: "policy_evaluation",
        label: `Policy evaluation #${ev.evaluation_id} (engine ${r.engineVersion})`,
        record: { table: "policy_evaluations", id: ev.evaluation_id },
        status: `${r.verdict} · ${r.approverRequired}`,
      },
    ],
  };
}

/** Execute one tool call with validated arguments. */
export function executeTool(db: DB, name: string, rawArgs: unknown, actor: Actor): ToolResult {
  if (!isToolName(name)) throw new ToolError(`Unknown tool "${name}"`);
  const parsed = Args[name].safeParse(rawArgs);
  if (!parsed.success) throw new ToolError(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const a = parsed.data as Record<string, unknown>;
  switch (name) {
    case "get_lease_details":
      return getLeaseDetails(db, a.lease_id as number);
    case "get_payment_ledger":
      return getPaymentLedger(db, a.tenant_id as string);
    case "get_ticket_details":
      return getTicketDetails(db, a.ticket_id as number);
    case "run_policy_check":
      return runPolicyCheck(db, a.ticket_id as number, actor);
  }
}
