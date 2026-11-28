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

/** How the lease text was read: per page, and overall (text, ocr or mixed). */
function textSource(db: DB, lease: repo.LeaseRow) {
  const pages = repo.getSourcePages(db, lease.source_doc_name);
  if (!pages.length) return null;
  const ocr = pages.filter((p) => p.method === "ocr");
  const conf = ocr.map((p) => p.confidence).filter((c): c is number => c !== null);
  return {
    method: ocr.length === 0 ? "text" : ocr.length === pages.length ? "ocr" : "mixed",
    page_count: pages.length,
    ocr_pages: ocr.map((p) => p.page),
    average_ocr_confidence: conf.length ? Math.round(conf.reduce((a, b) => a + b, 0) / conf.length) : null,
    pages,
  };
}

export function leaseDetail(db: DB, leaseId: number) {
  const lease = repo.getLeaseRow(db, leaseId)!;
  return {
    ...repo.leaseSummary(db, lease),
    ...links(db, lease),
    text_source: textSource(db, lease),
    fields: repo.getFieldSources(db, leaseId),
    clauses: repo.getClauses(db, leaseId),
  };
}
