/**
 * Grounding: no number in a Decision Brief may come from the model.
 *
 * The model receives a table of figures (computed in code from tool outputs) and must reference them
 * as {{figure_key}} placeholders. Any figure it writes out literally (money, percentages, day/month/
 * year counts, dates — as digits or as words) must exactly equal one of those figures; anything else is
 * "ungrounded" and the draft is rejected. Every other number must be an identifier taken from the brief's
 * own records (unit, ticket, lease, section or option number). Placeholders are rendered from the stored
 * figures, never from model text.
 *
 * Limit: a literal that equals a figure is accepted without checking the label the sentence gives it.
 */
import type { Figure } from "./evidence.js";

export const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Internal evidence ids ("unit:U101", "lease:3:field:monthly_rent") belong in evidence_ids, never in prose. */
const INTERNAL_ID = /\b(?:unit|ticket|tenant|lease|clause|ledger|evaluation|policy):[A-Za-z0-9_][A-Za-z0-9_:]*|\btwelve_month_3pct\b/g;

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?";
const monthNumber = (name: string) => String(MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase()) + 1).padStart(2, "0");
const pad = (d: string) => d.padStart(2, "0");

const AMOUNT = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";
const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const NUMBER_WORD = `(?:${[...SMALL, ...TENS, "hundred", "thousand", "million"].sort((a, b) => b.length - a.length).join("|")})`;
const WORDS = `\\b${NUMBER_WORD}(?:[\\s-]+(?:and[\\s-]+)?${NUMBER_WORD})*\\b`;
/** Words allowed between a number and its unit: "30 calendar days". */
const BETWEEN = "(?:(?:calendar|business|full|consecutive|more|additional)[\\s-]+)?";
const OTHER_CURRENCY = "(?:EUR|GBP|INR|JPY|CAD|AUD|CHF|CNY|euros?|pounds? sterling|pounds?|rupees?|yen)";

function wordsToNumber(phrase: string): number {
  let total = 0;
  let current = 0;
  for (const w of phrase.toLowerCase().split(/[\s-]+/)) {
    if (SMALL.includes(w)) current += SMALL.indexOf(w);
    else if (TENS.includes(w)) current += (TENS.indexOf(w) + 2) * 10;
    else if (w === "hundred") current = (current || 1) * 100;
    else if (w === "thousand" || w === "million") {
      total += (current || 1) * (w === "thousand" ? 1_000 : 1_000_000);
      current = 0;
    }
  }
  return total + current;
}

interface RawFigure {
  text: string;
  kind: "money" | "percent" | "days" | "months" | "date" | "month" | "month_day" | "other_currency";
  value: number | string;
}

const cents = (amount: string) => Math.round(Number(amount.replace(/,/g, "")) * 100);
const period = (n: number, unit: string, text: string): RawFigure => {
  const u = unit.toLowerCase();
  return u === "day" || u === "week" ? { text, kind: "days", value: u === "week" ? n * 7 : n } : { text, kind: "months", value: u === "year" ? n * 12 : n };
};

