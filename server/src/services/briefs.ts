/**
 * Decision Briefs: run an agent workflow, persist the run and the brief, and audit everything.
 * The agent cannot create a brief in an approved state; only decisions.ts changes brief status.
 */
import { ApiError } from "../api/errors.js";
import { config } from "../config.js";
import type { PublicUser } from "../auth/authService.js";
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { LlmUnavailableError } from "../extraction/extractor.js";
import type { Figure, Evidence } from "../agent/evidence.js";
import type { GroundingReport } from "../agent/grounding.js";
import { renderDeep } from "../agent/grounding.js";
import type { AgentLlm } from "../agent/llm.js";
import type { ToolCallLog } from "../agent/runner.js";
import { NotEligibleError, runMaintenanceWorkflow, runRenewalWorkflow, type WorkflowResult } from "../agent/workflows.js";
import { isRenewalCandidate } from "../policy/renewalPolicy.js";
import { agentActor, audit, humanActor, SYSTEM, type Actor } from "./audit.js";
import { closedReason, isRenewalCycleApproved, renewalCycleHasBrief } from "./approvalGuards.js";
import { chargeDiscrepancy } from "../agent/chargeNotice.js";

export type BriefType = "renewal" | "maintenance";
const WORKFLOW = { renewal: "lease_renewal", maintenance: "maintenance_exception" } as const;

export interface BriefRow {
  brief_id: number;
  brief_type: BriefType;
  status: "pending" | "approved" | "rejected" | "revision_requested" | "superseded";
  priority: "high" | "medium" | "low";
  required_approver: "AUTO_APPROVE" | "PROPERTY_MANAGER" | "REGIONAL_DIRECTOR";
  lease_id: number | null;
  ticket_id: number | null;
  tenant_id: string | null;
  unit_id: string | null;
  agent_run_id: number | null;
  title: string;
  content_json: string;
  figures_json: string;
  evidence_json: string;
  policy_json: string | null;
  grounding_json: string;
  needs_review: number;
  model: string | null;
  created_at: string;
  decided_by: number | null;
  decided_at: string | null;
  selected_option: string | null;
  decision_comment: string | null;
  execution_json: string | null;
  supersedes_brief_id: number | null;
  /** Renewal briefs only: the lease end date this brief renews from. */
  renewal_cycle: string | null;
}

export const getBriefRow = (db: DB, id: number) => db.prepare("SELECT * FROM decision_briefs WHERE brief_id = ?").get(id) as unknown as BriefRow | undefined;

/** Parsed brief with the model's templates rendered from stored figures. */
export function briefView(db: DB, b: BriefRow) {
  const figures = JSON.parse(b.figures_json) as Figure[];
  const content = JSON.parse(b.content_json) as Record<string, unknown> | null;
  const tenant = b.tenant_id ? repo.getTenant(db, b.tenant_id) : undefined;
  const unit = b.unit_id ? repo.getUnit(db, b.unit_id) : undefined;
  const decider = b.decided_by ? (db.prepare("SELECT display_name, role FROM users WHERE user_id = ?").get(b.decided_by) as { display_name: string; role: string }) : null;
  const run = b.agent_run_id ? (db.prepare("SELECT * FROM agent_runs WHERE run_id = ?").get(b.agent_run_id) as Record<string, unknown> & { tool_calls_json: string }) : null;
  return {
    brief_id: b.brief_id,
    brief_type: b.brief_type,
    status: b.status,
    priority: b.priority,
    required_approver: b.required_approver,
    lease_id: b.lease_id,
    ticket_id: b.ticket_id,
    tenant: tenant ? { tenant_id: tenant.tenant_id, name: tenant.name, email: tenant.email } : null,
    unit: unit ? { unit_id: unit.unit_id, property_name: unit.property_name, unit_number: unit.unit_number } : null,
    title: b.title,
    /** Model output with {{placeholders}} replaced by stored figures. */
    content: content ? renderDeep(content, figures) : null,
    /** The same output with placeholders kept, so the UI can show which figure each number is. */
    content_template: content,
    figures,
    evidence: JSON.parse(b.evidence_json) as Evidence[],
    policy: b.policy_json ? JSON.parse(b.policy_json) : null,
    /** Set when the proposed tenant charge is above the tenant's share under the lease deductible. */
    charge_notice: b.policy_json ? chargeDiscrepancy(JSON.parse(b.policy_json)) : null,
    grounding: JSON.parse(b.grounding_json) as GroundingReport & { attempts?: unknown },
    needs_review: b.needs_review === 1,
    model: b.model,
    created_at: b.created_at,
    decision: b.decided_at
      ? {
          decided_by: decider ? `${decider.display_name} (${decider.role})` : null,
          decided_at: b.decided_at,
          status: b.status,
          selected_option: b.selected_option,
          comment: b.decision_comment,
          execution: b.execution_json ? JSON.parse(b.execution_json) : null,
        }
      : null,
    agent_run: run ? { ...run, tool_calls: JSON.parse(run.tool_calls_json) as ToolCallLog[], tool_calls_json: undefined } : null,
    supersedes_brief_id: b.supersedes_brief_id,
  };
}

