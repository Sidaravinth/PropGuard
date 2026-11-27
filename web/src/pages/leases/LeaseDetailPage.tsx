import { ArrowLeft, ChevronDown, ChevronRight, Download, ExternalLink, FileText, Link2, PencilLine, TextSearch } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiRequestError } from "../../api/client";
import { leasesApi, type ClauseType, type Correction, type FieldSource, type LeaseDetail } from "../../api/leases";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Card, EmptyState, FieldStatusBadge, LeaseFlagBadges, LeaseStateBadge, PageHeader } from "../../components/ui";
import { CLAUSE_LABEL, FIELD_META, formatCents, formatDate, formatFieldValue, gapLabel } from "../../lib/format";
import { CorrectFieldDialog } from "./CorrectFieldDialog";
import { LinkDialog } from "./LinkDialog";
import { SourceViewer, type Highlight } from "./SourceViewer";

const TERM_FIELDS = ["start_date", "end_date", "monthly_rent", "security_deposit", "notice_period_days", "repair_deductible"] as const;
const PARTY_FIELDS = ["tenant_name", "property_name", "unit_number"] as const;

const sourceRef = (section: string | null, page: number | null) => [section, page ? `p. ${page}` : null].filter(Boolean).join(" · ") || "—";

function FieldRows({ fields, canEdit, onShow, onCorrect, active }: {
  fields: FieldSource[]; canEdit: boolean; onShow: (f: FieldSource) => void; onCorrect: (f: FieldSource) => void; active: string | null;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Value</th>
            <th>Status</th>
            <th>Source</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.field_name} className={active === f.field_name ? "row-active" : undefined}>
              <td className="nowrap">{FIELD_META[f.field_name].label}</td>
              <td>
                <strong>{formatFieldValue(f.field_name, f.value_text)}</strong>
                {f.note && f.status !== "extracted" && <div className="muted small">{f.note}</div>}
              </td>
              <td>
                <FieldStatusBadge status={f.status} />
              </td>
              <td className="nowrap small">
                {f.verbatim_snippet ? (
                  <button className="link-btn" onClick={() => onShow(f)} title="Show this excerpt in the document">
                    <TextSearch size={14} aria-hidden /> {sourceRef(f.section_ref, f.page)}
                  </button>
                ) : (
                  <span className="muted">No excerpt</span>
                )}
              </td>
              <td className="right">
                {canEdit && (
                  <button className="btn btn-secondary btn-sm" onClick={() => onCorrect(f)}>
                    <PencilLine size={14} aria-hidden /> {f.status === "needs_review" ? "Review" : "Correct"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Clauses({ lease, onShow }: { lease: LeaseDetail; onShow: (h: Highlight) => void }) {
  const [type, setType] = useState<ClauseType | "all">("all");
  const [open, setOpen] = useState<number | null>(null);
  const types = [...new Set(lease.clauses.map((c) => c.clause_type))];
  const shown = lease.clauses.filter((c) => type === "all" || c.clause_type === type);
  if (!lease.clauses.length) return <EmptyState icon={FileText} title="No clauses were extracted" />;
  return (
    <>
      <div className="chips mb-sm">
        {(["all", ...types] as const).map((t) => (
          <button key={t} className={`chip${type === t ? " active" : ""}`} onClick={() => setType(t)}>
            {t === "all" ? "All" : CLAUSE_LABEL[t]}
          </button>
        ))}
      </div>
      <ul className="clause-list">
        {shown.map((c) => (
          <li key={c.clause_id} className="clause">
            <button className="clause-head" onClick={() => setOpen(open === c.clause_id ? null : c.clause_id)} aria-expanded={open === c.clause_id}>
              {open === c.clause_id ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
              <span className="badge">{CLAUSE_LABEL[c.clause_type]}</span>
              <span className="clause-ref">{sourceRef(c.section_ref, c.page)}</span>
              {c.verified ? <span className="badge badge-success">Verbatim in source</span> : <span className="badge badge-warning">Not found in source</span>}
            </button>
            {open === c.clause_id && (
              <div className="clause-body">
                <blockquote className="quote">{c.extracted_text}</blockquote>
                <button className="link-btn small" onClick={() => onShow({ page: c.page, text: c.extracted_text })}>
                  <TextSearch size={14} aria-hidden /> Show in document
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function CorrectionHistory({ items }: { items: Correction[] }) {
  if (!items.length) return <p className="muted small" style={{ margin: 0 }}>No corrections yet.</p>;
  const show = (field: string, v: string | null) =>
    field === "unit_link" || field === "tenant_link" ? (v ?? "—") : FIELD_META[field as keyof typeof FIELD_META] ? formatFieldValue(field as keyof typeof FIELD_META, v) : (v ?? "—");
  return (
    <ul className="timeline">
      {items.map((c) => (
        <li key={c.correction_id}>
          <div>
            <strong>{gapLabel(c.field_name)}</strong>: {show(c.field_name, c.previous_value_text)} → <strong>{show(c.field_name, c.new_value_text)}</strong>{" "}
            <FieldStatusBadge status={c.new_status} />
          </div>
          <div className="muted small">
            “{c.reason}” · {c.corrected_by_name} · {formatDate(c.corrected_at)}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LeaseDetailPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const [lease, setLease] = useState<LeaseDetail | null>(null);
  const [pages, setPages] = useState<string[] | null>(null);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [editing, setEditing] = useState<FieldSource | null>(null);
  const [linking, setLinking] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, c] = await Promise.all([leasesApi.get(id), leasesApi.corrections(id)]);
      setLease(l);
      setCorrections(c);
      leasesApi.source(id).then((s) => setPages(s.pages)).catch(() => setPages([]));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not load the lease");
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const byName = useMemo(() => new Map(lease?.fields.map((f) => [f.field_name, f]) ?? []), [lease]);
  const pick = (names: readonly string[]) => names.map((n) => byName.get(n as FieldSource["field_name"])).filter((f): f is FieldSource => Boolean(f));

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!lease) return <div className="spinner" aria-label="Loading" />;

  const canEdit = can("records.write");
  const show = (f: FieldSource) => {
    setActiveField(f.field_name);
    setHighlight({ page: f.page, text: f.verbatim_snippet! });
  };
  const saved = (l: LeaseDetail) => {
    setLease(l);
    setEditing(null);
    setLinking(false);
    void leasesApi.corrections(id).then(setCorrections);
  };
  const title = lease.tenant?.name ?? pick(["tenant_name"])[0]?.value_text ?? lease.source_doc_name;

  return (
    <>
      <Link to="/leases" className="back-link">
        <ArrowLeft size={14} aria-hidden /> All leases
      </Link>
      <PageHeader
        title={title}
        description={lease.unit ? `${lease.unit.property_name} · Unit ${lease.unit.unit_number}` : "Not linked to a unit yet"}
        actions={
          lease.document && (
            <>
              <a className="btn btn-secondary" href={leasesApi.fileUrl(lease.document.document_id)} target="_blank" rel="noreferrer">
                <ExternalLink size={16} aria-hidden /> View original
              </a>
              <a className="btn btn-secondary" href={leasesApi.fileUrl(lease.document.document_id, true)}>
                <Download size={16} aria-hidden /> Download
              </a>
            </>
          )
        }
      />

      <div className="summary-strip mb">
        <div>
          <div className="summary-label">Status</div>
          <div className="badges">
            <LeaseStateBadge state={lease.lease_state} />
            <LeaseFlagBadges flags={lease.flags} />
          </div>
        </div>
        <div>
          <div className="summary-label">Term</div>
          <div>
            {formatDate(lease.start_date)} – {formatDate(lease.end_date)}
          </div>
          {lease.days_until_end !== null && (
            <div className="muted small">{lease.days_until_end >= 0 ? `${lease.days_until_end} days left` : `Ended ${-lease.days_until_end} days ago`}</div>
          )}
        </div>
        <div>
          <div className="summary-label">Monthly rent</div>
          <div>{formatCents(lease.monthly_rent_cents)}</div>
        </div>
        <div>
          <div className="summary-label">Deposit remaining</div>
          <div>{lease.remaining_deposit_cents === null ? <span className="text-warning">No deposit recorded</span> : formatCents(lease.remaining_deposit_cents)}</div>
        </div>
        <div>
          <div className="summary-label">Source</div>
          <div className="small">{lease.source_doc_name}</div>
          <div className="muted small">Extracted {formatDate(lease.created_at)}</div>
        </div>
      </div>

      {lease.gaps.length > 0 && (
        <Alert tone="info">
          <strong>{lease.gaps.length} item{lease.gaps.length === 1 ? "" : "s"} need attention.</strong> Values that are missing or need review are not used by
          the policy engine until a person confirms them.
          <ul className="gap-list">
            {lease.gaps.map((g, i) => (
              <li key={`${g.field}-${i}`}>
                <span className={`badge badge-${g.status === "missing" ? "danger" : "warning"}`}>{g.status === "missing" ? "Missing" : "Review"}</span>{" "}
                <strong>{gapLabel(g.field)}</strong>: {g.reason}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="review-layout">
        <div className="review-main">
          <Card title="Lease terms" subtitle="Click a source reference to see the exact excerpt in the document" className="mb">
            <FieldRows fields={pick(TERM_FIELDS)} canEdit={canEdit} onShow={show} onCorrect={setEditing} active={activeField} />
          </Card>

          <Card
            title="Parties and unit"
            className="mb"
            actions={
              canEdit && (
                <button className="btn btn-secondary btn-sm" onClick={() => setLinking(true)}>
                  <Link2 size={14} aria-hidden /> {lease.unit && lease.tenant ? "Change link" : "Link records"}
                </button>
              )
            }
          >
            <dl className="details compact mb-sm">
              <dt>Linked unit</dt>
              <dd>{lease.unit ? `${lease.unit.property_name} · ${lease.unit.unit_number} (${lease.unit.unit_id})` : <span className="text-warning">Not linked</span>}</dd>
              <dt>Linked tenant</dt>
              <dd>
                {lease.tenant ? (
                  <>
                    {lease.tenant.name} ({lease.tenant.tenant_id}){lease.tenant.status === "pending" && <span className="badge badge-warning">Created from lease</span>}
                  </>
                ) : (
                  <span className="text-warning">Not linked</span>
                )}
              </dd>
            </dl>
            <FieldRows fields={pick(PARTY_FIELDS)} canEdit={canEdit} onShow={show} onCorrect={setEditing} active={activeField} />
          </Card>

          <Card title="Clauses" subtitle="Verbatim excerpts with their section and page" className="mb">
            <Clauses
              lease={lease}
              onShow={(h) => {
                setActiveField(null);
                setHighlight(h);
              }}
            />
          </Card>

          <Card title="Correction history" subtitle="Every change to extracted data, with who made it and why">
            <CorrectionHistory items={corrections} />
          </Card>
        </div>

        <aside className="review-side">
          <Card title="Source document" subtitle={lease.source_doc_name}>
            {pages === null ? <div className="spinner" aria-label="Loading" /> : pages.length ? <SourceViewer pages={pages} highlight={highlight} /> : <p className="muted">Source text unavailable.</p>}
          </Card>
        </aside>
      </div>

      {editing && <CorrectFieldDialog leaseId={lease.lease_id} field={editing} onClose={() => setEditing(null)} onSaved={saved} />}
      {linking && <LinkDialog lease={lease} onClose={() => setLinking(false)} onSaved={saved} />}
    </>
  );
}