/** Each pattern consumes the text it matches, so one number is never reported twice. Order matters. */
const PATTERNS: [string, string, (m: RegExpMatchArray) => RawFigure][] = [
  // dates first, so their numbers are not read as anything else
  ["\\b(\\d{4})-(\\d{2})-(\\d{2})\\b", "g", (m) => ({ text: m[0], kind: "date", value: m[0] })],
  [`\\b(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi", (m) => ({ text: m[0], kind: "date", value: `${m[3]}-${monthNumber(m[1]!)}-${pad(m[2]!)}` })],
  [`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH}),?\\s+(\\d{4})\\b`, "gi", (m) => ({ text: m[0], kind: "date", value: `${m[3]}-${monthNumber(m[2]!)}-${pad(m[1]!)}` })],
  ["\\b(\\d{1,2})/(\\d{1,2})/(\\d{4})\\b", "g", (m) => ({ text: m[0], kind: "date", value: `${m[3]}-${pad(m[1]!)}-${pad(m[2]!)}` })],
  [`\\b(${MONTH}),?\\s+(\\d{4})\\b`, "gi", (m) => ({ text: m[0], kind: "month", value: `${m[2]}-${monthNumber(m[1]!)}` })],
  // dates without a year (month names must be capitalised, so the verb "may" is not read as a month)
  [`\\b(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:%|percent|day|week|month|year|dollar))`, "g", (m) => ({ text: m[0], kind: "month_day", value: `${monthNumber(m[1]!)}-${pad(m[2]!)}` })],
  [`\\b(\\d{1,2})(?:st|nd|rd|th)\\s+(?:of\\s+)?(${MONTH})\\b`, "g", (m) => ({ text: m[0], kind: "month_day", value: `${monthNumber(m[2]!)}-${pad(m[1]!)}` })],
  // other currencies are never grounded: every stored amount is in US dollars
  [`(?:€|£|₹|¥)\\s?(?:${AMOUNT})`, "g", (m) => ({ text: m[0], kind: "other_currency", value: m[0] })],
  [`\\b(?:${AMOUNT})\\s?${OTHER_CURRENCY}\\b|\\b(?:EUR|GBP|INR|JPY|CAD|AUD|CHF|CNY)\\s?(?:${AMOUNT})|${WORDS}\\s+(?:euros|pounds|rupees|yen)\\b`, "gi", (m) => ({ text: m[0], kind: "other_currency", value: m[0] })],
  // abbreviated magnitudes ("$5k") are not exact figures
  [`(?:\\$|\\bUSD\\s?)\\s?(?:${AMOUNT})\\s?(?:k|m|bn|thousand|million)\\b`, "gi", (m) => ({ text: m[0], kind: "other_currency", value: m[0] })],
  // US dollars: "$1,500.00", "USD 80", "5000 dollars", "1,500 USD", "nine hundred dollars"
  [`(?:\\$|\\bUSD\\s?)\\s?(${AMOUNT})`, "gi", (m) => ({ text: m[0], kind: "money", value: cents(m[1]!) })],
  [`\\b(${AMOUNT})[\\s-]?(?:US\\s+)?(?:dollars?|USD|bucks)\\b`, "gi", (m) => ({ text: m[0], kind: "money", value: cents(m[1]!) })],
  [`(${WORDS})(?:\\s*\\(\\d[\\d,.]*\\))?[\\s-]+(?:US\\s+)?(?:dollars?|bucks)\\b`, "gi", (m) => ({ text: m[0], kind: "money", value: wordsToNumber(m[1]!) * 100 })],
  // percentages and periods, as words then digits
  [`(${WORDS})(?:\\s*\\(\\d+%?\\))?[\\s-]*(?:per\\s?cent\\b|%)`, "gi", (m) => ({ text: m[0], kind: "percent", value: wordsToNumber(m[1]!) })],
  [`(${WORDS})(?:\\s*\\(\\d+\\))?[\\s-]+${BETWEEN}(day|week|month|year)s?\\b`, "gi", (m) => period(wordsToNumber(m[1]!), m[2]!, m[0])],
  ["(\\d+(?:\\.\\d+)?)\\s?(?:%|per\\s?cent\\b)", "gi", (m) => ({ text: m[0], kind: "percent", value: Number(m[1]) })],
  [`\\b(\\d+)[\\s-]*${BETWEEN}(day|week|month|year)s?\\b`, "gi", (m) => period(Number(m[1]), m[2]!, m[0])],
];

const KIND_ORDER: Record<RawFigure["kind"], number> = { money: 0, percent: 1, days: 2, months: 2, date: 3, month: 4, month_day: 5, other_currency: 6 };

/** Literal figures in text (placeholders must already be removed), plus the text left after consuming them. */
function scan(text: string): { figures: RawFigure[]; rest: string } {
  const found: { figure: RawFigure; at: number }[] = [];
  let rest = text;
  for (const [source, flags, read] of PATTERNS) {
    // Replacing with spaces of the same length keeps every later match at its original position.
    rest = rest.replace(new RegExp(source, flags), (...args) => {
      const offsetIndex = args.findIndex((a, i) => i > 0 && typeof a === "number");
      found.push({ figure: read(args.slice(0, offsetIndex) as unknown as RegExpMatchArray), at: args[offsetIndex] as number });
      return " ".repeat((args[0] as string).length);
    });
  }
  // Grouped by kind, then in reading order.
  const figures = found.sort((a, b) => KIND_ORDER[a.figure.kind] - KIND_ORDER[b.figure.kind] || a.at - b.at).map((x) => x.figure);
  return { figures, rest };
}

/** Find literal figures in text (placeholders must already be removed). */
export function findRawFigures(text: string): RawFigure[] {
  return scan(text).figures;
}

function matchesFigure(raw: RawFigure, figures: Figure[], ids: Identifiers): boolean {
  const dates = figures.filter((f) => f.unit === "date" && typeof f.value === "string").map((f) => f.value as string);
  // A bare month ("November 2026") may name a ledger month or the month of a computed date.
  if (raw.kind === "month") return ids.months.includes(raw.value as string) || dates.some((d) => d.startsWith(raw.value as string));
  if (raw.kind === "month_day") return dates.some((d) => d.slice(5) === raw.value);
  // "6 months" may count ledger months ("5 of 6 months"). A hyphenated "6-month term" must match a term figure.
  if (raw.kind === "months" && /^\d+\s+(?:\w+\s+)?months$/i.test(raw.text) && figures.some((f) => f.unit === "count" && f.key.includes("month") && f.value === raw.value)) return true;
  return figures.some((f) => {
    if (f.value === null) return false;
    switch (raw.kind) {
      case "money":
        return f.unit === "cents" && Math.abs(f.value as number) === raw.value;
      case "percent":
        return f.unit === "percent" && Number(f.value) === raw.value;
      case "days":
        return f.unit === "days" && f.value === raw.value;
      case "months":
        return f.unit === "months" && f.value === raw.value;
      case "date":
        return f.unit === "date" && f.value === raw.value;
      default:
        return false;
    }
  });
}

/** Identifiers taken from the records behind a brief: the only numbers allowed that are not figures. */
export interface Identifiers {
  unitNumbers: string[];
  propertyNames: string[];
  ticketIds: number[];
  leaseIds: number[];
  evaluationIds: number[];
  /** Numbers appearing in the lease's section references ("5.2", "4"). */
  sections: string[];
  /** Ledger months, "YYYY-MM". */
  months: string[];
}
export const NO_IDENTIFIERS: Identifiers = { unitNumbers: [], propertyNames: [], ticketIds: [], leaseIds: [], evaluationIds: [], sections: [], months: [] };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Numbers left after figures are consumed that are not identifiers of this brief's records. */
export function findStrayNumbers(text: string, figures: Figure[], ids: Identifiers): string[] {
  let rest = scan(text).rest;
  const consume = (source: string) => {
    rest = rest.replace(new RegExp(source, "gi"), (m) => " ".repeat(m.length));
  };
  const labelled = (labels: string, values: (string | number)[]) => {
    for (const v of values) consume(`(?:${labels})\\s*(?:(?:number|no\\.?|id)\\s*)?(?:#\\s*)?${escapeRe(String(v))}(?![\\d]|[.,]\\d)`);
  };
  consume("\\b(?:3|three)[\\s-]way\\b"); // the 3-way verification
  consume("(?:^|\\n)\\s*[1-9][.)](?=\\s)"); // list markers
  labelled("\\bunits?|\\bapartment|\\bapt\\.?|\\bloft|\\bsuite", ids.unitNumbers);
  labelled(ids.propertyNames.length ? ids.propertyNames.map(escapeRe).join("|") : "(?!)", ids.unitNumbers);
  labelled("\\bticket|\\bwork order", ids.ticketIds);
  labelled("\\blease", ids.leaseIds);
  labelled("\\bevaluation", ids.evaluationIds);
  labelled("\\bsection|\\bsec\\.|§|\\bclause|\\barticle|\\bparagraph", ids.sections);
  labelled("\\boption", [1, 2, 3]);
  // A bare "#7" refers to the ticket or lease itself.
  labelled("(?=#)", [...ids.ticketIds, ...ids.leaseIds]);
  // Counts (ledger months paid, and so on) are figures without a currency or period unit.
  const counts = figures.filter((f) => f.unit === "count" && typeof f.value === "number").map((f) => String(f.value));
  for (const n of new Set(counts)) {
    consume(`(?<![\\d.,$])${n}(?=\\s+(?:of\\b|(?:\\w+[\\s-]+){0,2}?(?:months?|payments?|entr(?:y|ies)|times?)\\b))`);
    consume(`(?<=\\bof\\s)${n}(?![\\d]|[.,]\\d)`);
  }
  return [...rest.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]);
}

