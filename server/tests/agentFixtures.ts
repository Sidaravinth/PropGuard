/**
 * Scripted stand-in for the agent model, used ONLY in unit tests so the deterministic code around the
 * model (tool execution, orchestration, grounding, persistence, approvals) can be tested offline.
 * Production always calls the real model (createGeminiAgentLlm).
 */
import type { AgentLlm, AgentTurnRequest, ToolCallRequest } from "../src/agent/llm.js";

export interface AgentScript {
  /** Tool calls the "model" makes on its first retrieval turn (then it stops calling tools). */
  toolCalls?: ToolCallRequest[];
  /** Successive drafts returned for JSON drafting turns (the last one repeats). */
  drafts: (object | string)[];
}

export function scriptedAgent(script: AgentScript): AgentLlm & { requests: AgentTurnRequest[] } {
  let retrievalTurns = 0;
  let draftTurns = 0;
  const fn = (async (req) => {
    fn.requests.push(req);
    if (req.tools) {
      const calls = retrievalTurns++ === 0 ? (script.toolCalls ?? []) : [];
      return { text: "", toolCalls: calls, stopReason: "end_turn", model: "test-agent" };
    }
    const d = script.drafts[Math.min(draftTurns++, script.drafts.length - 1)]!;
    return { text: typeof d === "string" ? d : JSON.stringify(d), toolCalls: [], stopReason: "end_turn", model: "test-agent" };
  }) as AgentLlm & { requests: AgentTurnRequest[] };
  fn.requests = [];
  return fn;
}

export function renewalDraft(leaseId: number, overrides: Record<string, unknown> = {}) {
  const ev = (f: string) => `lease:${leaseId}:field:${f}`;
  return {
    title: "Renewal decision: Priya Sharma, Maple Court Apartments 101",
    summary: "The lease ends on {{lease_end}}, in {{days_until_end}}. Notice must be given by {{notice_deadline}} ({{notice_period_days}} before the end).",
    payment_summary: "{{paid_on_time_months}} of {{months_on_record}} months paid on time; unpaid balance {{unpaid_balance}}.",
    recommendation: {
      option_key: "twelve_month_3pct",
      rationale: "A reliable payer: a 12-month term at {{twelve_month_rent}} ({{adjustment_percent}} adjustment) secures occupancy.",
      evidence_ids: ["ledger:tenant:T001", ev("monthly_rent")],
    },
    options: [
      { key: "standard", explanation: "Same term ({{standard_term_months}}) at the current rent of {{standard_rent}}.", risks: ["No rent growth."], evidence_ids: [ev("monthly_rent")],
        email: { subject: "Your standard lease renewal", body: "Dear Priya, your lease ends on {{lease_end}}. We offer a renewal for {{standard_term_months}} at {{standard_rent}} per month." } },
      { key: "twelve_month_3pct", explanation: "12-month term from {{twelve_month_start}} to {{twelve_month_end}} at {{twelve_month_rent}}, {{twelve_month_rent_change}} more per month.", risks: ["Tenant may push back on the increase."], evidence_ids: [ev("monthly_rent"), "policy:renewal"],
        email: { subject: "Your 12-month lease renewal", body: "Dear Priya, your lease ends on {{lease_end}}. We offer a 12-month renewal at {{twelve_month_rent}} per month from {{twelve_month_start}}." } },
      { key: "month_to_month", explanation: "Rolling monthly at {{month_to_month_rent}} from {{month_to_month_start}}.", risks: ["Vacancy risk at short notice."], evidence_ids: [ev("notice_period_days")],
        email: { subject: "Your month-to-month renewal", body: "Dear Priya, your lease ends on {{lease_end}}. We offer to continue month-to-month at {{month_to_month_rent}} from {{month_to_month_start}}." } },
    ],
    risk_notes: [{ text: "Send the notice before {{notice_deadline}}.", evidence_ids: [ev("notice_period_days"), ev("end_date")] }],
    ...overrides,
  };
}

export function maintenanceDraft(ticketId: number, codes: string[], overrides: Record<string, unknown> = {}) {
  return {
    title: "Quote exceeds work order on ticket",
    summary: "The technician quoted {{technician_quote}} against a work order of {{work_order}} ({{quote_variance_percent}} over; tolerance {{quote_tolerance_percent}}).",
    exception_explanations: codes.map((code) => ({ code, explanation: `Raised by the policy engine: ${code}. Cost basis {{cost_basis}}.`, evidence_ids: [`ticket:${ticketId}`, "policy:engine"] })),
    options: [
      { key: "A", title: "Approve at the work order amount", action: "approve_at_work_order", rationale: "Pay {{work_order}}; the tenant share is {{tenant_share}}.", risks: ["Technician may decline."], evidence_ids: ["policy:engine"],
        message: { recipient: "technician", subject: "Quote for the repair", body: "Please confirm you can complete the work for {{work_order}} instead of {{technician_quote}}." } },
      { key: "B", title: "Ask for a revised quote", action: "request_revised_quote", rationale: "The quote is {{quote_difference}} above the work order.", risks: ["Delay."], evidence_ids: ["policy:engine"],
        message: { recipient: "technician", subject: "Revised quote needed", body: "Please send a revised quote. The current quote is {{technician_quote}} against a work order of {{work_order}}." } },
    ],
    recommended_option: "A",
    ...overrides,
  };
}
