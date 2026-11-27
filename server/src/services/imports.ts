/**
 * Spreadsheet imports (tenants, payment ledger) from CSV or XLSX.
 *
 *   preview: parse → map columns → validate every row → flag duplicates. Nothing is written.
 *   commit:  the same steps again on the server (the client's preview is never trusted), then the
 *            original file is stored and the valid, non-duplicate rows are inserted in one
 *            transaction, each linked to the import's document record.
 */
import crypto from "node:crypto";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { readSheet } from "read-excel-file/node";
import { ApiError } from "../api/errors.js";
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import type { DocumentStore } from "../storage/documentStore.js";
import { deriveStatus, isMonth, ledgerDuplicate } from "./ledger.js";
import { createTenant, TENANT_STATUSES, tenantDuplicate, type TenantStatus } from "./records.js";

export type ImportKind = "tenants" | "ledger";
const DOC_KIND = { tenants: "tenant_import", ledger: "ledger_import" } as const;
const MAX_ROWS = 5000;

export interface TargetField {
  key: string;
  label: string;
  required?: boolean;
  synonyms: string[];
  hint?: string;
}

export const TARGET_FIELDS: Record<ImportKind, TargetField[]> = {
  tenants: [
    { key: "name", label: "Tenant name", required: true, synonyms: ["name", "tenant", "tenantname", "fullname", "resident", "lessee"] },
    { key: "email", label: "Email", synonyms: ["email", "emailaddress", "mail"] },
    { key: "phone", label: "Phone", synonyms: ["phone", "phonenumber", "mobile", "telephone", "tel"] },
    { key: "unit_id", label: "Unit ID", synonyms: ["unitid"], hint: "e.g. U101" },
    { key: "property_name", label: "Property name", synonyms: ["property", "propertyname", "building", "complex"] },
    { key: "unit_number", label: "Unit number", synonyms: ["unit", "unitnumber", "unitno", "apartment", "apt", "suite"] },
    { key: "status", label: "Status", synonyms: ["status", "tenantstatus"], hint: TENANT_STATUSES.join(", ") },
  ],
  ledger: [
    { key: "tenant_id", label: "Tenant ID", synonyms: ["tenantid"], hint: "e.g. T001" },
    { key: "tenant_email", label: "Tenant email", synonyms: ["email", "tenantemail"] },
    { key: "tenant_name", label: "Tenant name", synonyms: ["tenant", "tenantname", "name", "resident"] },
    { key: "month", label: "Month", required: true, synonyms: ["month", "period", "rentmonth", "billingmonth", "date", "duedate"], hint: "YYYY-MM, a date, or e.g. Nov 2026" },
    { key: "amount_due", label: "Amount due", required: true, synonyms: ["amountdue", "due", "rentdue", "charged", "rent", "amountcharged"] },
    { key: "amount_paid", label: "Amount paid", required: true, synonyms: ["amountpaid", "paid", "payment", "received", "amountreceived"] },
    { key: "status", label: "Status", synonyms: ["status", "paymentstatus"], hint: "optional; derived from the amounts if empty" },
  ],
};

export type Mapping = Record<string, number | null>;

export interface ParsedSheet {
  headers: string[];
  rows: string[][];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v).trim();
}

