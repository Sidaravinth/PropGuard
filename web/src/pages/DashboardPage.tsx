import { Activity, FileSpreadsheet, FileText, LayoutDashboard, Wallet, Wrench } from "lucide-react";
import { Link } from "react-router";
import { recordsApi, type Dashboard, type LeaseRef, type TicketRef } from "../api/records";
import { useAuth } from "../auth/AuthContext";
import { Alert, ApproverBadge, Card, EmptyState, PageHeader, StatCard, VerdictBadge } from "../components/ui";
import { formatCents, formatDate } from "../lib/format";
import { useLoad } from "../lib/useLoad";
import { BriefStatusBadge } from "./inbox/badges";

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

function LeaseList({ items, empty, show }: { items: LeaseRef[]; empty: string; show: (l: LeaseRef) => string }) {
  if (!items.length) return <p className="muted small list-empty">{empty}</p>;
  return (
    <ul className="plain-list compact">
      {items.slice(0, 5).map((l) => (
        <li key={l.lease_id}>
          <Link to={`/leases/${l.lease_id}`}>{l.tenant_name ?? "Unlinked lease"}</Link> <span className="muted small">{l.unit_label ?? ""}</span>
          <span className="list-meta">{show(l)}</span>
        </li>
      ))}
      {items.length > 5 && <li className="muted small">and {items.length - 5} more</li>}
    </ul>
  );
}

function TicketList({ items, empty }: { items: TicketRef[]; empty: string }) {
  if (!items.length) return <p className="muted small list-empty">{empty}</p>;
  return (
    <ul className="plain-list compact">
      {items.slice(0, 5).map((t) => (
        <li key={t.ticket_id}>
          <Link to={`/maintenance/${t.ticket_id}`}>#{t.ticket_id}</Link> {t.issue_summary} <span className="muted small">{t.unit_label}</span>
          <span className="list-meta">
            <ApproverBadge tier={t.approver_required} />
          </span>
        </li>
      ))}
      {items.length > 5 && <li className="muted small">and {items.length - 5} more</li>}
    </ul>
  );
}

