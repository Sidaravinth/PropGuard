/** Day 2 lease management endpoints: uploads, original files, source text, corrections, linking. */
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requirePermission } from "../auth/middleware.js";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import type { LlmCall } from "../extraction/extractor.js";
import { auditUnitRentSync, correctLeaseField, linkLease, listCorrections } from "../services/leaseCorrections.js";
import { audit, humanActor, type Actor } from "../services/audit.js";
import { deleteLeaseDocument, getDocument, leaseSourcePages, listDocuments, processStoredUpload, retryExtraction, storeLeaseUpload, type DocumentRow, type UploadOutcome } from "../services/leaseDocuments.js";
import type { DocumentStore } from "../storage/documentStore.js";
import { ApiError, notFound, parseOr400 } from "./errors.js";
import { leaseDetail } from "./leaseViews.js";
import { askLeaseQuestion, clearLeaseConversation, MAX_QUESTION_LENGTH, qaHistory } from "../services/leaseQa.js";

const IntId = z.coerce.number().int().positive();
/** Stored originals are served with their own type; anything else as plain text. */
const SERVED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
const Cents = z.number().int().nonnegative().max(100_000_000);

const CorrectionBody = z
  .object({ value: z.union([z.string(), z.number(), z.null()]), reason: z.string().trim().min(3, "Give a short reason (at least 3 characters)").max(500) })
  .strict();
const LinkBody = z
  .object({ unit_id: z.string().min(1), tenant_id: z.string().min(1).nullable(), reason: z.string().trim().max(500).optional() })
  .strict();

const QuestionBody = z.object({ question: z.string().trim().min(1, "Ask a question").max(MAX_QUESTION_LENGTH) }).strict();

