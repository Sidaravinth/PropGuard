import { Building2, DoorOpen, MapPin, PencilLine, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { recordsApi, type Property, type UnitItem } from "../../api/records";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Chips, EmptyState, PageHeader, SearchBox } from "../../components/ui";
import { formatCents } from "../../lib/format";
import { useLoad } from "../../lib/useLoad";
import { PropertyDialog, UnitDialog } from "./PropertyDialogs";

type Occ = "all" | "available" | "occupied";

export function PropertiesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, error, reload } = useLoad(() => Promise.all([recordsApi.properties(), recordsApi.units()]));
  const [occ, setOcc] = useState<Occ>("all");
  const [propertyFilter, setPropertyFilter] = useState<number | "all">("all");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{ kind: "property"; property?: Property } | { kind: "unit"; unit?: UnitItem } | null>(null);

  const [properties, units] = data ?? [[], []];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return units.filter(
      (u) =>
        (occ === "all" || (occ === "occupied") === u.occupied) &&
        (propertyFilter === "all" || u.property_id === propertyFilter) &&
        (!q || [u.unit_id, u.unit_number, u.property_name, ...u.tenants.map((t) => t.name)].some((s) => s.toLowerCase().includes(q))),
    );
  }, [units, occ, propertyFilter, query]);

  const saved = () => {
    setDialog(null);
    void reload();
  };
  const canEdit = can("records.write");

  return (
    <>
      <PageHeader
        title="Properties & Units"
        description="Your buildings and units, which are occupied, and the tenants and leases attached to each."
        actions={
          canEdit && (
            <>
              <button className="btn btn-secondary" onClick={() => setDialog({ kind: "property" })}>
                <Plus size={16} aria-hidden /> Add property
              </button>
              <button className="btn btn-primary" onClick={() => setDialog({ kind: "unit" })} disabled={!properties.length} title={properties.length ? undefined : "Add a property first"}>
                <Plus size={16} aria-hidden /> Add unit
              </button>
            </>
          )
        }
      />
      {error && <Alert tone="error">{error}</Alert>}

      {data && properties.length === 0 ? (
        <section className="card">
          <EmptyState icon={Building2} title="No properties yet">
            Add your first property, then its units. Tenants, leases, payments and maintenance tickets all attach to units.
          </EmptyState>
        </section>
      ) : (
        <>
          <div className="property-grid mb">
            {properties.map((p) => (
              <div
                key={p.property_id}
                className={`property-card${propertyFilter === p.property_id ? " selected" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setPropertyFilter(propertyFilter === p.property_id ? "all" : p.property_id)}
                onKeyDown={(e) => e.key === "Enter" && setPropertyFilter(propertyFilter === p.property_id ? "all" : p.property_id)}
              >
                <div className="property-card-head">
                  <Building2 size={18} aria-hidden />
                  <strong>{p.name}</strong>
                  {canEdit && (
                    <button
                      className="icon-btn"
                      aria-label={`Edit ${p.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDialog({ kind: "property", property: p });
                      }}
                    >
                      <PencilLine size={15} />
                    </button>
                  )}
                </div>
                {p.address && (
                  <div className="muted small property-address">
                    <MapPin size={13} aria-hidden /> {p.address}
                  </div>
                )}
                <div className="occupancy">
                  <div className="occupancy-bar">
                    <div style={{ width: `${p.unit_count ? (p.occupied_count / p.unit_count) * 100 : 0}%` }} />
                  </div>
                  <span className="small">
                    {p.occupied_count}/{p.unit_count} occupied
                  </span>
                </div>
              </div>
            ))}
          </div>

          <section className="card">
            <div className="toolbar">
              <div className="toolbar-left">
                <Chips<Occ>
                  options={[
                    { key: "all", label: "All units" },
                    { key: "available", label: "Available" },
                    { key: "occupied", label: "Occupied" },
                  ]}
                  value={occ}
                  onChange={setOcc}
                  counts={{
                    all: units.length,
                    available: units.filter((u) => !u.occupied).length,
                    occupied: units.filter((u) => u.occupied).length,
                  }}
                />
                <select className="select-sm" value={propertyFilter} onChange={(e) => setPropertyFilter(e.target.value === "all" ? "all" : Number(e.target.value))} aria-label="Filter by property">
                  <option value="all">All properties</option>
                  {properties.map((p) => (
                    <option key={p.property_id} value={p.property_id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <SearchBox value={query} onChange={setQuery} placeholder="Search unit, property, tenant…" />
            </div>
            {!data ? (
              <div className="card-body">
                <div className="spinner" aria-label="Loading" />
              </div>
            ) : visible.length === 0 ? (
              <EmptyState icon={DoorOpen} title={units.length ? "No units match" : "No units yet"} />
            ) : (
              <div className="table-wrap">
                <table className="table table-clickable">
                  <thead>
                    <tr>
                      <th>Unit</th>
                      <th>Property</th>
                      <th className="right">Base rent</th>
                      <th>Status</th>
                      <th>Tenants</th>
                      <th className="right">Leases</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((u) => (
                      <tr key={u.unit_id} onClick={() => navigate(`/properties/units/${u.unit_id}`)}>
                        <td>
                          <Link to={`/properties/units/${u.unit_id}`} onClick={(e) => e.stopPropagation()}>
                            Unit {u.unit_number}
                          </Link>
                          <div className="muted small">{u.unit_id}</div>
                        </td>
                        <td>{u.property_name}</td>
                        <td className="right">{formatCents(u.base_rent_cents)}</td>
                        <td>{u.occupied ? <span className="badge badge-info">Occupied</span> : <span className="badge badge-success">Available</span>}</td>
                        <td>{u.tenants.length ? u.tenants.map((t) => t.name).join(", ") : <span className="muted">—</span>}</td>
                        <td className="right">{u.lease_count}</td>
                        <td className="right">
                          {canEdit && (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDialog({ kind: "unit", unit: u });
                              }}
                            >
                              Edit
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
        </>
      )}

      {dialog?.kind === "property" && <PropertyDialog property={dialog.property} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === "unit" && (
        <UnitDialog
          unit={dialog.unit}
          properties={properties}
          defaultPropertyId={propertyFilter === "all" ? undefined : propertyFilter}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
    </>
  );
}
