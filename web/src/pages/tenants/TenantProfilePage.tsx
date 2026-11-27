import { ArrowLeft, Mail, PencilLine, Phone } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { recordsApi } from "../../api/records";
import { useAuth } from "../../auth/AuthContext";
import {
  Alert, ApproverBadge, Card, LeaseFlagBadges, LeaseStateBadge, LedgerStatusBadge, PageHeader, TenantStatusBadge, TicketStatusBadge,
} from "../../components/ui";
import { formatCents, formatDate } from "../../lib/format";
import { useLoad } from "../../lib/useLoad";
import { TenantDialog } from "./TenantDialog";

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });

export function TenantProfilePage() {
  const id = useParams().id!;
  const { can } = useAuth();
  const { data: t, error, reload } = useLoad(() => recordsApi.tenant(id), [id]);
  const [editing, setEditing] = useState(false);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!t) return <div className="spinner" aria-label="Loading" />;
  const currentMonth = new Date().toISOString().slice(0, 7);

  return (
    <>
      <Link to="/tenants" className="back-link">
        <ArrowLeft size={14} aria-hidden /> All tenants
      </Link>
      <PageHeader
        title={t.name}
        description={t.unit_id ? `${t.property_name} · Unit ${t.unit_number}` : "No unit assigned"}
        actions={
          can("records.write") && (
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              <PencilLine size={16} aria-hidden /> Edit tenant
            </button>
          )
        }
      />

      <div className="summary-strip mb">
        <div>
          <div className="summary-label">Status</div>
          <TenantStatusBadge status={t.status} />
        </div>
        <div>
          <div className="summary-label">Contact</div>
          <div className="small status-line">
            <Mail size={13} aria-hidden /> {t.email ?? "—"}
          </div>
          <div className="small status-line">
            <Phone size={13} aria-hidden /> {t.phone ?? "—"}
          </div>
        </div>
        <div>
          <div className="summary-label">Unit</div>
          {t.unit_id ? <Link to={`/properties/units/${t.unit_id}`}>{t.unit_id}</Link> : "—"}
        </div>
        <div>
          <div className="summary-label">Outstanding rent</div>
          <div className={t.unpaid_balance_cents ? "text-danger" : undefined}>{formatCents(t.unpaid_balance_cents)}</div>
        </div>
        <div>
          <div className="summary-label">Tenant ID</div>
          <div>{t.tenant_id}</div>
          {t.source_document_id && <div className="muted small">Imported from spreadsheet</div>}
        </div>
      </div>

      <div className="grid-2">
        <Card title="Lease history">
          {t.leases.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No leases linked to this tenant.
            </p>
          ) : (
            <ul className="plain-list">
              {t.leases.map((l) => (
                <li key={l.lease_id}>
                  <Link to={`/leases/${l.lease_id}`}>
                    {formatDate(l.start_date)} – {formatDate(l.end_date)}
                  </Link>{" "}
                  <span className="muted small">{formatCents(l.monthly_rent_cents)}/mo</span>{" "}
                  <span className="badges inline">
                    <LeaseStateBadge state={l.lease_state} />
                    <LeaseFlagBadges flags={l.flags} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Maintenance history">
          {t.tickets.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No maintenance tickets.
            </p>
          ) : (
            <ul className="plain-list">
              {t.tickets.map((k) => (
                <li key={k.ticket_id}>
                  <Link to={`/maintenance/${k.ticket_id}`}>#{k.ticket_id}</Link> {k.issue_summary} <TicketStatusBadge status={k.status} />
                  {k.latest && <ApproverBadge tier={k.latest.approver_required} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Payment history" subtitle="From the payment ledger; the policy engine reads these same rows" className="mt">
        {t.ledger.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No ledger entries. Add payments in the Payment Ledger.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="right">Due</th>
                  <th className="right">Paid</th>
                  <th className="right">Outstanding</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {[...t.ledger].reverse().map((e) => {
                  const outstanding = Math.max(e.amount_due_cents - e.amount_paid_cents, 0);
                  return (
                    <tr key={e.entry_id}>
                      <td>{monthLabel(e.month)}</td>
                      <td className="right">{formatCents(e.amount_due_cents)}</td>
                      <td className="right">{formatCents(e.amount_paid_cents)}</td>
                      <td className={`right${outstanding ? " text-danger" : ""}`}>{formatCents(outstanding)}</td>
                      <td>
                        <LedgerStatusBadge status={e.status} overdue={outstanding > 0 && e.month <= currentMonth} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <TenantDialog
          tenant={t}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void reload();
          }}
        />
      )}
    </>
  );
}
