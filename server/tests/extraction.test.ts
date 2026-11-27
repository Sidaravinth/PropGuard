import { describe, expect, it } from "vitest";
import { loadDocument } from "../src/extraction/documentText.js";
import { ApiError } from "@google/genai";
import { extractLease, extractionJsonSchema, normalizeStopReason, withBackoff } from "../src/extraction/extractor.js";
import { normalizeText, snippetInSource, verifyExtraction } from "../src/extraction/verify.js";
import { readLease, scriptedLlm, sharmaExtraction } from "./fixtures.js";

const sharmaPages = async () => (await loadDocument("lease_maple_101_sharma.txt", readLease("lease_maple_101_sharma.txt"))).pages;

describe("documentText", () => {
  it("loads a text lease as one page", async () => {
    const doc = await loadDocument("lease_maple_101_sharma.txt", readLease("lease_maple_101_sharma.txt"));
    expect(doc.pages).toHaveLength(1);
    expect(doc.mimeType).toBe("text/plain");
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("loads the PDF lease page by page", async () => {
    const doc = await loadDocument("lease_oakwood_301_patel.pdf", readLease("lease_oakwood_301_patel.pdf"));
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0]).toContain("$1,800.00");
    expect(doc.pages[1]).toContain("deductible of $75.00");
  });

  it("rejects unsupported file types", async () => {
    await expect(loadDocument("lease.docx", Buffer.from("PK..."))).rejects.toThrow(/Unsupported/);
  });
});

describe("verifyExtraction — deterministic checks on model output", () => {
  it("accepts a correct extraction, converting money to cents", async () => {
    const v = verifyExtraction(sharmaExtraction(), await sharmaPages());
    expect(v.gaps).toEqual([]);
    expect(v.fields.monthly_rent.value).toBe(150_000);
    expect(v.fields.repair_deductible.value).toBe(10_000);
    expect(v.fields.notice_period_days.value).toBe(30);
    expect(v.fields.start_date.value).toBe("2026-01-16");
    expect(v.clauses.every((c) => c.verified)).toBe(true);
  });

  it("flags a fabricated snippet as needs_review and drops the value", async () => {
    const x = sharmaExtraction();
    x.security_deposit.verbatim_snippet = "Tenant shall pay a security deposit of $1,500.00.";
    const v = verifyExtraction(x, await sharmaPages());
    expect(v.fields.security_deposit.status).toBe("needs_review");
    expect(v.fields.security_deposit.value).toBeNull();
    expect(v.fields.security_deposit.notes.join()).toMatch(/not found verbatim/);
  });

  it("flags a value that does not appear in its own snippet (hallucinated number)", async () => {
    const x = sharmaExtraction();
    x.monthly_rent.value = 1600;
    const v = verifyExtraction(x, await sharmaPages());
    expect(v.fields.monthly_rent.status).toBe("needs_review");
    expect(v.fields.monthly_rent.value).toBeNull();
    expect(v.fields.monthly_rent.valueText).toBe("160000"); // kept for the human reviewer only
  });

  it("does not let $1,500 match inside $11,500 or $1,500.50", async () => {
    const x = sharmaExtraction();
    x.monthly_rent.value = 500;
    const v = verifyExtraction(x, await sharmaPages());
    expect(v.fields.monthly_rent.status).toBe("needs_review");
  });

  it("accepts amounts followed by sentence punctuation", () => {
    for (const tail of [", payable monthly", ".", ";"]) {
      const snippet = `Monthly Rent: $1,500.00${tail}`;
      const x = sharmaExtraction();
      x.monthly_rent.verbatim_snippet = snippet;
      expect(verifyExtraction(x, [snippet]).fields.monthly_rent.value).toBe(150_000);
    }
  });

  it("does not match an amount that is only the start of a longer number", () => {
    const x = sharmaExtraction();
    x.monthly_rent.value = 1;
    x.monthly_rent.verbatim_snippet = "Monthly Rent: $1,500.00";
    expect(verifyExtraction(x, ["Monthly Rent: $1,500.00"]).fields.monthly_rent.status).toBe("needs_review");
  });

  it("missing fields stay null and become data gaps", async () => {
    const x = sharmaExtraction();
    x.security_deposit = { value: 1500, status: "missing", section_ref: null, page: null, verbatim_snippet: null, note: null };
    x.clauses = x.clauses.filter((c) => c.clause_type !== "deposit");
    const v = verifyExtraction(x, await sharmaPages());
    expect(v.fields.security_deposit.value).toBeNull();
    expect(v.fields.security_deposit.valueText).toBeNull();
    expect(v.gaps.map((g) => g.field).sort()).toEqual(["clause:deposit", "security_deposit"]);
  });

  it("an 'extracted' field with no evidence is downgraded", async () => {
    const x = sharmaExtraction();
    x.repair_deductible.verbatim_snippet = null;
    const v = verifyExtraction(x, await sharmaPages());
    expect(v.fields.repair_deductible.status).toBe("needs_review");
  });

  it("rejects invalid dates and end-before-start terms", async () => {
    const x = sharmaExtraction();
    x.start_date.value = "2026-02-30";
    expect(verifyExtraction(x, await sharmaPages()).fields.start_date.status).toBe("needs_review");

    const y = sharmaExtraction();
    y.end_date = { ...y.start_date };
    const v = verifyExtraction(y, await sharmaPages());
    expect(v.fields.end_date.status).toBe("needs_review");
    expect(v.fields.start_date.status).toBe("needs_review");
  });

  it("keeps the model's needs_review verdict (ambiguity) and never stores its value as trusted", async () => {
    const x = sharmaExtraction();
    x.monthly_rent = { ...x.monthly_rent, status: "needs_review", note: "Numerals and words disagree" };
    const v = verifyExtraction(x, await sharmaPages());
    expect(v.fields.monthly_rent.status).toBe("needs_review");
    expect(v.fields.monthly_rent.value).toBeNull();
    expect(v.gaps.find((g) => g.field === "monthly_rent")?.reason).toMatch(/disagree/);
  });

  it("marks clauses not present in the source as unverified", async () => {
    const x = sharmaExtraction();
    x.clauses.push({ clause_type: "renewal", section_ref: "Section 9", page: 1, verbatim_text: "Tenant has an automatic right to renew at the same rent." });
    const v = verifyExtraction(x, await sharmaPages());
    expect(v.clauses.find((c) => c.clauseType === "renewal")?.verified).toBe(false);
    expect(v.gaps.some((g) => g.field === "clause:renewal")).toBe(true);
  });

  it("snippet matching tolerates PDF line wraps and curly quotes but not paraphrase", () => {
    const src = normalizeText("Lessee shall pay monthly rent of $1,800.00 (One Thousand\nEight Hundred Fifty Dollars) on the first day");
    expect(snippetInSource("monthly rent of $1,800.00 (One Thousand Eight Hundred Fifty Dollars)", src)).toBe(true);
    expect(snippetInSource("rent is $1,800.00 per month", src)).toBe(false);
  });
});

