import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import { seedStructured } from "../src/db/seed.js";
import { parseMoney, parseMonth } from "../src/services/imports.js";
import { deriveStatus } from "../src/services/ledger.js";
import { LocalDocumentStore } from "../src/storage/documentStore.js";
import { signedIn, testAuth } from "./authHelpers.js";
import { readLease, scriptedLlm, sharmaExtraction } from "./fixtures.js";

let tmp: string;
let db: DB;
let pm: Agent;
let rd: Agent;
let store: LocalDocumentStore;
const prevToday = process.env.PROPGUARD_TODAY;

beforeEach(async () => {
  process.env.PROPGUARD_TODAY = "2026-11-26";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "propguard-rec-"));
  store = new LocalDocumentStore(path.join(tmp, "uploads"));
  db = openDb(":memory:");
  migrate(db);
  const auth = testAuth(db);
  const app = createApp({ db, auth, store, llm: () => scriptedLlm([JSON.stringify(sharmaExtraction())]) });
  pm = await signedIn(app, "pm");
  rd = await signedIn(app, "rd");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (prevToday === undefined) delete process.env.PROPGUARD_TODAY;
  else process.env.PROPGUARD_TODAY = prevToday;
});

const csv = (s: string) => Buffer.from(s.trim() + "\n");
const preview = (kind: string, file: Buffer, name = "data.csv", mapping?: object) => {
  const req = pm.post(`/api/imports/${kind}/preview`).attach("file", file, name);
  return mapping ? req.field("mapping", JSON.stringify(mapping)) : req;
};
const commit = (kind: string, file: Buffer, mapping: object, name = "data.csv") =>
  pm.post(`/api/imports/${kind}/commit`).attach("file", file, name).field("mapping", JSON.stringify(mapping));

describe("starts empty (user-driven)", () => {
  it("a fresh database has no operational records and the dashboard shows zeros", async () => {
    const d = (await pm.get("/api/dashboard").expect(200)).body.data;
    expect(d.summary).toEqual({
      properties: 0, units: 0, occupied_units: 0, tenants: 0, active_leases: 0, expiring_leases: 0, pending_tickets: 0, outstanding_rent_cents: 0,
    });
    expect(d.activity.uploads).toEqual([]);
  });
});

describe("properties and units", () => {
  it("creates, edits and lists properties with occupancy", async () => {
    const p = (await pm.post("/api/properties").send({ name: "Birch House", address: "1 Birch Rd" }).expect(201)).body.data;
    await pm.post("/api/properties").send({ name: "birch house" }).expect(409);
    const u1 = (await pm.post("/api/units").send({ property_id: p.property_id, unit_number: "1A", base_rent_cents: 120_000 }).expect(201)).body.data;
    await pm.post("/api/units").send({ property_id: p.property_id, unit_number: "2A", base_rent_cents: 130_000 }).expect(201);
    await pm.post("/api/units").send({ property_id: p.property_id, unit_number: "1a", base_rent_cents: 1 }).expect(409);
    await pm.post("/api/tenants").send({ name: "Ana Diaz", unit_id: u1.unit_id }).expect(201);

    const list = (await pm.get("/api/properties").expect(200)).body.data;
    expect(list[0]).toMatchObject({ name: "Birch House", unit_count: 2, occupied_count: 1 });

    // Renaming a property renames it on its units (used for lease linking).
    await pm.patch(`/api/properties/${p.property_id}`).send({ name: "Birch Court" }).expect(200);
    const unit = (await pm.get(`/api/units/${u1.unit_id}`).expect(200)).body.data;
    expect(unit).toMatchObject({ property_name: "Birch Court", occupied: true, tenants: [{ name: "Ana Diaz" }] });

    const edited = (await pm.patch(`/api/units/${u1.unit_id}`).send({ base_rent_cents: 125_000 }).expect(200)).body.data;
    expect(edited.base_rent_cents).toBe(125_000);
    await pm.patch(`/api/units/${u1.unit_id}`).send({ unit_number: "2A" }).expect(409);
  });

  it("validates input", async () => {
    await pm.post("/api/properties").send({ name: "" }).expect(400);
    await pm.post("/api/units").send({ property_id: 999, unit_number: "1", base_rent_cents: 1 }).expect(422);
    await pm.post("/api/units").send({ property_name: "X", unit_number: "1", base_rent_cents: -5 }).expect(400);
    await pm.post("/api/units").send({ property_name: "X", unit_number: "1", base_rent_cents: 10.5 }).expect(400);
  });

  it("the Regional Director can manage records too (no extra role restrictions)", async () => {
    await rd.post("/api/properties").send({ name: "Director Plaza" }).expect(201);
  });
});

