import type { LeaseFieldName } from "../api/leases";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const formatCents = (cents: number | null | undefined): string => (cents === null || cents === undefined ? "—" : usd.format(cents / 100));

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : undefined });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Parse a dollar amount typed by a user into integer cents, without float rounding surprises. */
export function parseDollarsToCents(input: string): number | null {
  const s = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export const centsToDollarInput = (cents: number | null): string => (cents === null ? "" : (cents / 100).toFixed(2));

export const FIELD_META: Record<LeaseFieldName, { label: string; kind: "money" | "date" | "days" | "text" }> = {
  tenant_name: { label: "Tenant name", kind: "text" },
  property_name: { label: "Property", kind: "text" },
  unit_number: { label: "Unit number", kind: "text" },
  start_date: { label: "Lease start", kind: "date" },
  end_date: { label: "Lease end", kind: "date" },
  monthly_rent: { label: "Monthly rent", kind: "money" },
  security_deposit: { label: "Security deposit", kind: "money" },
  notice_period_days: { label: "Notice period", kind: "days" },
  repair_deductible: { label: "Repair deductible", kind: "money" },
};

/** Display a field's stored text value (cents / ISO date / days / text). */
export function formatFieldValue(field: LeaseFieldName, valueText: string | null): string {
  if (valueText === null || valueText === "") return "—";
  switch (FIELD_META[field].kind) {
    case "money":
      return formatCents(Number(valueText));
    case "date":
      return formatDate(valueText);
    case "days":
      return `${valueText} days`;
    default:
      return valueText;
  }
}

export const CLAUSE_LABEL: Record<string, string> = {
  rent: "Rent", deposit: "Deposit", repair: "Repair", pet: "Pet", notice: "Notice",
  renewal: "Renewal", late_fee: "Late fee", other: "Other",
};

export function gapLabel(field: string): string {
  if (field === "unit_link") return "Unit link";
  if (field === "tenant_link") return "Tenant link";
  if (field.startsWith("clause:")) return `${CLAUSE_LABEL[field.slice(7)] ?? field.slice(7)} clause`;
  return FIELD_META[field as LeaseFieldName]?.label ?? field;
}