export async function parseSpreadsheet(fileName: string, bytes: Buffer): Promise<ParsedSheet> {
  const ext = path.extname(fileName).toLowerCase();
  let grid: string[][];
  try {
    if (ext === ".csv") {
      grid = (parseCsv(bytes, { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true }) as unknown[][]).map((r) => r.map(cellToString));
    } else if (ext === ".xlsx") {
      grid = (await readSheet(bytes)).map((r) => r.map(cellToString));
    } else {
      throw new ApiError(422, "UNSUPPORTED_FILE", `Unsupported file type "${ext || "none"}": upload a .csv or .xlsx spreadsheet`);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(422, "UNREADABLE_SPREADSHEET", `The spreadsheet could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  grid = grid.filter((r) => r.some((c) => c !== ""));
  if (grid.length < 2) throw new ApiError(422, "EMPTY_SPREADSHEET", "The spreadsheet needs a header row and at least one data row");
  const [headers, ...rows] = grid;
  if (rows.length > MAX_ROWS) throw new ApiError(422, "TOO_MANY_ROWS", `At most ${MAX_ROWS} rows per import`);
  const width = headers!.length;
  return { headers: headers!.map((h, i) => h || `Column ${i + 1}`), rows: rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? "")) };
}

export function suggestMapping(kind: ImportKind, headers: string[]): Mapping {
  const used = new Set<number>();
  const mapping: Mapping = {};
  // Pass 1: exact (normalised) header matches. Pass 2: a header containing a synonym, e.g. "Rent Paid" ⊃ "paid".
  // Only a suggestion: the user confirms the mapping in the preview before anything is imported.
  const passes: ((h: string, s: string) => boolean)[] = [(h, s) => h === s, (h, s) => s.length >= 4 && h.includes(s)];
  for (const matches of passes) {
    for (const f of TARGET_FIELDS[kind]) {
      if (mapping[f.key] !== undefined && mapping[f.key] !== null) continue;
      const idx = headers.findIndex((h, i) => !used.has(i) && f.synonyms.some((s) => matches(norm(h), s)));
      mapping[f.key] = idx >= 0 ? idx : null;
      if (idx >= 0) used.add(idx);
    }
  }
  return mapping;
}

function validateMapping(kind: ImportKind, mapping: Mapping, width: number): void {
  for (const [k, v] of Object.entries(mapping)) {
    if (!TARGET_FIELDS[kind].some((f) => f.key === k)) throw new ApiError(400, "VALIDATION_ERROR", `Unknown field "${k}" in mapping`);
    if (v !== null && (!Number.isInteger(v) || v < 0 || v >= width)) throw new ApiError(400, "VALIDATION_ERROR", `Column index for "${k}" is out of range`);
  }
  const missing = TARGET_FIELDS[kind].filter((f) => f.required && (mapping[f.key] === null || mapping[f.key] === undefined)).map((f) => f.label);
  if (missing.length) throw new ApiError(400, "MAPPING_INCOMPLETE", `Map a column to: ${missing.join(", ")}`);
  if (kind === "ledger" && ["tenant_id", "tenant_email", "tenant_name"].every((k) => mapping[k] === null || mapping[k] === undefined)) {
    throw new ApiError(400, "MAPPING_INCOMPLETE", "Map a column that identifies the tenant (Tenant ID, email or name)");
  }
}

// --- value parsing (deterministic) ----------------------------------------------------------

/** "$1,500.00" / "1500" / "1500.5" → cents. Negative, non-numeric or > $1M is an error. */
export function parseMoney(raw: string): number | string {
  const s = raw.replace(/[$,\s]/g, "").replace(/^USD/i, "");
  if (s === "") return "is empty";
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return `"${raw}" is not a valid non-negative amount`;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return cents > 100_000_000 ? `"${raw}" is too large` : cents;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const okYear = (y: number) => y >= 1990 && y <= 2100;

/** Accepts YYYY-MM, YYYY-MM-DD, YYYY/MM, MM/YYYY, "Nov 2026", "November 2026". Day/month-ambiguous dates are rejected. */
export function parseMonth(raw: string): string | { error: string } {
  const s = raw.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/))) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (okYear(y) && mo >= 1 && mo <= 12) return `${y}-${pad(mo)}`;
  } else if ((m = s.match(/^(\d{1,2})[-/](\d{4})$/))) {
    const [mo, y] = [Number(m[1]), Number(m[2])];
    if (okYear(y) && mo >= 1 && mo <= 12) return `${y}-${pad(mo)}`;
  } else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a <= 12 && b <= 12 && a !== b) return { error: `"${raw}" is ambiguous (day/month order); use YYYY-MM` };
    const mo = a > 12 ? b : a;
    if (okYear(y) && mo >= 1 && mo <= 12) return `${y}-${pad(mo)}`;
  } else if ((m = s.match(/^([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/))) {
    const idx = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    if (idx >= 0 && okYear(Number(m[2]))) return `${m[2]}-${pad(idx + 1)}`;
  }
  return { error: `"${raw}" is not a recognisable month` };
}

// --- row validation -------------------------------------------------------------------------------

export interface PreviewRow {
  row_number: number; // spreadsheet row (header is row 1)
  values: Record<string, string>;
  normalized: Record<string, string | number | null> | null;
  errors: string[];
  duplicate: string | null;
  action: "import" | "skip";
}

export interface PreviewResult {
  kind: ImportKind;
  file_name: string;
  headers: string[];
  mapping: Mapping;
  fields: TargetField[];
  rows: PreviewRow[];
  summary: { total: number; importable: number; errors: number; duplicates: number };
  /** Set when the suggested mapping is missing required columns; the user must finish the mapping. */
  mapping_error?: string;
}

const get = (row: string[], mapping: Mapping, key: string) => {
  const i = mapping[key];
  return i === null || i === undefined ? "" : (row[i] ?? "").trim();
};

function validateTenantRows(db: DB, sheet: ParsedSheet, mapping: Mapping): PreviewRow[] {
  const seenEmail = new Map<string, number>();
  const seenNameUnit = new Map<string, number>();
  return sheet.rows.map((row, i) => {
    const rowNumber = i + 2;
    const v = Object.fromEntries(TARGET_FIELDS.tenants.map((f) => [f.key, get(row, mapping, f.key)]));
    const errors: string[] = [];
    if (!v.name) errors.push("Tenant name is empty");
    else if (v.name.length > 120) errors.push("Tenant name is longer than 120 characters");
    const email = v.email?.toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`"${v.email}" is not a valid email`);
    let status: TenantStatus = "active";
    if (v.status) {
      const s = v.status.toLowerCase().replace(/[\s-]+/g, "_");
      if ((TENANT_STATUSES as readonly string[]).includes(s)) status = s as TenantStatus;
      else errors.push(`Status "${v.status}" must be one of ${TENANT_STATUSES.join(", ")}`);
    }
    let unitId: string | null = null;
    if (v.unit_id) {
      if (repo.getUnit(db, v.unit_id)) unitId = v.unit_id;
      else errors.push(`Unit ${v.unit_id} does not exist`);
    } else if (v.property_name || v.unit_number) {
      if (!v.property_name || !v.unit_number) errors.push("Give both property name and unit number (or a unit ID)");
      else {
        const u = repo.findUnitByLabel(db, v.property_name, v.unit_number);
        if (u) unitId = u.unit_id;
        else errors.push(`Unit ${v.unit_number} at ${v.property_name} does not exist; add it under Properties & Units first`);
      }
    }
    let duplicate: string | null = null;
    if (!errors.length) {
      duplicate = tenantDuplicate(db, { name: v.name!, email, unit_id: unitId });
      const nameKey = unitId ? `${unitId}|${v.name!.toLowerCase()}` : null;
      if (!duplicate && email && seenEmail.has(email)) duplicate = `Same email as row ${seenEmail.get(email)}`;
      if (!duplicate && nameKey && seenNameUnit.has(nameKey)) duplicate = `Same tenant and unit as row ${seenNameUnit.get(nameKey)}`;
      if (!duplicate) {
        if (email) seenEmail.set(email, rowNumber);
        if (nameKey) seenNameUnit.set(nameKey, rowNumber);
      }
    }
    return {
      row_number: rowNumber,
      values: v,
      normalized: errors.length ? null : { name: v.name!, email, phone: v.phone || null, unit_id: unitId, status },
      errors,
      duplicate,
      action: errors.length || duplicate ? "skip" : "import",
    };
  });
}

function resolveTenant(db: DB, v: Record<string, string>): { tenant_id: string } | { error: string } {
  if (v.tenant_id) return repo.getTenant(db, v.tenant_id) ? { tenant_id: v.tenant_id } : { error: `Tenant ${v.tenant_id} does not exist` };
  if (v.tenant_email) {
    const t = db.prepare("SELECT tenant_id FROM tenants WHERE lower(email) = lower(?)").get(v.tenant_email) as { tenant_id: string } | undefined;
    return t ?? { error: `No tenant has email ${v.tenant_email}` };
  }
  if (v.tenant_name) {
    const ts = db.prepare("SELECT tenant_id FROM tenants WHERE lower(trim(name)) = lower(trim(?))").all(v.tenant_name) as { tenant_id: string }[];
    if (ts.length === 1) return ts[0]!;
    return { error: ts.length ? `"${v.tenant_name}" matches ${ts.length} tenants; use Tenant ID or email` : `No tenant named "${v.tenant_name}"` };
  }
  return { error: "Tenant is empty" };
}

function validateLedgerRows(db: DB, sheet: ParsedSheet, mapping: Mapping): PreviewRow[] {
  const seen = new Map<string, number>();
  return sheet.rows.map((row, i) => {
    const rowNumber = i + 2;
    const v = Object.fromEntries(TARGET_FIELDS.ledger.map((f) => [f.key, get(row, mapping, f.key)]));
    const errors: string[] = [];
    const tenant = resolveTenant(db, v);
    if ("error" in tenant) errors.push(tenant.error);
    const month = v.month ? parseMonth(v.month) : { error: "Month is empty" };
    if (typeof month !== "string") errors.push(month.error);
    const due = parseMoney(v.amount_due ?? "");
    const paid = parseMoney(v.amount_paid ?? "");
    if (typeof due === "string") errors.push(`Amount due ${due}`);
    if (typeof paid === "string") errors.push(`Amount paid ${paid}`);
    let status: string | null = null;
    if (typeof due === "number" && typeof paid === "number") {
      try {
        status = deriveStatus(due, paid, v.status || null);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    let duplicate: string | null = null;
    if (!errors.length && "tenant_id" in tenant && typeof month === "string" && isMonth(month)) {
      const existing = ledgerDuplicate(db, tenant.tenant_id, month);
      const key = `${tenant.tenant_id}|${month}`;
      if (existing) duplicate = `${tenant.tenant_id} already has an entry for ${month}`;
      else if (seen.has(key)) duplicate = `Same tenant and month as row ${seen.get(key)}`;
      else seen.set(key, rowNumber);
    }
    return {
      row_number: rowNumber,
      values: v,
      normalized: errors.length
        ? null
        : { tenant_id: (tenant as { tenant_id: string }).tenant_id, month: month as string, amount_due_cents: due as number, amount_paid_cents: paid as number, status },
      errors,
      duplicate,
      action: errors.length || duplicate ? "skip" : "import",
    };
  });
}

export async function previewImport(db: DB, kind: ImportKind, file: { name: string; bytes: Buffer }, mapping?: Mapping): Promise<PreviewResult> {
  const sheet = await parseSpreadsheet(file.name, file.bytes);
  const m = mapping ?? suggestMapping(kind, sheet.headers);
  // A fresh suggestion may be incomplete; report rows only once required columns are mapped.
  let rows: PreviewRow[] = [];
  let mappingError: ApiError | null = null;
  try {
    validateMapping(kind, m, sheet.headers.length);
    rows = kind === "tenants" ? validateTenantRows(db, sheet, m) : validateLedgerRows(db, sheet, m);
  } catch (e) {
    if (!(e instanceof ApiError) || mapping) throw e;
    mappingError = e;
  }
  return {
    kind,
    file_name: file.name,
    headers: sheet.headers,
    mapping: m,
    fields: TARGET_FIELDS[kind],
    rows,
    summary: {
      total: sheet.rows.length,
      importable: rows.filter((r) => r.action === "import").length,
      errors: rows.filter((r) => r.errors.length).length,
      duplicates: rows.filter((r) => !r.errors.length && r.duplicate).length,
    },
    ...(mappingError ? { mapping_error: mappingError.message } : {}),
  };
}

export async function commitImport(db: DB, store: DocumentStore, kind: ImportKind, file: { name: string; bytes: Buffer }, mapping: Mapping, userId: number) {
  const sha256 = crypto.createHash("sha256").update(file.bytes).digest("hex");
  const prior = db.prepare("SELECT document_id, doc_name, uploaded_at FROM documents WHERE sha256 = ?").get(sha256) as
    | { document_id: number; doc_name: string; uploaded_at: string }
    | undefined;
  if (prior) throw new ApiError(409, "DUPLICATE_IMPORT", `This file was already imported as "${prior.doc_name}"`, prior);

  const preview = await previewImport(db, kind, file, mapping);
  const importable = preview.rows.filter((r) => r.action === "import");
  if (!importable.length) throw new ApiError(422, "NOTHING_TO_IMPORT", "No rows can be imported; fix the errors shown in the preview", preview.summary);

  const ext = path.extname(file.name).toLowerCase();
  const storageKey = await store.put(file.bytes, ext);
  const base = path.basename(file.name).replace(/[^\w.\- ()]+/g, "_");
  const stem = base.slice(0, base.length - ext.length);
  let docName = base;
  for (let i = 2; db.prepare("SELECT 1 FROM documents WHERE doc_name = ?").get(docName); i++) docName = `${stem} (${i})${ext}`;

  return tx(db, () => {
    const doc = db
      .prepare(
        `INSERT INTO documents (kind, doc_name, original_filename, mime_type, size_bytes, sha256, storage_key, status, rows_imported, rows_skipped, uploaded_by, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, datetime('now'))`,
      )
      .run(
        DOC_KIND[kind], docName, file.name.slice(0, 255),
        ext === ".csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        file.bytes.length, sha256, storageKey, importable.length, preview.rows.length - importable.length, userId,
      );
    const documentId = Number(doc.lastInsertRowid);
    const created: string[] = [];
    for (const r of importable) {
      const n = r.normalized!;
      if (kind === "tenants") {
        created.push(
          createTenant(db, {
            name: n.name as string, email: n.email as string | null, phone: n.phone as string | null,
            unit_id: n.unit_id as string | null, status: n.status as TenantStatus, source_document_id: documentId,
          }).tenant_id,
        );
      } else {
        const ins = db
          .prepare("INSERT INTO payment_ledger (tenant_id, month, amount_due_cents, amount_paid_cents, status, source_document_id) VALUES (?, ?, ?, ?, ?, ?)")
          .run(n.tenant_id!, n.month!, n.amount_due_cents!, n.amount_paid_cents!, n.status!, documentId);
        created.push(String(ins.lastInsertRowid));
      }
    }
    return {
      document_id: documentId,
      doc_name: docName,
      imported: importable.length,
      skipped: preview.rows.length - importable.length,
      created_ids: created,
      skipped_rows: preview.rows.filter((r) => r.action === "skip").map((r) => ({ row_number: r.row_number, reason: r.errors.join("; ") || r.duplicate })),
    };
  });
}
