/** Read models for leases as the API returns them (summary + names + upload record). */
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { documentForLease } from "../services/leaseDocuments.js";

function links(db: DB, lease: repo.LeaseRow) {
  const unit = lease.unit_id ? repo.getUnit(db, lease.unit_id) ?? null : null;
  const tenant = lease.tenant_id ? repo.getTenant(db, lease.tenant_id) ?? null : null;
  const doc = documentForLease(db, lease.lease_id);
  return {
    unit: unit && { unit_id: unit.unit_id, property_name: unit.property_name, unit_number: unit.unit_number },
    tenant: tenant && { tenant_id: tenant.tenant_id, name: tenant.name, status: tenant.status },
    document: doc ? { document_id: doc.document_id, doc_name: doc.doc_name, mime_type: doc.mime_type, uploaded_at: doc.uploaded_at } : null,
  };
}

export function leaseListItem(db: DB, lease: repo.LeaseRow) {
  return { ...repo.leaseSummary(db, lease), ...links(db, lease) };
}

export function leaseDetail(db: DB, leaseId: number) {
  const lease = repo.getLeaseRow(db, leaseId)!;
  return {
    ...repo.leaseSummary(db, lease),
    ...links(db, lease),
    fields: repo.getFieldSources(db, leaseId),
    clauses: repo.getClauses(db, leaseId),
  };
}
