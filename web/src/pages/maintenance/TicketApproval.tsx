import { CheckCircle2, LoaderCircle, XCircle } from "lucide-react";
import { useState } from "react";
import { recordsApi, type TicketDetail } from "../../api/records";
import { useAuth } from "../../auth/AuthContext";
import { ChargeWarning } from "../../components/ChargeWarning";
import { Alert, ApproverBadge, Card, Modal } from "../../components/ui";
import { formatCents, formatDate } from "../../lib/format";
import { errorMessage } from "../../lib/useLoad";

/** "REGIONAL_DIRECTOR:Rae Director" (the audit actor) → "Rae Director (Regional Director)". */
function actorName(id: string): string {
  const [role = "", ...name] = id.split(":");
  return name.length ? `${name.join(":")} (${role.toLowerCase().replace(/(^|_)\w/g, (c) => c.replace("_", " ").toUpperCase())})` : id;
}

/**
 * Human sign-off for a ticket over the auto-approval limit with no policy exceptions.
 * The server re-runs the policy engine and checks the role; this only hides what would be refused.
 */
export function TicketApproval({ ticket, onChanged }: { ticket: TicketDetail; onChanged: () => Promise<unknown> }) {
  const { profile } = useAuth();
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = ticket.direct_decision;
  if (d) {
    return (
      <Alert tone={d.decision === "approve" ? "success" : "info"}>
        <strong>{d.decision === "approve" ? "Approved" : "Rejected"}</strong> by {actorName(d.decided_by)} on {formatDate(d.decided_at)}
        {d.approved_amount_cents !== null ? ` · ${formatCents(d.approved_amount_cents)}` : ""}
        {d.comment ? ` · “${d.comment}”` : ""}
      </Alert>
    );
  }
  const ev = ticket.latest_policy_evaluation;
  if (ticket.status !== "open" || !ev || ev.result.verdict !== "PASS" || ev.result.approverRequired === "AUTO_APPROVE") return null;
  const tier = ev.result.approverRequired as "PROPERTY_MANAGER" | "REGIONAL_DIRECTOR";
  const allowed = profile?.approvalTiers.includes(tier) ?? false;

  const submit = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await recordsApi.decideTicket(ticket.ticket_id, { decision: confirm, comment: comment.trim() || null });
      setConfirm(null);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
      setConfirm(null);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Approval required" subtitle="No policy exceptions. The server re-runs the policy check and verifies your role." className="mb">
      {error && <Alert tone="error">{error}</Alert>}
      <p className="small" style={{ marginTop: 0 }}>
        Repair cost <strong>{formatCents(ev.result.costBasisCents)}</strong> needs <ApproverBadge tier={tier} />
        {ticket.proposed_tenant_charge_cents ? ` · approving also reserves the ${formatCents(ticket.proposed_tenant_charge_cents)} tenant charge against the deposit` : ""}
      </p>
      {!allowed && <Alert tone="info">This decision needs a {tier === "REGIONAL_DIRECTOR" ? "Regional Director" : "Property Manager"}.</Alert>}
      <label className="field mb-sm">
        <span className="field-label">Comment (optional)</span>
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="Recorded with your decision in the audit trail" />
      </label>
      <div className="decision-buttons">
        <button className="btn btn-primary" disabled={!allowed} onClick={() => setConfirm("approve")}>
          <CheckCircle2 size={16} aria-hidden /> Approve
        </button>
        <button className="btn btn-danger" disabled={!allowed} onClick={() => setConfirm("reject")}>
          <XCircle size={16} aria-hidden /> Reject
        </button>
      </div>
      {confirm && (
        <Modal
          title={confirm === "approve" ? "Confirm approval" : "Reject this repair?"}
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
          {confirm === "approve" && <ChargeWarning notice={ticket.charge_notice} />}
          <p style={{ marginTop: 0 }}>
            {confirm === "approve" ? `Approve ${formatCents(ev.result.costBasisCents)} for ticket #${ticket.ticket_id}?` : `Reject ticket #${ticket.ticket_id}? The ticket is closed.`}
          </p>
        </Modal>
      )}
    </Card>
  );
}
