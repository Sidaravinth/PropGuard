import { ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Database, FileText, LoaderCircle, ShieldCheck, XCircle } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { briefsApi, type BriefDetail, type Evidence, type Figure, type MaintenanceContent, type RenewalContent } from "../../api/briefs";
import { useAuth } from "../../auth/AuthContext";
import { ChargeWarning } from "../../components/ChargeWarning";
import { Alert, ApproverBadge, Card, Modal, PageHeader, VerdictBadge } from "../../components/ui";
import { formatDate } from "../../lib/format";
import { errorMessage, useLoad } from "../../lib/useLoad";
import { BriefStatusBadge, BriefTypeBadge, PriorityBadge } from "./badges";

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
const RENEWAL_NAMES: Record<string, string> = { standard: "Standard renewal", twelve_month_3pct: "12-month renewal with 3% adjustment", month_to_month: "Month-to-month" };
const OPTION_PREFIX: Record<string, string> = { standard: "standard", twelve_month_3pct: "twelve_month", month_to_month: "month_to_month" };
const ACTION_LABEL: Record<string, string> = {
  approve_at_work_order: "Approve at the work order amount",
  approve_at_quote: "Approve at the technician quote",
  request_revised_quote: "Request a revised quote",
  hold_until_balance_paid: "Hold until the tenant's balance is paid",
};

function sourceText(f: Figure): string {
  const s = f.source as Record<string, unknown>;
  switch (s.kind) {
    case "column":
      return `${s.table}.${s.column} (id ${s.id})`;
    case "evaluation":
      return `policy evaluation #${s.evaluation_id} · ${s.path}`;
    case "policy_constant":
      return `policy rule ${s.name}`;
    default:
      return `computed in code: ${s.rule}`;
  }
}

/** Render a template: every {{figure}} becomes a highlighted value whose source is one hover away. */
function FigureText({ template, figures }: { template: string; figures: Map<string, Figure> }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    parts.push(template.slice(last, m.index));
    const f = figures.get(m[1]!.toLowerCase());
    parts.push(
      f ? (
        <span key={m.index} className="fig" title={`${f.label} — ${sourceText(f)}`}>
          {f.display}
        </span>
      ) : (
        m[0]
      ),
    );
    last = m.index! + m[0].length;
  }
  parts.push(template.slice(last));
  return <>{parts}</>;
}

function EvidenceChips({ ids, onOpen }: { ids: string[]; onOpen: (id: string) => void }) {
  if (!ids.length) return null;
  return (
    <span className="ev-chips">
      {ids.map((id) => (
        <button key={id} className="ev-chip" onClick={() => onOpen(id)} title="Show evidence">
          {id}
        </button>
      ))}
    </span>
  );
}

