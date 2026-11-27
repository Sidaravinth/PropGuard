import { LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { recordsApi, TENANT_STATUSES, type TenantItem, type TenantStatus, type UnitItem } from "../../api/records";
import { Alert, Modal } from "../../components/ui";
import { errorMessage, useLoad } from "../../lib/useLoad";

export function TenantDialog({ tenant, onClose, onSaved }: { tenant?: TenantItem; onClose: () => void; onSaved: (t: TenantItem) => void }) {
  const units = useLoad(() => recordsApi.units());
  const [form, setForm] = useState({
    name: tenant?.name ?? "",
    email: tenant?.email ?? "",
    phone: tenant?.phone ?? "",
    unit_id: tenant?.unit_id ?? "",
    status: (tenant?.status ?? "active") as TenantStatus,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { name: form.name.trim(), email: form.email.trim() || null, phone: form.phone.trim() || null, unit_id: form.unit_id || null, status: form.status };
    try {
      onSaved(tenant ? await recordsApi.updateTenant(tenant.tenant_id, body) : await recordsApi.createTenant(body));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const byProperty = (units.data ?? []).reduce<Record<string, UnitItem[]>>((acc, u) => ((acc[u.property_name] ??= []).push(u), acc), {});

  return (
    <Modal
      title={tenant ? `Edit ${tenant.name}` : "Add tenant"}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="tenant-form" disabled={busy || !form.name.trim()}>
            {busy && <LoaderCircle size={16} className="spin" aria-hidden />} Save
          </button>
        </>
      }
    >
      <form id="tenant-form" className="form" onSubmit={submit}>
        {error && <Alert tone="error">{error}</Alert>}
        <label className="field">
          <span className="field-label">Full name</span>
          <input value={form.name} onChange={set("name")} required maxLength={120} />
        </label>
        <div className="form-row">
          <label className="field">
            <span className="field-label">Email</span>
            <input type="email" value={form.email} onChange={set("email")} maxLength={254} />
          </label>
          <label className="field">
            <span className="field-label">Phone</span>
            <input type="tel" value={form.phone} onChange={set("phone")} maxLength={40} />
          </label>
        </div>
        <div className="form-row">
          <label className="field">
            <span className="field-label">Unit</span>
            <select value={form.unit_id} onChange={set("unit_id")}>
              <option value="">No unit</option>
              {Object.entries(byProperty).map(([prop, us]) => (
                <optgroup key={prop} label={prop}>
                  {us.map((u) => (
                    <option key={u.unit_id} value={u.unit_id}>
                      Unit {u.unit_number} ({u.unit_id}){u.occupied && u.unit_id !== tenant?.unit_id ? " · occupied" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Status</span>
            <select value={form.status} onChange={set("status")}>
              {TENANT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        </div>
      </form>
    </Modal>
  );
}
