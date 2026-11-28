import { Search, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not(.modal-close)")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-header">
          <h2 className="card-title">{title}</h2>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

/** Explicit (quoted and checked against the source) versus everything that is not trusted yet. */
const FIELD_STATUS: Record<string, { label: string; tone: string; title: string }> = {
  extracted: { label: "Verified", tone: "success", title: "Stated explicitly in the document: the quoted excerpt was checked word for word against the source text." },
  corrected: { label: "Corrected", tone: "info", title: "Entered or confirmed by a person." },
  needs_review: {
    label: "Needs review",
    tone: "warning",
    title: "Unclear, conflicting, or an AI reading the source text does not confirm. Not used until a person confirms it.",
  },
  missing: { label: "Missing", tone: "danger", title: "Not stated in the document. No value was guessed." },
};

export function FieldStatusBadge({ status }: { status: string }) {
  const s = FIELD_STATUS[status] ?? { label: status, tone: "", title: "" };
  return (
    <span className={`badge badge-${s.tone}`} title={s.title}>
      {s.label}
    </span>
  );
}

const LEASE_FLAG: Record<string, { label: string; tone: string }> = {
  EXPIRED: { label: "Expired", tone: "danger" },
  IN_NOTICE_WINDOW: { label: "Expiring", tone: "warning" },
  HAS_DATA_GAPS: { label: "Needs review", tone: "warning" },
};

export function LeaseStateBadge({ state }: { state: string }) {
  const tone = state === "active" ? "success" : state === "expired" ? "danger" : state === "upcoming" ? "info" : "";
  return <span className={`badge badge-${tone}`}>{state === "unknown" ? "Dates unknown" : state[0]!.toUpperCase() + state.slice(1)}</span>;
}

export function LeaseFlagBadges({ flags }: { flags: string[] }) {
  return (
    <>
      {flags
        .filter((f) => f !== "EXPIRED")
        .map((f) => {
          const m = LEASE_FLAG[f] ?? { label: f, tone: "" };
          return (
            <span key={f} className={`badge badge-${m.tone}`}>
              {m.label}
            </span>
          );
        })}
    </>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className = "" }: { title?: string; subtitle?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={22} strokeWidth={1.7} aria-hidden />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Alert({ tone, children }: { tone: "error" | "success" | "info"; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function StatCard({ label, value, hint, tone, to }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warning" | "danger" | "success"; to?: string }) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` text-${tone}` : ""}`}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </>
  );
  return to ? (
    <Link className="stat-card stat-link" to={to}>
      {body}
    </Link>
  ) : (
    <div className="stat-card">{body}</div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="search">
      <Search size={16} aria-hidden />
      <input type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
    </label>
  );
}

export function Chips<K extends string>({ options, value, onChange, counts }: { options: { key: K; label: string }[]; value: K; onChange: (k: K) => void; counts?: Partial<Record<K, number>> }) {
  return (
    <div className="chips" role="tablist">
      {options.map((o) => (
        <button key={o.key} role="tab" aria-selected={value === o.key} className={`chip${value === o.key ? " active" : ""}`} onClick={() => onChange(o.key)}>
          {o.label}
          {counts?.[o.key] !== undefined && <span className="chip-count">{counts[o.key]}</span>}
        </button>
      ))}
    </div>
  );
}

const APPROVER: Record<string, { label: string; tone: string }> = {
  AUTO_APPROVE: { label: "Auto-approve eligible", tone: "success" },
  PROPERTY_MANAGER: { label: "Property Manager", tone: "info" },
  REGIONAL_DIRECTOR: { label: "Regional Director", tone: "purple" },
};
export function ApproverBadge({ tier }: { tier: string | null | undefined }) {
  if (!tier) return <span className="badge">Not checked</span>;
  const a = APPROVER[tier] ?? { label: tier, tone: "" };
  return <span className={`badge badge-${a.tone}`}>{a.label}</span>;
}

export function VerdictBadge({ verdict }: { verdict: string | null | undefined }) {
  if (!verdict) return <span className="badge">Not checked</span>;
  return <span className={`badge badge-${verdict === "PASS" ? "success" : "danger"}`}>{verdict === "PASS" ? "Pass" : "Exception"}</span>;
}

const TICKET_STATUS: Record<string, string> = { open: "", flagged: "warning", pending_approval: "info", approved: "success", rejected: "danger", completed: "success" };
export function TicketStatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${TICKET_STATUS[status] ?? ""}`}>{status.replace(/_/g, " ")}</span>;
}

const TENANT_STATUS: Record<string, string> = { active: "success", notice_given: "warning", holdover: "warning", former: "", pending: "info" };
export function TenantStatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${TENANT_STATUS[status] ?? ""}`}>{status.replace(/_/g, " ")}</span>;
}

const LEDGER_STATUS: Record<string, string> = { paid: "success", late_paid: "warning", partial: "warning", unpaid: "danger" };
export function LedgerStatusBadge({ status, overdue }: { status: string; overdue?: boolean }) {
  return (
    <span className="badges">
      <span className={`badge badge-${LEDGER_STATUS[status] ?? ""}`}>{status.replace(/_/g, " ")}</span>
      {overdue && <span className="badge badge-danger">Overdue</span>}
    </span>
  );
}
