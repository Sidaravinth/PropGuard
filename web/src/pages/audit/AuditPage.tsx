import { ChevronDown, ChevronRight, History, ShieldAlert, ShieldCheck } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { briefsApi, type AuditEntry } from "../../api/briefs";
import { Alert, EmptyState, PageHeader } from "../../components/ui";
import { useLoad } from "../../lib/useLoad";

const PAGE = 50;
const ACTOR_TONE: Record<string, string> = { human: "badge-info", agent: "badge-purple", system: "" };

function subjectLink(a: AuditEntry) {
  if (!a.subject_type || !a.subject_id) return null;
  const to =
    a.subject_type === "lease" ? `/leases/${a.subject_id}` : a.subject_type === "ticket" ? `/maintenance/${a.subject_id}` : a.subject_type === "brief" ? `/inbox/${a.subject_id}` : a.subject_type === "tenant" ? `/tenants/${a.subject_id}` : a.subject_type === "unit" ? `/properties/units/${a.subject_id}` : a.subject_type === "property" ? "/properties" : null;
  const label = `${a.subject_type} ${a.subject_id}`;
  return to ? <Link to={to}>{label}</Link> : label;
}

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const f = Object.fromEntries(["q", "event_type", "actor_type", "actor", "from", "to", "brief_id"].map((k) => [k, params.get(k) ?? ""]));
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  const { data, error } = useLoad(() => briefsApi.audit({ ...f, limit }), [params.toString(), limit]);
  const verify = useLoad(() => briefsApi.verifyAudit(), [data?.total]);

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
    setLimit(PAGE);
  };

  return (
    <>
      <PageHeader
        title="Audit Trail"
        description="Append-only record of uploads, extractions, corrections, policy checks, agent tool calls, briefs and human decisions."
        actions={
          verify.data &&
          (verify.data.ok ? (
            <span className="badge badge-success chain-badge" title="Every entry's hash covers the previous entry; recomputed just now">
              <ShieldCheck size={14} aria-hidden /> Hash chain intact · {verify.data.checked} entries
            </span>
          ) : (
            <span className="badge badge-danger chain-badge">
              <ShieldAlert size={14} aria-hidden /> Chain broken at entry #{verify.data.first_broken_audit_id}
            </span>
          ))
        }
      />
      {error && <Alert tone="error">{error}</Alert>}
      <section className="card">
        <div className="toolbar audit-filters">
          <input type="search" placeholder="Search payloads…" value={f.q} onChange={(e) => set("q", e.target.value)} aria-label="Search" />
          <select value={f.event_type} onChange={(e) => set("event_type", e.target.value)} aria-label="Event type">
            <option value="">All events</option>
            {data?.event_types.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select value={f.actor_type} onChange={(e) => set("actor_type", e.target.value)} aria-label="Actor type">
            <option value="">All actors</option>
            <option value="human">Human</option>
            <option value="agent">AI agent</option>
            <option value="system">System</option>
          </select>
          <input placeholder="Actor name/role" value={f.actor} onChange={(e) => set("actor", e.target.value)} aria-label="Actor" />
          <input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} aria-label="From date" />
          <input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} aria-label="To date" />
          {f.brief_id && (
            <button className="chip active" onClick={() => set("brief_id", "")}>
              Brief #{f.brief_id} ×
            </button>
          )}
        </div>
        {!data ? (
          <div className="card-body">
            <div className="spinner" aria-label="Loading" />
          </div>
        ) : data.rows.length === 0 ? (
          <EmptyState icon={History} title="No audit entries match" />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th aria-label="Expand" />
                    <th>#</th>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Actor</th>
                    <th>Record</th>
                    <th>Brief</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((a) => (
                    <Fragment key={a.audit_id}>
                      <tr className="table-clickable-row" onClick={() => setOpen(open === a.audit_id ? null : a.audit_id)}>
                        <td>{open === a.audit_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td className="muted">{a.audit_id}</td>
                        <td className="nowrap small">{new Date(a.occurred_at).toLocaleString()}</td>
                        <td>
                          <strong>{a.event_type.replace(/_/g, " ")}</strong>
                        </td>
                        <td className="small">
                          <span className={`badge ${ACTOR_TONE[a.actor_type]}`}>{a.actor_type}</span> {a.actor_id}
                        </td>
                        <td className="small" onClick={(e) => e.stopPropagation()}>
                          {subjectLink(a)}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>{a.brief_id ? <Link to={`/inbox/${a.brief_id}`}>#{a.brief_id}</Link> : <span className="muted">—</span>}</td>
                      </tr>
                      {open === a.audit_id && (
                        <tr className="detail-row">
                          <td colSpan={7}>
                            <pre className="json">{JSON.stringify(a.payload, null, 2)}</pre>
                            <div className="muted small hash">
                              hash {a.hash.slice(0, 16)}… · previous {a.prev_hash.slice(0, 16)}…
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-body table-foot">
              <span className="muted small">
                Showing {data.rows.length} of {data.total}
              </span>
              {data.rows.length < data.total && (
                <button className="btn btn-secondary btn-sm" onClick={() => setLimit(Math.min(limit + PAGE, 200))} disabled={limit >= 200}>
                  Load more
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
