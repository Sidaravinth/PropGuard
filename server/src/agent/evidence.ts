/** Evidence (citations) and figures (numbers) shared by the agent and the brief services. */

export type EvidenceKind = "lease" | "lease_field" | "clause" | "ledger_entry" | "ledger" | "ticket" | "policy_evaluation" | "tenant" | "unit" | "policy_rule";

/** A citation to a database record (and, for lease data, the exact source excerpt). */
export interface Evidence {
  id: string; // e.g. "lease:3", "clause:12", "ledger:45", "evaluation:9"
  kind: EvidenceKind;
  label: string;
  record: { table: string; id: string | number };
  value?: string | number | null;
  status?: string | null;
  snippet?: string | null;
  source_doc?: string | null;
  section_ref?: string | null;
  page?: number | null;
}

/**
 * Where a figure's value comes from, so it can be re-verified against the database at any time:
 * a stored column, a stored policy evaluation, a policy constant, or a named deterministic rule.
 */
export type FigureSource =
  | { kind: "column"; table: "leases" | "maintenance_tickets" | "payment_ledger"; pk: string; id: string | number; column: string }
  | { kind: "evaluation"; evaluation_id: number; path: string }
  | { kind: "policy_constant"; name: string }
  | { kind: "derived"; rule: string; inputs: Record<string, string | number | null> };

export interface Figure {
  key: string;
  label: string;
  unit: "cents" | "days" | "months" | "percent" | "date" | "count" | "text";
  value: number | string | null;
  /** Human-readable rendering used wherever the model references {{key}}. */
  display: string;
  evidence_ids: string[];
  source: FigureSource;
}

export class EvidenceRegistry {
  private readonly items = new Map<string, Evidence>();
  add(...evidence: Evidence[]): void {
    for (const e of evidence) this.items.set(e.id, e);
  }
  has(id: string): boolean {
    return this.items.has(id);
  }
  all(): Evidence[] {
    return [...this.items.values()];
  }
}

const usd = (cents: number) => {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
};

export function displayFor(unit: Figure["unit"], value: number | string | null): string {
  if (value === null) return "not available";
  switch (unit) {
    case "cents":
      return usd(value as number);
    case "days":
      return `${value} day${value === 1 ? "" : "s"}`;
    case "months":
      return `${value} month${value === 1 ? "" : "s"}`;
    case "percent":
      return `${value}%`;
    case "date":
      return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    default:
      return String(value);
  }
}

export function figure(key: string, label: string, unit: Figure["unit"], value: number | string | null, evidence_ids: string[], source: FigureSource): Figure {
  return { key, label, unit, value, display: displayFor(unit, value), evidence_ids, source };
}
