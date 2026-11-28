/**
 * Deterministic figures for Decision Briefs, and their re-verification against the database.
 * Every figure records its source (a column, a stored policy evaluation, a policy constant, or a named
 * deterministic rule over database ids), so verifyFigures() can recompute it from the current data.
 */
import { today } from "../config.js";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { POLICY } from "../policy/policyEngine.js";
import { daysBetween, paymentReliability, renewalPlan, RENEWAL_RULES, type RenewalOptionKey } from "../policy/renewalPolicy.js";
import { figure, type Figure, type FigureSource } from "./evidence.js";

// --- named deterministic rules (shared by builders and the verifier) ------------------------------

type Inputs = Record<string, string | number | null>;

function planFor(db: DB, leaseId: number) {
  const l = repo.getLeaseRow(db, leaseId);
  if (!l) throw new Error(`Lease ${leaseId} not found`);
  return renewalPlan(l);
}

const RULES: Record<string, (db: DB, i: Inputs) => number | string | null> = {
  "renewal.option_rent": (db, i) => planFor(db, Number(i.lease_id)).options.find((o) => o.key === i.option)!.proposed_rent_cents,
  "renewal.option_rent_change": (db, i) => planFor(db, Number(i.lease_id)).options.find((o) => o.key === i.option)!.rent_change_cents,
  "renewal.option_term_months": (db, i) => planFor(db, Number(i.lease_id)).options.find((o) => o.key === i.option)!.term_months,
  "renewal.option_new_start": (db, i) => planFor(db, Number(i.lease_id)).options.find((o) => o.key === i.option)!.new_start_date,
  "renewal.option_new_end": (db, i) => planFor(db, Number(i.lease_id)).options.find((o) => o.key === i.option)!.new_end_date,
  "renewal.current_term_months": (db, i) => planFor(db, Number(i.lease_id)).current_term_months,
  "renewal.notice_deadline": (db, i) => planFor(db, Number(i.lease_id)).notice_deadline,
  "renewal.days_until_end": (db, i) => {
    const l = repo.getLeaseRow(db, Number(i.lease_id));
    return l?.end_date ? daysBetween(String(i.as_of), l.end_date) : null;
  },
  "renewal.days_until_notice_deadline": (db, i) => {
    const d = planFor(db, Number(i.lease_id)).notice_deadline;
    return d ? daysBetween(String(i.as_of), d) : null;
  },
  "lease.remaining_deposit": (db, i) => repo.remainingDepositCents(db, Number(i.lease_id)),
  "payment.unpaid_balance": (db, i) => repo.unpaidBalanceCents(db, String(i.tenant_id), String(i.as_of_month)),
  "payment.metric": (db, i) => {
    const r = paymentReliability(repo.getLedger(db, String(i.tenant_id)), String(i.as_of_month));
    return r[i.metric as keyof typeof r] as number | string | null;
  },
};

const CONSTANTS: Record<string, number> = {
  AUTO_APPROVE_MAX_CENTS: POLICY.AUTO_APPROVE_MAX_CENTS,
  PROPERTY_MANAGER_MAX_CENTS: POLICY.PROPERTY_MANAGER_MAX_CENTS,
  QUOTE_TOLERANCE_PERCENT: POLICY.QUOTE_TOLERANCE_PERCENT,
  RENEWAL_WINDOW_DAYS: RENEWAL_RULES.WINDOW_DAYS,
  TWELVE_MONTH_ADJUSTMENT_PERCENT: RENEWAL_RULES.TWELVE_MONTH_ADJUSTMENT_BPS / 100,
};

const PK: Record<string, string> = { leases: "lease_id", maintenance_tickets: "ticket_id", payment_ledger: "entry_id" };

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Resolve a figure's value from the database right now. */
export function resolveSource(db: DB, s: FigureSource): number | string | null {
  switch (s.kind) {
    case "column": {
      const row = db.prepare(`SELECT ${s.column} AS v FROM ${s.table} WHERE ${PK[s.table]} = ?`).get(s.id) as { v: number | string | null } | undefined;
      if (!row) throw new Error(`${s.table} ${s.id} not found`);
      return row.v;
    }
    case "evaluation": {
      const row = db.prepare("SELECT input_json, result_json FROM policy_evaluations WHERE evaluation_id = ?").get(s.evaluation_id) as
        | { input_json: string; result_json: string }
        | undefined;
      if (!row) throw new Error(`Evaluation ${s.evaluation_id} not found`);
      const doc = { input: JSON.parse(row.input_json), result: JSON.parse(row.result_json) };
      return (getPath(doc, s.path) ?? null) as number | string | null;
    }
    case "policy_constant":
      return CONSTANTS[s.name] ?? null;
    case "derived":
      return RULES[s.rule]!(db, s.inputs);
  }
}

