/**
 * Payment ledger. Status is derived from the amounts (never trusted from input), money is integer
 * cents, and (tenant, month) is unique. The policy engine's unpaid-balance check reads these rows.
 */
import { ApiError } from "../api/errors.js";
import { today } from "../config.js";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";

export const LEDGER_STATUSES = ["paid", "partial", "unpaid", "late_paid"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/**
 * paid ≥ due → paid (or late_paid if the caller says it was late); 0 < paid < due → partial; paid = 0 → unpaid.
 * An explicit status that contradicts the amounts is rejected.
 */
export function deriveStatus(dueCents: number, paidCents: number, explicit?: string | null): LedgerStatus {
  const computed: LedgerStatus = paidCents >= dueCents ? "paid" : paidCents === 0 ? "unpaid" : "partial";
  if (!explicit) return computed;
  const s = explicit.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "late_paid" || s === "late") {
    if (computed !== "paid") throw new ApiError(422, "STATUS_MISMATCH", "late_paid requires the amount paid to cover the amount due");
    return "late_paid";
  }
  if (s !== computed) throw new ApiError(422, "STATUS_MISMATCH", `Status "${explicit}" contradicts the amounts (due ${dueCents}, paid ${paidCents} → ${computed})`);
  return computed;
}

export interface LedgerInput {
  tenant_id: string;
  month: string;
  amount_due_cents: number;
  amount_paid_cents: number;
  status?: string | null;
}

export function ledgerDuplicate(db: DB, tenantId: string, month: string, excludeId?: number): number | null {
  const r = db.prepare("SELECT entry_id FROM payment_ledger WHERE tenant_id = ? AND month = ? AND entry_id != ?").get(tenantId, month, excludeId ?? -1) as
    | { entry_id: number }
    | undefined;
  return r?.entry_id ?? null;
}

export function addLedgerEntry(db: DB, input: LedgerInput, sourceDocumentId: number | null = null): repo.LedgerRow {
  if (!repo.getTenant(db, input.tenant_id)) throw new ApiError(422, "UNKNOWN_TENANT", `Tenant ${input.tenant_id} does not exist`);
  if (!isMonth(input.month)) throw new ApiError(400, "VALIDATION_ERROR", "month must be YYYY-MM");
  const dup = ledgerDuplicate(db, input.tenant_id, input.month);
  if (dup) throw new ApiError(409, "DUPLICATE_LEDGER_ENTRY", `${input.tenant_id} already has a ledger entry for ${input.month} (#${dup})`, { entry_id: dup });
  const status = deriveStatus(input.amount_due_cents, input.amount_paid_cents, input.status);
  const r = db
    .prepare("INSERT INTO payment_ledger (tenant_id, month, amount_due_cents, amount_paid_cents, status, source_document_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.tenant_id, input.month, input.amount_due_cents, input.amount_paid_cents, status, sourceDocumentId);
  return getEntry(db, Number(r.lastInsertRowid))!;
}

export const getEntry = (db: DB, id: number) => db.prepare("SELECT * FROM payment_ledger WHERE entry_id = ?").get(id) as unknown as repo.LedgerRow | undefined;

export function updateLedgerEntry(db: DB, id: number, input: { amount_due_cents?: number; amount_paid_cents?: number; status?: string | null }): repo.LedgerRow {
  const cur = getEntry(db, id);
  if (!cur) throw new ApiError(404, "NOT_FOUND", `Ledger entry ${id} not found`);
  const due = input.amount_due_cents ?? cur.amount_due_cents;
  const paid = input.amount_paid_cents ?? cur.amount_paid_cents;
  const status = deriveStatus(due, paid, input.status === undefined ? (cur.status === "late_paid" && paid >= due ? "late_paid" : null) : input.status);
  db.prepare("UPDATE payment_ledger SET amount_due_cents = ?, amount_paid_cents = ?, status = ? WHERE entry_id = ?").run(due, paid, status, id);
  return getEntry(db, id)!;
}

export type LedgerFilter = "all" | "overdue" | "outstanding" | "settled";

/** Ledger rows with tenant/unit names and derived outstanding/overdue values. */
export function listLedger(db: DB, opts: { tenant_id?: string; filter?: LedgerFilter } = {}) {
  const month = today().slice(0, 7);
  const rows = db
    .prepare(
      `SELECT l.*, t.name AS tenant_name, t.unit_id, u.property_name, u.unit_number,
              MAX(l.amount_due_cents - l.amount_paid_cents, 0) AS outstanding_cents
         FROM payment_ledger l JOIN tenants t ON t.tenant_id = l.tenant_id LEFT JOIN units u ON u.unit_id = t.unit_id
        WHERE (? IS NULL OR l.tenant_id = ?)
        ORDER BY l.month DESC, t.name`,
    )
    .all(opts.tenant_id ?? null, opts.tenant_id ?? null) as unknown as (repo.LedgerRow & {
    tenant_name: string; unit_id: string | null; property_name: string | null; unit_number: string | null; outstanding_cents: number;
  })[];
  const withFlags = rows.map((r) => ({ ...r, overdue: r.outstanding_cents > 0 && r.month <= month }));
  switch (opts.filter ?? "all") {
    case "overdue":
      return withFlags.filter((r) => r.overdue);
    case "outstanding":
      return withFlags.filter((r) => r.outstanding_cents > 0);
    case "settled":
      return withFlags.filter((r) => r.outstanding_cents === 0);
    default:
      return withFlags;
  }
}

/** Portfolio-level payment figures, all computed from stored ledger rows. */
export function ledgerSummary(db: DB) {
  const month = today().slice(0, 7);
  const balances = (db.prepare("SELECT DISTINCT tenant_id FROM payment_ledger").all() as { tenant_id: string }[])
    .map(({ tenant_id }) => ({ tenant_id, balance: repo.unpaidBalanceCents(db, tenant_id, month) }))
    .filter((b) => b.balance > 0);
  const overdueTenants = balances
    .map((b) => {
      const t = db
        .prepare("SELECT t.name, u.property_name, u.unit_number FROM tenants t LEFT JOIN units u ON u.unit_id = t.unit_id WHERE t.tenant_id = ?")
        .get(b.tenant_id) as { name: string; property_name: string | null; unit_number: string | null };
      const oldest = db
        .prepare("SELECT MIN(month) AS m FROM payment_ledger WHERE tenant_id = ? AND month <= ? AND amount_paid_cents < amount_due_cents")
        .get(b.tenant_id, month) as { m: string | null };
      return { tenant_id: b.tenant_id, name: t.name, property_name: t.property_name, unit_number: t.unit_number, balance_cents: b.balance, oldest_unpaid_month: oldest.m };
    })
    .sort((a, b) => b.balance_cents - a.balance_cents);
  const cur = db
    .prepare("SELECT COALESCE(SUM(amount_due_cents), 0) AS due, COALESCE(SUM(amount_paid_cents), 0) AS paid FROM payment_ledger WHERE month = ?")
    .get(month) as { due: number; paid: number };
  return {
    as_of_month: month,
    total_outstanding_cents: overdueTenants.reduce((s, t) => s + t.balance_cents, 0),
    overdue_tenants: overdueTenants,
    current_month_due_cents: cur.due,
    current_month_paid_cents: cur.paid,
    entry_count: (db.prepare("SELECT COUNT(*) AS n FROM payment_ledger").get() as { n: number }).n,
  };
}
