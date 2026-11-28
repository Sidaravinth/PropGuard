/**
 * Agent runner. Two phases:
 *  1. Retrieval: the model calls the read-only tools (function calling). Calls the workflow requires
 *     but the model skipped are executed by the orchestrator, so evidence is always complete.
 *  2. Drafting: the model writes the brief as JSON (schema-constrained) from the tool outputs and a
 *     table of deterministic figures. Output is Zod-validated and grounding-checked; on failure the
 *     model sees the exact errors and retries.
 * The runner never writes operational data and has no access to approval functions.
 */
import type { z } from "zod";
import type { DB } from "../db/connection.js";
import { LlmUnavailableError } from "../extraction/extractor.js";
import type { Actor } from "../services/audit.js";
import { EvidenceRegistry, type Evidence, type Figure } from "./evidence.js";
import { checkGrounding, describeGroundingFailure, type GroundingReport, type Identifiers } from "./grounding.js";
import type { AgentHistoryItem, AgentLlm } from "./llm.js";
import { executeTool, TOOL_SPECS, ToolError, type ToolResult } from "./tools.js";

export interface ToolCallLog {
  seq: number;
  name: string;
  args: Record<string, unknown>;
  by: "model" | "orchestrator";
  ok: boolean;
  error: string | null;
  evidence_ids: string[];
  output: Record<string, unknown> | null;
}

export interface WorkflowContext {
  db: DB;
  llm: AgentLlm;
  actor: Actor;
  onToolCall?: (call: ToolCallLog) => void;
}

export interface RunOutcome<T> {
  draft: T | null;
  grounding: GroundingReport | null;
  toolCalls: ToolCallLog[];
  evidence: Evidence[];
  model: string;
  attempts: { attempt: number; error: string | null }[];
}

const MAX_TOOL_TURNS = 6;
const MAX_DRAFT_ATTEMPTS = 3;

export const STATIC_EVIDENCE: Evidence[] = [
  { id: "policy:engine", kind: "policy_rule", label: "Deterministic policy engine (approval tiers, 3-way check, deposit cap)", record: { table: "code", id: "policy/policyEngine.ts" } },
  { id: "policy:renewal", kind: "policy_rule", label: "Deterministic renewal rules (pricing, dates, reliability)", record: { table: "code", id: "policy/renewalPolicy.ts" } },
];

export class ToolSession {
  readonly calls: ToolCallLog[] = [];
  readonly registry = new EvidenceRegistry();
  readonly outputs = new Map<string, ToolResult>();
  constructor(private readonly ctx: WorkflowContext) {
    this.registry.add(...STATIC_EVIDENCE);
  }
  private keyOf(name: string, args: Record<string, unknown>) {
    return `${name}:${JSON.stringify(Object.entries(args).sort())}`;
  }
  has(name: string, args: Record<string, unknown>) {
    return this.outputs.has(this.keyOf(name, args));
  }
  get(name: string, args: Record<string, unknown>) {
    return this.outputs.get(this.keyOf(name, args));
  }
  call(name: string, args: Record<string, unknown>, by: ToolCallLog["by"]): { output: unknown; ok: boolean } {
    const log: ToolCallLog = { seq: this.calls.length + 1, name, args, by, ok: true, error: null, evidence_ids: [], output: null };
    let output: unknown;
    try {
      const r = executeTool(this.ctx.db, name, args, this.ctx.actor);
      this.registry.add(...r.evidence);
      this.outputs.set(this.keyOf(name, args), r);
      log.evidence_ids = r.evidence.map((e) => e.id);
      log.output = r.output;
      output = r.output;
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      log.ok = false;
      log.error = err.message;
      output = { error: err.message };
    }
    this.calls.push(log);
    this.ctx.onToolCall?.(log);
    return { output, ok: log.ok };
  }
}

async function turn(llm: AgentLlm, req: Parameters<AgentLlm>[0]) {
  try {
    return await llm(req);
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw err;
    throw new LlmUnavailableError(`Agent model call failed: ${(err as Error).message}`, { cause: err });
  }
}

/** Phase 1: let the model gather evidence with tools; then guarantee the required calls happened. */
export async function retrieve(ctx: WorkflowContext, session: ToolSession, system: string, task: string, required: () => { name: string; args: Record<string, unknown> }[]): Promise<string> {
  const history: AgentHistoryItem[] = [{ role: "user", text: task }];
  let model = "";
  for (let i = 0; i < MAX_TOOL_TURNS; i++) {
    const t = await turn(ctx.llm, { system, history, tools: TOOL_SPECS });
    model = t.model;
    if (!t.toolCalls.length) break;
    history.push({ role: "model", text: t.text, toolCalls: t.toolCalls, raw: t.raw });
    history.push({ role: "tool", results: t.toolCalls.map((c) => ({ id: c.id, name: c.name, output: session.call(c.name, c.args, "model").output })) });
  }
  // `required` is evaluated after the model's calls, so it can depend on what was retrieved.
  for (const r of required()) if (!session.has(r.name, r.args)) session.call(r.name, r.args, "orchestrator");
  return model;
}

/** Phase 2: draft the brief as schema-valid, fully grounded JSON. */
export async function draft<T>(
  ctx: WorkflowContext,
  session: ToolSession,
  opts: { system: string; prompt: string; schema: z.ZodType<T>; jsonSchema: Record<string, unknown>; figures: Figure[]; identifiers?: Identifiers; extraCheck?: (d: T) => string[] },
): Promise<{ draft: T | null; grounding: GroundingReport | null; model: string; attempts: { attempt: number; error: string | null }[] }> {
  const history: AgentHistoryItem[] = [{ role: "user", text: opts.prompt }];
  const attempts: { attempt: number; error: string | null }[] = [];
  let model = "";
  let lastGrounding: GroundingReport | null = null;
  let lastValid: T | null = null;
  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
    const t = await turn(ctx.llm, { system: opts.system, history, jsonSchema: opts.jsonSchema });
    model = t.model;
    let error: string | null = null;
    let parsed: T | null = null;
    if (t.stopReason === "refusal") error = "The model declined the request.";
    else if (t.stopReason === "max_tokens") error = "Output was truncated; be more concise.";
    else {
      try {
        const r = opts.schema.safeParse(JSON.parse(t.text));
        if (r.success) parsed = r.data;
        else error = `Schema validation failed:\n${r.error.issues.slice(0, 12).map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}`;
      } catch (e) {
        error = `Output is not valid JSON: ${(e as Error).message}`;
      }
    }
    if (parsed) {
      lastValid = parsed;
      lastGrounding = checkGrounding(parsed, opts.figures, (id) => session.registry.has(id), opts.identifiers);
      const extra = opts.extraCheck?.(parsed) ?? [];
      if (!lastGrounding.passed || extra.length) error = [describeGroundingFailure(lastGrounding), ...extra.map((x) => `- ${x}`)].filter(Boolean).join("\n");
    }
    attempts.push({ attempt, error });
    if (!error) return { draft: parsed, grounding: lastGrounding, model, attempts };
    history.push({ role: "model", text: t.text, toolCalls: [] });
    history.push({ role: "user", text: `Your output has problems. Fix all of them and return the complete JSON again:\n${error}` });
  }
  // Out of attempts: return the last structurally valid draft (if any) with its failing grounding report.
  return { draft: lastValid, grounding: lastGrounding, model, attempts };
}

export function figuresTable(figures: Figure[]): string {
  return figures.map((f) => `{{${f.key}}} = ${f.display}  (${f.label}; evidence: ${f.evidence_ids.join(", ")})`).join("\n");
}
