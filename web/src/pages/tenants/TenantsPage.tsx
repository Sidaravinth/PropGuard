import { FileSpreadsheet, Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { recordsApi, type TenantStatus } from "../../api/records";
import { useAuth } from "../../auth/AuthContext";
import { ImportWizard } from "../../components/ImportWizard";
import { Alert, Chips, EmptyState, PageHeader, SearchBox, TenantStatusBadge } from "../../components/ui";
import { formatCents } from "../../lib/format";
import { useLoad } from "../../lib/useLoad";
import { TenantDialog } from "./TenantDialog";

type Filter = "all" | TenantStatus | "owing";

export function TenantsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(() => recordsApi.tenants());
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<"add" | "import" | null>(null);

  const tenants = data ?? [];
  const match = (f: Filter) => (t: (typeof tenants)[number]) => f === "all" || (f === "owing" ? t.unpaid_balance_cents > 0 : t.status === f);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tenants.filter(
      (t) => match(filter)(t) && (!q || [t.name, t.email, t.phone, t.tenant_id, t.property_name, t.unit_number].some((s) => s?.toLowerCase().includes(q))),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants, filter, query]);

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "notice_given", label: "Notice given" },
    { key: "holdover", label: "Holdover" },
    { key: "pending", label: "Pending" },
    { key: "former", label: "Former" },
    { key: "owing", label: "Owing rent" },
  ];

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Tenant profiles with their unit, lease history, payments and maintenance."
        actions={
          can("records.write") && (
            <>
              <button className="btn btn-secondary" onClick={() => setDialog("import")}>
                <FileSpreadsheet size={16} aria-hidden /> Import CSV/XLSX
              </button>
              <button className="btn btn-primary" onClick={() => setDialog("add")}>
                <Plus size={16} aria-hidden /> Add tenant
              </button>
            </>
          )
        }
      />
      {error && <Alert tone="error">{error}</Alert>}
      <section className="card">
        <div className="toolbar">
          <Chips<Filter> options={filters} value={filter} onChange={setFilter} counts={Object.fromEntries(filters.map((f) => [f.key, tenants.filter(match(f.key)).length]))} />
          <SearchBox value={query} onChange={setQuery} placeholder="Search name, email, phone, unit…" />
        </div>
        {!data ? (
          <div className="card-body">
            <div className="spinner" aria-label="Loading" />
          </div>
        ) : tenants.length === 0 ? (
          <EmptyState icon={Users} title="No tenants yet">
            Add tenants one by one, import a spreadsheet, or upload a lease: a lease for a known unit creates its tenant automatically.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon={Users} title="No tenants match" />
        ) : (
          <div className="table-wrap">
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Contact</th>
                  <th>Property / unit</th>
                  <th>Status</th>
                  <th className="right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => (
                  <tr key={t.tenant_id} onClick={() => navigate(`/tenants/${t.tenant_id}`)}>
                    <td>
                      <Link to={`/tenants/${t.tenant_id}`} onClick={(e) => e.stopPropagation()}>
                        {t.name}
                      </Link>
                      <div className="muted small">{t.tenant_id}</div>
                    </td>
                    <td className="small">
                      {t.email ?? <span className="muted">no email</span>}
                      {t.phone && <div className="muted">{t.phone}</div>}
                    </td>
                    <td>{t.unit_id ? `${t.property_name} · ${t.unit_number}` : <span className="muted">No unit</span>}</td>
                    <td>
                      <TenantStatusBadge status={t.status} />
                    </td>
                    <td className={`right${t.unpaid_balance_cents ? " text-danger" : ""}`}>{formatCents(t.unpaid_balance_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {dialog === "add" && (
        <TenantDialog
          onClose={() => setDialog(null)}
          onSaved={(t) => {
            setDialog(null);
            navigate(`/tenants/${t.tenant_id}`);
          }}
        />
      )}
      {dialog === "import" && <ImportWizard kind="tenants" onClose={() => setDialog(null)} onImported={() => void reload()} />}
    </>
  );
}
