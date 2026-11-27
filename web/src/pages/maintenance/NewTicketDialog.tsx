import { LoaderCircle } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { recordsApi } from "../../api/records";
import { Alert, Modal } from "../../components/ui";
import { parseDollarsToCents } from "../../lib/format";
import { errorMessage, useLoad } from "../../lib/useLoad";

/** Create a ticket. The deterministic policy check runs on the server as soon as it is saved. */
export function NewTicketDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (ticketId: number) => void }) {
  const lists = useLoad(() => Promise.all([recordsApi.properties(), recordsApi.units(), recordsApi.tenants()]));
  const [properties, units, tenants] = lists.data ?? [[], [], []];
  const [propertyId, setPropertyId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [summary, setSummary] = useState("");
  const [wo, setWo] = useState("");
  const [quote, setQuote] = useState("");
  const [charge, setCharge] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unitOptions = useMemo(() => units.filter((u) => String(u.property_id) === propertyId), [units, propertyId]);
  const tenantOptions = useMemo(() => tenants.filter((t) => t.unit_id === unitId && t.status !== "former"), [tenants, unitId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const woC = parseDollarsToCents(wo);
    const quoteC = parseDollarsToCents(quote);
    const chargeC = charge.trim() ? parseDollarsToCents(charge) : null;
    if (woC === null || quoteC === null) return setError("Enter the work order estimate and the technician quote, e.g. 450 or 450.00");
    if (charge.trim() && chargeC === null) return setError("Enter the proposed tenant charge as an amount, or leave it empty");
    setBusy(true);
    setError(null);
    try {
      const r = await recordsApi.createTicket({
        unit_id: unitId, tenant_id: tenantId || null, issue_summary: summary.trim(),
        work_order_amount_cents: woC, technician_quote_amount_cents: quoteC, proposed_tenant_charge_cents: chargeC,
      });
      onCreated(r.ticket.ticket_id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New maintenance ticket"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="ticket-form" disabled={busy || !unitId || summary.trim().length < 3}>
            {busy && <LoaderCircle size={16} className="spin" aria-hidden />} Create and check policy
          </button>
        </>
      }
    >
      <form id="ticket-form" className="form" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        {lists.data && units.length === 0 && <Alert tone="info">Add a property and unit first (Properties & Units).</Alert>}
        <div className="form-row">
          <label className="field">
            <span className="field-label">Property</span>
            <select
              value={propertyId}
              onChange={(e) => {
                setPropertyId(e.target.value);
                setUnitId("");
                setTenantId("");
              }}
              required
            >
              <option value="">Choose…</option>
              {properties.map((p) => (
                <option key={p.property_id} value={p.property_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Unit</span>
            <select
              value={unitId}
              onChange={(e) => {
                setUnitId(e.target.value);
                setTenantId("");
              }}
              disabled={!propertyId}
              required
            >
              <option value="">Choose…</option>
              {unitOptions.map((u) => (
                <option key={u.unit_id} value={u.unit_id}>
                  Unit {u.unit_number} ({u.unit_id})
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="field-label">Tenant (optional)</span>
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} disabled={!unitId}>
            <option value="">No tenant</option>
            {tenantOptions.map((t) => (
              <option key={t.tenant_id} value={t.tenant_id}>
                {t.name} ({t.tenant_id})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Issue summary</span>
          <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} placeholder="e.g. Water heater leaking from the base" required />
          <span className="field-hint">Free text is stored for people to read. The policy engine never reads it.</span>
        </label>
        <div className="form-row">
          <label className="field">
            <span className="field-label">Work order estimate</span>
            <span className="input-prefix" data-affix="$">
              <input inputMode="decimal" value={wo} onChange={(e) => setWo(e.target.value)} placeholder="450.00" required />
            </span>
          </label>
          <label className="field">
            <span className="field-label">Technician quote</span>
            <span className="input-prefix" data-affix="$">
              <input inputMode="decimal" value={quote} onChange={(e) => setQuote(e.target.value)} placeholder="480.00" required />
            </span>
          </label>
        </div>
        <label className="field">
          <span className="field-label">Proposed charge to tenant (optional)</span>
          <span className="input-prefix" data-affix="$">
            <input inputMode="decimal" value={charge} onChange={(e) => setCharge(e.target.value)} placeholder="Leave empty if none" />
          </span>
          <span className="field-hint">Checked against the remaining security deposit.</span>
        </label>
      </form>
    </Modal>
  );
}
