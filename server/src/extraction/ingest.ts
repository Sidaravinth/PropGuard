/**
 * Ingestion pipeline: file -> page text -> LLM extraction (schema-validated, retried)
 *   -> deterministic verification against source -> link to unit/tenant -> transactional store.
 *
 * Re-ingesting a document with the same name replaces its previous lease (idempotent).
 */
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { loadDocument, type LoadedDocument, type LoadOptions, type TextStage } from "./documentText.js";
import { extractLease, type ExtractionAttempt, type LlmCall } from "./extractor.js";
import { LEASE_FIELD_NAMES, type LeaseFieldName } from "./leaseSchema.js";
import { lowOcrConfidenceGaps, verifyExtraction, type DataGap, type VerifiedLease } from "./verify.js";

export interface IngestResult {
  lease_id: number;
  source_doc_name: string;
  extraction_status: "complete" | "needs_review";
  linked: { unit_id: string | null; tenant_id: string | null; tenant_created: boolean };
  gaps: DataGap[];
  attempts: ExtractionAttempt[];
  replaced_existing: boolean;
  /** The linked unit's base rent, changed to match this agreement's verified monthly rent (null if unchanged). */
  unit_rent_synced: repo.UnitRentChange | null;
  /** What the inspection and text-extraction step found. */
  text: { format: LoadedDocument["format"]; page_count: number; text_method: LoadedDocument["textMethod"]; pages: LoadedDocument["pageMeta"] };
}

/** Stages reported while a document is processed, so callers can show progress. */
export type IngestStage = TextStage | "ai_extraction";
export interface IngestOptions {
  ocr?: LoadOptions["ocr"];
  onStage?: (stage: IngestStage) => void;
}

/** Replacing this document would destroy or detach human work, so it is refused. */
export class LeaseHasHistoryError extends Error {
  constructor(
    readonly leaseId: number,
    readonly reasons: string[],
    docName: string,
  ) {
    super(`"${docName}" cannot be replaced: lease #${leaseId} has history (${reasons.join("; ")}). Upload the new document under a different name, or correct the lease instead.`);
  }
}

function refuseIfHistory(db: DB, docName: string): void {
  const history = repo.leaseHistory(db, docName);
  if (history) throw new LeaseHasHistoryError(history.lease_id, history.reasons, docName);
}

