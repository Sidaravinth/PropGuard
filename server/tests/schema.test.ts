import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import { leaseState, leaseSummary, unpaidBalanceCents, type LeaseRow } from "../src/db/repo.js";
import { seedStructured } from "../src/db/seed.js";
import { TENANTS, TICKETS, UNITS } from "../src/db/seedData.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});

const fks = (table: string) =>
  (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; from: string; to: string; on_delete: string }[])
    .map((r) => `${r.from}->${r.table}.${r.to}`)
    .sort();

describe("schema", () => {
  it("creates every required table", () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["units", "tenants", "leases", "lease_clauses", "maintenance_tickets", "payment_ledger", "source_documents", "lease_field_sources", "deposit_ledger", "policy_evaluations"]),
    );
  });

  it("declares the expected foreign keys", () => {
    expect(fks("tenants")).toEqual(["source_document_id->documents.document_id", "unit_id->units.unit_id"]);
    expect(fks("units")).toEqual(["property_id->properties.property_id"]);
    expect(fks("leases")).toEqual(["source_doc_name->source_documents.doc_name", "tenant_id->tenants.tenant_id", "unit_id->units.unit_id"]);
    expect(fks("lease_clauses")).toEqual(["lease_id->leases.lease_id"]);
    expect(fks("maintenance_tickets")).toEqual(["tenant_id->tenants.tenant_id", "unit_id->units.unit_id"]);
    expect(fks("payment_ledger")).toEqual(["source_document_id->documents.document_id", "tenant_id->tenants.tenant_id"]);
  });

  it("enforces foreign keys at runtime", () => {
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(() => db.prepare("INSERT INTO tenants (tenant_id, name, unit_id, status) VALUES ('TX', 'X', 'NOPE', 'active')").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO payment_ledger (tenant_id, month, amount_due_cents, amount_paid_cents, status) VALUES ('NOPE', '2026-11', 1, 0, 'unpaid')").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO maintenance_tickets (unit_id, issue_summary, work_order_amount_cents, technician_quote_amount_cents) VALUES ('NOPE', 'x', 1, 1)").run()).toThrow(/FOREIGN KEY/);
  });

  it("rejects negative money and unknown statuses", () => {
    seedStructured(db);
    expect(() => db.prepare("INSERT INTO maintenance_tickets (unit_id, issue_summary, work_order_amount_cents, technician_quote_amount_cents) VALUES ('U101', 'x', -1, 1)").run()).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO tenants (tenant_id, name, unit_id, status) VALUES ('TX', 'X', 'U101', 'evicted')").run()).toThrow(/CHECK/);
  });

  it("deleting a source document cascades to its lease, clauses and field sources", () => {
    seedStructured(db);
    const leaseId = insertLease({ end_date: "2027-01-15" });
    db.prepare("INSERT INTO lease_clauses (lease_id, clause_type, extracted_text, verified) VALUES (?, 'pet', 'One cat.', 1)").run(leaseId);
    db.prepare("DELETE FROM source_documents WHERE doc_name = 'test.txt'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM lease_clauses").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM leases").get()).toEqual({ n: 0 });
  });
});

function insertLease(over: Partial<LeaseRow>): number {
  db.prepare("INSERT INTO source_documents (doc_name, sha256, mime_type, page_count, raw_text) VALUES ('test.txt', 'x', 'text/plain', 1, 'x')").run();
  const r = db
    .prepare(
      `INSERT INTO leases (tenant_id, unit_id, start_date, end_date, monthly_rent_cents, security_deposit_cents, notice_period_days,
        repair_deductible_cents, source_doc_name, extraction_status, extraction_model)
       VALUES ('T004', 'U202', ?, ?, 195000, 195000, 60, 20000, 'test.txt', 'complete', 'test')`,
    )
    .run(over.start_date ?? "2025-09-01", over.end_date ?? "2026-08-31");
  return Number(r.lastInsertRowid);
}

describe("expired leases", () => {
  const prev = process.env.PROPGUARD_TODAY;
  beforeEach(() => {
    process.env.PROPGUARD_TODAY = "2026-11-26";
    seedStructured(db);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PROPGUARD_TODAY;
    else process.env.PROPGUARD_TODAY = prev;
  });

  it("classifies lease state by end date (end date itself is still active)", () => {
    expect(leaseState({ start_date: "2025-09-01", end_date: "2026-08-31" }, "2026-11-26")).toBe("expired");
    expect(leaseState({ start_date: "2025-09-01", end_date: "2026-11-26" }, "2026-11-26")).toBe("active");
    expect(leaseState({ start_date: "2026-12-01", end_date: "2027-11-30" }, "2026-11-26")).toBe("upcoming");
    expect(leaseState({ start_date: null, end_date: "2026-08-31" }, "2026-11-26")).toBe("unknown");
  });

  it("flags an expired lease as EXPIRED and never as IN_NOTICE_WINDOW", () => {
    const id = insertLease({ end_date: "2026-08-31" });
    const s = leaseSummary(db, db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(id) as unknown as LeaseRow);
    expect(s.lease_state).toBe("expired");
    expect(s.flags).toContain("EXPIRED");
    expect(s.flags).not.toContain("IN_NOTICE_WINDOW");
    expect(s.days_until_end).toBeLessThan(0);
  });

  it("flags an active lease ending within its notice period", () => {
    const id = insertLease({ end_date: "2027-01-15" }); // 50 days out, 60-day notice
    const s = leaseSummary(db, db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(id) as unknown as LeaseRow);
    expect(s.flags).toEqual(expect.arrayContaining(["IN_NOTICE_WINDOW"]));
    expect(s.flags).not.toContain("EXPIRED");
  });
});

describe("seed data scenario", () => {
  beforeEach(() => seedStructured(db));

  it("ships 5 lease documents, including a PDF, with 30/45/60-day notice periods", () => {
    const files = fs.readdirSync(config.leasesDir).filter((f) => /\.(pdf|txt)$/i.test(f));
    expect(files).toHaveLength(5);
    expect(files.some((f) => f.endsWith(".pdf"))).toBe(true);
    const text = files.filter((f) => f.endsWith(".txt")).map((f) => fs.readFileSync(`${config.leasesDir}/${f}`, "utf8")).join("\n");
    for (const n of ["thirty (30)", "forty-five (45)", "sixty (60)"]) expect(text.toLowerCase()).toContain(n);
  });

  it("has matching tenant and unit records", () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(5);
    expect(TENANTS).toHaveLength(5);
    for (const t of TENANTS) expect(UNITS.some((u) => u.unit_id === t.unit_id)).toBe(true);
  });

  it("has at least 2 tickets where the quote exceeds the work order by more than 10%", () => {
    const mismatched = TICKETS.filter((t) => t.technician_quote_amount_cents * 100 > t.work_order_amount_cents * 110);
    expect(mismatched.length).toBeGreaterThanOrEqual(2);
  });

  it("has at least 1 tenant with overdue rent", () => {
    const overdue = TENANTS.filter((t) => unpaidBalanceCents(db, t.tenant_id, "2026-11") > 0);
    expect(overdue.map((t) => t.tenant_id)).toEqual(["T003"]);
  });
});