const col = (table: "leases" | "maintenance_tickets" | "payment_ledger", id: number, column: string): FigureSource => ({ kind: "column", table, pk: PK[table]!, id, column });
const derived = (rule: string, inputs: Inputs): FigureSource => ({ kind: "derived", rule, inputs });
const make = (db: DB, key: string, label: string, unit: Figure["unit"], evidence: string[], source: FigureSource) => figure(key, label, unit, resolveSource(db, source), evidence, source);

// --- builders -----------------------------------------------------------------------------------------

const OPTION_PREFIX: Record<RenewalOptionKey, string> = { standard: "standard", twelve_month_3pct: "twelve_month", month_to_month: "month_to_month" };

export function renewalFigures(db: DB, leaseId: number, tenantId: string | null): Figure[] {
  const asOf = today();
  const asOfMonth = asOf.slice(0, 7);
  const lf = (f: string) => [`lease:${leaseId}:field:${f}`];
  const figs: Figure[] = [
    make(db, "current_rent", "Current monthly rent", "cents", lf("monthly_rent"), col("leases", leaseId, "monthly_rent_cents")),
    make(db, "lease_start", "Current lease start", "date", lf("start_date"), col("leases", leaseId, "start_date")),
    make(db, "lease_end", "Current lease end", "date", lf("end_date"), col("leases", leaseId, "end_date")),
    make(db, "notice_period_days", "Notice period", "days", lf("notice_period_days"), col("leases", leaseId, "notice_period_days")),
    make(db, "notice_deadline", "Notice deadline (end date minus notice period)", "date", [...lf("end_date"), ...lf("notice_period_days")], derived("renewal.notice_deadline", { lease_id: leaseId })),
    make(db, "days_until_end", "Days until lease end", "days", lf("end_date"), derived("renewal.days_until_end", { lease_id: leaseId, as_of: asOf })),
    make(db, "days_until_notice_deadline", "Days until notice deadline", "days", [...lf("end_date"), ...lf("notice_period_days")], derived("renewal.days_until_notice_deadline", { lease_id: leaseId, as_of: asOf })),
    make(db, "current_term_months", "Current term length", "months", [...lf("start_date"), ...lf("end_date")], derived("renewal.current_term_months", { lease_id: leaseId })),
    make(db, "security_deposit", "Security deposit", "cents", lf("security_deposit"), col("leases", leaseId, "security_deposit_cents")),
    make(db, "remaining_deposit", "Deposit remaining", "cents", lf("security_deposit"), derived("lease.remaining_deposit", { lease_id: leaseId })),
    make(db, "renewal_window_days", "Renewal review window", "days", ["policy:renewal"], { kind: "policy_constant", name: "RENEWAL_WINDOW_DAYS" }),
    make(db, "adjustment_percent", "12-month option adjustment", "percent", ["policy:renewal"], { kind: "policy_constant", name: "TWELVE_MONTH_ADJUSTMENT_PERCENT" }),
  ];
  for (const key of ["standard", "twelve_month_3pct", "month_to_month"] as RenewalOptionKey[]) {
    const p = OPTION_PREFIX[key];
    const ev = [...lf("monthly_rent"), ...lf("end_date"), "policy:renewal"];
    const i = { lease_id: leaseId, option: key };
    figs.push(
      make(db, `${p}_rent`, `${key} · proposed monthly rent`, "cents", ev, derived("renewal.option_rent", i)),
      make(db, `${p}_rent_change`, `${key} · change vs current rent`, "cents", ev, derived("renewal.option_rent_change", i)),
      make(db, `${p}_term_months`, `${key} · term`, "months", ev, derived("renewal.option_term_months", i)),
      make(db, `${p}_start`, `${key} · new term starts`, "date", ev, derived("renewal.option_new_start", i)),
      make(db, `${p}_end`, `${key} · new term ends`, "date", ev, derived("renewal.option_new_end", i)),
    );
  }
  if (tenantId) {
    const ledgerEv = [`ledger:tenant:${tenantId}`];
    const pi = (metric: string) => derived("payment.metric", { tenant_id: tenantId, as_of_month: asOfMonth, metric });
    figs.push(
      make(db, "unpaid_balance", "Unpaid rent balance", "cents", ledgerEv, derived("payment.unpaid_balance", { tenant_id: tenantId, as_of_month: asOfMonth })),
      make(db, "months_on_record", "Ledger months on record", "count", ledgerEv, pi("months_on_record")),
      make(db, "paid_on_time_months", "Months paid on time", "count", ledgerEv, pi("paid_on_time")),
      make(db, "paid_late_months", "Months paid late", "count", ledgerEv, pi("paid_late")),
      make(db, "partial_months", "Months partially paid", "count", ledgerEv, pi("partial")),
      make(db, "unpaid_months", "Months unpaid", "count", ledgerEv, pi("unpaid")),
      make(db, "on_time_percent", "On-time payment rate", "percent", ledgerEv, pi("on_time_percent")),
    );
  }
  return figs;
}

