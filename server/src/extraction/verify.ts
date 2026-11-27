/**
 * Deterministic post-extraction verification. The LLM's output is treated as a *claim*; this module
 * checks every claim against the source text and downgrades anything unverifiable to needs_review.
 * Only values that survive these checks are written to the structured lease columns.
 */
import {
  DATE_FIELDS,
  LEASE_FIELD_NAMES,
  MONEY_FIELDS,
  REQUIRED_CLAUSES,
  type ClauseType,
  type FieldStatus,
  type LeaseExtraction,
  type LeaseFieldName,
} from "./leaseSchema.js";

export interface VerifiedField {
  name: LeaseFieldName;
  /** Normalised value as text (cents for money, YYYY-MM-DD for dates). Kept even for needs_review, for the reviewer. */
  valueText: string | null;
  /** Typed value — populated ONLY when status is "extracted". */
  value: string | number | null;
  status: FieldStatus;
  sectionRef: string | null;
  page: number | null;
  snippet: string | null;
  notes: string[];
}

export interface VerifiedClause {
  clauseType: ClauseType;
  text: string;
  sectionRef: string | null;
  page: number | null;
  verified: boolean;
}

export interface DataGap {
  field: string;
  status: "missing" | "needs_review";
  reason: string;
}

export interface VerifiedLease {
  fields: Record<LeaseFieldName, VerifiedField>;
  clauses: VerifiedClause[];
  gaps: DataGap[];
}

// ---------------------------------------------------------------------------
// Text normalisation & matching
// ---------------------------------------------------------------------------

