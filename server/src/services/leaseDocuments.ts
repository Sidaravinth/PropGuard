/**
 * User-driven lease uploads (Day 2). Wraps the Day 1 extraction pipeline with:
 *  - original-file preservation (document store) and a `documents` record for every upload,
 *  - duplicate prevention by content hash,
 *  - safe failure: when text extraction or the LLM fails, the file and record are kept as `failed`
 *    and extraction can be retried later.
 */
import crypto from "node:crypto";
import path from "node:path";
import { ApiError } from "../api/errors.js";
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { detectFormat, UnsupportedDocumentError } from "../extraction/documentText.js";
import { LlmUnavailableError, type LlmCall } from "../extraction/extractor.js";
import { ingestLeaseDocument, type IngestResult, type IngestStage } from "../extraction/ingest.js";
import type { DocumentStore } from "../storage/documentStore.js";

export interface DocumentRow {
  document_id: number;
  kind: "lease" | "tenant_import" | "ledger_import";
  doc_name: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  status: "processing" | "extracted" | "needs_review" | "failed";
  /** While status is "processing": the step under way. */
  processing_stage: "uploaded" | IngestStage | null;
  page_count: number | null;
  text_method: "text" | "ocr" | "mixed" | null;
  error_code: string | null;
  error_message: string | null;
  lease_id: number | null;
  uploaded_by: number | null;
  uploaded_at: string;
  processed_at: string | null;
}

export const LEASE_EXTENSIONS = [".pdf", ".txt", ".docx", ".png", ".jpg", ".jpeg"] as const;

export const getDocument = (db: DB, id: number) =>
  db.prepare("SELECT * FROM documents WHERE document_id = ?").get(id) as unknown as DocumentRow | undefined;

export function listDocuments(db: DB, kind?: DocumentRow["kind"]): (DocumentRow & { uploaded_by_name: string | null })[] {
  return db
    .prepare(
      `SELECT d.*, u.display_name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.user_id = d.uploaded_by
        WHERE (? IS NULL OR d.kind = ?) ORDER BY d.document_id DESC`,
    )
    .all(kind ?? null, kind ?? null) as unknown as (DocumentRow & { uploaded_by_name: string | null })[];
}

/** Make the display name unique: "lease.pdf", then "lease (2).pdf", ... */
function uniqueDocName(db: DB, original: string): string {
  const clean = path.basename(original).replace(/[^\w.\- ()]+/g, "_").slice(-150) || "document";
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  const taken = (name: string) =>
    Boolean(db.prepare("SELECT 1 FROM documents WHERE doc_name = ? UNION SELECT 1 FROM source_documents WHERE doc_name = ?").get(name, name));
  let name = clean;
  for (let i = 2; taken(name); i++) name = `${stem} (${i})${ext}`;
  return name;
}

function failureOf(err: unknown): { code: string; message: string } {
  if (err instanceof UnsupportedDocumentError) return { code: "UNSUPPORTED_DOCUMENT", message: err.message };
  if (err instanceof LlmUnavailableError) return { code: "LLM_UNAVAILABLE", message: `${err.message}. The file is saved; retry extraction later.` };
  return { code: "EXTRACTION_ERROR", message: err instanceof Error ? err.message : String(err) };
}

async function runExtraction(db: DB, doc: DocumentRow, bytes: Buffer, llm: LlmCall): Promise<IngestResult | null> {
  const setStage = (stage: DocumentRow["processing_stage"]) =>
    db.prepare("UPDATE documents SET processing_stage = ? WHERE document_id = ? AND status = 'processing'").run(stage, doc.document_id);
  try {
    const result = await ingestLeaseDocument(db, { docName: doc.doc_name, bytes }, llm, { onStage: setStage });
    db.prepare(
      `UPDATE documents SET status = ?, lease_id = ?, error_code = NULL, error_message = NULL, processing_stage = NULL,
         page_count = ?, text_method = ?, processed_at = datetime('now') WHERE document_id = ?`,
    ).run(result.extraction_status === "complete" ? "extracted" : "needs_review", result.lease_id, result.text.page_count, result.text.text_method, doc.document_id);
    return result;
  } catch (err) {
    const f = failureOf(err);
    if (f.code === "EXTRACTION_ERROR") console.error(err);
    db.prepare(
      "UPDATE documents SET status = 'failed', error_code = ?, error_message = ?, processing_stage = NULL, processed_at = datetime('now') WHERE document_id = ?",
    ).run(f.code, f.message, doc.document_id);
    return null;
  }
}

export interface UploadOutcome {
  document: DocumentRow;
  ingest: IngestResult | null;
}