export function maintenanceFigures(db: DB, ticketId: number, evaluationId: number, leaseId: number | null): Figure[] {
  const t = [`ticket:${ticketId}`];
  const e = [`evaluation:${evaluationId}`];
  const ev = (path: string): FigureSource => ({ kind: "evaluation", evaluation_id: evaluationId, path });
  const figs: Figure[] = [
    make(db, "work_order", "Work order estimate", "cents", t, col("maintenance_tickets", ticketId, "work_order_amount_cents")),
    make(db, "technician_quote", "Technician quote", "cents", t, col("maintenance_tickets", ticketId, "technician_quote_amount_cents")),
    make(db, "proposed_tenant_charge", "Proposed tenant charge", "cents", t, col("maintenance_tickets", ticketId, "proposed_tenant_charge_cents")),
    make(db, "quote_difference", "Quote minus work order", "cents", e, ev("result.threeWay.quoteDeltaCents")),
    make(db, "quote_variance_percent", "Quote over work order", "percent", e, ev("result.threeWay.quoteVariancePercent")),
    make(db, "cost_basis", "Repair cost used for approval (higher of quote and work order)", "cents", e, ev("result.costBasisCents")),
    make(db, "tenant_share", "Tenant pays (up to the repair deductible)", "cents", e, ev("result.threeWay.tenantShareCents")),
    make(db, "owner_share", "Owner pays", "cents", e, ev("result.threeWay.ownerShareCents")),
    make(db, "unpaid_balance", "Tenant's unpaid rent balance", "cents", e, ev("input.facts.unpaidBalanceCents")),
    make(db, "remaining_deposit", "Deposit remaining", "cents", e, ev("input.facts.remainingDepositCents")),
    make(db, "quote_tolerance_percent", "Allowed quote tolerance", "percent", ["policy:engine"], { kind: "policy_constant", name: "QUOTE_TOLERANCE_PERCENT" }),
    make(db, "auto_approve_limit", "Auto-approval limit", "cents", ["policy:engine"], { kind: "policy_constant", name: "AUTO_APPROVE_MAX_CENTS" }),
    make(db, "manager_limit", "Property Manager approval limit", "cents", ["policy:engine"], { kind: "policy_constant", name: "PROPERTY_MANAGER_MAX_CENTS" }),
  ];
  if (leaseId) figs.push(make(db, "repair_deductible", "Lease repair deductible", "cents", [`lease:${leaseId}:field:repair_deductible`], col("leases", leaseId, "repair_deductible_cents")));
  return figs;
}

/** Re-resolve every figure from the current database. Any difference means the data changed (or a bug). */
export function verifyFigures(db: DB, figures: Figure[]): { ok: boolean; mismatches: { key: string; stored: unknown; current: unknown }[] } {
  const mismatches: { key: string; stored: unknown; current: unknown }[] = [];
  for (const f of figures) {
    let current: unknown;
    try {
      current = resolveSource(db, f.source);
    } catch (err) {
      current = `error: ${(err as Error).message}`;
    }
    if (current !== f.value) mismatches.push({ key: f.key, stored: f.value, current });
  }
  return { ok: mismatches.length === 0, mismatches };
}
