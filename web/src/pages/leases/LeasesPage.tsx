import { CircleAlert, FileText, LoaderCircle, RotateCw, Search, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ApiRequestError } from "../../api/client";
import { leasesApi, type DocumentRecord, type LeaseSummary } from "../../api/leases";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Card, EmptyState, LeaseFlagBadges, LeaseStateBadge, PageHeader } from "../../components/ui";
import { documentStatusLabel, formatCents, formatDate } from "../../lib/format";
import { DeleteDocumentDialog } from "./DeleteDocumentDialog";
import { UploadPanel } from "./UploadPanel";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "expiring", label: "Expiring ≤ 60 days" },
  { key: "expired", label: "Expired" },
  { key: "review", label: "Needs review" },
  { key: "unlinked", label: "Unlinked" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

function matchesFilter(l: LeaseSummary, f: FilterKey): boolean {
  switch (f) {
    case "all":
      return true;
    case "active":
      return l.lease_state === "active";
    case "expiring":
      return l.lease_state === "active" && l.days_until_end !== null && l.days_until_end <= 60;
    case "expired":
      return l.lease_state === "expired";
    case "review":
      return l.gaps.length > 0;
    case "unlinked":
      return !l.unit || !l.tenant;
  }
}

/** Uploads still being read (text extraction, OCR, AI extraction), with their current stage. */
function ProcessingUploads({ docs }: { docs: DocumentRecord[] }) {
  if (!docs.length) return null;
  return (
    <Alert tone="info">
      <strong>Processing {docs.length} upload{docs.length === 1 ? "" : "s"}.</strong>
      <ul className="gap-list">
        {docs.map((d) => (
          <li key={d.document_id} className="status-line">
            <LoaderCircle size={14} className="spin" aria-hidden /> {d.doc_name}: {documentStatusLabel(d)}…
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function FailedUploads({ docs, onRetried }: { docs: DocumentRecord[]; onRetried: () => void }) {
  const { can } = useAuth();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DocumentRecord | null>(null);
  if (!docs.length) return null;
  const retry = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      await leasesApi.retry(id);
      onRetried();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Retry failed");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Uploads that need attention" subtitle="The original files are saved. Retry extraction once the cause is fixed." className="mb">
      {error && <Alert tone="error">{error}</Alert>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Problem</th>
              <th>Uploaded</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.document_id}>
                <td>
                  <a href={leasesApi.fileUrl(d.document_id)} target="_blank" rel="noreferrer">
                    {d.doc_name}
                  </a>
                </td>
                <td>
                  <span className="status-line text-danger">
                    <CircleAlert size={14} aria-hidden /> {d.error_message ?? d.error_code}
                  </span>
                </td>
                <td className="nowrap">
                  {formatDate(d.uploaded_at)}
                  {d.uploaded_by_name && <div className="muted small">{d.uploaded_by_name}</div>}
                </td>
                <td className="right">
                  {can("records.write") && d.error_code !== "UNSUPPORTED_DOCUMENT" && (
                    <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void retry(d.document_id)}>
                      {busy === d.document_id ? <LoaderCircle size={14} className="spin" aria-hidden /> : <RotateCw size={14} aria-hidden />}
                      Retry
                    </button>
                  )}{" "}
                  {can("records.write") && (
                    <button className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => setDeleting(d)} aria-label={`Delete ${d.doc_name}`}>
                      <Trash2 size={14} aria-hidden /> Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleting && (
        <DeleteDocumentDialog
          documentId={deleting.document_id}
          docName={deleting.doc_name}
          hasLease={deleting.lease_id !== null}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            onRetried();
          }}
        />
      )}
    </Card>
  );
}

export function LeasesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [leases, setLeases] = useState<LeaseSummary[] | null>(null);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(params.get("upload") === "1");
  const filter = (params.get("filter") as FilterKey) ?? "all";
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const [l, d] = await Promise.all([leasesApi.list(), leasesApi.documents()]);
      setLeases(l);
      setDocs(d);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not load leases");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, leases?.filter((l) => matchesFilter(l, f.key)).length ?? 0])), [leases]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (leases ?? []).filter(
      (l) =>
        matchesFilter(l, filter) &&
        (!q ||
          [l.tenant?.name, l.unit?.property_name, l.unit?.unit_number, l.source_doc_name, l.tenant?.tenant_id, l.unit?.unit_id]
            .filter(Boolean)
            .some((s) => s!.toLowerCase().includes(q))),
    );
  }, [leases, filter, query]);

  const failed = docs.filter((d) => d.status === "failed");
  const processing = docs.filter((d) => d.status === "processing");
  // While anything is still processing, refresh so its stage and the finished lease appear.
  const stillProcessing = processing.length > 0;
  useEffect(() => {
    if (!stillProcessing) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  }, [stillProcessing, docs, load]);

  return (
    <>
      <PageHeader
        title="Lease Management"
        description="Upload lease documents, check every extracted term against its source, and correct what needs review."
        actions={
          can("records.write") &&
          !showUpload && (
            <button className="btn btn-primary" onClick={() => setShowUpload(true)}>
              <Upload size={16} aria-hidden /> Upload leases
            </button>
          )
        }
      />

      {showUpload && <UploadPanel onClose={() => setShowUpload(false)} onUploaded={() => void load()} />}
      {error && <Alert tone="error">{error}</Alert>}
      <ProcessingUploads docs={processing} />
      <FailedUploads docs={failed} onRetried={() => void load()} />

      <section className="card">
        <div className="toolbar">
          <div className="chips" role="tablist" aria-label="Filter leases">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                role="tab"
                aria-selected={filter === f.key}
                className={`chip${filter === f.key ? " active" : ""}`}
                onClick={() => setParams(f.key === "all" ? {} : { filter: f.key }, { replace: true })}
              >
                {f.label} <span className="chip-count">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={16} aria-hidden />
            <input type="search" placeholder="Search tenant, property, unit, file…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search leases" />
          </label>
        </div>

        {leases === null ? (
          <div className="card-body">
            <div className="spinner" aria-label="Loading" />
          </div>
        ) : leases.length === 0 ? (
          <EmptyState icon={FileText} title="No leases yet">
            Upload a signed lease (PDF, scanned PDF, Word, text or a photo). PropGuard saves the original, extracts the key terms with their source evidence, and flags anything missing or
            ambiguous for review.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon={Search} title="No leases match" />
        ) : (
          <div className="table-wrap">
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Property / unit</th>
                  <th>Term</th>
                  <th className="right">Rent</th>
                  <th>Status</th>
                  <th>Document</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => (
                  <tr key={l.lease_id} onClick={() => navigate(`/leases/${l.lease_id}`)}>
                    <td>
                      <Link to={`/leases/${l.lease_id}`} onClick={(e) => e.stopPropagation()}>
                        {l.tenant?.name ?? <span className="text-warning">Unlinked tenant</span>}
                      </Link>
                    </td>
                    <td>{l.unit ? `${l.unit.property_name} · ${l.unit.unit_number}` : <span className="text-warning">Unlinked unit</span>}</td>
                    <td className="nowrap">
                      {formatDate(l.start_date)} – {formatDate(l.end_date)}
                      {l.lease_state === "active" && l.days_until_end !== null && <div className="muted small">{l.days_until_end} days left</div>}
                    </td>
                    <td className="right nowrap">{formatCents(l.monthly_rent_cents)}</td>
                    <td>
                      <div className="badges">
                        <LeaseStateBadge state={l.lease_state} />
                        <LeaseFlagBadges flags={l.flags} />
                      </div>
                      {l.gaps.length > 0 && <div className="muted small">{l.gaps.length} to review</div>}
                    </td>
                    <td className="muted small">{l.source_doc_name}</td>
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
