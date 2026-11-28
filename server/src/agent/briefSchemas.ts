/** Structured output schemas for the two agent workflows (validated with Zod; sent to the model as JSON Schema). */
import { z } from "zod";

const Text = z.string().trim().min(1).max(2000);
const EvidenceIds = z.array(z.string()).max(12);

/** The renewal notice that is sent if, and only if, a human approves the option it belongs to. */
const RenewalEmail = z.object({ subject: z.string().trim().min(3).max(200), body: z.string().trim().min(20).max(5000) });

export const RenewalDraft = z.object({
  title: z.string().trim().min(3).max(140),
  summary: Text,
  payment_summary: Text,
  recommendation: z.object({
    option_key: z.enum(["standard", "twelve_month_3pct", "month_to_month", "none"]),
    rationale: Text,
    evidence_ids: EvidenceIds,
  }),
  options: z
    .array(
      z.object({
        key: z.enum(["standard", "twelve_month_3pct", "month_to_month"]),
        explanation: Text,
        risks: z.array(Text).max(5),
        evidence_ids: EvidenceIds,
        email: RenewalEmail,
      }),
    )
    .length(3),
  risk_notes: z.array(z.object({ text: Text, evidence_ids: EvidenceIds })).max(8),
});
export type RenewalDraft = z.infer<typeof RenewalDraft>;

/** The only actions a maintenance option may propose; each maps to fixed code run after human approval. */
export const MAINTENANCE_ACTIONS = ["approve_at_work_order", "approve_at_quote", "request_revised_quote", "hold_until_balance_paid"] as const;
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];

/** The follow-up that is sent if, and only if, a human approves the option it belongs to. */
const FollowUpMessage = z.object({
  recipient: z.enum(["technician", "tenant"]),
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(20).max(5000),
});

export const MaintenanceDraft = z.object({
  title: z.string().trim().min(3).max(140),
  summary: Text,
  exception_explanations: z
    .array(
      z.object({
        code: z.enum(["QUOTE_EXCEEDS_WORK_ORDER", "UNPAID_BALANCE", "LEASE_NOT_FOUND", "DEDUCTIBLE_UNKNOWN", "DEPOSIT_CAP_EXCEEDED", "DEPOSIT_UNKNOWN"]),
        explanation: Text,
        evidence_ids: EvidenceIds,
      }),
    )
    .min(1)
    .max(6),
  options: z
    .array(
      z.object({
        key: z.enum(["A", "B"]),
        title: z.string().trim().min(3).max(140),
        action: z.enum(MAINTENANCE_ACTIONS),
        rationale: Text,
        risks: z.array(Text).max(5),
        evidence_ids: EvidenceIds,
        message: FollowUpMessage,
      }),
    )
    .length(2),
  recommended_option: z.enum(["A", "B"]),
});
export type MaintenanceDraft = z.infer<typeof MaintenanceDraft>;

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...s } = z.toJSONSchema(schema) as Record<string, unknown>;
  return s;
}
