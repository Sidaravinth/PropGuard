import { LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { recordsApi, type Property, type UnitItem } from "../../api/records";
import { Alert, Modal } from "../../components/ui";
import { centsToDollarInput, parseDollarsToCents } from "../../lib/format";
import { errorMessage } from "../../lib/useLoad";

export function PropertyDialog({ property, onClose, onSaved }: { property?: Property; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(property?.name ?? "");
  const [address, setAddress] = useState(property?.address ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), address: address.trim() || null };
      if (property) await recordsApi.updateProperty(property.property_id, body);
      else await recordsApi.createProperty(body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={property ? "Edit property" : "Add property"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="property-form" disabled={busy || !name.trim()}>
            {busy && <LoaderCircle size={16} className="spin" aria-hidden />} Save
          </button>
        </>
      }
    >
      <form id="property-form" className="form" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        <label className="field">
          <span className="field-label">Property name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          <span className="field-hint">Use the name as written on leases, so uploaded leases link to it automatically.</span>
        </label>
        <label className="field">
          <span className="field-label">Address (optional)</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
        </label>
      </form>
    </Modal>
  );
}

export function UnitDialog({ unit, properties, defaultPropertyId, onClose, onSaved }: {
  unit?: UnitItem; properties: Property[]; defaultPropertyId?: number; onClose: () => void; onSaved: () => void;
}) {
  const [propertyId, setPropertyId] = useState<string>(String(unit?.property_id ?? defaultPropertyId ?? properties[0]?.property_id ?? ""));
  const [unitNumber, setUnitNumber] = useState(unit?.unit_number ?? "");
  const [rent, setRent] = useState(unit ? centsToDollarInput(unit.base_rent_cents) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = parseDollarsToCents(rent);
    if (cents === null) return setError("Enter the base rent, e.g. 1500 or 1,500.00");
    setBusy(true);
    setError(null);
    try {
      const body = { property_id: Number(propertyId), unit_number: unitNumber.trim(), base_rent_cents: cents };
      if (unit) await recordsApi.updateUnit(unit.unit_id, body);
      else await recordsApi.createUnit(body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={unit ? `Edit unit ${unit.unit_id}` : "Add unit"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="unit-form" disabled={busy || !propertyId || !unitNumber.trim()}>
            {busy && <LoaderCircle size={16} className="spin" aria-hidden />} Save
          </button>
        </>
      }
    >
      <form id="unit-form" className="form" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        {properties.length === 0 && <Alert tone="info">Add a property first.</Alert>}
        <label className="field">
          <span className="field-label">Property</span>
          <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)} required>
            {properties.map((p) => (
              <option key={p.property_id} value={p.property_id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-row">
          <label className="field">
            <span className="field-label">Unit number</span>
            <input value={unitNumber} onChange={(e) => setUnitNumber(e.target.value)} required maxLength={20} placeholder="e.g. 101" />
          </label>
          <label className="field">
            <span className="field-label">Base rent (monthly)</span>
            <span className="input-prefix" data-affix="$">
              <input inputMode="decimal" value={rent} onChange={(e) => setRent(e.target.value)} placeholder="1500.00" />
            </span>
          </label>
        </div>
      </form>
    </Modal>
  );
}