describe("tenants", () => {
  beforeEach(() => seedStructured(db));

  it("creates and edits tenants with duplicate checks", async () => {
    const t = (await pm.post("/api/tenants").send({ name: "New Person", email: "New@Example.com", phone: "555-0100", unit_id: "U302" }).expect(201)).body.data;
    expect(t).toMatchObject({ email: "new@example.com", phone: "555-0100", status: "active" });
    await pm.post("/api/tenants").send({ name: "Other", email: "new@example.com" }).expect(409);
    await pm.post("/api/tenants").send({ name: "new person", unit_id: "U302" }).expect(409);
    await pm.post("/api/tenants").send({ name: "Bad", email: "not-an-email" }).expect(400);
    await pm.post("/api/tenants").send({ name: "Bad", status: "evicted" }).expect(400);
    await pm.patch(`/api/tenants/${t.tenant_id}`).send({ email: "priya.sharma@example.com" }).expect(409);
    const e = (await pm.patch(`/api/tenants/${t.tenant_id}`).send({ status: "notice_given", phone: null }).expect(200)).body.data;
    expect(e).toMatchObject({ status: "notice_given", phone: null });
  });

  it("profile shows unit, leases, payments and maintenance history", async () => {
    await pm.post("/api/documents/leases").attach("file", readLease("lease_maple_101_sharma.txt"), "lease_maple_101_sharma.txt").expect(201);
    const p = (await pm.get("/api/tenants/T001").expect(200)).body.data;
    expect(p).toMatchObject({ tenant_id: "T001", property_name: "Maple Court Apartments", unit_number: "101", unpaid_balance_cents: 0 });
    expect(p.leases).toHaveLength(1);
    expect(p.ledger.length).toBeGreaterThan(0);
    expect(p.tickets.map((t: { ticket_id: number }) => t.ticket_id)).toEqual(expect.arrayContaining([1, 7]));
  });
});

