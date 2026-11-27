import { ArrowLeft, PencilLine } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { recordsApi } from "../../api/records";
import { useAuth } from "../../auth/AuthContext";
import { Alert, ApproverBadge, Card, LeaseFlagBadges, LeaseStateBadge, PageHeader, TenantStatusBadge, TicketStatusBadge } from "../../components/ui";
import { formatCents, formatDate } from "../../lib/format";
import { useLoad } from "../../lib/useLoad";
import { UnitDialog } from "./PropertyDialogs";

export function UnitDetailPage() {
  const id = useParams().id!;
  const { can } = useAuth();
  const { data, error, reload } = useLoad(() => Promise.all([recordsApi.unit(id), recordsApi.properties()]), [id]);
  const [editing, setEditing] = useState(false);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <div className="spinner" aria-label="Loading" />;
  const [unit, properties] = data;

  return (
    <>
      <Link to="/properties" className="back-link">
        <ArrowLeft size={14} aria-hidden /> Properties & Units
      </Link>
      <PageHeader
        title={`${unit.property_name} · Unit ${unit.unit_number}`}
        description={`${unit.unit_id} · base rent ${formatCents(unit.base_rent_cents)} · ${unit.occupied ? "occupied" : "available"}`}
        actions={
          can("records.write") && (
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              <PencilLine size={16} aria-hidden /> Edit unit
            </button>
          )
        }
      />
      <div className="grid-2">
        <Card title="Tenants" subtitle="People assigned to this unit">
          {unit.tenants.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No tenants. Add one under Tenants, or link a lease to create one.
            </p>
          ) : (
            <ul className="plain-list">
              {unit.tenants.map((t) => (
                <li key={t.tenant_id}>
                  <Link to={`/tenants/${t.tenant_id}`}>{t.name}</Link> <span className="muted small">{t.tenant_id}</span> <TenantStatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Leases" subtitle="Most recent first">
          {unit.leases.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No leases. Upload one in Lease Management.
            </p>
          ) : (
            <ul className="plain-list">
              {unit.leases.map((l) => (
                <li key={l.lease_id}>
                  <Link to={`/leases/${l.lease_id}`}>{l.tenant?.name ?? l.source_doc_name}</Link>{" "}
                  <span className="muted small">
                    {formatDate(l.start_date)} – {formatDate(l.end_date)}
                  </span>{" "}
                  <span className="badges inline">
                    <LeaseStateBadge state={l.lease_state} />
                    <LeaseFlagBadges flags={l.flags} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Maintenance tickets" className="mt">
        {unit.tickets.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No tickets for this unit.
          </p>
        ) : (
          <ul className="plain-list">
            {unit.tickets.map((t) => (
              <li key={t.ticket_id}>
                <Link to={`/maintenance/${t.ticket_id}`}>#{t.ticket_id}</Link> {t.issue_summary} <TicketStatusBadge status={t.status} />{" "}
                {t.latest && <ApproverBadge tier={t.latest.approver_required} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && (
        <UnitDialog
          unit={unit}
          properties={properties}
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