export function listBriefs(db: DB, filter: { status?: string; type?: string } = {}) {
  const rows = db
    .prepare("SELECT * FROM decision_briefs WHERE (? IS NULL OR status = ?) AND (? IS NULL OR brief_type = ?) ORDER BY brief_id DESC")
    .all(filter.status ?? null, filter.status ?? null, filter.type ?? null, filter.type ?? null) as unknown as BriefRow[];
  return rows.map((b) => {
    const v = briefView(db, b);
    return {
      brief_id: v.brief_id, brief_type: v.brief_type, status: v.status, priority: v.priority, required_approver: v.required_approver,
      title: v.title, summary: (v.content?.summary as string | undefined) ?? null, tenant: v.tenant, unit: v.unit,
      lease_id: v.lease_id, ticket_id: v.ticket_id, created_at: v.created_at, grounding_passed: v.grounding.passed, needs_review: v.needs_review,
      decided_at: v.decision?.decided_at ?? null,
    };
  });
}

function pendingBriefFor(db: DB, type: BriefType, subjectId: number): BriefRow | undefined {
  const col = type === "renewal" ? "lease_id" : "ticket_id";
  return db.prepare(`SELECT * FROM decision_briefs WHERE brief_type = ? AND ${col} = ? AND status = 'pending' ORDER BY brief_id DESC LIMIT 1`).get(type, subjectId) as unknown as
    | BriefRow
    | undefined;
}

/** Subjects with a brief being drafted right now (per database), so two runs cannot overlap. */
const generating = new WeakMap<DB, Set<string>>();

/** Actor of briefs generated by the automatic renewal scan. It can draft, never decide. */
export const RENEWAL_SCHEDULER: Actor = { type: "system", id: "renewal-scheduler" };

/**
 * An automatic run may only fill a gap: never a cycle that already has a brief, whether it is pending or
 * a human has decided it (approved, rejected or revision requested).
 */
function automaticBlock(db: DB, leaseId: number, cycle: string | null) {
  return cycle && renewalCycleHasBrief(db, leaseId, cycle)
    ? { code: "CYCLE_HAS_BRIEF", message: `Lease ${leaseId} already has a brief for the term ending ${cycle}.` }
    : null;
}

/**
 * Generate a brief for one lease or ticket. A pending brief for the same subject is superseded.
 * user = null means the automatic renewal scan.
 */
export async function generateBrief(db: DB, llm: AgentLlm, type: BriefType, subjectId: number, user: PublicUser | null) {
  const closed =
    closedReason(db, type, subjectId) ?? (user === null && type === "renewal" ? automaticBlock(db, subjectId, repo.getLeaseRow(db, subjectId)?.end_date ?? null) : null);
  if (closed) throw new ApiError(409, closed.code, closed.message);
  const running = generating.get(db) ?? new Set<string>();
  generating.set(db, running);
  const key = `${type}:${subjectId}`;
  if (running.has(key)) throw new ApiError(409, "GENERATION_IN_PROGRESS", "A brief for this item is already being drafted.");
  running.add(key);
  try {
    return await draftAndStore(db, llm, type, subjectId, user);
  } finally {
    running.delete(key);
  }
}

