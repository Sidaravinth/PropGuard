import { LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiRequestError } from "../../api/client";
import { leasesApi, type FieldSource, type LeaseDetail } from "../../api/leases";
import { Alert, FieldStatusBadge, Modal } from "../../components/ui";
import { centsToDollarInput, FIELD_META, formatFieldValue, parseDollarsToCents } from "../../lib/format";

/** Correct or confirm one extracted field. The server validates and records who changed what and why. */
export function CorrectFieldDialog({ leaseId, field, onClose, onSaved }: { leaseId: number; field: FieldSource; onClose: () => void; onSaved: (l: LeaseDetail) => void }) {
  const meta = FIELD_META[field.field_name];
  const initial = field.value_text === null ? "" : meta.kind === "money" ? centsToDollarInput(Number(field.value_text)) : field.value_text;
  const [value, setValue] = useState(initial);
  const [absent, setAbsent] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let payload: string | number | null = null;
    if (!absent) {
      if (meta.kind === "money") {
        payload = parseDollarsToCents(value);
        if (payload === null) return setError("Enter an amount like 1500 or 1,500.00");
      } else if (meta.kind === "days") {
        if (!/^\d+$/.test(value.trim())) return setError("Enter a whole number of days");
        payload = Number(value.trim());
      } else {
        if (!value.trim()) return setError("Enter a value, or tick “Not in the document”");
        payload = value.trim();
      }
    }
    setBusy(true);
    try {
      onSaved(await leasesApi.correct(leaseId, field.field_name, payload, reason));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not save the correction");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Correct ${meta.label.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="correct-form" className="btn btn-primary" disabled={busy || reason.trim().length < 3}>
            {busy && <LoaderCircle size={16} className="spin" aria-hidden />}
            Save correction
          </button>
        </>
      }
    >
      <form id="correct-form" className="form" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        <dl className="details compact">
          <dt>Current value</dt>
          <dd>
            {formatFieldValue(field.field_name, field.value_text)} <FieldStatusBadge status={field.status} />
          </dd>
          {field.note && (
            <>
              <dt>Why flagged</dt>
              <dd className="muted">{field.note}</dd>
            </>
          )}
          {field.verbatim_snippet && (
            <>
              <dt>Source excerpt</dt>
              <dd>
                <blockquote className="quote">{field.verbatim_snippet}</blockquote>
                <span className="muted small">
                  {[field.section_ref, field.page ? `page ${field.page}` : null].filter(Boolean).join(" · ")}
                </span>
              </dd>
            </>
          )}
        </dl>

        <label className="field">
          <span className="field-label">Correct value</span>
          {meta.kind === "date" ? (
            <input type="date" value={value} onChange={(e) => setValue(e.target.value)} disabled={absent} required={!absent} />
          ) : (
            <span className={meta.kind === "money" ? "input-prefix" : meta.kind === "days" ? "input-suffix" : undefined} data-affix={meta.kind === "money" ? "$" : meta.kind === "days" ? "days" : undefined}>
              <input
                type="text"
                inputMode={meta.kind === "money" ? "decimal" : meta.kind === "days" ? "numeric" : "text"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={absent}
              />
            </span>
          )}
        </label>
        {meta.kind !== "text" && (
          <label className="checkbox">
            <input type="checkbox" checked={absent} onChange={(e) => setAbsent(e.target.checked)} />
            Not in the document (keep it flagged as missing)
          </label>
        )}
        <label className="field">
          <span className="field-label">Reason</span>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Checked against the signed copy, page 2" required />
          <span className="field-hint">Recorded with your name in the correction history.</span>
        </label>
      </form>
    </Modal>
  );
}
