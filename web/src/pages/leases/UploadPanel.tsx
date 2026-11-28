import { CheckCircle2, CircleAlert, FileText, LoaderCircle, ScanText, UploadCloud, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { ApiRequestError } from "../../api/client";
import { leasesApi, uploadLease, type DocumentRecord, type UploadResult } from "../../api/leases";
import { Alert } from "../../components/ui";
import { documentStatusLabel, formatBytes, OCR_WARNING, textMethodLabel } from "../../lib/format";

type ItemState =
  | { phase: "queued" }
  | { phase: "uploading"; progress: number }
  | { phase: "processing"; doc: DocumentRecord }
  | { phase: "done"; result: UploadResult }
  | { phase: "error"; code: string; message: string; existingLeaseId?: number | null };

interface Item {
  id: number;
  file: File;
  state: ItemState;
}

const ACCEPTED = [".pdf", ".txt", ".docx", ".png", ".jpg", ".jpeg"];
const POLL_MS = 1500;
const MAX_BYTES = 10 * 1024 * 1024;

function validate(file: File): string | null {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!ACCEPTED.includes(ext)) return "Supported files: .pdf (text or scanned), .docx, .txt, .png and .jpg";
  if (file.size === 0) return "The file is empty";
  if (file.size > MAX_BYTES) return "The file is larger than 10 MB";
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Follow a stored upload through its stages (text extraction, OCR, AI extraction) until it finishes, then
 * load the extracted lease. A few failed polls in a row (for example a brief network drop) are tolerated.
 */
async function waitForProcessing(doc: DocumentRecord, onProgress: (doc: DocumentRecord) => void): Promise<UploadResult> {
  let current = doc;
  let failures = 0;
  while (current.status === "processing") {
    onProgress(current);
    await sleep(POLL_MS);
    try {
      current = await leasesApi.document(doc.document_id);
      failures = 0;
    } catch (err) {
      if ((err instanceof ApiRequestError && err.status === 401) || ++failures >= 5) throw err;
    }
  }
  const lease = current.lease_id ? await leasesApi.get(current.lease_id) : null;
  return { document: current, lease };
}

function ItemStatus({ item }: { item: Item }) {
  const s = item.state;
  switch (s.phase) {
    case "queued":
      return <span className="muted small">Waiting…</span>;
    case "uploading":
      return (
        <div className="progress" aria-label={`Uploading ${Math.round(s.progress * 100)}%`}>
          <div className="progress-bar" style={{ width: `${Math.round(s.progress * 100)}%` }} />
        </div>
      );
    case "processing":
      return (
        <span className="status-line">
          <LoaderCircle size={14} className="spin" aria-hidden /> {documentStatusLabel(s.doc)}…
        </span>
      );
    case "error":
      return (
        <span className="status-line text-danger">
          <CircleAlert size={14} aria-hidden /> {s.message}
          {s.existingLeaseId ? (
            <>
              {" "}
              · <Link to={`/leases/${s.existingLeaseId}`}>Open existing lease</Link>
            </>
          ) : null}
        </span>
      );
    case "done": {
      const { document: d, lease } = s.result;
      if (d.status === "failed") {
        return (
          <span className="status-line text-danger">
            <CircleAlert size={14} aria-hidden /> Saved, but extraction failed: {d.error_message}
          </span>
        );
      }
      const gaps = lease?.gaps.length ?? 0;
      const method = textMethodLabel(d.text_method);
      return (
        <span className={`status-line ${gaps ? "text-warning" : "text-success"}`}>
          {gaps ? <CircleAlert size={14} aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
          {gaps ? `Review required · ${gaps} item${gaps === 1 ? " needs" : "s need"} review` : "Completed · all fields verified"}
          {method && d.text_method !== "text" && (
            <span className="badge badge-warning" title="Text was recognised from an image. Check values against the original.">
              <ScanText size={12} aria-hidden /> {method}
            </span>
          )}
          {lease && (
            <>
              {" "}
              · <Link to={`/leases/${lease.lease_id}`}>Review lease</Link>
            </>
          )}
        </span>
      );
    }
  }
}

/** Multi-file lease upload. Files are uploaded one at a time so extraction is not rate-limited. */
export function UploadPanel({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const running = useRef(false);
  const queue = useRef<Item[]>([]);

  const update = (id: number, state: ItemState) => setItems((all) => all.map((i) => (i.id === id ? { ...i, state } : i)));

  const pump = async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const item = queue.current.shift()!;
        update(item.id, { phase: "uploading", progress: 0 });
        try {
          const stored = await uploadLease(item.file, (p) => p < 1 && update(item.id, { phase: "uploading", progress: p }));
          const result = await waitForProcessing(stored.document, (doc) => update(item.id, { phase: "processing", doc }));
          update(item.id, { phase: "done", result });
          onUploaded();
        } catch (err) {
          const e = err instanceof ApiRequestError ? err : new ApiRequestError(0, "ERROR", String(err));
          const details = e.details as { lease_id?: number | null } | undefined;
          update(item.id, { phase: "error", code: e.code, message: e.message, existingLeaseId: details?.lease_id ?? null });
        }
      }
    } finally {
      running.current = false;
    }
  };

  const addFiles = (files: FileList | File[]) => {
    const added: Item[] = [];
    for (const file of Array.from(files)) {
      const problem = validate(file);
      const item: Item = { id: nextId.current++, file, state: problem ? { phase: "error", code: "INVALID", message: problem } : { phase: "queued" } };
      added.push(item);
      if (!problem) queue.current.push(item);
    }
    setItems((all) => [...all, ...added]);
    void pump();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const busy = items.some((i) => i.state.phase === "queued" || i.state.phase === "uploading" || i.state.phase === "processing");

  return (
    <section className="card mb">
      <header className="card-header">
        <div>
          <h2 className="card-title">Upload lease documents</h2>
          <p className="card-subtitle">PDF (text or scanned), Word, text or image files, up to 10 MB each. The original is saved before extraction starts.</p>
        </div>
        <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close upload panel" title={busy ? "Wait for uploads to finish" : "Close"}>
          <X size={18} />
        </button>
      </header>
      <div className="card-body">
        <Alert tone="info">
          <strong>Please verify extracted data.</strong> {OCR_WARNING}
        </Alert>
        <div
          className={`dropzone${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        >
          <UploadCloud size={28} strokeWidth={1.6} aria-hidden />
          <div>
            <strong>Drop lease files here</strong> or click to choose
          </div>
          <div className="muted small">Multiple files allowed · .pdf, .docx, .txt, .png, .jpg · scanned pages are read with OCR on this server</div>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.txt,.docx,.png,.jpg,.jpeg,application/pdf,text/plain,image/png,image/jpeg,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {items.length > 0 && (
          <ul className="upload-list">
            {items.map((item) => (
              <li key={item.id} className="upload-item">
                <FileText size={18} className="muted" aria-hidden />
                <div className="upload-item-main">
                  <div className="upload-item-name">
                    {item.file.name} <span className="muted small">· {formatBytes(item.file.size)}</span>
                  </div>
                  <ItemStatus item={item} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
