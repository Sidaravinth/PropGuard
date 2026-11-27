import { CheckCircle2, CircleAlert, FileSpreadsheet, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { importRequest, type ImportKind, type ImportPreview, type ImportResult, type Mapping } from "../api/records";
import { errorMessage } from "../lib/useLoad";
import { Alert, Modal } from "./ui";

const TITLE: Record<ImportKind, string> = { tenants: "Import tenants", ledger: "Import payment ledger" };
const HELP: Record<ImportKind, string> = {
  tenants: "One tenant per row. Identify the unit by Unit ID, or by property name and unit number. Units must exist first.",
  ledger: "One row per tenant and month. Identify the tenant by ID, email or a unique name. Amounts in dollars.",
};

/**
 * File → column mapping → row-by-row preview → import. The server validates everything again on
 * import; nothing is saved until "Import" is pressed.
 */
export function ImportWizard({ kind, onClose, onImported }: { kind: ImportKind; onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSkipped, setShowSkipped] = useState(true);

  const run = async (f: File, m?: Mapping) => {
    setBusy(true);
    setError(null);
    try {
      const p = await importRequest<ImportPreview>(kind, "preview", f, m);
      setPreview(p);
      setMapping(p.mapping);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const changeMapping = (key: string, value: string) => {
    const next = { ...mapping, [key]: value === "" ? null : Number(value) };
    setMapping(next);
    if (file) void run(file, next);
  };

  const commit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await importRequest<ImportResult>(kind, "commit", file, mapping));
      onImported();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const fields = preview?.fields ?? [];
  const mappedFields = fields.filter((f) => mapping[f.key] !== null && mapping[f.key] !== undefined);
  const rows = (preview?.rows ?? []).filter((r) => showSkipped || r.action === "import");

  return (
    <Modal
      title={TITLE[kind]}
      wide
      onClose={onClose}
      footer={
        result ? (
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy || !preview || !!preview.mapping_error || preview.summary.importable === 0} onClick={() => void commit()}>
              {busy && <LoaderCircle size={16} className="spin" aria-hidden />}
              Import {preview?.summary.importable ?? 0} row{preview?.summary.importable === 1 ? "" : "s"}
            </button>
          </>
        )
      }
    >
      {error && <Alert tone="error">{error}</Alert>}

      {result ? (
        <div className="import-result">
          <Alert tone="success">
            <CheckCircle2 size={16} aria-hidden /> Imported <strong>{result.imported}</strong> row{result.imported === 1 ? "" : "s"} from {result.doc_name}
            {result.skipped ? `; ${result.skipped} skipped.` : "."} The original file is saved with the import.
          </Alert>
          {result.skipped_rows.length > 0 && (
            <ul className="skip-list">
              {result.skipped_rows.map((s) => (
                <li key={s.row_number}>
                  Row {s.row_number}: {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            {HELP[kind]}
          </p>
          <label className="file-pick">
            <FileSpreadsheet size={18} aria-hidden />
            <span>{file ? file.name : "Choose a .csv or .xlsx file"}</span>
            <input
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setFile(f);
                setPreview(null);
                setResult(null);
                void run(f);
              }}
            />
          </label>

          {busy && !preview && <div className="spinner mt" aria-label="Reading file" />}

          {preview && (
            <>
              <h3 className="section-title">Map columns</h3>
              <div className="mapping-grid">
                {fields.map((f) => (
                  <label key={f.key} className="field">
                    <span className="field-label">
                      {f.label}
                      {f.required && <span className="text-danger"> *</span>}
                    </span>
                    <select value={mapping[f.key] ?? ""} onChange={(e) => changeMapping(f.key, e.target.value)}>
                      <option value="">— not in file —</option>
                      {preview.headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h}
                        </option>
                      ))}
                    </select>
                    {f.hint && <span className="field-hint">{f.hint}</span>}
                  </label>
                ))}
              </div>

              {preview.mapping_error ? (
                <Alert tone="info">{preview.mapping_error}</Alert>
              ) : (
                <>
                  <div className="preview-head">
                    <h3 className="section-title">Preview</h3>
                    <div className="badges">
                      <span className="badge badge-success">{preview.summary.importable} to import</span>
                      {preview.summary.duplicates > 0 && <span className="badge badge-warning">{preview.summary.duplicates} duplicate</span>}
                      {preview.summary.errors > 0 && <span className="badge badge-danger">{preview.summary.errors} with errors</span>}
                      <label className="checkbox small">
                        <input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} /> Show skipped rows
                      </label>
                    </div>
                  </div>
                  <div className="table-wrap preview-table">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Row</th>
                          {mappedFields.map((f) => (
                            <th key={f.key}>{f.label}</th>
                          ))}
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.row_number} className={r.action === "skip" ? "row-skip" : undefined}>
                            <td className="muted">{r.row_number}</td>
                            {mappedFields.map((f) => (
                              <td key={f.key}>{r.values[f.key] || <span className="muted">—</span>}</td>
                            ))}
                            <td>
                              {r.action === "import" ? (
                                <span className="status-line text-success">
                                  <CheckCircle2 size={14} aria-hidden /> Import
                                </span>
                              ) : (
                                <span className={`status-line ${r.errors.length ? "text-danger" : "text-warning"}`}>
                                  <CircleAlert size={14} aria-hidden /> {r.errors.length ? r.errors.join("; ") : `Duplicate: ${r.duplicate}`}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
