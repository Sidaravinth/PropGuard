import { ArrowLeft, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, LoaderCircle, ShieldCheck, XCircle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { briefsApi } from "../../api/briefs";
import { recordsApi, type Evaluation, type TicketDetail } from "../../api/records";
import { BriefStatusBadge } from "../inbox/badges";
import { DepositCharges, depositText } from "./DepositCharges";
import { TicketApproval } from "./TicketApproval";
import { useAuth } from "../../auth/AuthContext";
import { ChargeWarning } from "../../components/ChargeWarning";
import { Alert, ApproverBadge, Card, LeaseFlagBadges, LeaseStateBadge, PageHeader, TicketStatusBadge, VerdictBadge } from "../../components/ui";
import { formatCents, formatDate } from "../../lib/format";
import { errorMessage, useLoad } from "../../lib/useLoad";

const APPROVER_TEXT: Record<string, string> = {
  AUTO_APPROVE: "Eligible for auto-approval: repair cost ≤ $200 and no exceptions.",
  PROPERTY_MANAGER: "Needs Property Manager approval: cost over $200 (up to $1,000), or an exception blocks auto-approval.",
  REGIONAL_DIRECTOR: "Needs Regional Director approval: repair cost over $1,000.",
};

function PolicyResult({ ev }: { ev: Evaluation }) {
  const [trace, setTrace] = useState(false);
  const r = ev.result;
  return (
    <>
      <div className="policy-head">
        <VerdictBadge verdict={r.verdict} />
        <ApproverBadge tier={r.approverRequired} />
        <span className="muted small">
          Cost basis {formatCents(r.costBasisCents)} · engine {ev.engine_version} · {formatDate(ev.evaluated_at)}
        </span>
      </div>
      <p className="small" style={{ margin: "8px 0 12px" }}>
        {APPROVER_TEXT[r.approverRequired]}
      </p>
      {r.exceptions.length > 0 ? (
        <ul className="exception-list">
          {r.exceptions.map((x, i) => (
            <li key={i}>
              <CircleAlert size={16} className="text-danger" aria-hidden />
              <div>
                <strong>{x.code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</strong>
                <div className="small">{x.message}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="status-line text-success" style={{ margin: 0 }}>
          <CheckCircle2 size={16} aria-hidden /> No exceptions.
        </p>
      )}
      {(r.threeWay?.tenantShareCents !== undefined || r.threeWay?.ownerShareCents !== undefined) && (
        <dl className="details compact mt">
          <dt>Tenant share under the deductible</dt>
          <dd>{r.threeWay.tenantShareCents === null ? "Unknown (no verified deductible)" : formatCents(r.threeWay.tenantShareCents as number)}</dd>
          <dt>Owner pays</dt>
          <dd>{r.threeWay.ownerShareCents === null ? "Unknown" : formatCents(r.threeWay.ownerShareCents as number)}</dd>
        </dl>
      )}
      <button className="link-btn small mt" onClick={() => setTrace(!trace)} aria-expanded={trace}>
        {trace ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />} Rule trace ({r.ruleTrace.length} rules)
      </button>
      {trace && (
        <ul className="trace-list">
          {r.ruleTrace.map((t, i) => (
            <li key={i}>
              {t.passed ? <CheckCircle2 size={14} className="text-success" aria-hidden /> : <XCircle size={14} className="text-danger" aria-hidden />}
              <code>{t.rule}</code> <span className="small">{t.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function TicketDetailPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const { data: t, error, reload } = useLoad(() => recordsApi.ticket(id), [id]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!t) return <div className="spinner" aria-label="Loading" />;

  const run = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await recordsApi.runPolicy(id);
      await reload();
    } catch (e) {
      setRunError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };
  const ev = t.latest_policy_evaluation;

  return (
    <>
      <Link to="/maintenance" className="back-link">
        <ArrowLeft size={14} aria-hidden /> All tickets
      </Link>
      <PageHeader
        title={`#${t.ticket_id} · ${t.issue_summary}`}
        description={`${t.unit ? `${t.unit.property_name} · Unit ${t.unit.unit_number}` : t.unit_id}${t.tenant ? ` · ${t.tenant.name}` : ""}`}
        actions={
          can("policy.run") && (
            <button className="btn btn-primary" onClick={() => void run()} disabled={running}>
              {running ? <LoaderCircle size={16} className="spin" aria-hidden /> : <ShieldCheck size={16} aria-hidden />} Run policy check
            </button>
          )
        }
      />
      {runError && <Alert tone="error">{runError}</Alert>}
      {t.unresolved_brief && (
        <Alert tone="info">
          <strong>This ticket still needs a resolution.</strong> <Link to={`/inbox/${t.unresolved_brief.brief_id}`}>Brief #{t.unresolved_brief.brief_id}</Link> was{" "}
          {t.unresolved_brief.status === "rejected" ? "rejected" : "sent for revision"}
          {t.unresolved_brief.decided_by ? ` by ${t.unresolved_brief.decided_by}` : ""}
          {t.unresolved_brief.comment ? `: “${t.unresolved_brief.comment}”` : "."} That declined the AI proposal, not the repair. Draft a new resolution brief below.
        </Alert>
      )}

      <ChargeWarning notice={t.charge_notice} />

      <div className="summary-strip mb">
        <div>
          <div className="summary-label">Status</div>
          <TicketStatusBadge status={t.status} />
        </div>
        <div>
          <div className="summary-label">Work order estimate</div>
          <div>{formatCents(t.work_order_amount_cents)}</div>
        </div>
        <div>
          <div className="summary-label">Technician quote</div>
          <div>{formatCents(t.technician_quote_amount_cents)}</div>
          {t.work_order_amount_cents > 0 && (
            <div className="muted small">
              {t.technician_quote_amount_cents >= t.work_order_amount_cents ? "+" : ""}
              {(((t.technician_quote_amount_cents - t.work_order_amount_cents) / t.work_order_amount_cents) * 100).toFixed(1)}% vs work order
            </div>
          )}
        </div>
        <div>
          <div className="summary-label">Proposed tenant charge</div>
          <div>{t.proposed_tenant_charge_cents === null ? "None" : formatCents(t.proposed_tenant_charge_cents)}</div>
        </div>
        <div>
          <div className="summary-label">Created</div>
          <div>{formatDate(t.created_at)}</div>
        </div>
      </div>

      <div className="review-layout">
        <div className="review-main">
          <Card title="Deterministic policy result" subtitle="Computed in code from stored records. AI never decides the outcome." className="mb">
            {ev ? <PolicyResult ev={ev} /> : <p className="muted">Not checked yet. Run the policy check.</p>}
          </Card>
          <TicketApproval ticket={t} onChanged={reload} />
          <DepositCharges ticket={t} onChanged={reload} />
          <TicketBriefs ticket={t} />
          <Card title="Policy check history">
            {t.policy_evaluations.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                None.
              </p>
            ) : (
              <ul className="timeline">
                {t.policy_evaluations.map((e) => (
                  <li key={e.evaluation_id}>
                    <VerdictBadge verdict={e.result.verdict} /> <ApproverBadge tier={e.result.approverRequired} />{" "}
                    <span className="muted small">
                      #{e.evaluation_id} · {formatDate(e.evaluated_at)}
                      {e.result.exceptions.length ? ` · ${e.result.exceptions.map((x) => x.code).join(", ")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <aside className="review-side">
          <Card title="Governing lease" subtitle="Source of the repair deductible and deposit">
            {t.lease ? (
              <>
                <p style={{ marginTop: 0 }}>
                  <Link to={`/leases/${t.lease.lease_id}`}>{t.lease.tenant?.name ?? t.lease.source_doc_name}</Link>{" "}
                  <span className="badges inline">
                    <LeaseStateBadge state={t.lease.lease_state} />
                    <LeaseFlagBadges flags={t.lease.flags} />
                  </span>
                </p>
                <dl className="details compact">
                  <dt>Term</dt>
                  <dd>
                    {formatDate(t.lease.start_date)} – {formatDate(t.lease.end_date)}
                  </dd>
                  <dt>Repair deductible</dt>
                  <dd>{t.lease.repair_deductible_cents === null ? <span className="text-warning">Not verified</span> : formatCents(t.lease.repair_deductible_cents)}</dd>
                  <dt>Security deposit</dt>
                  <dd>{t.lease.deposit === null ? <span className="text-warning">No deposit recorded</span> : depositText(t.lease.deposit)}</dd>
                  <dt>Source</dt>
                  <dd className="small">{t.lease.source_doc_name}</dd>
                </dl>
              </>
            ) : (
              <p className="text-warning" style={{ margin: 0 }}>
                No lease for this unit, so the check fails closed (LEASE_NOT_FOUND). Upload and link the lease in Lease Management.
              </p>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}

function TicketBriefs({ ticket }: { ticket: TicketDetail }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      navigate(`/inbox/${(await briefsApi.generate("maintenance", ticket.ticket_id)).brief_id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const flagged = ticket.status === "flagged";
  return (
    <Card
      title="Decision Briefs"
      subtitle="AI-drafted resolution options for human review. The agent explains exceptions; it cannot change the result or approve."
      className="mb"
      actions={
        can("briefs.generate") &&
        flagged && (
          <button className="btn btn-secondary btn-sm" onClick={() => void generate()} disabled={busy}>
            {busy ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Bot size={14} aria-hidden />} Draft resolution brief
          </button>
        )
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      {busy && <p className="small muted">The agent is reading the ticket, lease and ledger…</p>}
      {ticket.decision_briefs.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          {flagged ? "No brief yet." : "Briefs are drafted for tickets the policy engine flags."}
        </p>
      ) : (
        <ul className="plain-list compact">
          {ticket.decision_briefs.map((b) => (
            <li key={b.brief_id}>
              <Link to={`/inbox/${b.brief_id}`}>#{b.brief_id}</Link> {b.title}
              <span className="list-meta">
                <BriefStatusBadge status={b.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
