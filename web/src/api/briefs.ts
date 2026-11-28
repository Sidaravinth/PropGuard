import { api } from "./client";

export type BriefStatus = "pending" | "approved" | "rejected" | "revision_requested" | "superseded";
export type Tier = "AUTO_APPROVE" | "PROPERTY_MANAGER" | "REGIONAL_DIRECTOR";

export interface BriefListItem {
  brief_id: number;
  brief_type: "renewal" | "maintenance";
  status: BriefStatus;
  priority: "high" | "medium" | "low";
  required_approver: Tier;
  title: string;
  summary: string | null;
  tenant: { tenant_id: string; name: string; email: string | null } | null;
  unit: { unit_id: string; property_name: string; unit_number: string } | null;
  lease_id: number | null;
  ticket_id: number | null;
  created_at: string;
  grounding_passed: boolean;
  needs_review: boolean;
  decided_at: string | null;
}

export interface Figure {
  key: string;
  label: string;
  unit: string;
  value: number | string | null;
  display: string;
  evidence_ids: string[];
  source: { kind: string; [k: string]: unknown };
}

export interface Evidence {
  id: string;
  kind: string;
  label: string;
  record: { table: string; id: string | number };
  value?: string | number | null;
  status?: string | null;
  snippet?: string | null;
  source_doc?: string | null;
  section_ref?: string | null;
  page?: number | null;
}

export interface ToolCall {
  seq: number;
  name: string;
  args: Record<string, unknown>;
  by: "model" | "orchestrator";
  ok: boolean;
  error: string | null;
  evidence_ids: string[];
}

export interface AuditEntry {
  audit_id: number;
  occurred_at: string;
  event_type: string;
  actor_type: "agent" | "system" | "human";
  actor_id: string;
  subject_type: string | null;
  subject_id: string | null;
  brief_id: number | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface RenewalContent {
  title: string;
  summary: string;
  payment_summary: string;
  recommendation: { option_key: string; rationale: string; evidence_ids: string[] };
  options: { key: string; explanation: string; risks: string[]; evidence_ids: string[]; email?: { subject: string; body: string } }[];
  risk_notes: { text: string; evidence_ids: string[] }[];
  /** Only on briefs drafted before each option had its own email. They can be viewed but not approved. */
  email?: { subject: string; body: string };
}

export interface DraftMessage {
  recipient: "technician" | "tenant";
  subject: string;
  body: string;
}

export interface MaintenanceContent {
  title: string;
  summary: string;
  exception_explanations: { code: string; explanation: string; evidence_ids: string[] }[];
  options: { key: string; title: string; action: string; rationale: string; risks: string[]; evidence_ids: string[]; message?: DraftMessage }[];
  recommended_option: string;
  /** Only on briefs drafted before each option had its own message. They can be viewed but not approved. */
  message?: DraftMessage;
}

export interface BriefDetail extends Omit<BriefListItem, "summary" | "grounding_passed" | "decided_at"> {
  content: RenewalContent | MaintenanceContent | null;
  content_template: RenewalContent | MaintenanceContent | null;
  figures: Figure[];
  evidence: Evidence[];
  policy: {
    verdict: string;
    approverRequired: Tier;
    autoApproveEligible: boolean;
    costBasisCents: number;
    exceptions: { code: string; message: string }[];
    ruleTrace: { rule: string; passed: boolean; detail: string }[];
  } | null;
  charge_notice: { proposed_charge_cents: number; deductible_share_cents: number; difference_cents: number } | null;
  grounding: {
    passed: boolean;
    checked_text_fields: number;
    placeholders_used: string[];
    literal_figures_matched: string[];
    ungrounded_figures: { field: string; text: string }[];
    unknown_placeholders: { field: string; key: string }[];
    unknown_evidence_ids: string[];
    /** Absent on briefs drafted before internal ids were checked. */
    internal_ids_in_text?: { field: string; text: string }[];
    attempts?: { attempt: number; error: string | null }[];
  };
  model: string | null;
  decision: { decided_by: string | null; decided_at: string; status: BriefStatus; selected_option: string | null; comment: string | null; execution: Record<string, unknown> | null } | null;
  agent_run: { run_id: number; workflow: string; status: string; model: string | null; started_at: string; finished_at: string | null; tool_calls: ToolCall[] } | null;
  supersedes_brief_id: number | null;
  audit: AuditEntry[];
}

export interface Candidates {
  renewals: {
    lease_id: number;
    tenant_name: string | null;
    end_date: string | null;
    days_until_end: number | null;
    pending_brief_id: number | null;
    /** The pending brief was drafted from incomplete lease data that has since been fixed. */
    pending_brief_outdated: boolean;
  }[];
  maintenance: { ticket_id: number; issue_summary: string; unit_id: string; pending_brief_id: number | null }[];
}

export interface AuditPage {
  total: number;
  event_types: string[];
  rows: AuditEntry[];
}

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);

export const briefsApi = {
  list: (q: { status?: string; type?: string } = {}) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    return data(api<{ data: BriefListItem[] }>(`/briefs${p.size ? `?${p}` : ""}`));
  },
  get: (id: number) => data(api<{ data: BriefDetail }>(`/briefs/${id}`)),
  decide: (id: number, body: { decision: "approve" | "reject" | "request_revision"; option_key?: string | null; comment?: string | null }) =>
    data(api<{ data: BriefDetail }>(`/briefs/${id}/decision`, { method: "POST", json: body })),
  candidates: () => data(api<{ data: Candidates }>("/agent/candidates")),
  generate: (type: "renewals" | "maintenance", id: number) => data(api<{ data: BriefDetail }>(`/agent/${type}/${id}`, { method: "POST" })),
  runAll: (type: "renewals" | "maintenance") =>
    data(api<{ data: { subject_id: number; brief_id?: number; skipped?: string; error?: string }[] }>(`/agent/${type}/run`, { method: "POST" })),
  audit: (q: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return data(api<{ data: AuditPage }>(`/audit${p.size ? `?${p}` : ""}`));
  },
  verifyAudit: () => data(api<{ data: { ok: boolean; checked: number; first_broken_audit_id: number | null } }>("/audit/verify")),
};
