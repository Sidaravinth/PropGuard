/**
 * Test doubles for the LLM step. These are used ONLY in unit tests to exercise the deterministic
 * code around the model (validation, retry, verification, storage). Production code always calls
 * the real model.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import type { LlmCall } from "../src/extraction/extractor.js";
import type { LeaseExtraction } from "../src/extraction/leaseSchema.js";

export const readLease = (name: string) => fs.readFileSync(path.join(config.leasesDir, name));

const f = (value: string | number | null, section_ref: string | null, verbatim_snippet: string | null, status: "extracted" | "missing" | "needs_review" = "extracted", note: string | null = null) => ({
  value, status, section_ref, page: value === null && status === "missing" ? null : 1, verbatim_snippet, note,
});

/** What a correct extraction of lease_maple_101_sharma.txt looks like. */
export function sharmaExtraction(): LeaseExtraction {
  return {
    tenant_name: f("Priya Sharma", "Preamble", 'Maple Court Property Holdings LLC ("Landlord") and Priya Sharma ("Tenant")') as never,
    landlord_name: f("Maple Court Property Holdings LLC", "Preamble", 'between Maple Court Property Holdings LLC ("Landlord") and Priya Sharma') as never,
    property_name: f("Maple Court Apartments", "Section 1", "Unit 101, Maple Court Apartments, 1420 Maple Avenue, Springfield") as never,
    unit_number: f("101", "Section 1", "Unit 101, Maple Court Apartments") as never,
    start_date: f("2026-01-16", "Section 2", "The term of this Lease shall commence on January 16, 2026 and shall end on January 15, 2027") as never,
    end_date: f("2027-01-15", "Section 2", "shall end on January 15, 2027") as never,
    monthly_rent: f(1500, "Section 3.1", "Tenant shall pay monthly rent of $1,500.00 (One Thousand Five Hundred Dollars)") as never,
    security_deposit: f(1500, "Section 4", "Tenant shall deposit with Landlord a security deposit of $1,500.00.") as never,
    notice_period_days: f(30, "Section 7", "by giving written notice at least thirty (30) days prior to the end date") as never,
    repair_deductible: f(100, "Section 5.2", "Tenant shall be responsible for the first $100.00 of the repair cost") as never,
    clauses: [
      { clause_type: "rent", section_ref: "Section 3.1", page: 1, verbatim_text: "Tenant shall pay monthly rent of $1,500.00 (One Thousand Five Hundred Dollars), due on the first day of each calendar month." },
      { clause_type: "deposit", section_ref: "Section 4", page: 1, verbatim_text: "Upon execution of this Lease, Tenant shall deposit with Landlord a security deposit of $1,500.00." },
      { clause_type: "repair", section_ref: "Section 5.2", page: 1, verbatim_text: "For each repair request arising from Tenant's use of the Premises, Tenant shall be responsible for the first $100.00 of the repair cost (the \"Repair Deductible\")." },
      { clause_type: "pet", section_ref: "Section 6", page: 1, verbatim_text: "Tenant may keep one (1) domestic cat at the Premises." },
      { clause_type: "notice", section_ref: "Section 7", page: 1, verbatim_text: "Either party may terminate this Lease at the end of the term by giving written notice at least thirty (30) days prior to the end date." },
    ],
  };
}

/** A test double that replays a fixed sequence of raw model outputs. */
export function scriptedLlm(outputs: (string | { text: string; stopReason: string })[]): LlmCall & { calls: number; lastMessages: unknown[] } {
  const fn = (async ({ messages }) => {
    const out = outputs[Math.min(fn.calls, outputs.length - 1)]!;
    fn.calls++;
    fn.lastMessages = messages;
    return typeof out === "string"
      ? { text: out, stopReason: "end_turn", model: "test-double" }
      : { text: out.text, stopReason: out.stopReason, model: "test-double" };
  }) as LlmCall & { calls: number; lastMessages: unknown[] };
  fn.calls = 0;
  fn.lastMessages = [];
  return fn;
}