describe("payment ledger", () => {
  beforeEach(() => seedStructured(db));

  it("derives status from the amounts and rejects contradictions", () => {
    expect(deriveStatus(150_000, 150_000)).toBe("paid");
    expect(deriveStatus(150_000, 50_000)).toBe("partial");
    expect(deriveStatus(150_000, 0)).toBe("unpaid");
    expect(deriveStatus(150_000, 150_000, "late paid")).toBe("late_paid");
    expect(() => deriveStatus(150_000, 0, "paid")).toThrow(/contradicts/);
    expect(() => deriveStatus(150_000, 10, "late_paid")).toThrow(/late_paid/);
  });

  it("adds, edits and filters entries; duplicates are refused", async () => {
    const e = (await pm.post("/api/ledger").send({ tenant_id: "T001", month: "2026-12", amount_due_cents: 150_000, amount_paid_cents: 0 }).expect(201)).body.data;
    expect(e.status).toBe("unpaid");
    expect((await pm.post("/api/ledger").send({ tenant_id: "T001", month: "2026-12", amount_due_cents: 1, amount_paid_cents: 0 }).expect(409)).body.error.code).toBe("DUPLICATE_LEDGER_ENTRY");
    await pm.post("/api/ledger").send({ tenant_id: "T001", month: "2026-13", amount_due_cents: 1, amount_paid_cents: 0 }).expect(400);
    await pm.post("/api/ledger").send({ tenant_id: "T999", month: "2026-12", amount_due_cents: 1, amount_paid_cents: 0 }).expect(422);
    await pm.post("/api/ledger").send({ tenant_id: "T001", month: "2026-11", amount_due_cents: 1.5, amount_paid_cents: 0 }).expect(400);

    const paid = (await pm.patch(`/api/ledger/${e.entry_id}`).send({ amount_paid_cents: 150_000 }).expect(200)).body.data;
    expect(paid.status).toBe("paid");

    const overdue = (await pm.get("/api/ledger?filter=overdue").expect(200)).body.data;
    expect(overdue.every((r: { overdue: boolean; tenant_id: string }) => r.overdue && r.tenant_id === "T003")).toBe(true);
    expect(overdue.map((r: { month: string }) => r.month).sort()).toEqual(["2026-10", "2026-11"]);
    // A future month with nothing paid is outstanding but not overdue.
    await pm.post("/api/ledger").send({ tenant_id: "T002", month: "2027-01", amount_due_cents: 165_000, amount_paid_cents: 0 }).expect(201);
    expect((await pm.get("/api/ledger?filter=overdue").expect(200)).body.data).toHaveLength(2);

    const s = (await pm.get("/api/ledger/summary").expect(200)).body.data;
    expect(s.total_outstanding_cents).toBe(315_000);
    expect(s.overdue_tenants).toEqual([expect.objectContaining({ tenant_id: "T003", balance_cents: 315_000, oldest_unpaid_month: "2026-10" })]);
  });

  it("the policy engine reacts to ledger entries added by a user", async () => {
    await pm.post("/api/documents/leases").attach("file", readLease("lease_maple_101_sharma.txt"), "lease_maple_101_sharma.txt").expect(201);
    const before = (await pm.post("/api/tickets/1/policy-check").expect(200)).body.data.result;
    expect(before.exceptions.map((x: { code: string }) => x.code)).not.toContain("UNPAID_BALANCE");
    await pm.post("/api/ledger").send({ tenant_id: "T001", month: "2026-11", amount_due_cents: 1, amount_paid_cents: 0 }).expect(409); // already exists
    const nov = (await pm.get("/api/ledger?tenant_id=T001").expect(200)).body.data.find((r: { month: string }) => r.month === "2026-11");
    await pm.patch(`/api/ledger/${nov.entry_id}`).send({ amount_paid_cents: 100_000 }).expect(200);
    const after = (await pm.post("/api/tickets/1/policy-check").expect(200)).body.data.result;
    expect(after.exceptions.map((x: { code: string }) => x.code)).toContain("UNPAID_BALANCE");
    expect(after.autoApproveEligible).toBe(false);
  });
});

