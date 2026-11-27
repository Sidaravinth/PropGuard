/**
 * Operational records managed by users: properties, units, tenants.
 * Validation and duplicate checks live here so the API, imports and the lease-link dialog agree.
 */
import { ApiError } from "../api/errors.js";
import { leaseListItem } from "../api/leaseViews.js";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";

export const TENANT_STATUSES = ["active", "notice_given", "holdover", "former", "pending"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];
/** Tenants in these statuses occupy their unit. */
const OCCUPYING = "('active', 'notice_given', 'holdover')";

export interface PropertyRow { property_id: number; name: string; address: string | null; created_at: string }

const conflict = (code: string, msg: string) => new ApiError(409, code, msg);

/** Next id like U303 / T006: prefix + (largest numeric suffix + 1), at least 3 digits. */
function nextId(db: DB, table: "units" | "tenants", column: "unit_id" | "tenant_id", prefix: string): string {
  const r = db
    .prepare(`SELECT COALESCE(MAX(CAST(substr(${column}, ${prefix.length + 1}) AS INTEGER)), 0) + 1 AS n FROM ${table} WHERE ${column} GLOB ?`)
    .get(`${prefix}[0-9]*`) as { n: number };
  return `${prefix}${String(r.n).padStart(3, "0")}`;
}

// --- properties ---------------------------------------------------------------------

export function listProperties(db: DB) {
  return db
    .prepare(
      `SELECT p.*, COUNT(u.unit_id) AS unit_count,
              COALESCE(SUM(EXISTS (SELECT 1 FROM tenants t WHERE t.unit_id = u.unit_id AND t.status IN ${OCCUPYING})), 0) AS occupied_count
         FROM properties p LEFT JOIN units u ON u.property_id = p.property_id
        GROUP BY p.property_id ORDER BY p.name`,
    )
    .all() as unknown as (PropertyRow & { unit_count: number; occupied_count: number })[];
}

export const getProperty = (db: DB, id: number) => db.prepare("SELECT * FROM properties WHERE property_id = ?").get(id) as unknown as PropertyRow | undefined;

export function createProperty(db: DB, input: { name: string; address?: string | null }): PropertyRow {
  const name = input.name.trim();
  if (db.prepare("SELECT 1 FROM properties WHERE name = ? COLLATE NOCASE").get(name)) throw conflict("DUPLICATE_PROPERTY", `A property named "${name}" already exists`);
  const r = db.prepare("INSERT INTO properties (name, address) VALUES (?, ?)").run(name, input.address?.trim() || null);
  return getProperty(db, Number(r.lastInsertRowid))!;
}

export function updateProperty(db: DB, id: number, input: { name?: string; address?: string | null }): PropertyRow {
  const p = getProperty(db, id);
  if (!p) throw new ApiError(404, "NOT_FOUND", `Property ${id} not found`);
  const name = input.name?.trim() ?? p.name;
  if (db.prepare("SELECT 1 FROM properties WHERE name = ? COLLATE NOCASE AND property_id != ?").get(name, id)) {
    throw conflict("DUPLICATE_PROPERTY", `A property named "${name}" already exists`);
  }
  const address = input.address === undefined ? p.address : input.address?.trim() || null;
  db.prepare("UPDATE properties SET name = ?, address = ? WHERE property_id = ?").run(name, address, id);
  return getProperty(db, id)!;
}

function findOrCreateProperty(db: DB, name: string): number {
  const found = db.prepare("SELECT property_id FROM properties WHERE name = ? COLLATE NOCASE").get(name.trim()) as { property_id: number } | undefined;
  return found?.property_id ?? createProperty(db, { name }).property_id;
}

// --- units ----------------------------------------------------------------------------

export interface UnitListItem extends repo.UnitRow {
  property_id: number;
  occupied: boolean;
  tenants: { tenant_id: string; name: string; status: string }[];
  lease_count: number;
}