async function draftAndStore(db: DB, llm: AgentLlm, type: BriefType, subjectId: number, user: PublicUser | null) {
  const requester = user ? humanActor(user) : RENEWAL_SCHEDULER;
  // The cycle is fixed when drafting starts; if the lease's end date changes meanwhile, the draft is discarded.
  const cycle = type === "renewal" ? (repo.getLeaseRow(db, subjectId)?.end_date ?? null) : null;
  const runId = Number(
    db
      .prepare("INSERT INTO agent_runs (workflow, subject_type, subject_id, status, triggered_by) VALUES (?, ?, ?, 'running', ?)")
      .run(WORKFLOW[type], type === "renewal" ? "lease" : "ticket", String(subjectId), user?.user_id ?? null).lastInsertRowid,
  );
  const subject = type === "renewal" ? ({ type: "lease", id: subjectId } as const) : ({ type: "ticket", id: subjectId } as const);
  const agent = agentActor(config.agentModel);
  const ctx = {
    db,
    llm,
    actor: agent,
    // Every tool call is audited as it happens, with its arguments, evidence ids and raw output.
    onToolCall: (c: ToolCallLog) =>
      audit(db, { event_type: "tool_call", actor: agent, subject, payload: { agent_run_id: runId, workflow: WORKFLOW[type], ...c } }),
  };

  let result: WorkflowResult<Record<string, unknown>>;
  try {
    result = (type === "renewal" ? await runRenewalWorkflow(ctx, subjectId) : await runMaintenanceWorkflow(ctx, subjectId)) as unknown as WorkflowResult<Record<string, unknown>>;
  } catch (err) {
    const msg = (err as Error).message;
    db.prepare("UPDATE agent_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE run_id = ?").run(msg, runId);
    audit(db, { event_type: "agent_run", actor: agent, subject, payload: { agent_run_id: runId, workflow: WORKFLOW[type], status: "failed", error: msg, triggered_by: requester.id } });
    if (err instanceof NotEligibleError) throw new ApiError(422, "NOT_ELIGIBLE", msg);
    if (err instanceof LlmUnavailableError) throw new ApiError(503, "LLM_UNAVAILABLE", `${msg} (check GEMINI_API_KEY / AGENT_MODEL in .env, or your free-tier quota)`);
    throw err;
  }

  const toolSummary = result.toolCalls.map((c) => ({ seq: c.seq, name: c.name, args: c.args, by: c.by, ok: c.ok, evidence_ids: c.evidence_ids }));
  if (!result.draft) {
    const msg = `The model did not produce a valid brief: ${result.attempts.map((a) => a.error).filter(Boolean).join(" | ")}`;
    db.prepare("UPDATE agent_runs SET status = 'failed', model = ?, tool_calls_json = ?, error = ?, finished_at = datetime('now') WHERE run_id = ?").run(
      result.model, JSON.stringify(result.toolCalls), msg.slice(0, 4000), runId,
    );
    audit(db, { event_type: "agent_run", actor: agentActor(result.model), subject, payload: { agent_run_id: runId, workflow: WORKFLOW[type], status: "failed", tools_called: toolSummary, attempts: result.attempts } });
    throw new ApiError(502, "AGENT_OUTPUT_INVALID", msg.slice(0, 1000));
  }

  const grounding = { ...result.grounding!, attempts: result.attempts };
  const saved = tx(db, (): number | { code: string; message: string } => {
    // Checked again at save time: a decision may have been made while the model was drafting.
    const cycleChanged = type === "renewal" && (repo.getLeaseRow(db, subjectId)?.end_date ?? null) !== cycle;
    const blocked =
      closedReason(db, type, subjectId) ??
      (user === null && type === "renewal" ? automaticBlock(db, subjectId, cycle) : null) ??
      (cycleChanged ? { code: "STALE_BRIEF", message: "The lease end date changed while the brief was being drafted; generate it again." } : null);
    if (blocked) {
      db.prepare("UPDATE agent_runs SET status = 'failed', model = ?, tool_calls_json = ?, error = ?, finished_at = datetime('now') WHERE run_id = ?").run(
        result.model, JSON.stringify(result.toolCalls), blocked.message, runId,
      );
      audit(db, { event_type: "agent_run", actor: agentActor(result.model), subject, payload: { agent_run_id: runId, workflow: WORKFLOW[type], status: "discarded", reason: blocked.code, tools_called: toolSummary } });
      return blocked;
    }
    const prior = pendingBriefFor(db, type, subjectId);
    if (prior) {
      db.prepare("UPDATE decision_briefs SET status = 'superseded' WHERE brief_id = ?").run(prior.brief_id);
      audit(db, { event_type: "brief_superseded", actor: requester, subject: { type: "brief", id: prior.brief_id }, brief_id: prior.brief_id, payload: { superseded_by_run: runId } });
    }
    const id = Number(
      db
        .prepare(
          `INSERT INTO decision_briefs (brief_type, status, priority, required_approver, lease_id, ticket_id, tenant_id, unit_id, agent_run_id, title,
             content_json, figures_json, evidence_json, policy_json, grounding_json, needs_review, model, supersedes_brief_id, renewal_cycle)
           VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          type, result.priority, result.required_approver, result.lease_id, result.ticket_id, result.tenant_id, result.unit_id, runId,
          String(result.draft!.title), JSON.stringify(result.draft), JSON.stringify(result.figures), JSON.stringify(result.evidence),
          result.policy ? JSON.stringify(result.policy) : null, JSON.stringify(grounding), result.needs_review ? 1 : 0, result.model, prior?.brief_id ?? null, cycle,
        ).lastInsertRowid,
    );
    db.prepare("UPDATE agent_runs SET status = 'completed', model = ?, tool_calls_json = ?, brief_id = ?, finished_at = datetime('now') WHERE run_id = ?").run(
      result.model, JSON.stringify(result.toolCalls), id, runId,
    );
    audit(db, {
      event_type: "agent_run",
      actor: agentActor(result.model),
      subject,
      brief_id: id,
      payload: {
        agent_run_id: runId,
        workflow: WORKFLOW[type],
        status: "completed",
        triggered_by: requester.id,
        tools_called: toolSummary,
        evidence_ids: result.evidence.map((e) => e.id),
        draft_attempts: result.attempts,
      },
    });
    audit(db, {
      event_type: "brief_created",
      actor: agentActor(result.model),
      subject: { type: "brief", id },
      brief_id: id,
      payload: {
        brief_type: type,
        lease_id: result.lease_id,
        ticket_id: result.ticket_id,
        priority: result.priority,
        required_approver: result.required_approver,
        needs_review: result.needs_review,
        grounding_passed: grounding.passed,
        ungrounded_figures: grounding.ungrounded_figures,
        figures: result.figures.map((f) => ({ key: f.key, value: f.value })),
      },
    });
    return id;
  });
  if (typeof saved !== "number") throw new ApiError(409, saved.code, saved.message);
  return briefView(db, getBriefRow(db, saved)!);
}

/** On startup: a run still "running" was interrupted by a restart. Close it, and record that in the audit trail. */
export function recoverInterruptedAgentRuns(db: DB): number {
  return tx(db, () => {
    const stuck = db.prepare("SELECT run_id, workflow, subject_type, subject_id FROM agent_runs WHERE status = 'running' ORDER BY run_id").all() as {
      run_id: number;
      workflow: string;
      subject_type: "lease" | "ticket";
      subject_id: string;
    }[];
    for (const r of stuck) {
      const error = "Interrupted by a server restart; generate the brief again.";
      db.prepare("UPDATE agent_runs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE run_id = ?").run(error, r.run_id);
      audit(db, { event_type: "agent_run", actor: SYSTEM, subject: { type: r.subject_type, id: r.subject_id }, payload: { agent_run_id: r.run_id, workflow: r.workflow, status: "failed", error } });
    }
    return stuck.length;
  });
}

// --- candidates and batch runs ----------------------------------------------------------------------

export function renewalCandidates(db: DB) {
  return repo
    .listLeases(db)
    .map((l) => ({ lease: l, s: repo.leaseSummary(db, l) }))
    .filter(({ s }) => s.lease_state === "active" && isRenewalCandidate(s.days_until_end, s.notice_period_days))
    // Once this cycle's renewal is approved there is nothing left to decide.
    .filter(({ lease }) => !(lease.end_date && isRenewalCycleApproved(db, lease.lease_id, lease.end_date)))
    .map(({ lease, s }) => ({
      lease_id: lease.lease_id,
      tenant_id: lease.tenant_id,
      tenant_name: lease.tenant_id ? repo.getTenant(db, lease.tenant_id)?.name ?? null : null,
      unit_id: lease.unit_id,
      end_date: lease.end_date,
      days_until_end: s.days_until_end,
      notice_period_days: lease.notice_period_days,
      pending_brief_id: pendingBriefFor(db, "renewal", lease.lease_id)?.brief_id ?? null,
    }));
}

export function maintenanceCandidates(db: DB) {
  return (db.prepare("SELECT ticket_id, issue_summary, unit_id FROM maintenance_tickets WHERE status = 'flagged' ORDER BY ticket_id").all() as {
    ticket_id: number;
    issue_summary: string;
    unit_id: string;
  }[]).map((t) => ({ ...t, pending_brief_id: pendingBriefFor(db, "maintenance", t.ticket_id)?.brief_id ?? null }));
}

/** Run a workflow for every candidate that has no pending brief yet. Failures are reported per item. */
export async function runBatch(db: DB, llm: AgentLlm, type: BriefType, user: PublicUser) {
  const items = type === "renewal" ? renewalCandidates(db).map((c) => ({ id: c.lease_id, pending: c.pending_brief_id })) : maintenanceCandidates(db).map((c) => ({ id: c.ticket_id, pending: c.pending_brief_id }));
  const results: { subject_id: number; brief_id?: number; skipped?: string; error?: string }[] = [];
  for (const it of items) {
    if (it.pending) {
      results.push({ subject_id: it.id, skipped: `pending brief #${it.pending} exists` });
      continue;
    }
    try {
      results.push({ subject_id: it.id, brief_id: (await generateBrief(db, llm, type, it.id, user)).brief_id });
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) throw err; // model unavailable: stop the batch
      results.push({ subject_id: it.id, error: (err as Error).message });
    }
  }
  return results;
}
