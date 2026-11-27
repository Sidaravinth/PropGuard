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
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { UnsupportedDocumentError } from "../extraction/documentText.js";
import { LlmUnavailableError, type LlmCall } from "../extraction/extractor.js";
import { ingestLeaseDocument, type IngestResult } from "../extraction/ingest.js";
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
  error_code: string | null;
  error_message: string | null;
  lease_id: number | null;
  uploaded_by: number | null;
  uploaded_at: string;
  processed_at: string | null;
}

export const LEASE_EXTENSIONS = [".pdf", ".txt"] as const;

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
  try {
    const result = await ingestLeaseDocument(db, { docName: doc.doc_name, bytes }, llm);
    db.prepare(
      "UPDATE documents SET status = ?, lease_id = ?, error_code = NULL, error_message = NULL, processed_at = datetime('now') WHERE document_id = ?",
    ).run(result.extraction_status === "complete" ? "extracted" : "needs_review", result.lease_id, doc.document_id);
    return result;
  } catch (err) {
    const f = failureOf(err);
    if (f.code === "EXTRACTION_ERROR") console.error(err);
    db.prepare("UPDATE documents SET status = 'failed', error_code = ?, error_message = ?, processed_at = datetime('now') WHERE document_id = ?").run(
      f.code, f.message, doc.document_id,
    );
    return null;
  }
}

export interface UploadOutcome {
  document: DocumentRow;
  ingest: IngestResult | null;
}

export async function uploadLeaseDocument(
  db: DB,
  store: DocumentStore,
  file: { originalName: string; bytes: Buffer; mimeType: string },
  userId: number,
  llm: LlmCall,
): Promise<UploadOutcome> {
  const ext = path.extname(file.originalName).toLowerCase();
  if (!(LEASE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ApiError(422, "UNSUPPORTED_DOCUMENT", `Unsupported file type "${ext || "none"}": upload a .pdf or .txt lease document`);
  }
  if (file.bytes.length === 0) throw new ApiError(422, "EMPTY_FILE", "The uploaded file is empty");

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
      `INSERT INTO documents (kind, doc_name, original_filename, mime_type, size_bytes, sha256, storage_key, status, uploaded_by)
       VALUES ('lease', ?, ?, ?, ?, ?, ?, 'processing', ?)`,
    )
    .run(docName, file.originalName.slice(0, 255), ext === ".pdf" ? "application/pdf" : "text/plain", file.bytes.length, sha256, storageKey, userId);
  const doc = getDocument(db, Number(ins.lastInsertRowid))!;

  // 3-8. Run the Day 1 pipeline (extraction, validation, linking, storage of fields/clauses/evidence, gap flags).
  const ingest = await runExtraction(db, doc, file.bytes, llm);
  return { document: getDocument(db, doc.document_id)!, ingest };
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
  db.prepare("UPDATE documents SET status = 'processing' WHERE document_id = ?").run(documentId);
  const ingest = await runExtraction(db, doc, bytes, llm);
  return { document: getDocument(db, documentId)!, ingest };
}

/** On startup: an upload still "processing" was interrupted by a restart. Mark it failed so it can be retried. */
export function recoverInterruptedUploads(db: DB): number {
  const r = db
    .prepare(
      "UPDATE documents SET status = 'failed', error_code = 'INTERRUPTED', error_message = 'Extraction was interrupted by a server restart; retry it.', processed_at = datetime('now') WHERE status = 'processing'",
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
