/**
 * Data access. Plain SQL, typed rows. Business rules do NOT live here: this layer only reads/writes
 * facts. Derived values (unpaid balance, remaining deposit) are computed from ledgers, never stored.
 */
import type { SQLInputValue } from "node:sqlite";
import { today } from "../config.js";
import { computeGaps, lowOcrConfidenceGaps, type DataGap } from "../extraction/verify.js";
import type { ClauseType, FieldStatus } from "../extraction/leaseSchema.js";
import type { DB } from "./connection.js";

export interface UnitRow { unit_id: string; property_name: string; unit_number: string; base_rent_cents: number }
export interface TenantRow { tenant_id: string; name: string; email: string | null; unit_id: string | null; status: string }
export interface LeaseRow {
  lease_id: number; tenant_id: string | null; unit_id: string | null;
  start_date: string | null; end_date: string | null;
  monthly_rent_cents: number | null; security_deposit_cents: number | null;
  notice_period_days: number | null; repair_deductible_cents: number | null;
  source_doc_name: string; extraction_status: "complete" | "needs_review"; extraction_model: string; created_at: string;
}
export interface FieldSourceRow {
  lease_id: number; field_name: string; value_text: string | null; status: FieldStatus | "corrected";
  section_ref: string | null; page: number | null; verbatim_snippet: string | null; note: string | null;
}
export interface ClauseRow {
  clause_id: number; lease_id: number; clause_type: ClauseType; extracted_text: string;
  section_ref: string | null; page: number | null; verified: number;
}
export interface TicketRow {
  ticket_id: number; unit_id: string; tenant_id: string | null; issue_summary: string;
  work_order_amount_cents: number; technician_quote_amount_cents: number;
  proposed_tenant_charge_cents: number | null; status: string; created_at: string;
}
export interface LedgerRow {
  entry_id: number; tenant_id: string; month: string; amount_due_cents: number; amount_paid_cents: number; status: string;
}

