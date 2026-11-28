/** Day 2 lease management endpoints: uploads, original files, source text, corrections, linking. */
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requirePermission } from "../auth/middleware.js";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import type { LlmCall } from "../extraction/extractor.js";
import { correctLeaseField, linkLease, listCorrections } from "../services/leaseCorrections.js";
import { audit, humanActor, type Actor } from "../services/audit.js";
import { getDocument, leaseSourcePages, listDocuments, retryExtraction, uploadLeaseDocument, type UploadOutcome } from "../services/leaseDocuments.js";
import type { DocumentStore } from "../storage/documentStore.js";
import { ApiError, notFound, parseOr400 } from "./errors.js";
import { leaseDetail } from "./leaseViews.js";

const IntId = z.coerce.number().int().positive();
const Cents = z.number().int().nonnegative().max(100_000_000);

const CorrectionBody = z
  .object({ value: z.union([z.string(), z.number(), z.null()]), reason: z.string().trim().min(3, "Give a short reason (at least 3 characters)").max(500) })
  .strict();
const LinkBody = z
  .object({ unit_id: z.string().min(1), tenant_id: z.string().min(1).nullable(), reason: z.string().trim().max(500).optional() })
  .strict();

export function createLeaseRouter(db: DB, deps: { llm: () => LlmCall; store: () => DocumentStore }): Router {
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

  /** The original uploaded bytes, unchanged. */
  r.get("/documents/:id/file", async (req, res) => {
    const doc = getDocument(db, parseOr400(IntId, req.params.id, "document id"));
    if (!doc) throw notFound("Document");
    const bytes = await deps.store().get(doc.storage_key);
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.set({
      "Content-Type": doc.mime_type === "application/pdf" ? "application/pdf" : "text/plain; charset=utf-8",
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.doc_name)}`,
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
    });
    res.send(bytes);
  });

  r.post("/documents/leases", write, upload.single("file"), async (req, res) => {
    if (!req.file) throw new ApiError(400, "FILE_REQUIRED", 'Upload the lease as multipart/form-data field "file" (.pdf or .txt)');
    const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const out = await uploadLeaseDocument(db, deps.store(), { originalName, bytes: req.file.buffer, mimeType: req.file.mimetype }, req.auth!.user.user_id, deps.llm());
    const actor = humanActor(req.auth!.user);
    audit(db, {
      event_type: "document_uploaded",
      actor,
      subject: { type: "document", id: out.document.document_id },
      payload: { doc_name: out.document.doc_name, sha256: out.document.sha256, size_bytes: out.document.size_bytes, storage_key: out.document.storage_key },
    });
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

  r.get("/leases/:id/corrections", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    if (!repo.getLeaseRow(db, id)) throw notFound("Lease");
    res.json({ data: listCorrections(db, id) });
  });

  r.patch("/leases/:id/fields/:field", write, (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    const body = parseOr400(CorrectionBody, req.body, "correction");
    correctLeaseField(db, id, String(req.params.field), body.value, body.reason, req.auth!.user.user_id);
    const c = listCorrections(db, id)[0]!;
    audit(db, {
      event_type: "extraction_correction",
      actor: humanActor(req.auth!.user),
      subject: { type: "lease", id },
      payload: { correction_id: c.correction_id, field: c.field_name, previous_value: c.previous_value_text, previous_status: c.previous_status, new_value: c.new_value_text, new_status: c.new_status, reason: c.reason },
    });
    res.json({ data: leaseDetail(db, id) });
  });

  r.put("/leases/:id/link", write, (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    const body = parseOr400(LinkBody, req.body, "link");
    linkLease(db, id, body.unit_id, body.tenant_id, body.reason ?? "", req.auth!.user.user_id);
    audit(db, { event_type: "lease_linked", actor: humanActor(req.auth!.user), subject: { type: "lease", id }, payload: { unit_id: body.unit_id, tenant_id: body.tenant_id, reason: body.reason ?? null } });
    res.json({ data: leaseDetail(db, id) });
  });

  return r;
}
