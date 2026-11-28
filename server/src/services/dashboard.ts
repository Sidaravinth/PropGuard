/** Dashboard figures. Every number is computed from stored records at request time; nothing is cached or invented. */
import { leaseListItem } from "../api/leaseViews.js";
import { latestEvaluation } from "../api/ticketViews.js";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { ledgerSummary } from "./ledger.js";

const EXPIRING_WITHIN_DAYS = 60;
const OPEN_TICKET = ["open", "flagged", "pending_approval"];

const count = (db: DB, sql: string) => (db.prepare(sql).get() as { n: number }).n;

export function dashboard(db: DB) {
  const leases = repo.listLeases(db).map((l) => leaseListItem(db, l));
  const active = leases.filter((l) => l.lease_state === "active");
  const expiring = active.filter((l) => l.days_until_end !== null && l.days_until_end <= EXPIRING_WITHIN_DAYS);
  const expired = leases.filter((l) => l.lease_state === "expired");
  const review = leases.filter((l) => l.gaps.length > 0);

  const tickets = repo.listTickets(db).map((t) => ({ ...t, latest: latestEvaluation(db, t.ticket_id) }));
  const open = tickets.filter((t) => OPEN_TICKET.includes(t.status));
  const exceptions = open.filter((t) => t.latest?.verdict === "EXCEPTION");
  const awaitingApproval = open.filter((t) => t.latest && t.latest.approver_required !== "AUTO_APPROVE");
  const completed = tickets.filter((t) => t.status === "completed");

  const payments = ledgerSummary(db);
  const leaseRef = (l: (typeof leases)[number]) => ({
    lease_id: l.lease_id,
    tenant_name: l.tenant?.name ?? null,
    unit_label: l.unit ? `${l.unit.property_name} · ${l.unit.unit_number}` : null,
    end_date: l.end_date,
    days_until_end: l.days_until_end,
    gap_count: l.gaps.length,
  });
  const ticketRef = (t: (typeof tickets)[number]) => {
    const unit = repo.getUnit(db, t.unit_id);
    return {
      ticket_id: t.ticket_id,
      issue_summary: t.issue_summary,
      unit_label: unit ? `${unit.property_name} · ${unit.unit_number}` : t.unit_id,
      status: t.status,
      created_at: t.created_at,
      verdict: t.latest?.verdict ?? null,
      approver_required: t.latest?.approver_required ?? null,
      exception_codes: t.latest?.exception_codes ?? [],
    };
  };

  return {
    summary: {
      properties: count(db, "SELECT COUNT(*) AS n FROM properties"),
      units: count(db, "SELECT COUNT(*) AS n FROM units"),
      occupied_units: count(
        db,
        "SELECT COUNT(*) AS n FROM units u WHERE EXISTS (SELECT 1 FROM tenants t WHERE t.unit_id = u.unit_id AND t.status IN ('active', 'notice_given', 'holdover'))",
      ),
      tenants: count(db, "SELECT COUNT(*) AS n FROM tenants WHERE status != 'former'"),
      active_leases: active.length,
      expiring_leases: expiring.length,
      pending_tickets: open.length,
      outstanding_rent_cents: payments.total_outstanding_cents,
    },
    leases: {
      active: active.length,
      expiring_within_days: EXPIRING_WITHIN_DAYS,
      expiring: expiring.sort((a, b) => (a.days_until_end ?? 0) - (b.days_until_end ?? 0)).map(leaseRef),
      expired: expired.map(leaseRef),
      needs_review: review.map(leaseRef),
    },
    maintenance: {
      open: open.length,
      policy_exceptions: exceptions.map(ticketRef),
      awaiting_approval: awaitingApproval.map(ticketRef),
      completed: completed.length,
    },
    payments: {
      total_outstanding_cents: payments.total_outstanding_cents,
      overdue_tenants: payments.overdue_tenants.slice(0, 5),
      overdue_tenant_count: payments.overdue_tenants.length,
      current_month: payments.as_of_month,
      current_month_due_cents: payments.current_month_due_cents,
      current_month_paid_cents: payments.current_month_paid_cents,
      recent_payments: db
        .prepare(
          `SELECT l.entry_id, l.tenant_id, t.name AS tenant_name, l.month, l.amount_paid_cents, l.status
             FROM payment_ledger l JOIN tenants t ON t.tenant_id = l.tenant_id
            WHERE l.amount_paid_cents > 0 ORDER BY l.month DESC, l.entry_id DESC LIMIT 5`,
        )
        .all(),
    },
    activity: {
      uploads: db
        .prepare(
          `SELECT d.document_id, d.kind, d.doc_name, d.status, d.lease_id, d.rows_imported, d.uploaded_at, u.display_name AS uploaded_by_name
             FROM documents d LEFT JOIN users u ON u.user_id = d.uploaded_by ORDER BY d.document_id DESC LIMIT 5`,
        )
        .all(),
      new_tickets: [...tickets].sort((a, b) => b.ticket_id - a.ticket_id).slice(0, 5).map(ticketRef),
      briefs: db.prepare("SELECT brief_id, brief_type, title, status, priority, required_approver, created_at FROM decision_briefs WHERE status != 'superseded' ORDER BY brief_id DESC LIMIT 5").all(),
      approvals: db
        .prepare("SELECT b.brief_id, b.brief_type, b.title, b.status, b.selected_option, b.decided_at, u.display_name AS decided_by FROM decision_briefs b JOIN users u ON u.user_id = b.decided_by WHERE b.decided_at IS NOT NULL ORDER BY b.decided_at DESC LIMIT 5")
        .all(),
    },
  };
}
