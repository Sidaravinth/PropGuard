/** Day 2: AI agent runs, Decision Inbox, human decisions, audit trail (read-only). */
import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../auth/middleware.js";
import type { DB } from "../db/connection.js";
import type { AgentLlm } from "../agent/llm.js";
import { listAudit, verifyAuditChain } from "../services/audit.js";
import { briefView, generateBrief, getBriefRow, listBriefs, maintenanceCandidates, renewalCandidates, runBatch } from "../services/briefs.js";
import { decideBrief, decideTicket } from "../services/decisions.js";
import { collectReservation, releaseReservation } from "../services/deposits.js";
import { notFound, parseOr400 } from "./errors.js";

const IntId = z.coerce.number().int().positive();
const DecisionBody = z
  .object({
    decision: z.enum(["approve", "reject", "request_revision"]),
    option_key: z.string().max(40).nullable().optional(),
    comment: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const TicketDecisionBody = z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().trim().max(2000).nullable().optional() }).strict();
const ReleaseBody = z.object({ reason: z.string().trim().min(3, "Give a short reason (at least 3 characters)").max(500) }).strict();

export function createBriefRouter(db: DB, deps: { agentLlm: () => AgentLlm }): Router {
  const r = Router();
  r.use(requirePermission("records.read"));
  const generate = requirePermission("briefs.generate");
  /** The one shape of a single brief. The page re-renders from whichever of these responses it last got. */
  const briefDetail = (id: number) => ({ ...briefView(db, getBriefRow(db, id)!), audit: listAudit(db, { brief_id: id, limit: 200 }).rows });

  // --- agent ---------------------------------------------------------------------------
  r.get("/agent/candidates", (_req, res) => {
    res.json({ data: { renewals: renewalCandidates(db), maintenance: maintenanceCandidates(db) } });
  });
  r.post("/agent/renewals/run", generate, async (req, res) => {
    res.json({ data: await runBatch(db, deps.agentLlm(), "renewal", req.auth!.user) });
  });
  r.post("/agent/maintenance/run", generate, async (req, res) => {
    res.json({ data: await runBatch(db, deps.agentLlm(), "maintenance", req.auth!.user) });
  });
  r.post("/agent/renewals/:leaseId", generate, async (req, res) => {
    const b = await generateBrief(db, deps.agentLlm(), "renewal", parseOr400(IntId, req.params.leaseId, "lease id"), req.auth!.user);
    res.status(201).json({ data: briefDetail(b.brief_id) });
  });
  r.post("/agent/maintenance/:ticketId", generate, async (req, res) => {
    const b = await generateBrief(db, deps.agentLlm(), "maintenance", parseOr400(IntId, req.params.ticketId, "ticket id"), req.auth!.user);
    res.status(201).json({ data: briefDetail(b.brief_id) });
  });

  // --- Decision Inbox --------------------------------------------------------------------
  r.get("/briefs", (req, res) => {
    const q = parseOr400(
      z.object({ status: z.enum(["pending", "approved", "rejected", "revision_requested", "superseded"]).optional(), type: z.enum(["renewal", "maintenance"]).optional() }),
      req.query,
      "query",
    );
    res.json({ data: listBriefs(db, q) });
  });
  r.get("/briefs/:id", (req, res) => {
    const b = getBriefRow(db, parseOr400(IntId, req.params.id, "brief id"));
    if (!b) throw notFound("Brief");
    res.json({ data: briefDetail(b.brief_id) });
  });
  /** The only endpoint that finalises a brief. Role and policy are re-checked on the server. */
  r.post("/briefs/:id/decision", (req, res) => {
    const body = parseOr400(DecisionBody, req.body, "decision");
    const b = decideBrief(db, parseOr400(IntId, req.params.id, "brief id"), req.auth!.user, body);
    res.json({ data: briefDetail(b.brief_id) });
  });

  /** Tickets over the auto-approval limit with no exceptions; the role is checked against the engine's tier. */
  r.post("/tickets/:id/decision", (req, res) => {
    const body = parseOr400(TicketDecisionBody, req.body, "ticket decision");
    res.json({ data: decideTicket(db, parseOr400(IntId, req.params.id, "ticket id"), req.auth!.user, body) });
  });

  // --- approved tenant charges: human-only; the role is checked against the ticket's approval tier -----
  r.post("/deposit-reservations/:id/collect", (req, res) => {
    parseOr400(z.object({}).strict(), req.body ?? {}, "collection");
    res.json({ data: collectReservation(db, parseOr400(IntId, req.params.id, "reservation id"), req.auth!.user) });
  });
  r.post("/deposit-reservations/:id/release", (req, res) => {
    const { reason } = parseOr400(ReleaseBody, req.body, "release");
    res.json({ data: releaseReservation(db, parseOr400(IntId, req.params.id, "reservation id"), req.auth!.user, reason) });
  });

  // --- audit trail (read-only: there is no endpoint to edit or delete entries) -----------------------
  r.get("/audit", (req, res) => {
    const q = parseOr400(
      z.object({
        event_type: z.string().max(60).optional(),
        actor_type: z.enum(["agent", "system", "human"]).optional(),
        actor: z.string().max(120).optional(),
        subject_type: z.string().max(20).optional(),
        subject_id: z.string().max(40).optional(),
        brief_id: z.coerce.number().int().positive().optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
      req.query,
      "query",
    );
    res.json({ data: listAudit(db, q) });
  });
  r.get("/audit/verify", (_req, res) => {
    res.json({ data: verifyAuditChain(db) });
  });

  return r;
}
