import { z } from "zod";

/**
 * Contract between the LLM and PropGuard. The model fills this schema (enforced with structured
 * outputs) and the result is re-validated with Zod before anything else touches it.
 *
 * Every field carries its own evidence so nothing is stored without a source reference.
 */

export const FieldStatus = z.enum(["extracted", "missing", "needs_review"]);
export type FieldStatus = z.infer<typeof FieldStatus>;

export const ClauseType = z.enum(["rent", "deposit", "repair", "pet", "notice", "renewal", "late_fee", "termination", "payment", "other"]);
export type ClauseType = z.infer<typeof ClauseType>;

function field<T extends z.ZodType>(value: T, valueHint: string) {
  return z.object({
    value: value.nullable().describe(`${valueHint}. null unless status is "extracted" or "needs_review".`),
    status: FieldStatus.describe(
      'extracted = stated clearly once; missing = not stated anywhere in the document; needs_review = stated but ambiguous, conflicting or unclear.',
    ),
    section_ref: z.string().nullable().describe('Section/clause label exactly as written, e.g. "Section 4" or "§2". null if missing.'),
    page: z.number().int().nullable().describe("1-based page number from the <page> markers. null if missing."),
    verbatim_snippet: z
      .string()
      .nullable()
      .describe("Exact sentence(s) from the document that state this value, copied character-for-character. null if missing."),
    note: z.string().nullable().describe("Short reason when status is missing or needs_review; otherwise null."),
  });
}

export const LeaseFields = {
  tenant_name: field(z.string(), "Full name of the tenant/resident/lessee"),
  landlord_name: field(z.string(), "Name of the landlord/lessor/owner (person or company)"),
  property_name: field(z.string(), 'Name of the property/building, e.g. "Maple Court Apartments"'),
  unit_number: field(z.string(), 'Unit/apartment/loft number only, e.g. "101"'),
  start_date: field(z.string(), "Lease start date as YYYY-MM-DD"),
  end_date: field(z.string(), "Lease end/expiry date as YYYY-MM-DD"),
  monthly_rent: field(z.number(), "Monthly rent in US dollars as a number, e.g. 1500"),
  security_deposit: field(z.number(), "Security deposit in US dollars as a number (exclude pet deposits/fees)"),
  notice_period_days: field(z.number().int(), "Days of written notice required before the end of the term (non-renewal/vacate notice)"),
  repair_deductible: field(z.number(), "Tenant repair deductible per repair in US dollars"),
} as const;

export type LeaseFieldName = keyof typeof LeaseFields;
export const LEASE_FIELD_NAMES = Object.keys(LeaseFields) as LeaseFieldName[];

export const ExtractedClause = z.object({
  clause_type: ClauseType,
  section_ref: z.string().nullable(),
  page: z.number().int().nullable(),
  verbatim_text: z.string().describe("The clause text copied exactly from the document."),
});

export const LeaseExtractionSchema = z.object({
  ...LeaseFields,
  clauses: z
    .array(ExtractedClause)
    .describe("Key clauses present in the document (rent, deposit, repair, pet, notice, renewal, late_fee, termination, payment). Omit types that are absent."),
});

export type LeaseExtraction = z.infer<typeof LeaseExtractionSchema>;
export type ExtractedField = LeaseExtraction[LeaseFieldName];

/** Fields whose value is a US-dollar amount (stored as integer cents). */
export const MONEY_FIELDS = ["monthly_rent", "security_deposit", "repair_deductible"] as const satisfies readonly LeaseFieldName[];
export const DATE_FIELDS = ["start_date", "end_date"] as const satisfies readonly LeaseFieldName[];

/** Clause types every complete lease must contain; absence is reported as a data gap. */
export const REQUIRED_CLAUSES: readonly ClauseType[] = ["rent", "deposit", "repair", "notice"];
