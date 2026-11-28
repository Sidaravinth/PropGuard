import { api, ApiRequestError, notifyUnauthorized } from "./client";
import type { LeaseSummary } from "./leases";

export interface Property { property_id: number; name: string; address: string | null; created_at: string; unit_count: number; occupied_count: number }
export interface UnitItem {
  unit_id: string; property_id: number; property_name: string; unit_number: string; base_rent_cents: number;
  occupied: boolean; tenants: { tenant_id: string; name: string; status: string }[]; lease_count: number;
}
export interface UnitDetail extends UnitItem { property: Property | null; leases: LeaseSummary[]; tickets: Ticket[] }

export type TenantStatus = "active" | "notice_given" | "holdover" | "former" | "pending";
export const TENANT_STATUSES: TenantStatus[] = ["active", "notice_given", "holdover", "former", "pending"];
export interface TenantItem {
  tenant_id: string; name: string; email: string | null; phone: string | null; unit_id: string | null; status: TenantStatus;
  property_name: string | null; unit_number: string | null; property_id: number | null; unpaid_balance_cents: number; source_document_id: number | null;
}
export interface LedgerEntry {
  entry_id: number; tenant_id: string; month: string; amount_due_cents: number; amount_paid_cents: number; status: string;
  tenant_name?: string; unit_id?: string | null; property_name?: string | null; unit_number?: string | null;
  outstanding_cents?: number; overdue?: boolean; source_document_id?: number | null;
}
export interface TenantProfile extends TenantItem { leases: LeaseSummary[]; ledger: LedgerEntry[]; tickets: Ticket[] }

export interface LatestEvaluation {
  evaluation_id: number; evaluated_at: string; verdict: "PASS" | "EXCEPTION"; approver_required: string; auto_approve_eligible: boolean; exception_codes: string[];
}
export interface Ticket {
  ticket_id: number; unit_id: string; tenant_id: string | null; issue_summary: string;
  work_order_amount_cents: number; technician_quote_amount_cents: number; proposed_tenant_charge_cents: number | null;
  status: string; created_at: string;
  unit?: { unit_id: string; property_name: string; unit_number: string } | null;
  tenant?: { tenant_id: string; name: string } | null;
  latest?: LatestEvaluation | null;
  /** Set when the ticket is still flagged and its latest brief was rejected or sent for revision. */
  unresolved_brief?: { brief_id: number; status: "rejected" | "revision_requested"; comment: string | null; decided_at: string | null; decided_by: string | null } | null;
}
export interface PolicyException { code: string; message: string; values: Record<string, number | null> }
export interface RuleTrace { rule: string; passed: boolean; detail: string }
export interface Evaluation {
  evaluation_id: number; ticket_id: number; engine_version: string; evaluated_at: string;
  input: { facts: Record<string, unknown>; sources: Record<string, unknown> } | Record<string, unknown>;
  result: {
    verdict: "PASS" | "EXCEPTION"; approverRequired: string; autoApproveEligible: boolean; costBasisCents: number;
    exceptions: PolicyException[]; ruleTrace: RuleTrace[];
    threeWay: { tenantShareCents?: number | null; ownerShareCents?: number | null; [k: string]: unknown };
  };
}
export interface DepositReservation {
  reservation_id: number; lease_id: number; ticket_id: number; amount_cents: number; required_tier: "AUTO_APPROVE" | "PROPERTY_MANAGER" | "REGIONAL_DIRECTOR";
  status: "reserved" | "collected" | "released"; reserved_at: string; reserved_by_name: string; resolved_at: string | null; resolved_by_name: string | null; release_reason: string | null;
}
export interface TicketDecision { decision: "approve" | "reject"; approved_amount_cents: number | null; comment: string | null; decided_by: string; decided_at: string }
export interface TicketDetail extends Ticket { charge_notice: { proposed_charge_cents: number; deductible_share_cents: number; difference_cents: number } | null; direct_decision: TicketDecision | null;deposit_reservations: DepositReservation[];latest_policy_evaluation: Evaluation | null; policy_evaluations: Evaluation[]; lease: LeaseSummary | null;decision_briefs: { brief_id: number; status: string; priority: string; required_approver: string; title: string; created_at: string }[] }

export interface LedgerSummary {
  as_of_month: string; total_outstanding_cents: number; current_month_due_cents: number; current_month_paid_cents: number; entry_count: number;
  overdue_tenants: { tenant_id: string; name: string; property_name: string | null; unit_number: string | null; balance_cents: number; oldest_unpaid_month: string | null }[];
}

export interface Dashboard {
  summary: { properties: number; units: number; occupied_units: number; tenants: number; active_leases: number; expiring_leases: number; pending_tickets: number; outstanding_rent_cents: number };
  leases: {
    active: number; expiring_within_days: number;
    expiring: LeaseRef[]; expired: LeaseRef[]; needs_review: LeaseRef[];
  };
  maintenance: { open: number; policy_exceptions: TicketRef[]; awaiting_approval: TicketRef[]; completed: number };
  payments: {
    total_outstanding_cents: number; overdue_tenant_count: number; current_month: string; current_month_due_cents: number; current_month_paid_cents: number;
    overdue_tenants: LedgerSummary["overdue_tenants"];
    recent_payments: { entry_id: number; tenant_id: string; tenant_name: string; month: string; amount_paid_cents: number; status: string }[];
  };
  activity: {
    uploads: { document_id: number; kind: string; doc_name: string; status: string; lease_id: number | null; rows_imported: number | null; uploaded_at: string; uploaded_by_name: string | null }[];
    new_tickets: TicketRef[];
    briefs: { brief_id: number; brief_type: string; title: string; status: string; priority: string; required_approver: string; created_at: string }[];
    approvals: { brief_id: number; brief_type: string; title: string; status: string; selected_option: string | null; decided_at: string; decided_by: string }[];
  };
}
export interface LeaseRef { lease_id: number; tenant_name: string | null; unit_label: string | null; end_date: string | null; days_until_end: number | null; gap_count: number }
export interface TicketRef { ticket_id: number; issue_summary: string; unit_label: string; status: string; created_at: string; verdict: string | null; approver_required: string | null; exception_codes: string[] }

