/** Every ingestion route, record edit and rule evaluation is audited; history is never silently replaced. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentLlm } from "../src/agent/llm.js";
import { createApp } from "../src/app.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import { seedStructured } from "../src/db/seed.js";
import type { LlmCall } from "../src/extraction/extractor.js";
import { verifyAuditChain } from "../src/services/audit.js";
import { auditedIngest } from "../src/services/leaseIngest.js";
import { LocalDocumentStore } from "../src/storage/documentStore.js";
import { renewalDraft, scriptedAgent } from "./agentFixtures.js";
import { signedIn, testAuth } from "./authHelpers.js";
import { readLease, scriptedLlm, sharmaExtraction } from "./fixtures.js";

const SHARMA = "lease_maple_101_sharma.txt";
let tmp: string;
let db: DB;
let llm: LlmCall;
let agentLlm: AgentLlm;
let pm: Agent;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "propguard-audit-"));
  db = openDb(":memory:");
  migrate(db);
  seedStructured(db);
  llm = scriptedLlm(Array(6).fill(JSON.stringify(sharmaExtraction())));
  const app = createApp({ db, auth: testAuth(db), store: new LocalDocumentStore(path.join(tmp, "uploads")), llm: () => llm, agentLlm: () => agentLlm });
  pm = await signedIn(app, "pm");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Row = { event_type: string; actor_id: string; subject_type: string | null; subject_id: string | null; payload: Record<string, unknown> };
const events = (type: string): Row[] =>
  (db.prepare("SELECT event_type, actor_id, subject_type, subject_id, payload_json FROM audit_logs WHERE event_type = ? ORDER BY audit_id").all(type) as unknown as (Row & { payload_json: string })[]).map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
const ingest = () => pm.post("/api/leases/ingest").attach("file", readLease(SHARMA), SHARMA);
const leaseCount = () => (db.prepare("SELECT COUNT(*) AS n FROM leases").get() as { n: number }).n;

describe("POST /api/leases/ingest and the CLI", () => {
  it("audit a stored lease and an allowed replacement, naming the replaced lease", async () => {
    const first = (await ingest().expect(201)).body.data.ingest.lease_id;
    const second = (await ingest().expect(201)).body.data.ingest.lease_id;
    const rows = events("extraction_completed");
    expect(rows.map((r) => [r.payload.source, r.payload.replaced_existing, r.payload.replaced_lease_id])).toEqual([["api", false, null], ["api", true, first]]);
    expect(rows[1]).toMatchObject({ actor_id: "PROPERTY_MANAGER:Pat Manager", subject_type: "lease", subject_id: String(second) });
    expect(rows[1]!.payload.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("audit a failed attempt", async () => {
    llm = async () => {
      throw new Error("429 RESOURCE_EXHAUSTED");
    };
    await ingest().expect(503);
    expect(events("extraction_failed")[0]!.payload).toMatchObject({ source: "api", doc_name: SHARMA, error: expect.stringContaining("429") });
  });

  it("audit CLI ingestion with its own actor", async () => {
    await auditedIngest(db, { docName: SHARMA, bytes: readLease(SHARMA) }, llm, { type: "system", id: "ingest-cli" }, "cli");
    expect(events("extraction_completed")[0]).toMatchObject({ actor_id: "ingest-cli", payload: { source: "cli" } });
  });

  const lease = () => (db.prepare("SELECT lease_id FROM leases").get() as { lease_id: number }).lease_id;
  it.each<[string, () => Promise<unknown>, RegExp]>([
    ["a human correction", () => pm.patch(`/api/leases/${lease()}/fields/monthly_rent`).send({ value: 160_000, reason: "Addendum" }).expect(200), /corrections/],
    ["a Decision Brief and an approved renewal offer", async () => {
      agentLlm = scriptedAgent({ drafts: [renewalDraft(lease())] });
      const b = (await pm.post(`/api/agent/renewals/${lease()}`).expect(201)).body.data;
      await pm.post(`/api/briefs/${b.brief_id}/decision`).send({ decision: "approve", option_key: "standard" }).expect(200);
    }, /Decision Briefs; it has an approved renewal offer/],
    ["a deposit deduction", async () => void db.prepare("INSERT INTO deposit_ledger (lease_id, entry_type, amount_cents) VALUES (?, 'deduction', 100)").run(lease()), /deductions/],
  ])("refuse to replace a lease that has %s, without calling the model", async (_label, addHistory, reason) => {
    await ingest().expect(201);
    const id = lease();
    await addHistory();
    let called = false;
    llm = async () => {
      called = true;
      throw new Error("must not be called");
    };
    const r = await ingest().expect(409);
    expect(r.body.error.code).toBe("LEASE_HAS_HISTORY");
    expect(r.body.error.message).toMatch(reason);
    expect(called).toBe(false);
    expect([lease(), leaseCount()]).toEqual([id, 1]);
    expect(events("extraction_failed")).toHaveLength(1);
  });

  it("refuse to replace a lease uploaded through the application", async () => {
    await pm.post("/api/documents/leases").attach("file", readLease(SHARMA), SHARMA).expect(201);
    expect((await ingest().expect(409)).body.error.message).toMatch(/uploaded through the application/);
  });

  it("check again when saving, if a person acted while the model was reading", async () => {
    await ingest().expect(201);
    const id = lease();
    const inner = llm;
    llm = async (req) => {
      await pm.patch(`/api/leases/${id}/fields/monthly_rent`).send({ value: 170_000, reason: "Edited meanwhile" }).expect(200);
      return inner(req);
    };
    expect((await ingest().expect(409)).body.error.code).toBe("LEASE_HAS_HISTORY");
    expect(db.prepare("SELECT monthly_rent_cents AS r FROM leases").get()).toEqual({ r: 170_000 });
  });
});

describe("record edits", () => {
  it("audit creating and editing properties, units and tenants with the changed values", async () => {
    const p = (await pm.post("/api/properties").send({ name: "Audit House" }).expect(201)).body.data;
    await pm.patch(`/api/properties/${p.property_id}`).send({ address: "1 Test Way" }).expect(200);
    const u = (await pm.post("/api/units").send({ property_id: p.property_id, unit_number: "9", base_rent_cents: 100_000 }).expect(201)).body.data;
    await pm.patch(`/api/units/${u.unit_id}`).send({ base_rent_cents: 110_000 }).expect(200);
    const t = (await pm.post("/api/tenants").send({ name: "Nia Audit", unit_id: u.unit_id }).expect(201)).body.data;
    await pm.patch(`/api/tenants/${t.tenant_id}`).send({ unit_id: "U101" }).expect(200);

    for (const type of ["property", "unit", "tenant"]) {
      expect(events(`${type}_created`)).toHaveLength(1);
      expect(events(`${type}_updated`)).toHaveLength(1);
    }
    expect(events("unit_updated")[0]!.payload.changes).toEqual({ base_rent_cents: { from: 100_000, to: 110_000 } });
    expect(events("tenant_updated")[0]!.payload.changes).toEqual({ unit_id: { from: u.unit_id, to: "U101" } });
    expect(events("tenant_updated")[0]).toMatchObject({ subject_type: "tenant", subject_id: t.tenant_id, actor_id: "PROPERTY_MANAGER:Pat Manager" });
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("write nothing for a refused change or a save with no change", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as { n: number }).n;
    await pm.post("/api/units").send({ property_name: "Maple Court Apartments", unit_number: "101", base_rent_cents: 1 }).expect(409);
    await pm.patch("/api/tenants/T001").send({ name: "Priya Sharma" }).expect(200);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as { n: number }).n).toBe(before);
  });
});

describe("renewal rule evaluations", () => {
  it("are logged with inputs, rules and approver, at drafting and at approval", async () => {
    await pm.post("/api/documents/leases").attach("file", readLease(SHARMA), SHARMA).expect(201);
    agentLlm = scriptedAgent({ drafts: [renewalDraft(1)] });
    const b = (await pm.post("/api/agent/renewals/1").expect(201)).body.data;
    await pm.post(`/api/briefs/${b.brief_id}/decision`).send({ decision: "approve", option_key: "standard" }).expect(200);
    const rows = events("policy_evaluation").filter((r) => r.payload.rule_set === "renewal");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_id: "renewal-rules", subject_type: "lease", payload: { approver_required: "PROPERTY_MANAGER", needs_review: false, input: { monthly_rent_cents: 150_000, notice_period_days: 30 } } });
    expect((rows[0]!.payload.rule_trace as { rule: string }[]).map((r) => r.rule)).toEqual(["RENEWAL_WINDOW", "SOURCE_DATA_COMPLETE", "RENEWAL_PRICING", "PAYMENT_RELIABILITY"]);
  });
});

describe("deposit reservations cannot be replaced either", () => {
  it.each([
    "INSERT OR REPLACE INTO deposit_reservations (reservation_id, lease_id, ticket_id, amount_cents, required_tier, reserved_by) SELECT reservation_id, lease_id, ticket_id, 1, required_tier, reserved_by FROM deposit_reservations",
    "REPLACE INTO deposit_reservations (lease_id, ticket_id, amount_cents, required_tier, reserved_by) SELECT lease_id, ticket_id, 1, required_tier, reserved_by FROM deposit_reservations",
  ])("%s", async (sql) => {
    await ingest().expect(201);
    db.exec("INSERT INTO deposit_reservations (lease_id, ticket_id, amount_cents, required_tier, reserved_by) VALUES ((SELECT lease_id FROM leases), 1, 5000, 'PROPERTY_MANAGER', 1)");
    expect(() => db.exec(sql)).toThrow(/cannot be duplicated or replaced/);
    expect(db.prepare("SELECT reservation_id, amount_cents, status FROM deposit_reservations").all()).toEqual([{ reservation_id: 1, amount_cents: 5000, status: "reserved" }]);
  });
});

describe("the audit log cannot be rewritten", () => {
  it.each([
    "INSERT OR REPLACE INTO audit_logs (audit_id, occurred_at, event_type, actor_type, actor_id, payload_json, prev_hash, hash) VALUES (1,'t','e','system','forged','{}','p','h')",
    "REPLACE INTO audit_logs (occurred_at, event_type, actor_type, actor_id, payload_json, prev_hash, hash) SELECT 't','e','system','forged','{}','p',hash FROM audit_logs WHERE audit_id = 1",
    "INSERT INTO audit_logs (audit_id, occurred_at, event_type, actor_type, actor_id, payload_json, prev_hash, hash) VALUES (1,'t','e','system','forged','{}','p','h') ON CONFLICT(audit_id) DO UPDATE SET actor_id = 'forged'",
  ])("%s", async (sql) => {
    await ingest().expect(201);
    const before = db.prepare("SELECT * FROM audit_logs ORDER BY audit_id").all();
    expect(() => db.exec(sql)).toThrow(/append-only/);
    expect(db.prepare("SELECT * FROM audit_logs ORDER BY audit_id").all()).toEqual(before);
    expect(verifyAuditChain(db).ok).toBe(true);
  });
});
