import { LoaderCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiRequestError } from "../../api/client";
import { leasesApi } from "../../api/leases";
import { Alert, Modal } from "../../components/ui";

/**
 * Confirm and delete an uploaded lease document. The server removes the record, the stored original and
 * the lease extracted from it, and refuses when the lease has Decision Briefs, a renewal offer or deposit
 * charges (that message is shown here as is).
 */
export function DeleteDocumentDialog({
  documentId,
  docName,
  hasLease,
  onClose,
  onDeleted,
}: {
  documentId: number;
  docName: string;
  hasLease: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await leasesApi.deleteDocument(documentId);
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "The document could not be deleted");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Delete lease document?"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" aria-hidden /> : <Trash2 size={16} aria-hidden />} Delete
          </button>
        </>
      }
    >
      {error && <Alert tone="error">{error}</Alert>}
      <p style={{ marginTop: 0 }}>
        <strong>{docName}</strong> will be deleted, with its stored original file
        {hasLease ? " and the lease extracted from it: its terms, clauses, corrections and Q&A conversations." : "."}
      </p>
      <p className="muted small">
        Units and tenants are kept. This cannot be undone, but the audit trail keeps a record of the upload, the extraction and this deletion. A lease with
        Decision Briefs, a renewal offer or deposit charges cannot be deleted.
      </p>
    </Modal>
  );
}