export async function ingestLeaseDocument(
  db: DB,
  input: { docName: string; bytes: Buffer },
  llm: LlmCall,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  refuseIfHistory(db, input.docName); // before spending OCR time or a model call
  const doc = await loadDocument(input.docName, input.bytes, { ocr: opts.ocr, onStage: opts.onStage });
  opts.onStage?.("ai_extraction");
  const outcome = await extractLease(doc, llm);

  const verified: VerifiedLease | null = outcome.extraction ? verifyExtraction(outcome.extraction, doc.pages) : null;
  const failureNote = `Automatic extraction failed after ${outcome.attempts.length} attempt(s): ${
    outcome.attempts.at(-1)?.error ?? "unknown error"
  }`;

  return tx(db, () => {
    refuseIfHistory(db, doc.docName); // again: a person may have acted while the model was reading
    const existing = db.prepare("SELECT doc_id FROM source_documents WHERE doc_name = ?").get(doc.docName);
    // Cascades to the lease, its field sources, clauses and deposit entries.
    if (existing) db.prepare("DELETE FROM source_documents WHERE doc_name = ?").run(doc.docName);

    db.prepare("INSERT INTO source_documents (doc_name, sha256, mime_type, page_count, raw_text) VALUES (?, ?, ?, ?, ?)").run(
      doc.docName, doc.sha256, doc.mimeType, doc.pages.length, doc.pages.join("\f"),
    );

    const docId = (db.prepare("SELECT doc_id FROM source_documents WHERE doc_name = ?").get(doc.docName) as { doc_id: number }).doc_id;
    const insPage = db.prepare("INSERT INTO source_document_pages (doc_id, page, method, ocr_confidence) VALUES (?, ?, ?, ?)");
    doc.pageMeta.forEach((m, i) => insPage.run(docId, i + 1, m.method, m.confidence));

    // Link to a known unit and tenant using ONLY verified values.
    const v = (name: LeaseFieldName) => verified?.fields[name].value ?? null;
    let unitId: string | null = null;
    let tenantId: string | null = null;
    let tenantCreated = false;
    const prop = v("property_name");
    const unitNo = v("unit_number");
    const tenantName = v("tenant_name");
    if (typeof prop === "string" && typeof unitNo === "string") {
      unitId = repo.findUnitByLabel(db, prop, unitNo)?.unit_id ?? null;
    }
    if (unitId && typeof tenantName === "string") {
      const t = repo.findTenantInUnit(db, unitId, tenantName);
      if (t) tenantId = t.tenant_id;
      else {
        tenantId = repo.createPendingTenant(db, tenantName, unitId).tenant_id;
        tenantCreated = true;
      }
    }

    const gaps = verified ? [...verified.gaps] : LEASE_FIELD_NAMES.map((f) => ({ field: f, status: "needs_review" as const, reason: failureNote }));
    if (!unitId) gaps.push({ field: "unit_link", status: "needs_review", reason: "Document could not be linked to a known unit" });
    if (!tenantId) gaps.push({ field: "tenant_link", status: "needs_review", reason: "Document could not be linked to a tenant" });
    gaps.push(...lowOcrConfidenceGaps(doc.pageMeta.map((m, i) => ({ page: i + 1, ...m }))));
    const status: IngestResult["extraction_status"] = gaps.length === 0 ? "complete" : "needs_review";

    const num = (name: LeaseFieldName) => {
      const x = v(name);
      return typeof x === "number" ? x : null;
    };
    const str = (name: LeaseFieldName) => {
      const x = v(name);
      return typeof x === "string" ? x : null;
    };

    const leaseIns = db
      .prepare(
        `INSERT INTO leases (tenant_id, unit_id, start_date, end_date, monthly_rent_cents, security_deposit_cents,
           notice_period_days, repair_deductible_cents, source_doc_name, extraction_status, extraction_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(tenantId, unitId, str("start_date"), str("end_date"), num("monthly_rent"), num("security_deposit"),
        num("notice_period_days"), num("repair_deductible"), doc.docName, status, outcome.model);
    const leaseId = Number(leaseIns.lastInsertRowid);

    const insField = db.prepare(
      `INSERT INTO lease_field_sources (lease_id, field_name, value_text, status, section_ref, page, verbatim_snippet, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const name of LEASE_FIELD_NAMES) {
      const f = verified?.fields[name];
      if (f) insField.run(leaseId, name, f.valueText, f.status, f.sectionRef, f.page, f.snippet, f.notes.join("; ") || null);
      else insField.run(leaseId, name, null, "needs_review", null, null, null, failureNote);
    }

    const insClause = db.prepare(
      "INSERT INTO lease_clauses (lease_id, clause_type, extracted_text, section_ref, page, verified) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const c of verified?.clauses ?? []) {
      insClause.run(leaseId, c.clauseType, c.text, c.sectionRef, c.page, c.verified ? 1 : 0);
    }

    const deposit = num("security_deposit");
    if (deposit !== null && deposit > 0) {
      db.prepare("INSERT INTO deposit_ledger (lease_id, entry_type, amount_cents, note) VALUES (?, 'held', ?, ?)").run(
        leaseId, deposit, `Security deposit per ${doc.docName}`,
      );
    }

    // The unit's base rent follows the agreement it is linked to (verified rent only).
    const unitRentSynced = repo.syncUnitRentFromLease(db, leaseId);

    return {
      lease_id: leaseId,
      unit_rent_synced: unitRentSynced,
      source_doc_name: doc.docName,
      extraction_status: status,
      linked: { unit_id: unitId, tenant_id: tenantId, tenant_created: tenantCreated },
      gaps,
      attempts: outcome.attempts,
      replaced_existing: Boolean(existing),
      text: { format: doc.format, page_count: doc.pages.length, text_method: doc.textMethod, pages: doc.pageMeta },
    };
  });
}
