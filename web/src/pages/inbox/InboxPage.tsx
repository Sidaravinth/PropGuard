import { Bot, Inbox, LoaderCircle, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { briefsApi, type BriefListItem } from "../../api/briefs";
import { useAuth } from "../../auth/AuthContext";
import { Alert, ApproverBadge, Card, Chips, EmptyState, PageHeader, SearchBox } from "../../components/ui";
import { formatDate } from "../../lib/format";
import { errorMessage, useLoad } from "../../lib/useLoad";
import { BriefStatusBadge, BriefTypeBadge, PriorityBadge } from "./badges";

type Filter = "all" | "renewal" | "maintenance" | "pending" | "approved" | "rejected" | "revision_requested";
const FILTERS: { key: Filter; label: string; test: (b: BriefListItem) => boolean }[] = [
  { key: "all", label: "All", test: (b) => b.status !== "superseded" },
  { key: "renewal", label: "Renewal", test: (b) => b.brief_type === "renewal" && b.status !== "superseded" },
  { key: "maintenance", label: "Maintenance", test: (b) => b.brief_type === "maintenance" && b.status !== "superseded" },
  { key: "pending", label: "Pending", test: (b) => b.status === "pending" },
  { key: "approved", label: "Approved", test: (b) => b.status === "approved" },
  { key: "rejected", label: "Rejected", test: (b) => b.status === "rejected" },
  { key: "revision_requested", label: "Revision requested", test: (b) => b.status === "revision_requested" },
];
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

function AgentPanel({ onDone }: { onDone: () => void }) {
  const { data: c, error, reload } = useLoad(() => briefsApi.candidates());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const navigate = useNavigate();

  const run = async (key: string, fn: () => Promise<unknown>, after?: (r: unknown) => void) => {
    setBusy(key);
    setMessage(null);
    try {
      const r = await fn();
      after?.(r);
      onDone();
      void reload();
    } catch (e) {
      setMessage({ tone: "error", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const summarise = (r: unknown) => {
    const rows = r as { brief_id?: number; skipped?: string; error?: string }[];
    const made = rows.filter((x) => x.brief_id).length;
    const failed = rows.filter((x) => x.error);
    setMessage({ tone: failed.length ? "error" : "success", text: `${made} brief${made === 1 ? "" : "s"} generated, ${rows.length - made - failed.length} skipped${failed.length ? `, ${failed.length} failed: ${failed.map((f) => f.error).join("; ")}` : ""}.` });
  };

  return (
    <Card title="AI operations agent" subtitle="Drafts evidence-backed briefs using read-only database tools. It cannot approve anything." className="mb" actions={<Bot size={18} className="muted" aria-hidden />}>
      {error && <Alert tone="error">{error}</Alert>}
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {busy && (
        <p className="status-line small muted" style={{ marginTop: 0 }}>
          <LoaderCircle size={14} className="spin" aria-hidden /> The agent is calling tools and drafting. This can take a minute per brief.
        </p>
      )}
      <div className="grid-2 agent-grid">
        <div>
          <div className="agent-head">
            <h3 className="section-title">Leases in their renewal window ({c?.renewals.length ?? 0})</h3>
            <button className="btn btn-secondary btn-sm" disabled={!!busy || !c?.renewals.some((x) => !x.pending_brief_id)} onClick={() => void run("all-r", () => briefsApi.runAll("renewals"), summarise)}>
              <Sparkles size={14} aria-hidden /> Run renewal workflow
            </button>
          </div>
          {c && !c.renewals.length && <p className="muted small list-empty">No active lease ends within 60 days (or within its notice period).</p>}
          <ul className="plain-list compact">
            {c?.renewals.map((r) => (
              <li key={r.lease_id}>
                <Link to={`/leases/${r.lease_id}`}>{r.tenant_name ?? `Lease #${r.lease_id}`}</Link>
                <span className="muted small">
                  ends {formatDate(r.end_date)} · {r.days_until_end} days
                </span>
                <span className="list-meta">
                  {r.pending_brief_id ? (
                    <Link to={`/inbox/${r.pending_brief_id}`}>Brief #{r.pending_brief_id}</Link>
                  ) : (
                    <button className="link-btn small" disabled={!!busy} onClick={() => void run(`r${r.lease_id}`, () => briefsApi.generate("renewals", r.lease_id), (b) => navigate(`/inbox/${(b as { brief_id: number }).brief_id}`))}>
                      {busy === `r${r.lease_id}` ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />} Generate
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="agent-head">
            <h3 className="section-title">Tickets flagged by the policy engine ({c?.maintenance.length ?? 0})</h3>
            <button className="btn btn-secondary btn-sm" disabled={!!busy || !c?.maintenance.some((x) => !x.pending_brief_id)} onClick={() => void run("all-m", () => briefsApi.runAll("maintenance"), summarise)}>
              <Sparkles size={14} aria-hidden /> Run exception resolver
            </button>
          </div>
          {c && !c.maintenance.length && <p className="muted small list-empty">No flagged tickets.</p>}
          <ul className="plain-list compact">
            {c?.maintenance.map((t) => (
              <li key={t.ticket_id}>
                <Link to={`/maintenance/${t.ticket_id}`}>#{t.ticket_id}</Link> <span className="small">{t.issue_summary.slice(0, 60)}</span>
                <span className="list-meta">
                  {t.pending_brief_id ? (
                    <Link to={`/inbox/${t.pending_brief_id}`}>Brief #{t.pending_brief_id}</Link>
                  ) : (
                    <button className="link-btn small" disabled={!!busy} onClick={() => void run(`m${t.ticket_id}`, () => briefsApi.generate("maintenance", t.ticket_id), (b) => navigate(`/inbox/${(b as { brief_id: number }).brief_id}`))}>
                      {busy === `m${t.ticket_id}` ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />} Generate
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

export function InboxPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("filter") as Filter) ?? "pending";
  const { data, error, reload } = useLoad(() => briefsApi.list());
  const [query, setQuery] = useState("");
  const briefs = data ?? [];

  const visible = useMemo(() => {
    const test = FILTERS.find((f) => f.key === filter)!.test;
    const q = query.trim().toLowerCase();
    return briefs
      .filter((b) => test(b) && (!q || [b.title, b.summary, b.tenant?.name, b.unit?.property_name, String(b.brief_id)].some((s) => s?.toLowerCase().includes(q))))
      .sort((a, b) => (a.status === "pending" && b.status === "pending" ? PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.brief_id - a.brief_id : b.brief_id - a.brief_id));
  }, [briefs, filter, query]);

  return (
    <>
      <PageHeader title="Decision Inbox" description="AI-drafted Decision Briefs. Every figure is pulled from the database; every decision is yours and is checked again in code." />
      {error && <Alert tone="error">{error}</Alert>}
      {can("briefs.generate") && <AgentPanel onDone={() => void reload()} />}
      <section className="card">
        <div className="toolbar">
          <Chips<Filter> options={FILTERS} value={filter} onChange={(f) => setParams({ filter: f }, { replace: true })} counts={Object.fromEntries(FILTERS.map((f) => [f.key, briefs.filter(f.test).length]))} />
          <SearchBox value={query} onChange={setQuery} placeholder="Search briefs…" />
        </div>
        {!data ? (
          <div className="card-body">
            <div className="spinner" aria-label="Loading" />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon={Inbox} title={briefs.length ? "No briefs match" : "No Decision Briefs yet"}>
            {!briefs.length && "Run the renewal workflow or the exception resolver above to draft briefs."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Brief</th>
                  <th>Type</th>
                  <th>Tenant / unit</th>
                  <th>Summary</th>
                  <th>Priority</th>
                  <th>Required approver</th>
                  <th>Created</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((b) => (
                  <tr key={b.brief_id} onClick={() => navigate(`/inbox/${b.brief_id}`)}>
                    <td>
                      <Link to={`/inbox/${b.brief_id}`} onClick={(e) => e.stopPropagation()}>
                        #{b.brief_id}
                      </Link>
                    </td>
                    <td>
                      <BriefTypeBadge type={b.brief_type} />
                    </td>
                    <td className="small">
                      {b.tenant?.name ?? <span className="muted">—</span>}
                      {b.unit && <div className="muted">{`${b.unit.property_name} · ${b.unit.unit_number}`}</div>}
                    </td>
                    <td className="issue-cell small">
                      <strong>{b.title}</strong>
                      {b.summary && <div className="muted clamp-2">{b.summary}</div>}
                      {!b.grounding_passed && <div className="text-danger">Grounding check failed</div>}
                      {b.needs_review && <div className="text-warning">Source data needs review</div>}
                    </td>
                    <td>
                      <PriorityBadge priority={b.priority} />
                    </td>
                    <td>
                      <ApproverBadge tier={b.required_approver} />
                    </td>
                    <td className="nowrap small">{formatDate(b.created_at)}</td>
                    <td>
                      <BriefStatusBadge status={b.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