function Overview({ d }: { d: Dashboard }) {
  const s = d.summary;
  return (
    <>
      <div className="stat-grid stat-grid-4 mb">
        <StatCard label="Properties" value={s.properties} to="/properties" />
        <StatCard label="Units" value={s.units} hint={`${s.occupied_units} occupied · ${s.units - s.occupied_units} available`} to="/properties" />
        <StatCard label="Occupied units" value={s.occupied_units} hint={s.units ? `${Math.round((s.occupied_units / s.units) * 100)}% occupancy` : undefined} to="/properties" />
        <StatCard label="Tenants" value={s.tenants} to="/tenants" />
        <StatCard label="Active leases" value={s.active_leases} to="/leases?filter=active" />
        <StatCard label="Expiring leases" value={s.expiring_leases} hint={`within ${d.leases.expiring_within_days} days`} tone={s.expiring_leases ? "warning" : undefined} to="/leases?filter=expiring" />
        <StatCard label="Pending maintenance" value={s.pending_tickets} to="/maintenance?filter=open" />
        <StatCard label="Outstanding rent" value={formatCents(s.outstanding_rent_cents)} tone={s.outstanding_rent_cents ? "danger" : undefined} to="/payments?filter=overdue" />
      </div>

      <div className="grid-2">
        <Card title="Lease overview" subtitle={`${d.leases.active} active`} actions={<Link to="/leases" className="small">All leases</Link>}>
          <div className="mini-stats">
            <Link to="/leases?filter=expiring">
              <strong className={d.leases.expiring.length ? "text-warning" : undefined}>{d.leases.expiring.length}</strong> expiring soon
            </Link>
            <Link to="/leases?filter=expired">
              <strong className={d.leases.expired.length ? "text-danger" : undefined}>{d.leases.expired.length}</strong> expired
            </Link>
            <Link to="/leases?filter=review">
              <strong className={d.leases.needs_review.length ? "text-warning" : undefined}>{d.leases.needs_review.length}</strong> to review
            </Link>
          </div>
          <h3 className="section-title">Expiring soon</h3>
          <LeaseList items={d.leases.expiring} empty="No leases end in the next 60 days." show={(l) => `${l.days_until_end} days · ${formatDate(l.end_date)}`} />
          <h3 className="section-title">Needs document review</h3>
          <LeaseList items={d.leases.needs_review} empty="Every lease is fully verified." show={(l) => `${l.gap_count} item${l.gap_count === 1 ? "" : "s"}`} />
        </Card>

        <Card title="Maintenance overview" subtitle={`${d.maintenance.open} open · ${d.maintenance.completed} completed`} actions={<Link to="/maintenance" className="small">All tickets</Link>}>
          <div className="mini-stats">
            <Link to="/maintenance?filter=open">
              <strong>{d.maintenance.open}</strong> open
            </Link>
            <Link to="/maintenance?filter=exceptions">
              <strong className={d.maintenance.policy_exceptions.length ? "text-danger" : undefined}>{d.maintenance.policy_exceptions.length}</strong> policy exceptions
            </Link>
            <Link to="/maintenance?filter=approval">
              <strong className={d.maintenance.awaiting_approval.length ? "text-warning" : undefined}>{d.maintenance.awaiting_approval.length}</strong> need approval
            </Link>
            <span>
              <strong>{d.maintenance.completed}</strong> completed
            </span>
          </div>
          <h3 className="section-title">Policy exceptions</h3>
          <TicketList items={d.maintenance.policy_exceptions} empty="No open ticket has a policy exception." />
          <h3 className="section-title">Awaiting human approval</h3>
          <TicketList items={d.maintenance.awaiting_approval} empty="Nothing is waiting for approval." />
        </Card>

        <Card title="Payment overview" subtitle={`${monthLabel(d.payments.current_month)}`} actions={<Link to="/payments" className="small">Ledger</Link>}>
          <div className="mini-stats">
            <span>
              <strong className={d.payments.total_outstanding_cents ? "text-danger" : undefined}>{formatCents(d.payments.total_outstanding_cents)}</strong> outstanding
            </span>
            <span>
              <strong>{formatCents(d.payments.current_month_paid_cents)}</strong> of {formatCents(d.payments.current_month_due_cents)} collected this month
            </span>
          </div>
          <h3 className="section-title">Overdue tenants ({d.payments.overdue_tenant_count})</h3>
          {d.payments.overdue_tenants.length === 0 ? (
            <p className="muted small list-empty">No tenant is behind on rent.</p>
          ) : (
            <ul className="plain-list compact">
              {d.payments.overdue_tenants.map((o) => (
                <li key={o.tenant_id}>
                  <Link to={`/tenants/${o.tenant_id}`}>{o.name}</Link> <span className="muted small">{o.property_name ? `${o.property_name} · ${o.unit_number}` : ""}</span>
                  <span className="list-meta text-danger">{formatCents(o.balance_cents)}</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="section-title">Recent payments</h3>
          {d.payments.recent_payments.length === 0 ? (
            <p className="muted small list-empty">No payments recorded.</p>
          ) : (
            <ul className="plain-list compact">
              {d.payments.recent_payments.map((p) => (
                <li key={p.entry_id}>
                  <Link to={`/tenants/${p.tenant_id}`}>{p.tenant_name}</Link> <span className="muted small">{monthLabel(p.month)}</span>
                  <span className="list-meta">{formatCents(p.amount_paid_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent activity">
          <h3 className="section-title" style={{ marginTop: 0 }}>
            Document uploads
          </h3>
          {d.activity.uploads.length === 0 ? (
            <p className="muted small list-empty">No uploads yet.</p>
          ) : (
            <ul className="plain-list compact">
              {d.activity.uploads.map((u) => (
                <li key={u.document_id}>
                  {u.kind === "lease" ? <FileText size={14} className="muted" aria-hidden /> : <FileSpreadsheet size={14} className="muted" aria-hidden />}{" "}
                  {u.lease_id ? <Link to={`/leases/${u.lease_id}`}>{u.doc_name}</Link> : u.doc_name}{" "}
                  <span className="muted small">
                    {u.kind === "lease" ? u.status.replace("_", " ") : `${u.rows_imported ?? 0} rows imported`} · {u.uploaded_by_name ?? "unknown"}
                  </span>
                  <span className="list-meta muted small">{formatDate(u.uploaded_at)}</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="section-title">New maintenance tickets</h3>
          {d.activity.new_tickets.length === 0 ? (
            <p className="muted small list-empty">No tickets yet.</p>
          ) : (
            <ul className="plain-list compact">
              {d.activity.new_tickets.map((t) => (
                <li key={t.ticket_id}>
                  <Link to={`/maintenance/${t.ticket_id}`}>#{t.ticket_id}</Link> {t.issue_summary}
                  <span className="list-meta">
                    <VerdictBadge verdict={t.verdict} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="section-title">Decision Briefs</h3>
          {d.activity.briefs.length === 0 ? (
            <p className="muted small list-empty">No briefs yet. Run the agent from the Decision Inbox.</p>
          ) : (
            <ul className="plain-list compact">
              {d.activity.briefs.map((b) => (
                <li key={b.brief_id}>
                  <Link to={`/inbox/${b.brief_id}`}>#{b.brief_id}</Link> {b.title}
                  <span className="list-meta">
                    <BriefStatusBadge status={b.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="section-title">Recent decisions</h3>
          {d.activity.approvals.length === 0 ? (
            <p className="muted small list-empty">No decisions yet.</p>
          ) : (
            <ul className="plain-list compact">
              {d.activity.approvals.map((a) => (
                <li key={a.brief_id}>
                  <Link to={`/inbox/${a.brief_id}`}>#{a.brief_id}</Link> {a.title} <span className="muted small">by {a.decided_by}</span>
                  <span className="list-meta">
                    <BriefStatusBadge status={a.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

export function DashboardPage() {
  const { profile } = useAuth();
  const { data, error } = useLoad(() => recordsApi.dashboard());
  const name = profile?.user.display_name;
  const empty = data && data.summary.properties === 0 && data.summary.tenants === 0 && data.activity.uploads.length === 0 && data.activity.new_tickets.length === 0;

  return (
    <>
      <PageHeader title="Dashboard" description={name ? `Welcome back, ${name}. Every figure below is computed from your records.` : undefined} />
      {error && <Alert tone="error">{error}</Alert>}
      {!data ? (
        <div className="spinner" aria-label="Loading" />
      ) : empty ? (
        <Card>
          <EmptyState icon={LayoutDashboard} title="No portfolio data yet">
            Start by adding a property and its units, then tenants, leases and payments. <Link to="/properties">Go to Properties & Units</Link>
          </EmptyState>
          <div className="getting-started">
            <Link to="/properties" className="gs-step">
              <strong>1.</strong> Add properties and units
            </Link>
            <Link to="/tenants" className="gs-step">
              <strong>2.</strong> Add or import tenants
            </Link>
            <Link to="/leases?upload=1" className="gs-step">
              <strong>3.</strong> Upload lease documents
            </Link>
            <Link to="/payments" className="gs-step">
              <strong>4.</strong> Record or import payments
            </Link>
          </div>
        </Card>
      ) : (
        <Overview d={data} />
      )}
      {data && !empty && (
        <p className="muted small mt">
          <Activity size={12} aria-hidden /> Live from the database · <Wallet size={12} aria-hidden /> money in USD · <Wrench size={12} aria-hidden /> approval tiers set by the
          policy engine
        </p>
      )}
    </>
  );
}