export type ImportKind = "tenants" | "ledger";
export type Mapping = Record<string, number | null>;
export interface ImportField { key: string; label: string; required?: boolean; hint?: string }
export interface ImportPreview {
  kind: ImportKind; file_name: string; headers: string[]; mapping: Mapping; fields: ImportField[]; mapping_error?: string;
  rows: { row_number: number; values: Record<string, string>; normalized: Record<string, unknown> | null; errors: string[]; duplicate: string | null; action: "import" | "skip" }[];
  summary: { total: number; importable: number; errors: number; duplicates: number };
}
export interface ImportResult { document_id: number; doc_name: string; imported: number; skipped: number; created_ids: string[]; skipped_rows: { row_number: number; reason: string }[] }

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);

export const recordsApi = {
  dashboard: () => data(api<{ data: Dashboard }>("/dashboard")),
  properties: () => data(api<{ data: Property[] }>("/properties")),
  createProperty: (body: { name: string; address: string | null }) => data(api<{ data: Property }>("/properties", { method: "POST", json: body })),
  updateProperty: (id: number, body: { name?: string; address?: string | null }) => data(api<{ data: Property }>(`/properties/${id}`, { method: "PATCH", json: body })),
  units: (propertyId?: number) => data(api<{ data: UnitItem[] }>(`/units${propertyId ? `?property_id=${propertyId}` : ""}`)),
  unit: (id: string) => data(api<{ data: UnitDetail }>(`/units/${encodeURIComponent(id)}`)),
  createUnit: (body: { property_id: number; unit_number: string; base_rent_cents: number }) => data(api<{ data: UnitItem }>("/units", { method: "POST", json: body })),
  updateUnit: (id: string, body: { property_id?: number; unit_number?: string; base_rent_cents?: number }) =>
    data(api<{ data: UnitItem }>(`/units/${encodeURIComponent(id)}`, { method: "PATCH", json: body })),
  tenants: () => data(api<{ data: TenantItem[] }>("/tenants")),
  tenant: (id: string) => data(api<{ data: TenantProfile }>(`/tenants/${encodeURIComponent(id)}`)),
  createTenant: (body: { name: string; email: string | null; phone: string | null; unit_id: string | null; status: TenantStatus }) =>
    data(api<{ data: TenantItem }>("/tenants", { method: "POST", json: body })),
  updateTenant: (id: string, body: Partial<{ name: string; email: string | null; phone: string | null; unit_id: string | null; status: TenantStatus }>) =>
    data(api<{ data: TenantItem }>(`/tenants/${encodeURIComponent(id)}`, { method: "PATCH", json: body })),
  ledger: (q: { tenant_id?: string; filter?: string } = {}) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    return data(api<{ data: LedgerEntry[] }>(`/ledger${p.size ? `?${p}` : ""}`));
  },
  ledgerSummary: () => data(api<{ data: LedgerSummary }>("/ledger/summary")),
  addLedger: (body: { tenant_id: string; month: string; amount_due_cents: number; amount_paid_cents: number; status: string | null }) =>
    data(api<{ data: LedgerEntry }>("/ledger", { method: "POST", json: body })),
  updateLedger: (id: number, body: { amount_due_cents?: number; amount_paid_cents?: number; status?: string | null }) =>
    data(api<{ data: LedgerEntry }>(`/ledger/${id}`, { method: "PATCH", json: body })),
  tickets: () => data(api<{ data: Ticket[] }>("/tickets")),
  ticket: (id: number) => data(api<{ data: TicketDetail }>(`/tickets/${id}`)),
  createTicket: (body: { unit_id: string; tenant_id: string | null; issue_summary: string; work_order_amount_cents: number; technician_quote_amount_cents: number; proposed_tenant_charge_cents: number | null }) =>
    data(api<{ data: { ticket: Ticket; policy: unknown } }>("/tickets", { method: "POST", json: body })),
  runPolicy: (id: number) => data(api<{ data: unknown }>(`/tickets/${id}/policy-check`, { method: "POST" })),
  decideTicket: (id: number, body: { decision: "approve" | "reject"; comment: string | null }) => data(api<{ data: unknown }>(`/tickets/${id}/decision`, { method: "POST", json: body })),
  collectCharge:(reservationId: number) => data(api<{ data: DepositReservation }>(`/deposit-reservations/${reservationId}/collect`, { method: "POST", json: {} })),
  releaseCharge: (reservationId: number, reason: string) => data(api<{ data: DepositReservation }>(`/deposit-reservations/${reservationId}/release`, { method: "POST", json: { reason } })),
};

/** Multipart import call (preview or commit). Mapping is sent as a JSON field. */
export async function importRequest<T>(kind: ImportKind, step: "preview" | "commit", file: File, mapping?: Mapping): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  if (mapping) form.append("mapping", JSON.stringify(mapping));
  const res = await fetch(`/api/imports/${kind}/${step}`, { method: "POST", body: form, credentials: "same-origin", headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    throw new ApiRequestError(res.status, body?.error?.code ?? "HTTP_ERROR", body?.error?.message ?? `Request failed (${res.status})`, body?.error?.details);
  }
  return body.data as T;
}