export interface GroundingReport {
  passed: boolean;
  checked_text_fields: number;
  placeholders_used: string[];
  literal_figures_matched: string[];
  ungrounded_figures: { field: string; text: string }[];
  unknown_placeholders: { field: string; key: string }[];
  unknown_evidence_ids: string[];
  internal_ids_in_text: { field: string; text: string }[];
}

/** Walk every string in the draft (except enum-like keys), checking placeholders and literal figures. */
export function checkGrounding(draft: unknown, figures: Figure[], knownEvidence: (id: string) => boolean, ids: Identifiers = NO_IDENTIFIERS): GroundingReport {
  const keys = new Set(figures.map((f) => f.key));
  const report: GroundingReport = {
    passed: true,
    checked_text_fields: 0,
    placeholders_used: [],
    literal_figures_matched: [],
    ungrounded_figures: [],
    unknown_placeholders: [],
    unknown_evidence_ids: [],
    internal_ids_in_text: [],
  };
  const SKIP = new Set(["key", "option_key", "action", "code", "recipient", "recommended_option"]);
  const visit = (v: unknown, path: string, parentKey: string) => {
    if (typeof v === "string") {
      if (parentKey === "evidence_ids") {
        if (!knownEvidence(v)) report.unknown_evidence_ids.push(v);
        return;
      }
      if (SKIP.has(parentKey)) return;
      report.checked_text_fields++;
      for (const m of v.matchAll(PLACEHOLDER)) {
        const k = m[1]!.toLowerCase();
        if (keys.has(k)) report.placeholders_used.push(k);
        else report.unknown_placeholders.push({ field: path, key: k });
      }
      const text = v.replace(PLACEHOLDER, " ").replace(INTERNAL_ID, (id) => {
        report.internal_ids_in_text.push({ field: path, text: id });
        return " ";
      });
      for (const raw of findRawFigures(text)) {
        if (matchesFigure(raw, figures, ids)) report.literal_figures_matched.push(raw.text);
        else report.ungrounded_figures.push({ field: path, text: raw.text });
      }
      for (const n of findStrayNumbers(text, figures, ids)) report.ungrounded_figures.push({ field: path, text: n });
    } else if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${path}[${i}]`, parentKey));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k, k);
  };
  visit(draft, "", "");
  report.placeholders_used = [...new Set(report.placeholders_used)];
  report.passed = !report.ungrounded_figures.length && !report.unknown_placeholders.length && !report.unknown_evidence_ids.length && !report.internal_ids_in_text.length;
  return report;
}

export function describeGroundingFailure(r: GroundingReport): string {
  const lines: string[] = [];
  for (const u of r.ungrounded_figures) lines.push(`- ${u.field}: "${u.text}" is not one of the provided figures. Use a {{placeholder}} from the FIGURES table or remove it.`);
  for (const u of r.internal_ids_in_text) {
    lines.push(
      u.text === "twelve_month_3pct"
        ? `- ${u.field}: "${u.text}" is an internal option code. In text, write the option's name in words ("the 12-month renewal"); use the code only in option key fields.`
        : `- ${u.field}: "${u.text}" is an internal record id. Never write ids in text; name the unit, ticket or lease in words and put ids only in evidence_ids.`,
    );
  }
  for (const u of r.unknown_placeholders) lines.push(`- ${u.field}: {{${u.key}}} is not a figure key. Use only keys from the FIGURES table.`);
  for (const id of r.unknown_evidence_ids) lines.push(`- evidence id "${id}" does not exist. Use only ids from the EVIDENCE list.`);
  return lines.join("\n");
}

/** Replace placeholders with the stored figure display values. */
export function renderTemplate(text: string, figures: Figure[]): string {
  const byKey = new Map(figures.map((f) => [f.key, f]));
  return text.replace(PLACEHOLDER, (all, k: string) => byKey.get(k.toLowerCase())?.display ?? all);
}

/** Deep-render every string in a draft. */
export function renderDeep<T>(v: T, figures: Figure[]): T {
  if (typeof v === "string") return renderTemplate(v, figures) as T;
  if (Array.isArray(v)) return v.map((x) => renderDeep(x, figures)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x, figures)])) as T;
  return v;
}
