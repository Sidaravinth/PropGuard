/** Day 2 Group B: properties, units, tenants, payment ledger, spreadsheet imports, dashboard. */
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requirePermission } from "../auth/middleware.js";
import type { DB } from "../db/connection.js";
import { dashboard } from "../services/dashboard.js";
import { commitImport, previewImport, type ImportKind, type Mapping } from "../services/imports.js";
import { addLedgerEntry, listLedger, ledgerSummary, updateLedgerEntry } from "../services/ledger.js";
import * as records from "../services/records.js";
import type { DocumentStore } from "../storage/documentStore.js";
import { ApiError, notFound, parseOr400 } from "./errors.js";

const IntId = z.coerce.number().int().positive();
const Cents = z.number().int().nonnegative().max(100_000_000);
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");
const Email = z.string().trim().email().max(254);
const Phone = z.string().trim().max(40);
const TenantStatus = z.enum(records.TENANT_STATUSES);

const PropertyBody = z.object({ name: z.string().trim().min(1).max(120), address: z.string().trim().max(300).nullable().optional() }).strict();
const PropertyPatch = PropertyBody.partial().strict();
const UnitBody = z
  .object({
    property_id: z.number().int().positive().optional(),
    property_name: z.string().trim().min(1).max(120).optional(),
    unit_number: z.string().trim().min(1).max(20),
    base_rent_cents: Cents,
  })
  .strict();
const UnitPatch = z.object({ property_id: z.number().int().positive(), unit_number: z.string().trim().min(1).max(20), base_rent_cents: Cents }).partial().strict();
const TenantBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: Email.nullable().optional(),
    phone: Phone.nullable().optional(),
    unit_id: z.string().min(1).nullable().optional(),
    status: TenantStatus.optional(),
  })
  .strict();
const TenantPatch = TenantBody.partial().strict();
const LedgerBody = z
  .object({ tenant_id: z.string().min(1), month: Month, amount_due_cents: Cents, amount_paid_cents: Cents, status: z.string().max(20).nullable().optional() })
  .strict();
const LedgerPatch = z.object({ amount_due_cents: Cents, amount_paid_cents: Cents, status: z.string().max(20).nullable() }).partial().strict();
const ImportKindParam = z.enum(["tenants", "ledger"]);
const MappingJson = z.record(z.string(), z.number().int().nonnegative().nullable());

export function createRecordsRouter(db: DB, deps: { store: () => DocumentStore }): Router {
  const r = Router();
  const write = requirePermission("records.write");
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  r.use(requirePermission("records.read"));

  // --- dashboard -------------------------------------------------------------------------
  r.get("/dashboard", (_req, res) => {
    res.json({ data: dashboard(db) });
  });

  // --- properties ------------------------------------------------------------------------
  r.get("/properties", (_req, res) => {
    res.json({ data: records.listProperties(db) });
  });
  r.get("/properties/:id", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "property id");
    const p = records.listProperties(db).find((x) => x.property_id === id);
    if (!p) throw notFound(`Property ${id}`);
    res.json({ data: { ...p, units: records.listUnitsDetailed(db, { property_id: id }) } });
  });
  r.post("/properties", write, (req, res) => {
    res.status(201).json({ data: records.createProperty(db, parseOr400(PropertyBody, req.body, "property")) });
  });
  r.patch("/properties/:id", write, (req, res) => {
    res.json({ data: records.updateProperty(db, parseOr400(IntId, req.params.id, "property id"), parseOr400(PropertyPatch, req.body, "property")) });
  });

  // --- units ------------------------------------------------------------------------------
  r.post("/units", write, (req, res) => {
    res.status(201).json({ data: records.createUnit(db, parseOr400(UnitBody, req.body, "unit")) });
  });
  r.patch("/units/:id", write, (req, res) => {
    res.json({ data: records.updateUnit(db, req.params.id as string, parseOr400(UnitPatch, req.body, "unit")) });
  });

  // --- tenants ----------------------------------------------------------------------------
  r.post("/tenants", write, (req, res) => {
    res.status(201).json({ data: records.createTenant(db, parseOr400(TenantBody, req.body, "tenant")) });
  });
  r.patch("/tenants/:id", write, (req, res) => {
    res.json({ data: records.updateTenant(db, req.params.id as string, parseOr400(TenantPatch, req.body, "tenant")) });
  });

  // --- payment ledger ---------------------------------------------------------------------
  r.get("/ledger", (req, res) => {
    const q = parseOr400(
      z.object({ tenant_id: z.string().optional(), filter: z.enum(["all", "overdue", "outstanding", "settled"]).optional() }),
      req.query,
      "query",
    );
    res.json({ data: listLedger(db, q) });
  });
  r.get("/ledger/summary", (_req, res) => {
    res.json({ data: ledgerSummary(db) });
  });
  r.post("/ledger", write, (req, res) => {
    res.status(201).json({ data: addLedgerEntry(db, parseOr400(LedgerBody, req.body, "ledger entry")) });
  });
  r.patch("/ledger/:id", write, (req, res) => {
    res.json({ data: updateLedgerEntry(db, parseOr400(IntId, req.params.id, "entry id"), parseOr400(LedgerPatch, req.body, "ledger entry")) });
  });

  // --- spreadsheet imports (multipart: file, optional mapping JSON) --------------------------------
  const readImport = (req: { params: Record<string, string>; file?: Express.Multer.File; body?: Record<string, unknown> }) => {
    const kind: ImportKind = parseOr400(ImportKindParam, req.params.kind, "import kind");
    if (!req.file) throw new ApiError(400, "FILE_REQUIRED", 'Upload the spreadsheet as multipart/form-data field "file" (.csv or .xlsx)');
    let mapping: Mapping | undefined;
    if (typeof req.body?.mapping === "string" && req.body.mapping) {
      let raw: unknown;
      try {
        raw = JSON.parse(req.body.mapping);
      } catch {
        throw new ApiError(400, "VALIDATION_ERROR", "mapping must be JSON");
      }
      mapping = parseOr400(MappingJson, raw, "mapping");
    }
    const name = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    return { kind, file: { name, bytes: req.file.buffer }, mapping };
  };

  r.post("/imports/:kind/preview", write, upload.single("file"), async (req, res) => {
    const { kind, file, mapping } = readImport(req as never);
    res.json({ data: await previewImport(db, kind, file, mapping) });
  });

  r.post("/imports/:kind/commit", write, upload.single("file"), async (req, res) => {
    const { kind, file, mapping } = readImport(req as never);
    if (!mapping) throw new ApiError(400, "MAPPING_REQUIRED", "Send the confirmed column mapping with the commit");
    res.status(201).json({ data: await commitImport(db, deps.store(), kind, file, mapping, req.auth!.user.user_id) });
  });

  return r;
}