const all = <T>(db: DB, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as unknown as T[];
const one = <T>(db: DB, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as unknown as T | undefined;

// --- units & tenants ----------------------------------------------------------

export const listUnits = (db: DB) => all<UnitRow>(db, "SELECT * FROM units ORDER BY unit_id");
export const getUnit = (db: DB, id: string) => one<UnitRow>(db, "SELECT * FROM units WHERE unit_id = ?", id);

export function findUnitByLabel(db: DB, propertyName: string, unitNumber: string): UnitRow | undefined {
  const num = unitNumber.replace(/^(unit|apartment|apt\.?|loft|suite|#)\s*/i, "").trim();
  return one<UnitRow>(
    db,
    "SELECT * FROM units WHERE lower(property_name) = lower(?) AND lower(unit_number) = lower(?)",
    propertyName.trim(),
    num,
  );
}

export function listTenants(db: DB, status?: string): TenantRow[] {
  return status
    ? all<TenantRow>(db, "SELECT * FROM tenants WHERE status = ? ORDER BY tenant_id", status)
    : all<TenantRow>(db, "SELECT * FROM tenants ORDER BY tenant_id");
}
export const getTenant = (db: DB, id: string) => one<TenantRow>(db, "SELECT * FROM tenants WHERE tenant_id = ?", id);

export function findTenantInUnit(db: DB, unitId: string, name: string): TenantRow | undefined {
  return one<TenantRow>(db, "SELECT * FROM tenants WHERE unit_id = ? AND lower(trim(name)) = lower(trim(?))", unitId, name);
}

export function createPendingTenant(db: DB, name: string, unitId: string): TenantRow {
  const row = one<{ n: number }>(db, "SELECT COALESCE(MAX(CAST(substr(tenant_id, 2) AS INTEGER)), 0) + 1 AS n FROM tenants")!;
  const id = `T${String(row.n).padStart(3, "0")}`;
  db.prepare("INSERT INTO tenants (tenant_id, name, email, unit_id, status) VALUES (?, ?, NULL, ?, 'pending')").run(id, name.trim(), unitId);
  return getTenant(db, id)!;
}

// --- ledger -------------------------------------------------------------------

export const getLedger = (db: DB, tenantId: string) =>
  all<LedgerRow>(db, "SELECT * FROM payment_ledger WHERE tenant_id = ? ORDER BY month", tenantId);

/** Outstanding rent: sum of (due - paid) for every month up to and including the current month. */
export function unpaidBalanceCents(db: DB, tenantId: string, asOfMonth = today().slice(0, 7)): number {
  const r = one<{ bal: number }>(
    db,
    `SELECT COALESCE(SUM(MAX(amount_due_cents - amount_paid_cents, 0)), 0) AS bal
       FROM payment_ledger WHERE tenant_id = ? AND month <= ?`,
    tenantId,
    asOfMonth,
  )!;
  return r.bal;
}

// --- leases -------------------------------------------------------------------

export function listLeases(db: DB): LeaseRow[] {
  return all<LeaseRow>(db, "SELECT * FROM leases ORDER BY lease_id");
}
export const getLeaseRow = (db: DB, id: number) => one<LeaseRow>(db, "SELECT * FROM leases WHERE lease_id = ?", id);

export const getFieldSources = (db: DB, leaseId: number) =>
  all<FieldSourceRow>(db, "SELECT * FROM lease_field_sources WHERE lease_id = ? ORDER BY rowid", leaseId);

export function getClauses(db: DB, leaseId: number, type?: string): ClauseRow[] {
  return type
    ? all<ClauseRow>(db, "SELECT * FROM lease_clauses WHERE lease_id = ? AND clause_type = ? ORDER BY clause_id", leaseId, type)
    : all<ClauseRow>(db, "SELECT * FROM lease_clauses WHERE lease_id = ? ORDER BY clause_id", leaseId);
}

/**
 * Deposit position of a lease, or null when no deposit was ever recorded. "collected" is every deduction in
 * the ledger (a collected reservation is one of them); "reserved" is approved charges not yet collected.
 * excludeTicketId leaves out that ticket's own reservation or collected charge, so a ticket is never
 * checked against itself.
 */
export function depositPosition(db: DB, leaseId: number, excludeTicketId: number | null = null) {
  const ledger = one<{ held: number | null; deducted: number | null }>(
    db,
    `SELECT SUM(CASE WHEN entry_type = 'held' THEN amount_cents END) AS held,
            SUM(CASE WHEN entry_type = 'deduction' AND entry_id NOT IN
                     (SELECT deduction_entry_id FROM deposit_reservations WHERE ticket_id IS ? AND deduction_entry_id IS NOT NULL)
                THEN amount_cents END) AS deducted
       FROM deposit_ledger WHERE lease_id = ?`,
    excludeTicketId,
    leaseId,
  )!;
  if (ledger.held === null) return null;
  const reserved = one<{ n: number }>(
    db,
    "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM deposit_reservations WHERE lease_id = ? AND status = 'reserved' AND ticket_id IS NOT ?",
    leaseId,
    excludeTicketId,
  )!.n;
  const collected = ledger.deducted ?? 0;
  return { held_cents: ledger.held, collected_cents: collected, reserved_cents: reserved, available_cents: Math.max(ledger.held - collected - reserved, 0) };
}

/** Deposit still available = held - collected - reserved. null when no deposit was ever recorded for the lease. */
export function remainingDepositCents(db: DB, leaseId: number, excludeTicketId: number | null = null): number | null {
  return depositPosition(db, leaseId, excludeTicketId)?.available_cents ?? null;
}

/** The lease governing a unit (and tenant, if known): the most recent by end date. */
export function findGoverningLease(db: DB, unitId: string, tenantId: string | null): LeaseRow | undefined {
  return one<LeaseRow>(
    db,
    `SELECT * FROM leases WHERE unit_id = ? AND (? IS NULL OR tenant_id = ?)
      ORDER BY COALESCE(end_date, '') DESC, lease_id DESC LIMIT 1`,
    unitId,
    tenantId,
    tenantId,
  );
}

export type LeaseState = "active" | "expired" | "upcoming" | "unknown";

export function leaseState(lease: Pick<LeaseRow, "start_date" | "end_date">, asOf = today()): LeaseState {
  if (!lease.start_date || !lease.end_date) return "unknown";
  if (lease.end_date < asOf) return "expired";
  if (lease.start_date > asOf) return "upcoming";
  return "active";
}

export function daysUntil(isoDate: string, asOf = today()): number {
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
}

export interface SourcePageRow {
  page: number;
  method: "text" | "ocr";
  confidence: number | null;
}

/** How each page of a lease's source text was obtained (empty for documents ingested before OCR support). */
export function getSourcePages(db: DB, docName: string): SourcePageRow[] {
  return all<SourcePageRow>(
    db,
    `SELECT p.page, p.method, p.ocr_confidence AS confidence FROM source_document_pages p
       JOIN source_documents s ON s.doc_id = p.doc_id WHERE s.doc_name = ? ORDER BY p.page`,
    docName,
  );
}

export interface UnitRentChange {
  unit_id: string;
  lease_id: number;
  from_cents: number;
  to_cents: number;
}

/**
 * Make a unit's base rent match the monthly rent of the lease linked to it. Only a rent that is verified
 * (or confirmed by a person) is used; a missing or needs-review rent changes nothing, and neither does an
 * expired lease, so an old agreement never overwrites the current rent. Returns the change, if any.
 */
export function syncUnitRentFromLease(db: DB, leaseId: number): UnitRentChange | null {
  const lease = getLeaseRow(db, leaseId);
  if (!lease?.unit_id || lease.monthly_rent_cents === null || leaseState(lease) === "expired") return null;
  const unit = getUnit(db, lease.unit_id);
  if (!unit || unit.base_rent_cents === lease.monthly_rent_cents) return null;
  db.prepare("UPDATE units SET base_rent_cents = ? WHERE unit_id = ?").run(lease.monthly_rent_cents, unit.unit_id);
  return { unit_id: unit.unit_id, lease_id: leaseId, from_cents: unit.base_rent_cents, to_cents: lease.monthly_rent_cents };
}

/** Lease with state flags and data gaps, the shape the API returns. */
export function leaseSummary(db: DB, lease: LeaseRow) {
  const sources = getFieldSources(db, lease.lease_id);
  const clauses = getClauses(db, lease.lease_id);
  const gaps: DataGap[] = computeGaps(
    sources.map((s) => ({ field: s.field_name, status: s.status, note: s.note })),
    clauses.map((c) => ({ clauseType: c.clause_type, verified: c.verified === 1 })),
  );
  if (!lease.unit_id) gaps.push({ field: "unit_link", status: "needs_review", reason: "Document could not be linked to a known unit" });
  if (!lease.tenant_id) gaps.push({ field: "tenant_link", status: "needs_review", reason: "Document could not be linked to a tenant" });
  gaps.push(...lowOcrConfidenceGaps(getSourcePages(db, lease.source_doc_name)));

  const state = leaseState(lease);
  const flags: string[] = [];
  if (state === "expired") flags.push("EXPIRED");
  if (lease.end_date && lease.notice_period_days !== null && state === "active") {
    const d = daysUntil(lease.end_date);
    if (d <= lease.notice_period_days) flags.push("IN_NOTICE_WINDOW");
  }
  if (gaps.length) flags.push("HAS_DATA_GAPS");
  return {
    ...lease,
    lease_state: state,
    days_until_end: lease.end_date ? daysUntil(lease.end_date) : null,
    remaining_deposit_cents: remainingDepositCents(db, lease.lease_id),
    deposit: depositPosition(db, lease.lease_id),
    flags,
    gaps,
  };
}

/**
 * Human work attached to the lease stored under this document name, which replacing the document would
 * destroy or detach. Empty when there is no such lease, or nothing but its extraction.
 */
export function leaseHistory(db: DB, docName: string): { lease_id: number; reasons: string[] } | null {
  const lease = one<{ lease_id: number }>(db, "SELECT lease_id FROM leases WHERE source_doc_name = ?", docName);
  if (!lease) return null;
  const has = (sql: string) => Boolean(db.prepare(sql).get(lease.lease_id));
  const reasons = (
    [
      ["SELECT 1 FROM documents WHERE lease_id = ?", "it was uploaded through the application"],
      ["SELECT 1 FROM lease_field_corrections WHERE lease_id = ?", "it has human corrections or links"],
      ["SELECT 1 FROM decision_briefs WHERE lease_id = ?", "it has Decision Briefs"],
      ["SELECT 1 FROM renewal_offers WHERE lease_id = ?", "it has an approved renewal offer"],
      ["SELECT 1 FROM deposit_reservations WHERE lease_id = ?", "it has deposit reservations"],
      ["SELECT 1 FROM deposit_ledger WHERE lease_id = ? AND entry_type = 'deduction'", "it has deposit deductions"],
    ] as const
  )
    .filter(([sql]) => has(sql))
    .map(([, reason]) => reason);
  return reasons.length ? { lease_id: lease.lease_id, reasons } : null;
}

// --- tickets ------------------------------------------------------------------

export function listTickets(db: DB, filter: { status?: string; unit_id?: string } = {}): TicketRow[] {
  return all<TicketRow>(
    db,
    `SELECT * FROM maintenance_tickets
      WHERE (? IS NULL OR status = ?) AND (? IS NULL OR unit_id = ?) ORDER BY ticket_id`,
    filter.status ?? null, filter.status ?? null, filter.unit_id ?? null, filter.unit_id ?? null,
  );
}
export const getTicket = (db: DB, id: number) => one<TicketRow>(db, "SELECT * FROM maintenance_tickets WHERE ticket_id = ?", id);

export interface NewTicket {
  unit_id: string;
  tenant_id: string | null;
  issue_summary: string;
  work_order_amount_cents: number;
  technician_quote_amount_cents: number;
  proposed_tenant_charge_cents: number | null;
  created_at?: string;
}

export function insertTicket(db: DB, t: NewTicket): number {
  const r = db
    .prepare(
      `INSERT INTO maintenance_tickets (unit_id, tenant_id, issue_summary, work_order_amount_cents,
         technician_quote_amount_cents, proposed_tenant_charge_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    )
    .run(t.unit_id, t.tenant_id, t.issue_summary, t.work_order_amount_cents, t.technician_quote_amount_cents,
      t.proposed_tenant_charge_cents, t.created_at ?? null);
  return Number(r.lastInsertRowid);
}

export function setTicketStatus(db: DB, id: number, status: string): void {
  db.prepare("UPDATE maintenance_tickets SET status = ? WHERE ticket_id = ?").run(status, id);
}

export function listPolicyEvaluations(db: DB, ticketId: number) {
  return all<{ evaluation_id: number; ticket_id: number; input_json: string; result_json: string; engine_version: string; evaluated_at: string }>(
    db,
    "SELECT * FROM policy_evaluations WHERE ticket_id = ? ORDER BY evaluation_id DESC",
    ticketId,
  ).map((r) => ({ ...r, input: JSON.parse(r.input_json), result: JSON.parse(r.result_json), input_json: undefined, result_json: undefined }));
}
