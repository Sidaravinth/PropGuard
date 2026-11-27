import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import type { LlmCall } from "../extraction/extractor.js";
import { ingestLeaseDocument } from "../extraction/ingest.js";
import { ClauseType } from "../extraction/leaseSchema.js";
import { runTicketPolicyCheck } from "../services/policyService.js";
import { ApiError, notFound, parseOr400 } from "./errors.js";

const IntId = z.coerce.number().int().positive();
/** Money in the API is integer cents (no floats). */
const Cents = z.number().int().nonnegative().max(100_000_000);

const NewTicketBody = z
  .object({
    unit_id: z.string().min(1),
    tenant_id: z.string().min(1).nullable().optional(),
    issue_summary: z.string().trim().min(3).max(2000),
    work_order_amount_cents: Cents,
    technician_quote_amount_cents: Cents,
    proposed_tenant_charge_cents: Cents.nullable().optional(),
  })
  .strict();

export function createRouter(db: DB, deps: { llm: () => LlmCall }): Router {
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  r.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // --- units ---------------------------------------------------------------
  r.get("/units", (_req, res) => {
    res.json({ data: repo.listUnits(db) });
  });
  r.get("/units/:id", (req, res) => {
    const unit = repo.getUnit(db, req.params.id);
    if (!unit) throw notFound(`Unit ${req.params.id}`);
    res.json({ data: unit });
  });

  // --- tenants -------------------------------------------------------------
  r.get("/tenants", (req, res) => {
    const { status } = parseOr400(z.object({ status: z.string().optional() }), req.query, "query");
    res.json({ data: repo.listTenants(db, status) });
  });
  r.get("/tenants/:id", (req, res) => {
    const tenant = repo.getTenant(db, req.params.id);
    if (!tenant) throw notFound(`Tenant ${req.params.id}`);
    res.json({ data: { ...tenant, unpaid_balance_cents: repo.unpaidBalanceCents(db, tenant.tenant_id) } });
  });
  r.get("/tenants/:id/ledger", (req, res) => {
    const tenant = repo.getTenant(db, req.params.id);
    if (!tenant) throw notFound(`Tenant ${req.params.id}`);
    res.json({ data: repo.getLedger(db, tenant.tenant_id), unpaid_balance_cents: repo.unpaidBalanceCents(db, tenant.tenant_id) });
  });

  // --- leases --------------------------------------------------------------
  r.get("/leases", (_req, res) => {
    res.json({ data: repo.listLeases(db).map((l) => repo.leaseSummary(db, l)) });
  });

  r.post("/leases/ingest", upload.single("file"), async (req, res) => {
    if (!req.file) throw new ApiError(400, "FILE_REQUIRED", 'Upload the lease as multipart/form-data field "file" (.pdf or .txt)');
    const docName = req.file.originalname.replace(/[^\w.\- ]+/g, "_");
    const result = await ingestLeaseDocument(db, { docName, bytes: req.file.buffer }, deps.llm());
    const lease = repo.getLeaseRow(db, result.lease_id)!;
    res.status(201).json({
      data: {
        ingest: result,
        lease: repo.leaseSummary(db, lease),
        fields: repo.getFieldSources(db, result.lease_id),
        clauses: repo.getClauses(db, result.lease_id),
      },
    });
  });

  r.get("/leases/:id", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    const lease = repo.getLeaseRow(db, id);
    if (!lease) throw notFound(`Lease ${id}`);
    res.json({
      data: {
        ...repo.leaseSummary(db, lease),
        fields: repo.getFieldSources(db, id),
        clauses: repo.getClauses(db, id),
      },
    });
  });

  r.get("/leases/:id/clauses", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "lease id");
    const { type } = parseOr400(z.object({ type: ClauseType.optional() }), req.query, "query");
    const lease = repo.getLeaseRow(db, id);
    if (!lease) throw notFound(`Lease ${id}`);
    res.json({
      data: repo.getClauses(db, id, type).map((c) => ({ ...c, verified: c.verified === 1, source_doc_name: lease.source_doc_name })),
    });
  });

  // --- maintenance tickets ---------------------------------------------------
  r.get("/tickets", (req, res) => {
    const q = parseOr400(z.object({ status: z.string().optional(), unit_id: z.string().optional() }), req.query, "query");
    res.json({ data: repo.listTickets(db, q) });
  });

  r.get("/tickets/:id", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "ticket id");
    const ticket = repo.getTicket(db, id);
    if (!ticket) throw notFound(`Ticket ${id}`);
    const latest = repo.listPolicyEvaluations(db, id)[0] ?? null;
    res.json({ data: { ...ticket, latest_policy_evaluation: latest } });
  });

  r.post("/tickets", (req, res) => {
    const body = parseOr400(NewTicketBody, req.body, "ticket");
    const unit = repo.getUnit(db, body.unit_id);
    if (!unit) throw new ApiError(422, "UNKNOWN_UNIT", `Unit ${body.unit_id} does not exist`);
    if (body.tenant_id) {
      const tenant = repo.getTenant(db, body.tenant_id);
      if (!tenant) throw new ApiError(422, "UNKNOWN_TENANT", `Tenant ${body.tenant_id} does not exist`);
      if (tenant.unit_id !== body.unit_id) throw new ApiError(422, "TENANT_UNIT_MISMATCH", `Tenant ${body.tenant_id} is not assigned to unit ${body.unit_id}`);
    }
    const ticketId = repo.insertTicket(db, {
      unit_id: body.unit_id,
      tenant_id: body.tenant_id ?? null,
      issue_summary: body.issue_summary,
      work_order_amount_cents: body.work_order_amount_cents,
      technician_quote_amount_cents: body.technician_quote_amount_cents,
      proposed_tenant_charge_cents: body.proposed_tenant_charge_cents ?? null,
    });
    // UC3: every new ticket is immediately checked by the deterministic engine.
    const evaluation = runTicketPolicyCheck(db, ticketId);
    res.status(201).json({ data: { ticket: repo.getTicket(db, ticketId), policy: evaluation } });
  });

  r.post("/tickets/:id/policy-check", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "ticket id");
    if (!repo.getTicket(db, id)) throw notFound(`Ticket ${id}`);
    res.json({ data: runTicketPolicyCheck(db, id) });
  });

  r.get("/tickets/:id/policy-evaluations", (req, res) => {
    const id = parseOr400(IntId, req.params.id, "ticket id");
    if (!repo.getTicket(db, id)) throw notFound(`Ticket ${id}`);
    res.json({ data: repo.listPolicyEvaluations(db, id) });
  });

  return r;
}
