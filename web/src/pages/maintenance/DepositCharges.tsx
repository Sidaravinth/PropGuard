import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { recordsApi, type DepositReservation, type TicketDetail } from "../../api/records";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Card, Modal } from "../../components/ui";
import { formatCents, formatDate } from "../../lib/format";
import { errorMessage } from "../../lib/useLoad";

const TONE = { reserved: "warning", collected: "success", released: "" } as const;

/** "$1,500.00 available · $480.00 reserved · $0.00 collected of $1,500.00 held" */
export function depositText(d: NonNullable<TicketDetail["lease"]>["deposit"]): string {
  return d ? `${formatCents(d.available_cents)} available · ${formatCents(d.reserved_cents)} reserved · ${formatCents(d.collected_cents)} collected of ${formatCents(d.held_cents)} held` : "No deposit recorded";
}

/** Approved tenant charges on this ticket, with the human actions that settle them. */
export function DepositCharges({ ticket, onChanged }: { ticket: TicketDetail; onChanged: () => Promise<unknown> }) {
  const { profile } = useAuth();
  const [action, setAction] = useState<{ kind: "collect" | "release"; r: DepositReservation } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!ticket.deposit_reservations.length) return null;

  const close = () => {
    setAction(null);
    setReason("");
    setError(null);
  };
  const confirm = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "collect") await recordsApi.collectCharge(action.r.reservation_id);
      else await recordsApi.releaseCharge(action.r.reservation_id, reason.trim());
      await onChanged();
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Approved tenant charges" subtitle="Reserved against the security deposit on approval, then collected or released." className="mb">
      <ul className="plain-list compact">
        {ticket.deposit_reservations.map((r) => {
          const allowed = profile?.approvalTiers.includes(r.required_tier) ?? false;
          return (
            <li key={r.reservation_id}>
              <strong>{formatCents(r.amount_cents)}</strong> <span className={`badge badge-${TONE[r.status]}`}>{r.status}</span>
              <span className="muted small">
                reserved by {r.reserved_by_name} on {formatDate(r.reserved_at)}
                {r.resolved_by_name ? ` · ${r.status} by ${r.resolved_by_name}` : ""}
                {r.release_reason ? ` · “${r.release_reason}”` : ""}
              </span>
              {r.status === "reserved" && (
                <span className="list-meta">
                  <button className="btn btn-secondary btn-sm" disabled={!allowed} onClick={() => setAction({ kind: "collect", r })}>
                    Collect
                  </button>{" "}
                  <button className="btn btn-secondary btn-sm" disabled={!allowed} onClick={() => setAction({ kind: "release", r })}>
                    Release
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {action && (
        <Modal
          title={action.kind === "collect" ? "Record collection" : "Release reservation"}
          onClose={close}
          footer={
            <>
              <button className="btn btn-secondary" onClick={close}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy || (action.kind === "release" && reason.trim().length < 3)} onClick={() => void confirm()}>
                {busy && <LoaderCircle size={16} className="spin" aria-hidden />} Confirm
              </button>
            </>
          }
        >
          {error && <Alert tone="error">{error}</Alert>}
          {action.kind === "collect" ? (
            <p style={{ marginTop: 0 }}>
              Deduct <strong>{formatCents(action.r.amount_cents)}</strong> from the security deposit? The amount moves from reserved to collected. This cannot be undone.
            </p>
          ) : (
            <label className="field">
              <span className="field-label">Reason for releasing {formatCents(action.r.amount_cents)} (for a cancelled charge)</span>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </label>
          )}
        </Modal>
      )}
    </Card>
  );
}