function EvidencePanel({ evidence, open, setOpen }: { evidence: Evidence[]; open: string | null; setOpen: (id: string | null) => void }) {
  const order = ["lease_field", "clause", "ledger_entry", "ticket", "policy_evaluation", "lease", "ledger", "tenant", "unit", "policy_rule"];
  const sorted = [...evidence].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <ul className="evidence-list">
      {sorted.map((e) => (
        <li key={e.id} id={`ev-${e.id}`} className={open === e.id ? "open" : undefined}>
          <button className="evidence-head" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
            {open === e.id ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            <code>{e.id}</code>
            <span className="small">{e.label}</span>
            {e.status && <span className={`badge ${e.status === "unverified" || e.status === "needs_review" || e.status === "missing" ? "badge-warning" : ""}`}>{e.status}</span>}
          </button>
          {open === e.id && (
            <div className="evidence-body small">
              <div className="muted">
                <Database size={12} aria-hidden /> {e.record.table} · id {String(e.record.id)}
              </div>
              {e.source_doc && (
                <div className="muted">
                  <FileText size={12} aria-hidden /> {e.source_doc}
                  {e.section_ref ? ` · ${e.section_ref}` : ""}
                  {e.page ? ` · page ${e.page}` : ""}
                </div>
              )}
              {e.value !== undefined && e.value !== null && <div>Value: {String(e.value)}</div>}
              {e.snippet && <blockquote className="quote">{e.snippet}</blockquote>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function DecisionControls({ brief, selected, onDecided }: { brief: BriefDetail; selected: string | null; onDecided: (b: BriefDetail) => void }) {
  const { profile } = useAuth();
  const [comment, setComment] = useState("");
  const [confirm, setConfirm] = useState<"approve" | "reject" | "request_revision" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canTier = profile?.approvalTiers.includes(brief.required_approver) ?? false;
  const blocked = !brief.grounding.passed ? "The grounding check failed, so this brief cannot be approved." : brief.needs_review ? "Source data is missing; correct the lease and regenerate before approving." : null;

  const submit = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      onDecided(await briefsApi.decide(brief.brief_id, { decision: confirm, option_key: confirm === "approve" ? selected : null, comment: comment.trim() || null }));
      setConfirm(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const optionName = (k: string | null) =>
    k ? (brief.brief_type === "renewal" ? RENEWAL_NAMES[k] : `Option ${k}: ${(brief.content as MaintenanceContent).options.find((o) => o.key === k)?.title ?? ""}`) : "";

  return (
    <Card title="Your decision" subtitle="Approval is re-checked on the server: your role, every figure against the database, and the policy engine.">
      {error && <Alert tone="error">{error}</Alert>}
      <dl className="details compact mb-sm">
        <dt>Required approver</dt>
        <dd>
          <ApproverBadge tier={brief.required_approver} />
        </dd>
        <dt>You are</dt>
        <dd>{profile?.user.role_label}</dd>
        <dt>Selected option</dt>
        <dd>{selected ? optionName(selected) : <span className="muted">Choose an option on the left</span>}</dd>
      </dl>
      {!canTier && <Alert tone="info">This decision needs a {brief.required_approver === "REGIONAL_DIRECTOR" ? "Regional Director" : "Property Manager"}. You can reject it or request a revision.</Alert>}
      {blocked && <Alert tone="info">{blocked}</Alert>}
      <label className="field mb-sm">
        <span className="field-label">Comment (optional)</span>
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="Recorded with your decision in the audit trail" />
      </label>
      <div className="decision-buttons">
        <button className="btn btn-primary" disabled={!selected || !canTier || !!blocked} onClick={() => setConfirm("approve")}>
          <CheckCircle2 size={16} aria-hidden /> Approve
        </button>
        <button className="btn btn-secondary" onClick={() => setConfirm("request_revision")}>
          Request revision
        </button>
        <button className="btn btn-danger" onClick={() => setConfirm("reject")}>
          <XCircle size={16} aria-hidden /> Reject
        </button>
      </div>
      {confirm && (
        <Modal
          title={confirm === "approve" ? "Confirm approval" : confirm === "reject" ? "Reject this brief?" : "Request a revision?"}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className={`btn ${confirm === "reject" ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={() => void submit()}>
                {busy && <LoaderCircle size={16} className="spin" aria-hidden />} Confirm
              </button>
            </>
          }
        >
          {confirm === "approve" ? (
            <>
              <p style={{ marginTop: 0 }}>
                Approve <strong>{optionName(selected)}</strong>?
              </p>
              {(brief.content as MaintenanceContent).options.find((o) => o.key === selected)?.action?.startsWith("approve_") && <ChargeWarning notice={brief.charge_notice} />}
              <p className="small muted">
                {brief.brief_type === "renewal"
                  ? "This records the renewal offer and marks the renewal notice to the tenant as sent (simulated)."
                  : "This executes the option's action on the ticket and marks the drafted message as sent (simulated)."}{" "}
                The server first re-runs the deterministic checks and refuses if anything changed.
              </p>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>
                This declines the AI proposal only.{" "}
                {brief.brief_type === "maintenance"
                  ? `Ticket #${brief.ticket_id} stays flagged and still needs a resolution; you can draft a new brief.`
                  : "The lease is unchanged. No new brief is generated automatically for this cycle; you can generate one with the button."}
              </p>
              <p className="small muted">{comment.trim() ? `Your comment: “${comment.trim()}”` : "You can add a comment before confirming."}</p>
            </>
          )}
        </Modal>
      )}
    </Card>
  );
}

export function BriefDetailPage() {
  const id = Number(useParams().id);
  const { data: b, error, setData } = useLoad(() => briefsApi.get(id), [id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [openEv, setOpenEv] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [allFigures, setAllFigures] = useState(false);
  const figures = useMemo(() => new Map((b?.figures ?? []).map((f) => [f.key, f])), [b]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!b) return <div className="spinner" aria-label="Loading" />;
  const t = b.content_template;
  if (!t) return <Alert tone="error">This brief has no content.</Alert>;
  const T = ({ s }: { s: string }) => <FigureText template={s} figures={figures} />;
  const openEvidence = (evId: string) => {
    setOpenEv(evId);
    setTimeout(() => document.getElementById(`ev-${evId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 30);
  };
  const pending = b.status === "pending";
  const recommended = b.brief_type === "renewal" ? (t as RenewalContent).recommendation.option_key : (t as MaintenanceContent).recommended_option;
  const fig = (k: string) => figures.get(k);
  // The message belongs to an option: preview the chosen one (after a decision, the approved one).
  const wanted = b.decision?.selected_option ?? selected ?? recommended;
  // A renewal with missing data recommends "none": preview the first option until one is chosen.
  const previewKey = t.options.some((o) => o.key === wanted) ? wanted : t.options[0]!.key;
  const maintenance = b.brief_type === "maintenance" ? (t as MaintenanceContent) : null;
  const renewalContent = maintenance ? null : (t as RenewalContent);
  const previewMessage = maintenance
    ? (maintenance.options.find((o) => o.key === previewKey)?.message ?? maintenance.message)
    : (renewalContent!.options.find((o) => o.key === previewKey)?.email ?? renewalContent!.email);
  const recipient = maintenance && previewMessage && "recipient" in previewMessage ? ` · to the ${previewMessage.recipient}` : "";
  const sharedFormat = Boolean(maintenance?.message ?? renewalContent?.email);

  return (
    <>
      <Link to="/inbox" className="back-link">
        <ArrowLeft size={14} aria-hidden /> Decision Inbox
      </Link>
      <PageHeader
        title={`#${b.brief_id} · ${b.title}`}
        description={[b.tenant?.name, b.unit ? `${b.unit.property_name} · Unit ${b.unit.unit_number}` : null, `created ${formatDate(b.created_at)}`, b.model ? `drafted by ${b.model}` : null].filter(Boolean).join(" · ")}
      />
      <div className="badges mb">
        <BriefTypeBadge type={b.brief_type} />
        <BriefStatusBadge status={b.status} />
        <PriorityBadge priority={b.priority} />
        <ApproverBadge tier={b.required_approver} />
        {b.grounding.passed ? (
          <span className="badge badge-success" title={`${b.grounding.placeholders_used.length} figures from the database; no ungrounded numbers`}>
            <ShieldCheck size={12} aria-hidden /> Grounded
          </span>
        ) : (
          <span className="badge badge-danger">Grounding failed</span>
        )}
        {b.lease_id && <Link to={`/leases/${b.lease_id}`} className="badge">Lease #{b.lease_id}</Link>}
        {b.ticket_id && <Link to={`/maintenance/${b.ticket_id}`} className="badge">Ticket #{b.ticket_id}</Link>}
      </div>

      {!b.grounding.passed && (
        <Alert tone="error">
          <strong>Ungrounded content.</strong> The model wrote figures that are not in the database:{" "}
          {[...b.grounding.ungrounded_figures.map((u) => `"${u.text}"`), ...b.grounding.unknown_placeholders.map((u) => `{{${u.key}}}`), ...b.grounding.unknown_evidence_ids, ...(b.grounding.internal_ids_in_text ?? []).map((u) => u.text)].join(", ")}. Approval is blocked.
        </Alert>
      )}
      {b.needs_review && <Alert tone="info">Source data for this lease is missing or unverified, so no prices were generated. Fix the lease in Lease Management, then regenerate.</Alert>}
      <ChargeWarning notice={b.charge_notice} />
      {b.decision && (
        <Alert tone={b.status === "approved" ? "success" : "info"}>
          <strong>{b.status === "approved" ? "Approved" : b.status === "rejected" ? "Rejected" : "Revision requested"}</strong> by {b.decision.decided_by} on {formatDate(b.decision.decided_at)}
          {b.decision.selected_option ? ` · option ${b.decision.selected_option}` : ""}
          {b.decision.comment ? ` · “${b.decision.comment}”` : ""}
          {b.decision.execution && <div className="small mt-xs">Executed: {String(b.decision.execution.action).replace(/_/g, " ")}{(b.decision.execution.message as { recipient_type?: string } | undefined)?.recipient_type ? ` · message to ${(b.decision.execution.message as { recipient_type: string }).recipient_type} marked sent (simulated)` : ""}</div>}
        </Alert>
      )}

      <div className="review-layout">
        <div className="review-main">
          <Card title="Summary" subtitle="AI-written. Highlighted numbers come from the database; hover one to see its source." className="mb">
            <p className="brief-text">
              <T s={t.summary} />
            </p>
            {b.brief_type === "renewal" && (
              <>
                <h3 className="section-title">Tenant payment history</h3>
                <p className="brief-text">
                  <T s={(t as RenewalContent).payment_summary} />
                </p>
              </>
            )}
          </Card>

          <Card title={b.brief_type === "renewal" ? "Renewal options" : "Resolution options"} subtitle={pending ? "Select the option to approve" : undefined} className="mb">
            <div className="option-list">
              {t.options.map((o) => {
                const isRec = o.key === recommended;
                const p = OPTION_PREFIX[o.key];
                const priced = b.brief_type !== "renewal" || fig(`${p}_rent`)?.value !== null;
                return (
                  <label key={o.key} className={`option-card${selected === o.key ? " selected" : ""}${!priced ? " disabled" : ""}`}>
                    <div className="option-head">
                      {pending && <input type="radio" name="option" checked={selected === o.key} disabled={!priced} onChange={() => setSelected(o.key)} />}
                      <strong>{b.brief_type === "renewal" ? RENEWAL_NAMES[o.key] : `Option ${o.key}: ${(o as MaintenanceContent["options"][number]).title}`}</strong>
                      {isRec && <span className="badge badge-success">AI recommendation</span>}
                      {b.decision?.selected_option === o.key && <span className="badge badge-info">Selected</span>}
                    </div>
                    {b.brief_type === "renewal" ? (
                      <div className="option-figures">
                        <span>
                          Rent <strong>{fig(`${p}_rent`)?.display}</strong>
                        </span>
                        <span>Term {fig(`${p}_term_months`)?.value === null ? "rolling monthly" : fig(`${p}_term_months`)?.display}</span>
                        <span>
                          From {fig(`${p}_start`)?.display}
                          {fig(`${p}_end`)?.value ? ` to ${fig(`${p}_end`)?.display}` : ""}
                        </span>
                        <span>Change {fig(`${p}_rent_change`)?.display}</span>
                      </div>
                    ) : (
                      <div className="option-figures">
                        <span>Action: {ACTION_LABEL[(o as MaintenanceContent["options"][number]).action]}</span>
                      </div>
                    )}
                    <p className="brief-text small">
                      <T s={"explanation" in o ? o.explanation : (o as MaintenanceContent["options"][number]).rationale} />
                    </p>
                    {o.risks.length > 0 && (
                      <ul className="risk-list small">
                        {o.risks.map((r, i) => (
                          <li key={i}>
                            <T s={r} />
                          </li>
                        ))}
                      </ul>
                    )}
                    <EvidenceChips ids={o.evidence_ids} onOpen={openEvidence} />
                  </label>
                );
              })}
            </div>
            {b.brief_type === "renewal" && (
              <p className="brief-text small mt">
                <strong>Recommendation rationale:</strong> <T s={(t as RenewalContent).recommendation.rationale} />{" "}
                <EvidenceChips ids={(t as RenewalContent).recommendation.evidence_ids} onOpen={openEvidence} />
              </p>
            )}
          </Card>

          <Card title={b.brief_type === "renewal" ? "Risk assessment" : "Why the ticket was flagged"} className="mb">
            <ul className="plain-list">
              {b.brief_type === "renewal"
                ? (t as RenewalContent).risk_notes.map((r, i) => (
                    <li key={i} className="risk-row">
                      <CircleAlert size={15} className="text-warning" aria-hidden />
                      <span>
                        <T s={r.text} /> <EvidenceChips ids={r.evidence_ids} onOpen={openEvidence} />
                      </span>
                    </li>
                  ))
                : (t as MaintenanceContent).exception_explanations.map((x, i) => (
                    <li key={i} className="risk-row">
                      <CircleAlert size={15} className="text-danger" aria-hidden />
                      <span>
                        <code>{x.code}</code> <T s={x.explanation} /> <EvidenceChips ids={x.evidence_ids} onOpen={openEvidence} />
                      </span>
                    </li>
                  ))}
            </ul>
          </Card>

          <Card title="Financial breakdown" subtitle="Every number in this brief, with where it comes from" className="mb" actions={<button className="link-btn small" onClick={() => setAllFigures(!allFigures)}>{allFigures ? "Show figures used" : `Show all ${b.figures.length} computed figures`}</button>}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Figure</th>
                    <th className="right">Value</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {b.figures.filter((f) => allFigures || b.grounding.placeholders_used.includes(f.key)).map((f) => (
                    <tr key={f.key} className={b.grounding.placeholders_used.includes(f.key) ? undefined : "row-dim"}>
                      <td>
                        {f.label}
                        <div className="muted small">
                          <code>{`{{${f.key}}}`}</code>
                        </div>
                      </td>
                      <td className="right nowrap">
                        <strong>{f.display}</strong>
                      </td>
                      <td className="small">
                        {sourceText(f)} <EvidenceChips ids={f.evidence_ids} onOpen={openEvidence} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Deterministic policy result" subtitle="Computed in code; the agent can only explain it" className="mb">
            {b.policy ? (
              <>
                <div className="policy-head">
                  <VerdictBadge verdict={b.policy.verdict} />
                  <ApproverBadge tier={b.policy.approverRequired} />
                  <span className="muted small">auto-approve eligible: {b.policy.autoApproveEligible ? "yes" : "no"}</span>
                </div>
                <ul className="exception-list mt">
                  {b.policy.exceptions.map((x) => (
                    <li key={x.code}>
                      <CircleAlert size={16} className="text-danger" aria-hidden />
                      <div>
                        <strong>{x.code}</strong>
                        <div className="small">{x.message}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                <button className="link-btn small mt" onClick={() => setShowTrace(!showTrace)}>
                  {showTrace ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Rule trace
                </button>
                {showTrace && (
                  <ul className="trace-list">
                    {b.policy.ruleTrace.map((r, i) => (
                      <li key={i}>
                        {r.passed ? <CheckCircle2 size={14} className="text-success" /> : <XCircle size={14} className="text-danger" />} <code>{r.rule}</code> <span className="small">{r.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="small" style={{ margin: 0 }}>
                Renewal pricing, dates and payment reliability are computed by <code>policy/renewalPolicy.ts</code>. Renewal decisions require a Property Manager
                (a Regional Director may also approve).
              </p>
            )}
          </Card>

          <Card
            title={maintenance ? `Drafted message for option ${previewKey}${recipient}` : `Drafted renewal notice · ${RENEWAL_NAMES[previewKey]}`}
            subtitle="Only the approved option's message is marked as sent (simulated). Code adds a first line stating the decision."
          >
            {sharedFormat && <Alert tone="info">This brief uses the older single-message format. Regenerate it before approving.</Alert>}
            {previewMessage && (
              <div className="email">
                <div className="email-subject">
                  <T s={previewMessage.subject} />
                </div>
                <div className="email-body">
                  {previewMessage.body.split("\n").map((line, i) => (
                    <Fragment key={i}>
                      <T s={line} />
                      <br />
                    </Fragment>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>

        <aside className="review-side">
          {pending && <DecisionControls brief={b} selected={selected} onDecided={setData} />}
          <Card title="Evidence" subtitle="Database records and exact lease excerpts the agent retrieved" className={pending ? "mt" : undefined}>
            <EvidencePanel evidence={b.evidence} open={openEv} setOpen={setOpenEv} />
          </Card>
          {b.agent_run && (
            <Card title="Agent run" subtitle={`Run #${b.agent_run.run_id} · ${b.agent_run.status}`} className="mt">
              <ol className="tool-list small">
                {b.agent_run.tool_calls.map((c) => (
                  <li key={c.seq}>
                    <code>
                      {c.name}({Object.values(c.args).join(", ")})
                    </code>{" "}
                    <span className="muted">{c.by === "model" ? "called by model" : "enforced by orchestrator"}</span> {!c.ok && <span className="text-danger">{c.error}</span>}
                  </li>
                ))}
              </ol>
              {b.grounding.attempts && b.grounding.attempts.length > 1 && (
                <p className="small muted" style={{ marginBottom: 0 }}>
                  Draft attempts: {b.grounding.attempts.length} (earlier drafts were rejected by validation and corrected)
                </p>
              )}
            </Card>
          )}
          <Card title="Audit trail" className="mt" actions={<Link to={`/audit?brief_id=${b.brief_id}`} className="small">Open</Link>}>
            <ul className="timeline small">
              {b.audit.map((a) => (
                <li key={a.audit_id}>
                  <strong>{a.event_type.replace(/_/g, " ")}</strong> <span className="muted">· {a.actor_id} · {formatDate(a.occurred_at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </>
  );
}
