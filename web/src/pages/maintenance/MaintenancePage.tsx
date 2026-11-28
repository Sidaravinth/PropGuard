import { Plus, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { recordsApi, type Ticket } from "../../api/records";
import { useAuth } from "../../auth/AuthContext";
import { Alert, ApproverBadge, Chips, EmptyState, PageHeader, SearchBox, TicketStatusBadge, VerdictBadge } from "../../components/ui";
import { formatCents, formatDate } from "../../lib/format";
import { useLoad } from "../../lib/useLoad";
import { NewTicketDialog } from "./NewTicketDialog";

type Filter = "all" | "open" | "exceptions" | "approval" | "closed";
const OPEN = ["open", "flagged", "pending_approval"];

const FILTERS: { key: Filter; label: string; test: (t: Ticket) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "open", label: "Open", test: (t) => OPEN.includes(t.status) },
  { key: "exceptions", label: "Policy exceptions", test: (t) => OPEN.includes(t.status) && t.latest?.verdict === "EXCEPTION" },
  { key: "approval", label: "Needs human approval", test: (t) => OPEN.includes(t.status) && !!t.latest && t.latest.approver_required !== "AUTO_APPROVE" },
  { key: "closed", label: "Closed", test: (t) => !OPEN.includes(t.status) },
];

export function MaintenancePage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("filter") as Filter) ?? "all";
  const { data, error } = useLoad(() => recordsApi.tickets());
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const tickets = useMemo(() => [...(data ?? [])].sort((a, b) => b.ticket_id - a.ticket_id), [data]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const test = FILTERS.find((f) => f.key === filter)?.test ?? (() => true);
    return tickets.filter(
      (t) => test(t) && (!q || [String(t.ticket_id), t.issue_summary, t.unit?.property_name, t.unit?.unit_number, t.tenant?.name].some((s) => s?.toLowerCase().includes(q))),
    );
  }, [tickets, filter, query]);

  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Repair tickets checked by the deterministic policy engine: 3-way verification, approval tier and deposit cap."
        actions={
          can("records.write") && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden /> New ticket
            </button>
          )
        }
      />
      {error && <Alert tone="error">{error}</Alert>}
      <section className="card">
        <div className="toolbar">
          <Chips<Filter>
            options={FILTERS}
            value={filter}
            onChange={(f) => setParams(f === "all" ? {} : { filter: f }, { replace: true })}
            counts={Object.fromEntries(FILTERS.map((f) => [f.key, tickets.filter(f.test).length]))}
          />
          <SearchBox value={query} onChange={setQuery} placeholder="Search issue, unit, tenant, #id…" />
        </div>
        {!data ? (
          <div className="card-body">
            <div className="spinner" aria-label="Loading" />
          </div>
        ) : tickets.length === 0 ? (
          <EmptyState icon={Wrench} title="No maintenance tickets yet">
            Create a ticket with the work order estimate and technician quote. The policy check runs automatically.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon={Wrench} title="No tickets match" />
        ) : (
          <div className="table-wrap">
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Issue</th>
                  <th>Unit / tenant</th>
                  <th className="right">Work order</th>
                  <th className="right">Quote</th>
                  <th>Policy</th>
                  <th>Approval</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => (
                  <tr key={t.ticket_id} onClick={() => navigate(`/maintenance/${t.ticket_id}`)}>
                    <td>
                      <Link to={`/maintenance/${t.ticket_id}`} onClick={(e) => e.stopPropagation()}>
                        #{t.ticket_id}
                      </Link>
                    </td>
                    <td className="issue-cell">
                      {t.issue_summary}
                      <div className="muted small">{formatDate(t.created_at)}</div>
                    </td>
                    <td className="small">
                      {t.unit ? `${t.unit.property_name} · ${t.unit.unit_number}` : t.unit_id}
                      {t.tenant && <div className="muted">{t.tenant.name}</div>}
                    </td>
                    <td className="right">{formatCents(t.work_order_amount_cents)}</td>
                    <td className="right">{formatCents(t.technician_quote_amount_cents)}</td>
                    <td>
                      <VerdictBadge verdict={t.latest?.verdict} />
                      {!!t.latest?.exception_codes.length && <div className="muted small">{t.latest.exception_codes.length} exception{t.latest.exception_codes.length > 1 ? "s" : ""}</div>}
                    </td>
                    <td>
                      <ApproverBadge tier={t.latest?.approver_required} />
                    </td>
                    <td>
                      <TicketStatusBadge status={t.status} />
                      {t.unresolved_brief && (
                        <div className="text-warning small">
                          Brief {t.unresolved_brief.status === "rejected" ? "rejected" : "sent for revision"} · needs a resolution
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && <NewTicketDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`/maintenance/${id}`)} />}
    </>
  );
}