describe("spreadsheet imports", () => {
  beforeEach(() => seedStructured(db));

  it("parses months and money deterministically", () => {
    expect(parseMonth("2026-11")).toBe("2026-11");
    expect(parseMonth("2026-11-01")).toBe("2026-11");
    expect(parseMonth("11/2026")).toBe("2026-11");
    expect(parseMonth("Nov 2026")).toBe("2026-11");
    expect(parseMonth("November, 2026")).toBe("2026-11");
    expect(parseMonth("25/11/2026")).toBe("2026-11");
    expect(parseMonth("03/04/2026")).toHaveProperty("error");
    expect(parseMonth("2026-13")).toHaveProperty("error");
    expect(parseMoney("$1,500.00")).toBe(150_000);
    expect(parseMoney("1500.5")).toBe(150_050);
    expect(typeof parseMoney("-10")).toBe("string");
    expect(typeof parseMoney("12.345")).toBe("string");
    expect(typeof parseMoney("abc")).toBe("string");
  });

  it("previews a ledger file: suggests the mapping, validates rows, flags duplicates, writes nothing", async () => {
    const file = csv(`
Tenant ID,Billing Cycle,Amount Due,Amount Paid
T001,Dec 2026,"$1,500.00",1500
T001,2026-12,1500,0
T002,2026-11,1650,1650
T999,2026-12,100,0
T003,2026-12,abc,0
T004,03/04/2026,100,0
`);
    const p = (await preview("ledger", file).expect(200)).body.data;
    expect(p.headers).toEqual(["Tenant ID", "Billing Cycle", "Amount Due", "Amount Paid"]);
    expect(p.mapping).toMatchObject({ tenant_id: 0, amount_due: 2, amount_paid: 3 });
    expect(p.mapping_error).toMatch(/Month/); // "Billing Cycle" is not a known synonym: the user maps it

    const mapped = (await preview("ledger", file, "data.csv", { ...p.mapping, month: 1 }).expect(200)).body.data;
    const byRow = Object.fromEntries(mapped.rows.map((r: { row_number: number }) => [r.row_number, r]));
    expect(byRow[2]).toMatchObject({ action: "import", normalized: { tenant_id: "T001", month: "2026-12", amount_due_cents: 150_000, amount_paid_cents: 150_000, status: "paid" } });
    expect(byRow[3].duplicate).toMatch(/row 2/);
    expect(byRow[4].duplicate).toMatch(/already has an entry for 2026-11/);
    expect(byRow[5].errors[0]).toMatch(/T999 does not exist/);
    expect(byRow[6].errors[0]).toMatch(/not a valid/);
    expect(byRow[7].errors[0]).toMatch(/ambiguous/);
    expect(mapped.summary).toEqual({ total: 6, importable: 1, errors: 3, duplicates: 2 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(0);
  });

  it("commits only valid rows, stores the original, links rows to it, and refuses the same file twice", async () => {
    const file = csv(`
tenant_name,month,due,paid
Marcus Chen,2026-12,1650,1650
Priya Sharma,2026-12,1500,700
Nobody Here,2026-12,1,0
`);
    const mapping = { tenant_name: 0, month: 1, amount_due: 2, amount_paid: 3 };
    const r = (await commit("ledger", file, mapping).expect(201)).body.data;
    expect(r).toMatchObject({ imported: 2, skipped: 1 });
    expect(r.skipped_rows[0]).toMatchObject({ row_number: 4 });
    const rows = db.prepare("SELECT tenant_id, status, source_document_id FROM payment_ledger WHERE month = '2026-12' ORDER BY tenant_id").all();
    expect(rows).toEqual([
      { tenant_id: "T001", status: "partial", source_document_id: r.document_id },
      { tenant_id: "T002", status: "paid", source_document_id: r.document_id },
    ]);
    const doc = db.prepare("SELECT kind, status, rows_imported, rows_skipped, storage_key FROM documents WHERE document_id = ?").get(r.document_id) as { storage_key: string };
    expect(doc).toMatchObject({ kind: "ledger_import", status: "imported", rows_imported: 2, rows_skipped: 1 });
    expect(await store.get(doc.storage_key)).toEqual(file);

    expect((await commit("ledger", file, mapping).expect(409)).body.error.code).toBe("DUPLICATE_IMPORT");
  });

  it("imports tenants by property + unit and rejects unknown units and duplicates", async () => {
    const file = csv(`
Full Name,Email,Property,Unit,Status
Zoe King,zoe@example.com,Oakwood Terrace,302,active
Yan Li,yan@example.com,Nowhere Towers,9,
Priya Sharma,dup@example.com,Maple Court Apartments,101,
Zoe Twin,ZOE@example.com,,,
Xi Wu,xi@example.com,,,evicted
`);
    const p = (await preview("tenants", file).expect(200)).body.data;
    expect(p.mapping).toMatchObject({ name: 0, email: 1, property_name: 2, unit_number: 3, status: 4 });
    const actions = p.rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(["import", "skip", "skip", "skip", "skip"]);
    expect(p.rows[1].errors[0]).toMatch(/does not exist/);
    expect(p.rows[2].duplicate).toMatch(/already a tenant of unit U101/);
    expect(p.rows[3].duplicate).toMatch(/row 2/);
    expect(p.rows[4].errors[0]).toMatch(/Status/);

    const r = (await commit("tenants", file, p.mapping).expect(201)).body.data;
    expect(r.imported).toBe(1);
    const t = (await pm.get(`/api/tenants/${r.created_ids[0]}`).expect(200)).body.data;
    expect(t).toMatchObject({ name: "Zoe King", unit_id: "U302", source_document_id: r.document_id });
  });

  it("refuses commits with nothing importable, bad mappings or unsupported files", async () => {
    const bad = csv("name\n\n");
    await preview("tenants", bad).expect(422);
    await preview("tenants", Buffer.from("x"), "people.txt").expect(422);
    const onlyErrors = csv("name,unit_id\nA,U999\n");
    expect((await commit("tenants", onlyErrors, { name: 0, unit_id: 1 }).expect(422)).body.error.code).toBe("NOTHING_TO_IMPORT");
    await commit("tenants", onlyErrors, { name: 7 }).expect(400);
    await commit("tenants", onlyErrors, { bogus: 0 }).expect(400);
    await pm.post("/api/imports/tenants/commit").attach("file", onlyErrors, "a.csv").expect(400); // mapping required
    await pm.post("/api/imports/widgets/preview").attach("file", onlyErrors, "a.csv").expect(400);
  });
});

describe("maintenance and dashboard read models", () => {
  beforeEach(() => seedStructured(db));

  it("tickets carry names, the latest policy result and the governing lease", async () => {
    await pm.post("/api/documents/leases").attach("file", readLease("lease_maple_101_sharma.txt"), "lease_maple_101_sharma.txt").expect(201);
    await pm.post("/api/tickets/7/policy-check").expect(200);
    const list = (await pm.get("/api/tickets").expect(200)).body.data;
    const t7 = list.find((t: { ticket_id: number }) => t.ticket_id === 7);
    expect(t7).toMatchObject({ unit: { unit_id: "U101" }, tenant: { name: "Priya Sharma" }, latest: { verdict: "EXCEPTION", approver_required: "PROPERTY_MANAGER" } });
    expect(t7.latest.exception_codes).toContain("QUOTE_EXCEEDS_WORK_ORDER");
    expect(list.find((t: { ticket_id: number }) => t.ticket_id === 2).latest).toBeNull();

    const d = (await pm.get("/api/tickets/7").expect(200)).body.data;
    expect(d.lease.lease_id).toBeGreaterThan(0);
    expect(d.policy_evaluations).toHaveLength(1);
    expect(d.latest_policy_evaluation.result.verdict).toBe("EXCEPTION");
  });

  it("dashboard figures come from the database", async () => {
    await pm.post("/api/documents/leases").attach("file", readLease("lease_maple_101_sharma.txt"), "lease_maple_101_sharma.txt").expect(201);
    await pm.post("/api/tickets/3/policy-check").expect(200);
    const d = (await pm.get("/api/dashboard").expect(200)).body.data;
    expect(d.summary).toEqual({
      properties: 3, units: 6, occupied_units: 5, tenants: 5, active_leases: 1, expiring_leases: 1, pending_tickets: 10, outstanding_rent_cents: 315_000,
    });
    expect(d.leases.expiring[0]).toMatchObject({ tenant_name: "Priya Sharma", days_until_end: 50 });
    expect(d.maintenance.policy_exceptions.map((t: { ticket_id: number }) => t.ticket_id)).toEqual([3]);
    expect(d.payments.overdue_tenants[0]).toMatchObject({ name: "Elena Rodriguez", balance_cents: 315_000 });
    expect(d.activity.uploads[0]).toMatchObject({ kind: "lease", doc_name: "lease_maple_101_sharma.txt", uploaded_by_name: "Pat Manager" });
  });
});