describe("extractLease — schema validation and retry", () => {
  it("returns the parsed extraction on the first valid response", async () => {
    const doc = await loadDocument("lease_maple_101_sharma.txt", readLease("lease_maple_101_sharma.txt"));
    const llm = scriptedLlm([JSON.stringify(sharmaExtraction())]);
    const out = await extractLease(doc, llm, { maxAttempts: 3 });
    expect(out.extraction?.monthly_rent.value).toBe(1500);
    expect(out.attempts).toHaveLength(1);
  });

  it("retries on malformed JSON and feeds the error back to the model", async () => {
    const doc = await loadDocument("lease_maple_101_sharma.txt", readLease("lease_maple_101_sharma.txt"));
    const llm = scriptedLlm(['{"tenant_name": {"value": "Priya', JSON.stringify(sharmaExtraction())]);
    const out = await extractLease(doc, llm, { maxAttempts: 3 });
    expect(out.extraction).not.toBeNull();
    expect(out.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(out.attempts[0]!.error).toMatch(/not valid JSON/);
    expect(JSON.stringify(llm.lastMessages)).toContain("could not be accepted");
  });

  it("retries on schema-invalid output", async () => {
    const doc = await loadDocument("lease_maple_101_sharma.txt", readLease("lease_maple_101_sharma.txt"));
    const bad = { ...sharmaExtraction(), monthly_rent: { value: "fifteen hundred", status: "extracted" } };
    const llm = scriptedLlm([JSON.stringify(bad), JSON.stringify(sharmaExtraction())]);
    const out = await extractLease(doc, llm, { maxAttempts: 3 });
    expect(out.attempts[0]!.error).toMatch(/schema validation[\s\S]*monthly_rent/);
    expect(out.extraction).not.toBeNull();
  });

  it("gives up after maxAttempts and returns null (caller stores needs_review)", async () => {
    const doc = await loadDocument("lease_maple_101_sharma.txt", readLease("lease_maple_101_sharma.txt"));
    const llm = scriptedLlm(["not json"]);
    const out = await extractLease(doc, llm, { maxAttempts: 3 });
    expect(out.extraction).toBeNull();
    expect(out.attempts).toHaveLength(3);
    expect(llm.calls).toBe(3);
  });

  it("treats refusal and truncation as failed attempts", async () => {
    const doc = await loadDocument("lease_maple_101_sharma.txt", readLease("lease_maple_101_sharma.txt"));
    const llm = scriptedLlm([{ text: "", stopReason: "refusal" }, { text: "{", stopReason: "max_tokens" }, JSON.stringify(sharmaExtraction())]);
    const out = await extractLease(doc, llm, { maxAttempts: 3 });
    expect(out.attempts.map((a) => a.error?.slice(0, 20) ?? null)).toEqual(["Model declined the r", "Output truncated (st", null]);
    expect(out.extraction).not.toBeNull();
  });
});

describe("Gemini adapter helpers", () => {
  const failing = (status: number, times: number) => {
    let calls = 0;
    return async () => {
      if (++calls <= times) throw new ApiError({ status, message: "x" });
      return calls;
    };
  };
  const noSleep = async () => {};

  it("waits out rate limits and then succeeds", async () => {
    expect(await withBackoff(failing(429, 2), noSleep)).toBe(3);
  });

  it("gives up after the last backoff step", async () => {
    await expect(withBackoff(failing(429, 99), noSleep)).rejects.toThrow(ApiError);
  });

  it("does not retry a bad request or bad key", async () => {
    let slept = 0;
    await expect(withBackoff(failing(400, 99), async () => void slept++)).rejects.toThrow(ApiError);
    expect(slept).toBe(0);
  });

  it("normalizes finish reasons", () => {
    expect(normalizeStopReason("STOP", false)).toBe("end_turn");
    expect(normalizeStopReason("MAX_TOKENS", false)).toBe("max_tokens");
    expect(normalizeStopReason("SAFETY", false)).toBe("refusal");
    expect(normalizeStopReason(undefined, true)).toBe("refusal");
  });

  it("builds a JSON schema covering every lease field", () => {
    const s = extractionJsonSchema() as { $schema?: string; required: string[] };
    expect(s.$schema).toBeUndefined();
    expect(s.required).toEqual(expect.arrayContaining(["monthly_rent", "security_deposit", "clauses"]));
  });
});
