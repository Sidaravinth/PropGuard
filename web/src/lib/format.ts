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
  landlord_name: { label: "Landlord", kind: "text" },
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
  renewal: "Renewal", late_fee: "Late fee", termination: "Termination", payment: "Payment terms", other: "Other",
};

export function gapLabel(field: string): string {
  if (field === "unit_link") return "Unit link";
  if (field === "tenant_link") return "Tenant link";
  if (field.startsWith("clause:")) return `${CLAUSE_LABEL[field.slice(7)] ?? field.slice(7)} clause`;
  if (field.startsWith("ocr_page:")) return `OCR quality, page ${field.slice(9)}`;
  return FIELD_META[field as LeaseFieldName]?.label ?? field;
}

/** Shown wherever documents are uploaded or their extracted data is reviewed. */
export const OCR_WARNING =
  "Document extraction uses OCR and AI to interpret uploaded agreements. OCR may not accurately recognize all text, especially in low-quality scans, handwritten sections, complex tables, or unusual document layouts. Extracted information may contain errors or omissions. Please review and verify all extracted fields against the original agreement before relying on them.";

type DocStatus = { status: "processing" | "extracted" | "needs_review" | "failed" | "imported"; processing_stage?: string | null };

/** The processing status in words: Uploaded, Text extraction / OCR / AI extraction in progress, Review required, Completed, Failed. */
export function documentStatusLabel(d: DocStatus): string {
  if (d.status === "processing") {
    switch (d.processing_stage) {
      case "text_extraction":
        return "Text extraction in progress";
      case "ocr":
        return "OCR in progress";
      case "ai_extraction":
        return "AI extraction in progress";
      default:
        return "Uploaded";
    }
  }
  if (d.status === "needs_review") return "Review required";
  if (d.status === "failed") return "Failed";
  return "Completed";
}

export function textMethodLabel(method: "text" | "ocr" | "mixed" | null | undefined): string | null {
  if (method === "ocr") return "Read by OCR";
  if (method === "mixed") return "Text + OCR";
  if (method === "text") return "Digital text";
  return null;
}
