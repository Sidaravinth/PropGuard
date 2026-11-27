import { CheckCircle2, CircleAlert, FileText, LoaderCircle, UploadCloud, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { ApiRequestError } from "../../api/client";
import { uploadLease, type UploadResult } from "../../api/leases";
import { formatBytes } from "../../lib/format";

type ItemState =
  | { phase: "queued" }
  | { phase: "uploading"; progress: number }
  | { phase: "extracting" }
  | { phase: "done"; result: UploadResult }
  | { phase: "error"; code: string; message: string; existingLeaseId?: number | null };

interface Item {
  id: number;
  file: File;
  state: ItemState;
}

const ACCEPTED = [".pdf", ".txt"];
const MAX_BYTES = 10 * 1024 * 1024;

function validate(file: File): string | null {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!ACCEPTED.includes(ext)) return "Only .pdf and .txt lease documents are supported";
  if (file.size === 0) return "The file is empty";
  if (file.size > MAX_BYTES) return "The file is larger than 10 MB";
  return null;
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
    case "extracting":
      return (
        <span className="status-line">
          <LoaderCircle size={14} className="spin" aria-hidden /> Extracting lease terms…
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
      return (
        <span className={`status-line ${gaps ? "text-warning" : "text-success"}`}>
          {gaps ? <CircleAlert size={14} aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
          {gaps ? `Extracted · ${gaps} item${gaps === 1 ? " needs" : "s need"} review` : "Extracted · all fields verified"}
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
          const result = await uploadLease(item.file, (p) => update(item.id, p >= 1 ? { phase: "extracting" } : { phase: "uploading", progress: p }));
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

  const busy = items.some((i) => i.state.phase === "queued" || i.state.phase === "uploading" || i.state.phase === "extracting");

  return (
    <section className="card mb">
      <header className="card-header">
        <div>
          <h2 className="card-title">Upload lease documents</h2>
          <p className="card-subtitle">PDF or text files, up to 10 MB each. The original is saved before extraction starts.</p>
        </div>
        <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close upload panel" title={busy ? "Wait for uploads to finish" : "Close"}>
          <X size={18} />
        </button>
      </header>
      <div className="card-body">
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
          <div className="muted small">Multiple files allowed · .pdf, .txt</div>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.txt,application/pdf,text/plain"
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