export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True if the snippet appears in the source, ignoring whitespace/line-wrap/quote-style differences. */
export function snippetInSource(snippet: string, normalizedSource: string): boolean {
  const n = normalizeText(snippet).replace(/^["'.…\s]+|["'.…\s]+$/g, "");
  return n.length >= 4 && normalizedSource.includes(n);
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberToWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 999) return null;
  if (n < 20) return SMALL[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${SMALL[n % 10]}` : "");
  const rest = n % 100;
  return `${SMALL[Math.floor(n / 100)]} hundred` + (rest ? ` ${numberToWords(rest)}` : "");
}

function moneyVariants(cents: number): string[] {
  const dollars = Math.floor(cents / 100);
  const c = String(cents % 100).padStart(2, "0");
  const grouped = dollars.toLocaleString("en-US");
  const variants = [`${grouped}.${c}`, `${dollars}.${c}`];
  if (c === "00") variants.push(grouped, String(dollars));
  return variants;
}

function dateVariants(iso: string): string[] {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const month = MONTHS[m - 1]!;
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return [iso, `${month} ${d}, ${y}`, `${month} ${d} ${y}`, `${d} ${month} ${y}`, `${d} ${month}, ${y}`, `${mm}/${dd}/${y}`, `${m}/${d}/${y}`];
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Does the normalised snippet literally contain the value (in any accepted surface form)? */
function valueAppearsIn(name: LeaseFieldName, value: string | number, normSnippet: string): boolean {
  if ((MONEY_FIELDS as readonly string[]).includes(name)) {
    return moneyVariants(value as number).some((v) => new RegExp(`(^|[^\\d.,])${escapeRe(v)}(?!\\d|[.,]\\d)`).test(normSnippet));
  }
  if ((DATE_FIELDS as readonly string[]).includes(name)) {
    return dateVariants(value as string).some((v) => normSnippet.includes(v));
  }
  if (name === "notice_period_days") {
    const n = value as number;
    const words = numberToWords(n);
    return new RegExp(`(^|\\D)${n}(\\D|$)`).test(normSnippet) || (words !== null && normSnippet.includes(words));
  }
  return normSnippet.includes(normalizeText(String(value)));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function verifyExtraction(extraction: LeaseExtraction, pages: string[]): VerifiedLease {
  const normSource = normalizeText(pages.join("\n"));
  const fields = {} as Record<LeaseFieldName, VerifiedField>;

  for (const name of LEASE_FIELD_NAMES) {
    const raw = extraction[name];
    const notes: string[] = raw.note ? [raw.note] : [];
    let status: FieldStatus = raw.status;
    let typed: string | number | null = raw.value;

    // Missing means missing: never keep a value the model labelled as absent.
    if (status === "missing") {
      fields[name] = {
        name, valueText: null, value: null, status, sectionRef: null, page: null, snippet: null,
        notes: notes.length ? notes : ["Not stated in the document"],
      };
      continue;
    }

    // Type/format normalisation.
    if (typed !== null) {
      if ((MONEY_FIELDS as readonly string[]).includes(name)) {
        const dollars = typed as number;
        if (!Number.isFinite(dollars) || dollars < 0) {
          notes.push(`Invalid amount ${String(dollars)}`);
          typed = null;
        } else {
          typed = Math.round(dollars * 100);
          if (typed === 0 && name === "monthly_rent") {
            notes.push("Monthly rent of $0 is implausible");
            status = "needs_review";
          }
        }
      } else if ((DATE_FIELDS as readonly string[]).includes(name)) {
        if (!isValidIsoDate(typed as string)) {
          notes.push(`"${String(typed)}" is not a valid YYYY-MM-DD date`);
          typed = null;
        }
      } else if (name === "notice_period_days") {
        const n = typed as number;
        if (!Number.isInteger(n) || n < 1 || n > 365) {
          notes.push(`Notice period ${String(n)} days is outside the plausible range 1–365`);
          status = "needs_review";
        }
      } else {
        typed = String(typed).trim();
        if (!typed) typed = null;
      }
    }

    if (status === "extracted") {
      if (typed === null) {
        status = "needs_review";
        notes.push("Model reported a value but none could be parsed");
      } else if (!raw.verbatim_snippet) {
        status = "needs_review";
        notes.push("No source snippet provided as evidence");
      } else if (!snippetInSource(raw.verbatim_snippet, normSource)) {
        status = "needs_review";
        notes.push("Snippet was not found verbatim in the source document");
      } else if (!valueAppearsIn(name, typed, normalizeText(raw.verbatim_snippet))) {
        status = "needs_review";
        notes.push("Extracted value does not appear in its cited snippet");
      }
    }

    if (raw.page !== null && (raw.page < 1 || raw.page > pages.length)) {
      notes.push(`Cited page ${raw.page} does not exist (document has ${pages.length})`);
    }

    fields[name] = {
      name,
      valueText: typed === null ? null : String(typed),
      value: status === "extracted" ? typed : null,
      status,
      sectionRef: raw.section_ref,
      page: raw.page !== null && raw.page >= 1 && raw.page <= pages.length ? raw.page : null,
      snippet: raw.verbatim_snippet,
      notes,
    };
  }

  // Cross-field rule: the term must be a positive interval.
  const s = fields.start_date;
  const e = fields.end_date;
  if (s.value !== null && e.value !== null && (e.value as string) <= (s.value as string)) {
    for (const f of [s, e]) {
      f.status = "needs_review";
      f.value = null;
      f.notes.push("End date is not after start date");
    }
  }

  const clauses: VerifiedClause[] = extraction.clauses
    .filter((c) => c.verbatim_text.trim().length > 0)
    .map((c) => ({
      clauseType: c.clause_type,
      text: c.verbatim_text.trim(),
      sectionRef: c.section_ref,
      page: c.page !== null && c.page >= 1 && c.page <= pages.length ? c.page : null,
      verified: snippetInSource(c.verbatim_text, normSource),
    }));

  const gaps = computeGaps(
    Object.values(fields).map((f) => ({ field: f.name, status: f.status, note: f.notes.join("; ") || null })),
    clauses,
  );
  return { fields, clauses, gaps };
}

/**
 * Single source of truth for "what is wrong with this lease's data". Used at ingest time and when
 * reading a lease back from the database, so both always agree.
 */
export function computeGaps(
  fields: { field: string; status: FieldStatus; note: string | null }[],
  clauses: { clauseType: ClauseType; verified: boolean }[],
): DataGap[] {
  const gaps: DataGap[] = [];
  for (const f of fields) {
    if (f.status !== "extracted") gaps.push({ field: f.field, status: f.status, reason: f.note ?? f.status });
  }
  for (const type of REQUIRED_CLAUSES) {
    if (!clauses.some((c) => c.clauseType === type && c.verified)) {
      gaps.push({ field: `clause:${type}`, status: "missing", reason: `No verified ${type} clause found in the document` });
    }
  }
  for (const c of clauses) {
    if (!c.verified) {
      gaps.push({ field: `clause:${c.clauseType}`, status: "needs_review", reason: "Clause text not found verbatim in the source" });
    }
  }
  return gaps;
}
