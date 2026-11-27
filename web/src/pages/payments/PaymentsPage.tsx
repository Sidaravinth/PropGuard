import { FileSpreadsheet, LoaderCircle, Plus, Wallet } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { recordsApi, type LedgerEntry, type TenantItem } from "../../api/records";
import { useAuth } from "../../auth/AuthContext";
import { ImportWizard } from "../../components/ImportWizard";
import { Alert, Chips, EmptyState, LedgerStatusBadge, Modal, PageHeader, SearchBox, StatCard } from "../../components/ui";
import { centsToDollarInput, formatCents, parseDollarsToCents } from "../../lib/format";
import { errorMessage, useLoad } from "../../lib/useLoad";

type Filter = "all" | "overdue" | "outstanding" | "settled";
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });

function EntryDialog({ entry, tenants, onClose, onSaved }: { entry?: LedgerEntry; tenants: TenantItem[]; onClose: () => void; onSaved: () => void }) {
  const [tenantId, setTenantId] = useState(entry?.tenant_id ?? "");
  const [month, setMonth] = useState(entry?.month ?? new Date().toISOString().slice(0, 7));
  const [due, setDue] = useState(entry ? centsToDollarInput(entry.amount_due_cents) : "");
  const [paid, setPaid] = useState(entry ? centsToDollarInput(entry.amount_paid_cents) : "0.00");
  const [late, setLate] = useState(entry?.status === "late_paid");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const dueC = parseDollarsToCents(due);
    const paidC = parseDollarsToCents(paid);
    if (dueC === null || paidC === null) return setError("Enter amounts like 1500 or 1,500.00");
    if (late && paidC < dueC) return setError("“Paid late” needs the full amount paid");
    setBusy(true);
    setError(null);
    try {
      if (entry) await recordsApi.updateLedger(entry.entry_id, { amount_due_cents: dueC, amount_paid_cents: paidC, status: late ? "late_paid" : null });
      else await recordsApi.addLedger({ tenant_id: tenantId, month, amount_due_cents: dueC, amount_paid_cents: paidC, status: late ? "late_paid" : null });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={entry ? `Update ${entry.tenant_name} · ${monthLabel(entry.month)}` : "Add payment record"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="entry-form" disabled={busy || (!entry && !tenantId)}>
            {busy && <LoaderCircle size={16} className="spin" aria-hidden />} Save
          </button>
        </>
      }
    >
      <form id="entry-form" className="form" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        {!entry && (
          <div className="form-row">
            <label className="field">
              <span className="field-label">Tenant</span>
              <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required>
                <option value="">Choose…</option>
                {tenants.map((t) => (
                  <option key={t.tenant_id} value={t.tenant_id}>
                    {t.name} ({t.tenant_id}){t.unit_number ? ` · ${t.property_name} ${t.unit_number}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Month</span>
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
            </label>
          </div>
        )}
        <div className="form-row">
          <label className="field">
            <span className="field-label">Amount due</span>
            <span className="input-prefix" data-affix="$">
              <input inputMode="decimal" value={due} onChange={(e) => setDue(e.target.value)} placeholder="1500.00" required />
            </span>
          </label>
          <label className="field">
            <span className="field-label">Amount paid</span>
            <span className="input-prefix" data-affix="$">
              <input inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} required />
            </span>
          </label>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={late} onChange={(e) => setLate(e.target.checked)} /> Paid in full but late
        </label>
        <span className="field-hint">Status (paid / partial / unpaid) is worked out from the amounts.</span>
      </form>
    </Modal>
  );
}

export function PaymentsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("filter") as Filter) ?? "all";
  const tenantFilter = params.get("tenant") ?? "";
  const { data, error, reload } = useLoad(() => Promise.all([recordsApi.ledger(), recordsApi.ledgerSummary(), recordsApi.tenants()]));
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ kind: "add" } | { kind: "edit"; entry: LedgerEntry } | { kind: "import" } | null>(null);

  const [entries, summary, tenants] = data ?? [[], null, []];
  const match = (f: Filter) => (e: LedgerEntry) =>
    f === "all" || (f === "overdue" ? !!e.overdue : f === "outstanding" ? (e.outstanding_cents ?? 0) > 0 : (e.outstanding_cents ?? 0) === 0);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        match(filter)(e) &&
        (!tenantFilter || e.tenant_id === tenantFilter) &&
        (!q || [e.tenant_name, e.tenant_id, e.month, e.property_name, e.unit_number].some((s) => s?.toLowerCase().includes(q))),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, filter, tenantFilter, query]);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v && v !== "all") p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const saved = () => {
    setDialog(null);
    void reload();
  };
  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "overdue", label: "Overdue" },
    { key: "outstanding", label: "Outstanding" },
    { key: "settled", label: "Settled" },
  ];

  return (
    <>
      <PageHeader
        title="Payment Ledger"
        description="Rent due and paid per tenant and month. The policy engine reads these records for unpaid-balance checks."
        actions={
          can("records.write") && (
            <>
              <button className="btn btn-secondary" onClick={() => setDialog({ kind: "import" })}>
                <FileSpreadsheet size={16} aria-hidden /> Import CSV/XLSX
              </button>
              <button className="btn btn-primary" onClick={() => setDialog({ kind: "add" })} disabled={!tenants.length} title={tenants.length ? undefined : "Add tenants first"}>
                <Plus size={16} aria-hidden /> Add payment
              </button>
            </>
          )
        }
      />
      {error && <Alert tone="error">{error}</Alert>}

      {summary && (
        <div className="stat-grid mb">
          <StatCard label="Outstanding balance" value={formatCents(summary.total_outstanding_cents)} tone={summary.total_outstanding_cents ? "danger" : undefined} hint={`as of ${monthLabel(summary.as_of_month)}`} />
          <StatCard label="Tenants overdue" value={summary.overdue_tenants.length} tone={summary.overdue_tenants.length ? "warning" : undefined} />
          <StatCard label={`Due in ${monthLabel(summary.as_of_month)}`} value={formatCents(summary.current_month_due_cents)} />
          <StatCard label={`Collected in ${monthLabel(summary.as_of_month)}`} value={formatCents(summary.current_month_paid_cents)} />
        </div>
      )}

      {summary && summary.overdue_tenants.length > 0 && (
        <section className="card mb">
          <header className="card-header">
            <h2 className="card-title">Overdue tenants</h2>
          </header>
          <div className="card-body">
            <ul className="plain-list">
              {summary.overdue_tenants.map((o) => (
                <li key={o.tenant_id}>
                  <Link to={`/tenants/${o.tenant_id}`}>{o.name}</Link> <span className="muted small">{o.property_name ? `${o.property_name} · ${o.unit_number}` : ""}</span>{" "}
                  <strong className="text-danger">{formatCents(o.balance_cents)}</strong>{" "}
                  {o.oldest_unpaid_month && <span className="muted small">since {monthLabel(o.oldest_unpaid_month)}</span>}{" "}
                  <button className="link-btn small" onClick={() => setParam("tenant", o.tenant_id)}>
                    Show entries
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="card">
        <div className="toolbar">
          <div className="toolbar-left">
            <Chips<Filter> options={filters} value={filter} onChange={(f) => setParam("filter", f)} counts={Object.fromEntries(filters.map((f) => [f.key, entries.filter(match(f.key)).length]))} />
            <select className="select-sm" value={tenantFilter} onChange={(e) => setParam("tenant", e.target.value)} aria-label="Filter by tenant">
              <option value="">All tenants</option>
              {tenants.map((t) => (
                <option key={t.tenant_id} value={t.tenant_id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <SearchBox value={query} onChange={setQuery} placeholder="Search tenant, month, unit…" />
        </div>
        {!data ? (
          <div className="card-body">
            <div className="spinner" aria-label="Loading" />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState icon={Wallet} title="No payment records yet">
            Add payments one at a time or import a ledger spreadsheet. Map its columns, check the preview, then import.
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState icon={Wallet} title="No entries match" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Tenant</th>
                  <th>Unit</th>
                  <th className="right">Due</th>
                  <th className="right">Paid</th>
                  <th className="right">Outstanding</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => (
                  <tr key={e.entry_id}>
                    <td className="nowrap">{monthLabel(e.month)}</td>
                    <td>
                      <Link to={`/tenants/${e.tenant_id}`}>{e.tenant_name}</Link>
                    </td>
                    <td className="small">{e.unit_number ? `${e.property_name} · ${e.unit_number}` : "—"}</td>
                    <td className="right">{formatCents(e.amount_due_cents)}</td>
                    <td className="right">{formatCents(e.amount_paid_cents)}</td>
                    <td className={`right${e.outstanding_cents ? " text-danger" : ""}`}>{formatCents(e.outstanding_cents ?? 0)}</td>
                    <td>
                      <LedgerStatusBadge status={e.status} overdue={e.overdue} />
                      {e.source_document_id && <div className="muted small">imported</div>}
                    </td>
                    <td className="right">
                      {can("records.write") && (
                        <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: "edit", entry: e })}>
                          Update
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog?.kind === "add" && <EntryDialog tenants={tenants} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === "edit" && <EntryDialog entry={dialog.entry} tenants={tenants} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === "import" && <ImportWizard kind="ledger" onClose={() => setDialog(null)} onImported={() => void reload()} />}
    </>
  );
}
