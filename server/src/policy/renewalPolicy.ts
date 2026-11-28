/**
 * Deterministic lease-renewal rules: renewal pricing, dates and payment reliability.
 * Pure functions over plain values — no I/O, no AI. The agent only explains these numbers.
 */

export const RENEWAL_RULES = {
  /** Leases whose end date falls within this many days (or within their notice period, if longer) get a brief. */
  WINDOW_DAYS: 60,
  /** Annual adjustment for the 12-month option, in basis points (300 = 3%). */
  TWELVE_MONTH_ADJUSTMENT_BPS: 300,
  /** Renewal decisions are lease decisions: Property Manager tier (a Regional Director may also approve). */
  REQUIRED_APPROVER: "PROPERTY_MANAGER" as const,
} as const;

export type RenewalOptionKey = "standard" | "twelve_month_3pct" | "month_to_month";
export const RENEWAL_OPTION_KEYS: RenewalOptionKey[] = ["standard", "twelve_month_3pct", "month_to_month"];

export interface RenewalInput {
  start_date: string | null;
  end_date: string | null;
  monthly_rent_cents: number | null;
  notice_period_days: number | null;
}

export interface RenewalOption {
  key: RenewalOptionKey;
  name: string;
  /** null = rolling month-to-month */
  term_months: number | null;
  /** null when the source data needed to price it is missing */
  proposed_rent_cents: number | null;
  rent_change_cents: number | null;
  new_start_date: string | null;
  new_end_date: string | null;
}

export interface RenewalPlan {
  missing: string[];
  current_term_months: number | null;
  notice_deadline: string | null;
  options: RenewalOption[];
}

// Pure calendar arithmetic (no Date objects, no clock): days since 1970-01-01 <-> civil date.
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}
const pad = (n: number) => String(n).padStart(2, "0");
const toDays = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return daysFromCivil(y, m, d);
};
const fromDays = (z: number) => {
  const [y, m, d] = civilFromDays(z);
  return `${y}-${pad(m)}-${pad(d)}`;
};
const daysInMonth = (y: number, m: number) => daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - daysFromCivil(y, m, 1);

export function addDays(date: string, days: number): string {
  return fromDays(toDays(date) + days);
}

export function daysBetween(from: string, to: string): number {
  return toDays(to) - toDays(from);
}

/** Add calendar months, clamping to the month's last day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

/** Whole months covered by [start, end] inclusive, e.g. 2026-01-16..2027-01-15 = 12. */
export function termMonths(start: string, end: string): number {
  const [sy, sm, sd] = start.split("-").map(Number) as [number, number, number];
  const endNext = addDays(end, 1);
  const [ey, em, ed] = endNext.split("-").map(Number) as [number, number, number];
  let months = (ey - sy) * 12 + (em - sm);
  if (ed < sd) months -= 1;
  return Math.max(months, 0);
}

/** rent × (1 + bps/10000), rounded half-up to the cent, in integer arithmetic. */
export function adjustRent(rentCents: number, bps: number): number {
  return Math.floor((rentCents * (10_000 + bps) + 5_000) / 10_000);
}

export function renewalPlan(input: RenewalInput): RenewalPlan {
  const missing: string[] = [];
  if (input.monthly_rent_cents === null) missing.push("monthly_rent");
  if (!input.end_date) missing.push("end_date");
  if (!input.start_date) missing.push("start_date");
  if (input.notice_period_days === null) missing.push("notice_period_days");

  const rent = input.monthly_rent_cents;
  const newStart = input.end_date ? addDays(input.end_date, 1) : null;
  const currentTerm = input.start_date && input.end_date ? termMonths(input.start_date, input.end_date) : null;
  const priced = rent !== null && newStart !== null;

  const option = (key: RenewalOptionKey, name: string, term: number | null, proposed: number | null): RenewalOption => ({
    key,
    name,
    term_months: term,
    proposed_rent_cents: priced ? proposed : null,
    rent_change_cents: priced && proposed !== null ? proposed - rent! : null,
    new_start_date: newStart,
    new_end_date: newStart && term ? addDays(addMonths(newStart, term), -1) : null,
  });

  return {
    missing,
    current_term_months: currentTerm,
    notice_deadline: input.end_date && input.notice_period_days !== null ? addDays(input.end_date, -input.notice_period_days) : null,
    options: [
      // Standard: same term length and rent as the current lease (needs the current term, i.e. start_date).
      option("standard", "Standard renewal", currentTerm, currentTerm !== null ? rent : null),
      option("twelve_month_3pct", "12-month renewal with 3% adjustment", 12, rent !== null ? adjustRent(rent, RENEWAL_RULES.TWELVE_MONTH_ADJUSTMENT_BPS) : null),
      option("month_to_month", "Month-to-month", null, rent),
    ],
  };
}

export function isRenewalCandidate(daysUntilEnd: number | null, noticePeriodDays: number | null): boolean {
  if (daysUntilEnd === null || daysUntilEnd < 0) return false;
  return daysUntilEnd <= Math.max(RENEWAL_RULES.WINDOW_DAYS, noticePeriodDays ?? 0);
}

// --- payment reliability ---------------------------------------------------------------------

export interface LedgerFact {
  month: string;
  amount_due_cents: number;
  amount_paid_cents: number;
  status: string;
}

export type ReliabilityRating = "reliable" | "mostly_reliable" | "at_risk" | "no_history";

export interface PaymentReliability {
  months_on_record: number;
  paid_on_time: number;
  paid_late: number;
  partial: number;
  unpaid: number;
  outstanding_cents: number;
  on_time_percent: number | null;
  rating: ReliabilityRating;
}

/** Ledger months up to and including asOfMonth only (future months are not yet due). */
export function paymentReliability(entries: LedgerFact[], asOfMonth: string): PaymentReliability {
  const due = entries.filter((e) => e.month <= asOfMonth);
  const count = (s: string) => due.filter((e) => e.status === s).length;
  const outstanding = due.reduce((s, e) => s + Math.max(e.amount_due_cents - e.amount_paid_cents, 0), 0);
  const r = {
    months_on_record: due.length,
    paid_on_time: count("paid"),
    paid_late: count("late_paid"),
    partial: count("partial"),
    unpaid: count("unpaid"),
    outstanding_cents: outstanding,
    on_time_percent: due.length ? Math.floor((count("paid") * 100) / due.length) : null,
  };
  const issues = r.paid_late + r.partial + r.unpaid;
  const rating: ReliabilityRating = !due.length ? "no_history" : outstanding > 0 || issues > 2 ? "at_risk" : issues > 0 ? "mostly_reliable" : "reliable";
  return { ...r, rating };
}

export function renewalPriority(daysUntilNoticeDeadline: number | null, rating: ReliabilityRating, missingData: boolean): "high" | "medium" | "low" {
  if (missingData || rating === "at_risk" || (daysUntilNoticeDeadline !== null && daysUntilNoticeDeadline <= 14)) return "high";
  if (rating === "reliable" && daysUntilNoticeDeadline !== null && daysUntilNoticeDeadline > 30) return "low";
  return "medium";
}