/**
 * Step 1 of an upload: validate, keep the original, and create the document record (status "processing",
 * stage "uploaded"). Nothing is read or sent to a model yet.
 */
export async function storeLeaseUpload(
  db: DB,
  store: DocumentStore,
  file: { originalName: string; bytes: Buffer; mimeType: string },
  userId: number,
): Promise<DocumentRow> {
  const ext = path.extname(file.originalName).toLowerCase();
  if (!(LEASE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ApiError(422, "UNSUPPORTED_DOCUMENT", `Unsupported file type "${ext || "none"}": upload a .pdf, .txt, .docx, .png or .jpg lease document`);
  }
  if (file.bytes.length === 0) throw new ApiError(422, "EMPTY_FILE", "The uploaded file is empty");
  // The file's own bytes must match its extension (a renamed file is refused before it is stored).
  const detected = detectFormat(file.originalName, file.bytes);
  const expected = ext === ".pdf" ? "pdf" : ext === ".txt" ? "text" : ext === ".docx" ? "docx" : "image";
  if (expected !== "pdf" && detected?.format !== expected) {
    throw new ApiError(422, "UNSUPPORTED_DOCUMENT", `The file's contents do not match its "${ext}" extension`);
  }
  const mimeType = detected?.mimeType ?? "application/pdf";

  const sha256 = crypto.createHash("sha256").update(file.bytes).digest("hex");
  const dup = db.prepare("SELECT document_id, doc_name, lease_id FROM documents WHERE sha256 = ?").get(sha256) as
    | { document_id: number; doc_name: string; lease_id: number | null }
    | undefined;
  if (dup) {
    throw new ApiError(409, "DUPLICATE_DOCUMENT", `This file was already uploaded as "${dup.doc_name}"`, dup);
  }

  // 1. Save the original first, 2. create the document record, both before any extraction work.
  const storageKey = await store.put(file.bytes, ext);
  const docName = uniqueDocName(db, file.originalName);
  const ins = db
    .prepare(
      `INSERT INTO documents (kind, doc_name, original_filename, mime_type, size_bytes, sha256, storage_key, status, processing_stage, uploaded_by)
       VALUES ('lease', ?, ?, ?, ?, ?, ?, 'processing', 'uploaded', ?)`,
    )
    .run(docName, file.originalName.slice(0, 255), mimeType, file.bytes.length, sha256, storageKey, userId);
  return getDocument(db, Number(ins.lastInsertRowid))!;
}

/**
 * Steps 2-6: inspect, read text (OCR where needed), AI extraction, validation and storage. Never throws for
 * a document problem: the record ends as extracted, needs_review or failed (with the reason).
 */
export async function processStoredUpload(db: DB, doc: DocumentRow, bytes: Buffer, llm: LlmCall): Promise<UploadOutcome> {
  const ingest = await runExtraction(db, doc, bytes, llm);
  return { document: getDocument(db, doc.document_id)!, ingest };
}

/** Upload and process in one request (the original synchronous flow). */
export async function uploadLeaseDocument(
  db: DB,
  store: DocumentStore,
  file: { originalName: string; bytes: Buffer; mimeType: string },
  userId: number,
  llm: LlmCall,
): Promise<UploadOutcome> {
  const doc = await storeLeaseUpload(db, store, file, userId);
  return processStoredUpload(db, doc, file.bytes, llm);
}

/** Re-run extraction for a failed upload from its stored original. */
export async function retryExtraction(db: DB, store: DocumentStore, documentId: number, llm: LlmCall): Promise<UploadOutcome> {
  const doc = getDocument(db, documentId);
  if (!doc) throw new ApiError(404, "NOT_FOUND", `Document ${documentId} not found`);
  if (doc.kind !== "lease") throw new ApiError(422, "NOT_A_LEASE", "Only lease documents can be extracted");
  if (doc.status !== "failed") {
    throw new ApiError(409, "NOT_RETRYABLE", `Document is "${doc.status}"; only failed extractions can be retried (use field corrections to fix extracted data)`);
  }
  const bytes = await store.get(doc.storage_key);
  db.prepare("UPDATE documents SET status = 'processing', processing_stage = 'uploaded' WHERE document_id = ?").run(documentId);
  const ingest = await runExtraction(db, doc, bytes, llm);
  return { document: getDocument(db, documentId)!, ingest };
}

/** On startup: an upload still "processing" was interrupted by a restart. Mark it failed so it can be retried. */
export function recoverInterruptedUploads(db: DB): number {
  const r = db
    .prepare(
      "UPDATE documents SET status = 'failed', error_code = 'INTERRUPTED', error_message = 'Extraction was interrupted by a server restart; retry it.', processing_stage = NULL, processed_at = datetime('now') WHERE status = 'processing'",
    )
    .run();
  return Number(r.changes);
}

/** The upload record for a lease, if it came through the Day 2 upload flow. */
export const documentForLease = (db: DB, leaseId: number) =>
  db.prepare("SELECT * FROM documents WHERE lease_id = ?").get(leaseId) as unknown as DocumentRow | undefined;

export function leaseSourcePages(db: DB, lease: repo.LeaseRow): { doc_name: string; mime_type: string; pages: string[] } | null {
  const src = db.prepare("SELECT doc_name, mime_type, raw_text FROM source_documents WHERE doc_name = ?").get(lease.source_doc_name) as
    | { doc_name: string; mime_type: string; raw_text: string }
    | undefined;
  return src ? { doc_name: src.doc_name, mime_type: src.mime_type, pages: src.raw_text.split("\f") } : null;
}

/** Decisions and money attached to a lease: deleting its document would erase them, so it is refused. */
function deletionBlockers(db: DB, leaseId: number): string[] {
  const has = (sql: string) => Boolean(db.prepare(sql).get(leaseId));
  return (
    [
      ["SELECT 1 FROM decision_briefs WHERE lease_id = ?", "it has Decision Briefs"],
      ["SELECT 1 FROM renewal_offers WHERE lease_id = ?", "it has a renewal offer"],
      ["SELECT 1 FROM deposit_reservations WHERE lease_id = ?", "it has deposit reservations"],
      ["SELECT 1 FROM deposit_ledger WHERE lease_id = ? AND entry_type = 'deduction'", "it has deposit deductions"],
    ] as const
  )
    .filter(([sql]) => has(sql))
    .map(([, reason]) => reason);
}

export interface DeletedDocument {
  document: DocumentRow;
  lease_id: number | null;
  removed: { corrections: number; clauses: number; qa_messages: number };
}

/**
 * Delete an uploaded lease document: its record, the stored original, and the lease extracted from it
 * (fields, clauses, corrections, chat history and the deposit held). Units and tenants stay. Refused while
 * the document is still being processed, and when the lease has Decision Briefs, renewal offers or deposit
 * charges, because those are decisions and money that must stay traceable. The audit log keeps the history.
 */
export async function deleteLeaseDocument(db: DB, store: DocumentStore, documentId: number): Promise<DeletedDocument> {
  const doc = getDocument(db, documentId);
  if (!doc) throw new ApiError(404, "NOT_FOUND", `Document ${documentId} not found`);
  if (doc.kind !== "lease") throw new ApiError(422, "NOT_A_LEASE", "Only lease documents can be deleted here");
  if (doc.status === "processing") throw new ApiError(409, "DOCUMENT_PROCESSING", "The document is still being processed; delete it once it has finished");
  const lease = doc.lease_id ? repo.getLeaseRow(db, doc.lease_id) : undefined;
  if (lease) {
    const reasons = deletionBlockers(db, lease.lease_id);
    if (reasons.length) {
      throw new ApiError(409, "LEASE_HAS_HISTORY", `"${doc.doc_name}" cannot be deleted: lease #${lease.lease_id} ${reasons.join("; ")}`, { lease_id: lease.lease_id, reasons });
    }
  }

  const result = tx(db, (): DeletedDocument => {
    const count = (sql: string) => (lease ? (db.prepare(sql).get(lease.lease_id) as { n: number }).n : 0);
    const removed = {
      corrections: count("SELECT COUNT(*) AS n FROM lease_field_corrections WHERE lease_id = ?"),
      clauses: count("SELECT COUNT(*) AS n FROM lease_clauses WHERE lease_id = ?"),
      qa_messages: count("SELECT COUNT(*) AS n FROM qa_messages WHERE lease_id = ?"),
    };
    db.prepare("DELETE FROM documents WHERE document_id = ?").run(documentId);
    // Removing the source text cascades to the lease and everything extracted from it.
    if (lease) db.prepare("DELETE FROM source_documents WHERE doc_name = ?").run(lease.source_doc_name);
    return { document: doc, lease_id: lease?.lease_id ?? null, removed };
  });

  // The original goes last, once nothing refers to it (identical bytes are stored once, so check first).
  const stillUsed = db.prepare("SELECT 1 FROM documents WHERE storage_key = ?").get(doc.storage_key);
  if (!stillUsed) await store.delete(doc.storage_key);
  return result;
}