export function listUnitsDetailed(db: DB, filter: { property_id?: number } = {}): UnitListItem[] {
  const units = db
    .prepare("SELECT * FROM units WHERE (? IS NULL OR property_id = ?) ORDER BY property_name COLLATE NOCASE, unit_number")
    .all(filter.property_id ?? null, filter.property_id ?? null) as unknown as (repo.UnitRow & { property_id: number })[];
  const tenantsBy = db.prepare("SELECT tenant_id, name, status FROM tenants WHERE unit_id = ? ORDER BY tenant_id");
  const leaseCount = db.prepare("SELECT COUNT(*) AS n FROM leases WHERE unit_id = ?");
  return units.map((u) => {
    const tenants = tenantsBy.all(u.unit_id) as unknown as UnitListItem["tenants"];
    return {
      ...u,
      tenants,
      occupied: tenants.some((t) => ["active", "notice_given", "holdover"].includes(t.status)),
      lease_count: (leaseCount.get(u.unit_id) as { n: number }).n,
    };
  });
}

export function unitDetail(db: DB, unitId: string) {
  const unit = listUnitsDetailed(db).find((u) => u.unit_id === unitId);
  if (!unit) return null;
  return {
    ...unit,
    property: getProperty(db, unit.property_id) ?? null,
    leases: (db.prepare("SELECT * FROM leases WHERE unit_id = ? ORDER BY COALESCE(end_date, '') DESC").all(unitId) as unknown as repo.LeaseRow[]).map((l) => leaseListItem(db, l)),
    tickets: repo.listTickets(db, { unit_id: unitId }),
  };
}

export function createUnit(db: DB, input: { property_id?: number; property_name?: string; unit_number: string; base_rent_cents: number }): repo.UnitRow {
  let propertyId = input.property_id;
  if (propertyId !== undefined) {
    if (!getProperty(db, propertyId)) throw new ApiError(422, "UNKNOWN_PROPERTY", `Property ${propertyId} does not exist`);
  } else if (input.property_name?.trim()) {
    propertyId = findOrCreateProperty(db, input.property_name);
  } else {
    throw new ApiError(400, "VALIDATION_ERROR", "Give property_id or property_name");
  }
  const property = getProperty(db, propertyId)!;
  const unitNo = input.unit_number.trim();
  if (repo.findUnitByLabel(db, property.name, unitNo)) throw conflict("DUPLICATE_UNIT", `Unit ${unitNo} at ${property.name} already exists`);
  const id = nextId(db, "units", "unit_id", "U");
  db.prepare("INSERT INTO units (unit_id, property_name, unit_number, base_rent_cents, property_id) VALUES (?, ?, ?, ?, ?)").run(
    id, property.name, unitNo, input.base_rent_cents, propertyId,
  );
  return repo.getUnit(db, id)!;
}

export function updateUnit(db: DB, unitId: string, input: { property_id?: number; unit_number?: string; base_rent_cents?: number }): repo.UnitRow {
  const unit = repo.getUnit(db, unitId) as (repo.UnitRow & { property_id: number }) | undefined;
  if (!unit) throw new ApiError(404, "NOT_FOUND", `Unit ${unitId} not found`);
  const propertyId = input.property_id ?? unit.property_id;
  const property = getProperty(db, propertyId);
  if (!property) throw new ApiError(422, "UNKNOWN_PROPERTY", `Property ${propertyId} does not exist`);
  const unitNo = input.unit_number?.trim() ?? unit.unit_number;
  const clash = repo.findUnitByLabel(db, property.name, unitNo);
  if (clash && clash.unit_id !== unitId) throw conflict("DUPLICATE_UNIT", `Unit ${unitNo} at ${property.name} already exists`);
  db.prepare("UPDATE units SET property_id = ?, property_name = ?, unit_number = ?, base_rent_cents = ? WHERE unit_id = ?").run(
    propertyId, property.name, unitNo, input.base_rent_cents ?? unit.base_rent_cents, unitId,
  );
  return repo.getUnit(db, unitId)!;
}

// --- tenants ----------------------------------------------------------------------------

export interface TenantInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  unit_id?: string | null;
  status?: TenantStatus;
}