export function createLeaseRouter(db: DB, deps: { llm: () => LlmCall; store: () => DocumentStore; qaLlm: () => LlmCall }): Router {
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  const write = requirePermission("records.write");
  r.use(requirePermission("records.read"));

  // --- documents -------------------------------------------------------------------
  r.get("/documents", (req, res) => {
    const { kind } = parseOr400(z.object({ kind: z.enum(["lease", "tenant_import", "ledger_import"]).optional() }), req.query, "query");
    res.json({ data: listDocuments(db, kind) });
  });

  r.get("/documents/:id", (req, res) => {
    const doc = getDocument(db, parseOr400(IntId, req.params.id, "document id"));
    if (!doc) throw notFound("Document");
    res.json({ data: doc });
  });

  /** Delete a lease document, its stored original and the lease extracted from it (refused if it has history). */
  r.delete("/documents/:id", write, async (req, res) => {
    const out = await deleteLeaseDocument(db, deps.store(), parseOr400(IntId, req.params.id, "document id"));
    const d = out.document;
    audit(db, {
      event_type: "document_deleted",
      actor: humanActor(req.auth!.user),
      subject: out.lease_id ? { type: "lease", id: out.lease_id } : { type: "document", id: d.document_id },
      payload: {
        document_id: d.document_id,
        doc_name: d.doc_name,
        sha256: d.sha256,
        storage_key: d.storage_key,
        status: d.status,
        lease_id: out.lease_id,
        removed: out.removed,
      },
    });
    res.json({ data: { document_id: d.document_id, lease_id: out.lease_id, removed: out.removed } });
  });

  /** The original uploaded bytes, unchanged. */
  r.get("/documents/:id/file", async (req, res) => {
    const doc = getDocument(db, parseOr400(IntId, req.params.id, "document id"));
    if (!doc) throw notFound("Document");
    const bytes = await deps.store().get(doc.storage_key);
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.set({
      "Content-Type": SERVED_TYPES.has(doc.mime_type) ? doc.mime_type : "text/plain; charset=utf-8",
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.doc_name)}`,
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
    });
    res.send(bytes);
  });

  r.post("/documents/leases", write, upload.single("file"), async (req, res) => {
    if (!req.file) throw new ApiError(400, "FILE_REQUIRED", 'Upload the lease as multipart/form-data field "file" (.pdf, .txt, .docx, .png or .jpg)');
    const { mode } = parseOr400(z.object({ mode: z.enum(["sync", "async"]).optional() }), req.query, "query");
    const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const bytes = req.file.buffer;
    const actor = humanActor(req.auth!.user);
    const stored = await storeLeaseUpload(db, deps.store(), { originalName, bytes, mimeType: req.file.mimetype }, req.auth!.user.user_id);
    const auditUpload = (d: DocumentRow) =>
      audit(db, {
        event_type: "document_uploaded",
        actor,
        subject: { type: "document", id: d.document_id },
        payload: { doc_name: d.doc_name, sha256: d.sha256, size_bytes: d.size_bytes, storage_key: d.storage_key, mime_type: d.mime_type },
      });

    if (mode === "async") {
      // The original is safe and recorded; reading, OCR and AI extraction continue in the background.
      // Progress is visible on GET /documents/:id (processing_stage), and the outcome is audited when done.
      auditUpload(stored);
      void processStoredUpload(db, stored, bytes, deps.llm())
        .then((out) => auditExtraction(out, actor))
        .catch((err) => console.error(`Background extraction of document ${stored.document_id} failed:`, err));
      res.status(202).json({ data: { document: stored, lease: null } });
      return;
    }

    const out = await processStoredUpload(db, stored, bytes, deps.llm());
    auditUpload(out.document);
    auditExtraction(out, actor);
    res.status(201).json({ data: { document: out.document, lease: out.document.lease_id ? leaseDetail(db, out.document.lease_id) : null } });
  });

  r.post("/documents/:id/retry", write, async (req, res) => {
    const out = await retryExtraction(db, deps.store(), parseOr400(IntId, req.params.id, "document id"), deps.llm());
    auditExtraction(out, humanActor(req.auth!.user), true);
    res.json({ data: { document: out.document, lease: out.document.lease_id ? leaseDetail(db, out.document.lease_id) : null } });
  });

  /** Extraction runs (the LLM step plus deterministic verification) are audited with their outcome. */
  function auditExtraction(out: UploadOutcome, actor: Actor, retry = false) {
    const d = out.document;
    if (out.ingest) auditUnitRentSync(db, out.ingest.unit_rent_synced, actor, `Matched to the monthly rent in ${d.doc_name}`);
    audit(db, {
      event_type: d.status === "failed" ? "extraction_failed" : "extraction_completed",
      actor,
      subject: d.lease_id ? { type: "lease", id: d.lease_id } : { type: "document", id: d.document_id },
      payload: {
        document_id: d.document_id,
        doc_name: d.doc_name,
        retry,
        status: d.status,
        error_code: d.error_code,
        lease_id: d.lease_id,
        model: d.lease_id ? (repo.getLeaseRow(db, d.lease_id)?.extraction_model ?? null) : null,
        attempts: out.ingest?.attempts ?? [],
        gaps: out.ingest?.gaps.map((g) => `${g.field}:${g.status}`) ?? [],
        linked: out.ingest?.linked ?? null,
        text: out.ingest ? { format: out.ingest.text.format, page_count: out.ingest.text.page_count, text_method: out.ingest.text.text_method, pages: out.ingest.text.pages } : null,
      },
    });
  }

  // --- lease review --------------------------------------------------------------------
  r.get("/leases/:id/source", (req, res) => {
    const lease = repo.getLeaseRow(db, parseOr400(IntId, req.params.id, "lease id"));
    if (!lease) throw notFound("Lease");
    const src = leaseSourcePages(db, lease);
    if (!src) throw notFound("Source document");
    res.json({ data: src });
  });

  // --- grounded Q&A (read-only; answers come only from this lease's own text) ----------------
  r.get("/leases/:id/qa", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    if (!repo.getLeaseRow(db, id)) throw notFound("Lease");
    res.json({ data: qaHistory(db, id, req.auth!.user.user_id) });
  });

  r.post("/leases/:id/qa", async (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    const { question } = parseOr400(QuestionBody, req.body, "question");
    res.json({ data: await askLeaseQuestion(db, deps.qaLlm(), id, req.auth!.user, question) });
  });

  r.delete("/leases/:id/qa", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    res.json({ data: { removed: clearLeaseConversation(db, id, req.auth!.user) } });
  });

  r.get("/leases/:id/corrections", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    if (!repo.getLeaseRow(db, id)) throw notFound("Lease");
    res.json({ data: listCorrections(db, id) });
  });

  r.patch("/leases/:id/fields/:field", write, (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    const body = parseOr400(CorrectionBody, req.body, "correction");
    const rentSync = correctLeaseField(db, id, String(req.params.field), body.value, body.reason, req.auth!.user.user_id);
    const c = listCorrections(db, id)[0]!;
    audit(db, {
      event_type: "extraction_correction",
      actor: humanActor(req.auth!.user),
      subject: { type: "lease", id },
      payload: { correction_id: c.correction_id, field: c.field_name, previous_value: c.previous_value_text, previous_status: c.previous_status, new_value: c.new_value_text, new_status: c.new_status, reason: c.reason },
    });
    auditUnitRentSync(db, rentSync, humanActor(req.auth!.user), `Matched to the corrected monthly rent of lease #${id}`);
    res.json({ data: leaseDetail(db, id) });
  });

  r.put("/leases/:id/link", write, (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    const body = parseOr400(LinkBody, req.body, "link");
    const rentSync = linkLease(db, id, body.unit_id, body.tenant_id, body.reason ?? "", req.auth!.user.user_id);
    audit(db, { event_type: "lease_linked", actor: humanActor(req.auth!.user), subject: { type: "lease", id }, payload: { unit_id: body.unit_id, tenant_id: body.tenant_id, reason: body.reason ?? null } });
    auditUnitRentSync(db, rentSync, humanActor(req.auth!.user), `Matched to the monthly rent of lease #${id} when it was linked`);
    res.json({ data: leaseDetail(db, id) });
  });

  return r;
}
