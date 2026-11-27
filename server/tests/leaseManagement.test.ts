import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth/authService.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import { seedStructured } from "../src/db/seed.js";
import { LlmUnavailableError, type LlmCall } from "../src/extraction/extractor.js";
import { recoverInterruptedUploads } from "../src/services/leaseDocuments.js";
import { LocalDocumentStore } from "../src/storage/documentStore.js";
import { signedIn, testAuth } from "./authHelpers.js";
import { readLease, scriptedLlm, sharmaExtraction } from "./fixtures.js";

let tmp: string;
let db: DB;
let store: LocalDocumentStore;
let llm: LlmCall;
let pm: Agent;

const SHARMA = "lease_maple_101_sharma.txt";
const makeApp = (auth = testAuth(db)) => createApp({ db, llm: () => llm, auth, store });
const uploadAs = (agent: Agent, bytes: Buffer, name = SHARMA) => agent.post("/api/documents/leases").attach("file", bytes, name);

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "propguard-test-"));
  store = new LocalDocumentStore(path.join(tmp, "uploads"));
  db = openDb(":memory:");
  migrate(db);
  seedStructured(db);
  llm = scriptedLlm([JSON.stringify(sharmaExtraction())]);
  pm = await signedIn(makeApp(), "pm");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("lease upload", () => {
  it("saves the original, creates a document record, extracts, links and stores evidence", async () => {
    const bytes = readLease(SHARMA);
    const r = await uploadAs(pm, bytes).expect(201);
    const { document, lease } = r.body.data;
    expect(document).toMatchObject({ kind: "lease", doc_name: SHARMA, original_filename: SHARMA, status: "extracted", size_bytes: bytes.length });
    expect(document.uploaded_by).toBe(1);
    expect(lease).toMatchObject({ lease_id: document.lease_id, unit: { unit_id: "U101" }, tenant: { tenant_id: "T001", name: "Priya Sharma" } });
    expect(lease.document.document_id).toBe(document.document_id);
    expect(lease.fields.find((f: { field_name: string }) => f.field_name === "repair_deductible").verbatim_snippet).toMatch(/\$100\.00/);
    expect(lease.clauses.length).toBeGreaterThan(0);

    // Original bytes are preserved exactly and retrievable.
    expect(await store.get(document.storage_key)).toEqual(bytes);
    const file = await pm.get(`/api/documents/${document.document_id}/file`).expect(200);
    expect(file.headers["content-type"]).toMatch(/text\/plain/);
    expect(file.headers["content-security-policy"]).toBe("sandbox");
    expect(Buffer.from(file.text)).toEqual(bytes);

    // Source text pages for side-by-side review.
    const src = await pm.get(`/api/leases/${lease.lease_id}/source`).expect(200);
    expect(src.body.data.pages[0]).toContain("Priya Sharma");

    const docs = await pm.get("/api/documents?kind=lease").expect(200);
    expect(docs.body.data[0]).toMatchObject({ document_id: document.document_id, uploaded_by_name: "Pat Manager" });
  });

  it("rejects an identical file as a duplicate and stores nothing new", async () => {
    const first = await uploadAs(pm, readLease(SHARMA)).expect(201);
    const r = await uploadAs(pm, readLease(SHARMA), "renamed-copy.txt").expect(409);
    expect(r.body.error.code).toBe("DUPLICATE_DOCUMENT");
    expect(r.body.error.details.document_id).toBe(first.body.data.document.document_id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM leases").get() as { n: number }).n).toBe(1);
  });

  it("keeps both files when a different file has the same name", async () => {
    await uploadAs(pm, readLease(SHARMA)).expect(201);
    llm = scriptedLlm([JSON.stringify(sharmaExtraction())]);
    const changed = Buffer.concat([readLease(SHARMA), Buffer.from("\n\nAddendum: none.\n")]);
    const r = await uploadAs(pm, changed).expect(201);
    expect(r.body.data.document.doc_name).toBe("lease_maple_101_sharma (2).txt");
    expect((db.prepare("SELECT COUNT(*) AS n FROM leases").get() as { n: number }).n).toBe(2);
  });

  it("rejects unsupported types before storing anything", async () => {
    const r = await uploadAs(pm, Buffer.from("hello"), "lease.docx").expect(422);
    expect(r.body.error.code).toBe("UNSUPPORTED_DOCUMENT");
    expect((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(0);
    await pm.post("/api/documents/leases").expect(400);
  });

  it("keeps the original and a failed record when the LLM is unavailable, then retries", async () => {
    llm = async () => {
      throw new LlmUnavailableError("GEMINI_API_KEY is not set");
    };
    const r = await uploadAs(pm, readLease(SHARMA)).expect(201);
    const doc = r.body.data.document;
    expect(doc).toMatchObject({ status: "failed", error_code: "LLM_UNAVAILABLE", lease_id: null });
    expect(r.body.data.lease).toBeNull();
    expect(await store.exists(doc.storage_key)).toBe(true);

    llm = scriptedLlm([JSON.stringify(sharmaExtraction())]);
    const retried = await pm.post(`/api/documents/${doc.document_id}/retry`).expect(200);
    expect(retried.body.data.document.status).toBe("extracted");
    expect(retried.body.data.lease.unit.unit_id).toBe("U101");
    // Only failed extractions can be retried.
    expect((await pm.post(`/api/documents/${doc.document_id}/retry`).expect(409)).body.error.code).toBe("NOT_RETRYABLE");
  });

  it("marks a PDF with no extractable text as failed but keeps it", async () => {
    const r = await uploadAs(pm, Buffer.from("%PDF-1.4\n%garbage that is not a real pdf\n"), "scan.pdf").expect(201);
    expect(r.body.data.document).toMatchObject({ status: "failed", error_code: "UNSUPPORTED_DOCUMENT" });
    expect(await store.exists(r.body.data.document.storage_key)).toBe(true);
  });

  it("stores a needs_review lease when the model output never validates (no invented values)", async () => {
    llm = scriptedLlm(["not json"]);
    const r = await uploadAs(pm, readLease(SHARMA)).expect(201);
    expect(r.body.data.document.status).toBe("needs_review");
    expect(r.body.data.lease.monthly_rent_cents).toBeNull();
  });

  it("recovers uploads interrupted by a restart", async () => {
    db.prepare(
      "INSERT INTO documents (kind, doc_name, original_filename, mime_type, size_bytes, sha256, storage_key, status) VALUES ('lease', 'x.txt', 'x.txt', 'text/plain', 1, 'abc', 'k', 'processing')",
    ).run();
    expect(recoverInterruptedUploads(db)).toBe(1);
    expect((db.prepare("SELECT status, error_code FROM documents").get() as { status: string; error_code: string })).toEqual({ status: "failed", error_code: "INTERRUPTED" });
  });
});

describe("corrections", () => {
  async function uploadWithReviewRent() {
    const x = sharmaExtraction();
    x.monthly_rent = { ...x.monthly_rent, status: "needs_review", note: "Numerals and words disagree" };
    llm = scriptedLlm([JSON.stringify(x)]);
    return (await uploadAs(pm, readLease(SHARMA)).expect(201)).body.data.lease;
  }

  it("a correction updates the trusted value, clears the gap and is recorded", async () => {
    const lease = await uploadWithReviewRent();
    expect(lease.monthly_rent_cents).toBeNull();
    expect(lease.gaps.map((g: { field: string }) => g.field)).toContain("monthly_rent");

    const r = await pm.patch(`/api/leases/${lease.lease_id}/fields/monthly_rent`).send({ value: 150_000, reason: "Checked against signed copy" }).expect(200);
    expect(r.body.data.monthly_rent_cents).toBe(150_000);
    expect(r.body.data.gaps).toEqual([]);
    expect(r.body.data.extraction_status).toBe("complete");
    const field = r.body.data.fields.find((f: { field_name: string }) => f.field_name === "monthly_rent");
    expect(field).toMatchObject({ status: "corrected", value_text: "150000" });
    expect(field.verbatim_snippet).toMatch(/\$1,500\.00/); // original evidence kept

    const c = (await pm.get(`/api/leases/${lease.lease_id}/corrections`).expect(200)).body.data;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ field_name: "monthly_rent", previous_status: "needs_review", new_value_text: "150000", new_status: "corrected", reason: "Checked against signed copy", corrected_by_name: "Pat Manager" });
    expect((db.prepare("SELECT status FROM documents").get() as { status: string }).status).toBe("extracted");
  });

  it("corrections are append-only", async () => {
    const lease = await uploadWithReviewRent();
    await pm.patch(`/api/leases/${lease.lease_id}/fields/monthly_rent`).send({ value: 150_000, reason: "Checked" }).expect(200);
    expect(() => db.prepare("UPDATE lease_field_corrections SET reason = 'tampered'").run()).toThrow(/append-only/);
  });

  it("the policy engine uses the corrected deductible", async () => {
    const lease = (await uploadAs(pm, readLease(SHARMA)).expect(201)).body.data.lease;
    await pm.patch(`/api/leases/${lease.lease_id}/fields/repair_deductible`).send({ value: 5_000, reason: "Addendum lowered deductible" }).expect(200);
    const t = await pm
      .post("/api/tickets")
      .send({ unit_id: "U101", tenant_id: "T001", issue_summary: "Leaky tap", work_order_amount_cents: 12_000, technician_quote_amount_cents: 12_000 })
      .expect(201);
    expect(t.body.data.policy.facts.deductibleCents).toBe(5_000);
  });

  it("a deposit correction updates the deposit held", async () => {
    const lease = (await uploadAs(pm, readLease(SHARMA)).expect(201)).body.data.lease;
    expect(lease.remaining_deposit_cents).toBe(150_000);
    const r = await pm.patch(`/api/leases/${lease.lease_id}/fields/security_deposit`).send({ value: 120_000, reason: "Receipt shows $1,200" }).expect(200);
    expect(r.body.data.remaining_deposit_cents).toBe(120_000);
  });

  it("confirming a value is absent keeps it missing and flagged", async () => {
    const lease = (await uploadAs(pm, readLease(SHARMA)).expect(201)).body.data.lease;
    const r = await pm.patch(`/api/leases/${lease.lease_id}/fields/security_deposit`).send({ value: null, reason: "No deposit was taken" }).expect(200);
    expect(r.body.data.security_deposit_cents).toBeNull();
    expect(r.body.data.remaining_deposit_cents).toBeNull();
    expect(r.body.data.gaps.map((g: { field: string }) => g.field)).toContain("security_deposit");
  });

  it("validates values deterministically", async () => {
    const lease = (await uploadAs(pm, readLease(SHARMA)).expect(201)).body.data.lease;
    const p = (field: string, body: object) => pm.patch(`/api/leases/${lease.lease_id}/fields/${field}`).send(body);
    expect((await p("start_date", { value: "2026-02-30", reason: "typo fix" }).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
    expect((await p("end_date", { value: "2025-01-01", reason: "typo fix" }).expect(422)).body.error.code).toBe("INVALID_TERM");
    await p("monthly_rent", { value: 1500.5, reason: "typo fix" }).expect(400);
    await p("monthly_rent", { value: "1500", reason: "typo fix" }).expect(400);
    await p("monthly_rent", { value: 150_000 }).expect(400); // reason required
    await p("monthly_rent", { value: 150_000, reason: "ok fix", extra: 1 }).expect(400);
    await p("not_a_field", { value: 1, reason: "typo fix" }).expect(404);
  });
});

describe("linking", () => {
  it("links an unlinked lease to a newly created unit and tenant", async () => {
    const x = sharmaExtraction();
    x.property_name = { ...x.property_name, value: "Unknown Towers" };
    llm = scriptedLlm([JSON.stringify(x)]);
    const lease = (await uploadAs(pm, readLease(SHARMA)).expect(201)).body.data.lease;
    expect(lease.unit).toBeNull();

    const unit = (await pm.post("/api/units").send({ property_name: "Birch House", unit_number: "7", base_rent_cents: 150_000 }).expect(201)).body.data;
    await pm.post("/api/units").send({ property_name: "birch house", unit_number: "7", base_rent_cents: 1 }).expect(409);
    const tenant = (await pm.post("/api/tenants").send({ name: "Priya Sharma", email: "priya.new@example.com", unit_id: unit.unit_id }).expect(201)).body.data;
    await pm.post("/api/tenants").send({ name: "Someone", email: "PRIYA.NEW@example.com" }).expect(409);

    const r = await pm.put(`/api/leases/${lease.lease_id}/link`).send({ unit_id: unit.unit_id, tenant_id: tenant.tenant_id }).expect(200);
    expect(r.body.data.unit.unit_id).toBe(unit.unit_id);
    expect(r.body.data.tenant.tenant_id).toBe(tenant.tenant_id);
    expect(r.body.data.gaps.map((g: { field: string }) => g.field)).not.toContain("unit_link");
    const c = (await pm.get(`/api/leases/${lease.lease_id}/corrections`).expect(200)).body.data;
    expect(c.map((x: { field_name: string }) => x.field_name).sort()).toEqual(["tenant_link", "unit_link"]);
  });

  it("refuses a tenant from a different unit", async () => {
    const lease = (await uploadAs(pm, readLease(SHARMA)).expect(201)).body.data.lease;
    const r = await pm.put(`/api/leases/${lease.lease_id}/link`).send({ unit_id: "U101", tenant_id: "T002" }).expect(422);
    expect(r.body.error.code).toBe("TENANT_UNIT_MISMATCH");
  });
});

describe("persistence", () => {
  it("documents, leases, corrections and files survive an application restart", async () => {
    const dbFile = path.join(tmp, "live.db");
    let fileDb = openDb(dbFile);
    migrate(fileDb);
    seedStructured(fileDb);
    let app = createApp({ db: fileDb, llm: () => llm, auth: testAuth(fileDb), store });
    let agent = await signedIn(app, "pm");
    const up = (await uploadAs(agent, readLease(SHARMA)).expect(201)).body.data;
    await agent.patch(`/api/leases/${up.lease.lease_id}/fields/repair_deductible`).send({ value: 9_000, reason: "Addendum" }).expect(200);
    fileDb.close();

    // "Restart": new connection, new store instance over the same directory, new app.
    fileDb = openDb(dbFile);
    migrate(fileDb);
    store = new LocalDocumentStore(path.join(tmp, "uploads"));
    app = createApp({ db: fileDb, llm: () => llm, auth: new AuthService(fileDb, { bcryptRounds: 4 }), store });
    agent = await signedIn(app, "pm");
    const lease = (await agent.get(`/api/leases/${up.lease.lease_id}`).expect(200)).body.data;
    expect(lease.repair_deductible_cents).toBe(9_000);
    expect(lease.document.doc_name).toBe(SHARMA);
    expect((await agent.get(`/api/leases/${up.lease.lease_id}/corrections`).expect(200)).body.data).toHaveLength(1);
    const file = await agent.get(`/api/documents/${up.document.document_id}/file`).expect(200);
    expect(Buffer.from(file.text)).toEqual(readLease(SHARMA));
    fileDb.close();
  });
});