/** Duplicate rules: email is unique (case-insensitive); a name may appear once per unit. */
export function tenantDuplicate(db: DB, t: { name: string; email: string | null; unit_id: string | null }, excludeId?: string): string | null {
  if (t.email) {
    const e = db.prepare("SELECT tenant_id FROM tenants WHERE lower(email) = ? AND tenant_id != ?").get(t.email.toLowerCase(), excludeId ?? "") as { tenant_id: string } | undefined;
    if (e) return `A tenant with email ${t.email} already exists (${e.tenant_id})`;
  }
  if (t.unit_id) {
    const n = db
      .prepare("SELECT tenant_id FROM tenants WHERE unit_id = ? AND lower(trim(name)) = lower(trim(?)) AND tenant_id != ?")
      .get(t.unit_id, t.name, excludeId ?? "") as { tenant_id: string } | undefined;
    if (n) return `${t.name} is already a tenant of unit ${t.unit_id} (${n.tenant_id})`;
  }
  return null;
}

export function createTenant(db: DB, input: TenantInput & { source_document_id?: number | null }): repo.TenantRow {
  const t = { name: input.name.trim(), email: input.email?.trim().toLowerCase() || null, unit_id: input.unit_id || null };
  if (t.unit_id && !repo.getUnit(db, t.unit_id)) throw new ApiError(422, "UNKNOWN_UNIT", `Unit ${t.unit_id} does not exist`);
  const dup = tenantDuplicate(db, t);
  if (dup) throw conflict("DUPLICATE_TENANT", dup);
  const id = nextId(db, "tenants", "tenant_id", "T");
  db.prepare("INSERT INTO tenants (tenant_id, name, email, phone, unit_id, status, source_document_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id, t.name, t.email, input.phone?.trim() || null, t.unit_id, input.status ?? "active", input.source_document_id ?? null,
  );
  return repo.getTenant(db, id)!;
}

export function updateTenant(db: DB, tenantId: string, input: Partial<TenantInput>): repo.TenantRow {
  const cur = repo.getTenant(db, tenantId) as (repo.TenantRow & { phone: string | null }) | undefined;
  if (!cur) throw new ApiError(404, "NOT_FOUND", `Tenant ${tenantId} not found`);
  const next = {
    name: input.name?.trim() ?? cur.name,
    email: input.email === undefined ? cur.email : input.email?.trim().toLowerCase() || null,
    phone: input.phone === undefined ? cur.phone : input.phone?.trim() || null,
    unit_id: input.unit_id === undefined ? cur.unit_id : input.unit_id || null,
    status: input.status ?? cur.status,
  };
  if (next.unit_id && !repo.getUnit(db, next.unit_id)) throw new ApiError(422, "UNKNOWN_UNIT", `Unit ${next.unit_id} does not exist`);
  const dup = tenantDuplicate(db, next, tenantId);
  if (dup) throw conflict("DUPLICATE_TENANT", dup);
  db.prepare("UPDATE tenants SET name = ?, email = ?, phone = ?, unit_id = ?, status = ? WHERE tenant_id = ?").run(
    next.name, next.email, next.phone, next.unit_id, next.status, tenantId,
  );
  return repo.getTenant(db, tenantId)!;
}

export function listTenantsDetailed(db: DB, filter: { status?: string } = {}) {
  const rows = db
    .prepare(
      `SELECT t.*, u.property_name, u.unit_number, u.property_id FROM tenants t LEFT JOIN units u ON u.unit_id = t.unit_id
        WHERE (? IS NULL OR t.status = ?) ORDER BY t.tenant_id`,
    )
    .all(filter.status ?? null, filter.status ?? null) as unknown as (repo.TenantRow & { phone: string | null; property_name: string | null; unit_number: string | null; property_id: number | null })[];
  return rows.map((t) => ({ ...t, unpaid_balance_cents: repo.unpaidBalanceCents(db, t.tenant_id) }));
}

export function tenantProfile(db: DB, tenantId: string) {
  const tenant = listTenantsDetailed(db).find((t) => t.tenant_id === tenantId);
  if (!tenant) return null;
  const leases = (db.prepare("SELECT * FROM leases WHERE tenant_id = ? ORDER BY COALESCE(start_date, '') DESC").all(tenantId) as unknown as repo.LeaseRow[]).map((l) =>
    leaseListItem(db, l),
  );
  const tickets = (db.prepare("SELECT * FROM maintenance_tickets WHERE tenant_id = ? ORDER BY ticket_id DESC").all(tenantId) as unknown as repo.TicketRow[]);
  return { ...tenant, leases, ledger: repo.getLedger(db, tenantId), tickets };
}
