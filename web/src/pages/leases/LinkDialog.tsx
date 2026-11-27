import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiRequestError } from "../../api/client";
import { leasesApi, type LeaseDetail, type Tenant, type Unit } from "../../api/leases";
import { Alert, Modal } from "../../components/ui";
import { parseDollarsToCents } from "../../lib/format";

const NEW = "__new__";
const NONE = "";

/** Link a lease to an existing unit and tenant, or create them first. */
export function LinkDialog({ lease, onClose, onSaved }: { lease: LeaseDetail; onClose: () => void; onSaved: (l: LeaseDetail) => void }) {
  const extracted = (name: string) => lease.fields.find((f) => f.field_name === name)?.value_text ?? "";
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [unitChoice, setUnitChoice] = useState<string>(lease.unit_id ?? NONE);
  const [tenantChoice, setTenantChoice] = useState<string>(lease.tenant_id ?? NONE);
  const [newUnit, setNewUnit] = useState({ property_name: extracted("property_name"), unit_number: extracted("unit_number"), rent: "" });
  const [newTenant, setNewTenant] = useState({ name: extracted("tenant_name"), email: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([leasesApi.units(), leasesApi.tenants()])
      .then(([u, t]) => {
        setUnits(u);
        setTenants(t);
        if (!lease.unit_id && u.length === 0) setUnitChoice(NEW);
      })
      .catch((e) => setError(e instanceof ApiRequestError ? e.message : "Could not load units"));
  }, [lease.unit_id]);

  const unitTenants = useMemo(() => tenants.filter((t) => t.unit_id === unitChoice), [tenants, unitChoice]);

  // Keep the tenant choice consistent with the chosen unit.
  useEffect(() => {
    if (tenantChoice !== NEW && tenantChoice !== NONE && !unitTenants.some((t) => t.tenant_id === tenantChoice)) {
      setTenantChoice(unitChoice === NEW ? NEW : NONE);
    }
  }, [unitChoice, unitTenants, tenantChoice]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!unitChoice) return setError("Choose a unit");
    setBusy(true);
    try {
      let unitId = unitChoice;
      if (unitChoice === NEW) {
        const cents = parseDollarsToCents(newUnit.rent);
        if (!newUnit.property_name.trim() || !newUnit.unit_number.trim()) throw new Error("Enter the property name and unit number");
        if (cents === null) throw new Error("Enter the unit's base rent, e.g. 1500");
        unitId = (await leasesApi.createUnit({ property_name: newUnit.property_name.trim(), unit_number: newUnit.unit_number.trim(), base_rent_cents: cents })).unit_id;
      }
      let tenantId: string | null = tenantChoice || null;
      if (tenantChoice === NEW) {
        if (!newTenant.name.trim()) throw new Error("Enter the tenant's name");
        tenantId = (await leasesApi.createTenant({ name: newTenant.name.trim(), email: newTenant.email.trim() || null, unit_id: unitId })).tenant_id;
      }
      onSaved(await leasesApi.link(lease.lease_id, unitId, tenantId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link the lease");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Link lease to unit and tenant"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="link-form" className="btn btn-primary" disabled={busy || units === null || !unitChoice}>
            {busy && <LoaderCircle size={16} className="spin" aria-hidden />}
            Save link
          </button>
        </>
      }
    >
      <form id="link-form" className="form" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        <p className="muted small" style={{ margin: 0 }}>
          The document names <strong>{extracted("tenant_name") || "an unknown tenant"}</strong> at{" "}
          <strong>{[extracted("property_name"), extracted("unit_number")].filter(Boolean).join(", unit ") || "an unknown unit"}</strong>.
        </p>

        <label className="field">
          <span className="field-label">Unit</span>
          <select value={unitChoice} onChange={(e) => setUnitChoice(e.target.value)} disabled={units === null}>
            <option value={NONE}>Choose a unit…</option>
            {(units ?? []).map((u) => (
              <option key={u.unit_id} value={u.unit_id}>
                {u.property_name} · {u.unit_number} ({u.unit_id})
              </option>
            ))}
            <option value={NEW}>+ Create a new unit</option>
          </select>
        </label>
        {unitChoice === NEW && (
          <div className="subform">
            <label className="field">
              <span className="field-label">Property name</span>
              <input value={newUnit.property_name} onChange={(e) => setNewUnit({ ...newUnit, property_name: e.target.value })} />
            </label>
            <div className="form-row">
              <label className="field">
                <span className="field-label">Unit number</span>
                <input value={newUnit.unit_number} onChange={(e) => setNewUnit({ ...newUnit, unit_number: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Base rent</span>
                <span className="input-prefix" data-affix="$">
                  <input inputMode="decimal" value={newUnit.rent} onChange={(e) => setNewUnit({ ...newUnit, rent: e.target.value })} placeholder="1500.00" />
                </span>
              </label>
            </div>
          </div>
        )}

        <label className="field">
          <span className="field-label">Tenant</span>
          <select value={tenantChoice} onChange={(e) => setTenantChoice(e.target.value)} disabled={!unitChoice}>
            <option value={NONE}>No tenant (leave unlinked)</option>
            {unitTenants.map((t) => (
              <option key={t.tenant_id} value={t.tenant_id}>
                {t.name} ({t.tenant_id}
                {t.status !== "active" ? `, ${t.status}` : ""})
              </option>
            ))}
            <option value={NEW}>+ Create a new tenant</option>
          </select>
          {unitChoice && unitChoice !== NEW && unitTenants.length === 0 && <span className="field-hint">This unit has no tenants yet.</span>}
        </label>
        {tenantChoice === NEW && (
          <div className="subform form-row">
            <label className="field">
              <span className="field-label">Tenant name</span>
              <input value={newTenant.name} onChange={(e) => setNewTenant({ ...newTenant, name: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Email (optional)</span>
              <input type="email" value={newTenant.email} onChange={(e) => setNewTenant({ ...newTenant, email: e.target.value })} />
            </label>
          </div>
        )}
      </form>
    </Modal>
  );
}
