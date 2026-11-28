import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentLlm } from "../src/agent/llm.js";
import { createApp } from "../src/app.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import * as repo from "../src/db/repo.js";
import { seedStructured } from "../src/db/seed.js";
import { verifyAuditChain } from "../src/services/audit.js";
import { LocalDocumentStore } from "../src/storage/documentStore.js";
import { maintenanceDraft, scriptedAgent } from "./agentFixtures.js";
import { signedIn, testAuth } from "./authHelpers.js";
import { readLease, scriptedLlm, sharmaExtraction } from "./fixtures.js";

let tmp: string;
let db: DB;
let agentLlm: AgentLlm;
let pm: Agent;
let rd: Agent;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "propguard-deposit-"));
  db = openDb(":memory:");
  migrate(db);
  seedStructured(db);
  const app = createApp({ db, auth: testAuth(db), store: new LocalDocumentStore(path.join(tmp, "uploads")), llm: () => scriptedLlm([JSON.stringify(sharmaExtraction())]), agentLlm: () => agentLlm });
  pm = await signedIn(app, "pm");
  rd = await signedIn(app, "rd");
  // Lease #1 (T001, U101): $1,500.00 deposit.
  await pm.post("/api/documents/leases").attach("file", readLease("lease_maple_101_sharma.txt"), "lease_maple_101_sharma.txt").expect(201);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DEPOSIT = 150_000;
const position = () => repo.depositPosition(db, 1)!;
/** The invariant: every charge is counted exactly once. */
const expectPosition = (reserved: number, collected: number) => {
  expect(position()).toEqual({ held_cents: DEPOSIT, reserved_cents: reserved, collected_cents: collected, available_cents: DEPOSIT - reserved - collected });
};

/** A $1,000.00 ticket with a quote exception (Property Manager tier) and a proposed tenant charge. */
async function chargeTicket(chargeCents: number) {
  const t = (await pm.post("/api/tickets").send({ unit_id: "U101", tenant_id: "T001", issue_summary: "Tenant damage", work_order_amount_cents: 80_000, technician_quote_amount_cents: 100_000, proposed_tenant_charge_cents: chargeCents }).expect(201)).body.data;
  return { id: t.ticket.ticket_id as number, codes: t.policy.result.exceptions.map((e: { code: string }) => e.code) as string[] };
}
async function briefFor(ticket: { id: number; codes: string[] }) {
  agentLlm = scriptedAgent({ drafts: [maintenanceDraft(ticket.id, ticket.codes)] });
  return (await pm.post(`/api/agent/maintenance/${ticket.id}`).expect(201)).body.data;
}
const approve = (briefId: number, key = "A") => pm.post(`/api/briefs/${briefId}/decision`).send({ decision: "approve", option_key: key });
async function approvedCharge(amount: number) {
  const ticket = await chargeTicket(amount);
  const d = (await approve((await briefFor(ticket)).brief_id).expect(200)).body.data;
  return { ticket, reservation: d.decision.execution.deposit_reservation.reservation_id as number };
}
const collect = (who: Agent, id: number) => who.post(`/api/deposit-reservations/${id}/collect`).send({});
const release = (who: Agent, id: number, reason = "Charge cancelled") => who.post(`/api/deposit-reservations/${id}/release`).send({ reason });
const recheck = async (ticketId: number) => (await pm.post(`/api/tickets/${ticketId}/policy-check`).expect(200)).body.data;

describe("deposit reservations", () => {
  it("approval reserves the charge at once; a non-spend option reserves nothing", async () => {
    const t = await chargeTicket(60_000);
    await approve((await briefFor(t)).brief_id, "B").expect(200);
    expectPosition(0, 0);
    await approve((await briefFor(t)).brief_id, "A").expect(200);
    expectPosition(60_000, 0);
    expect((await pm.get(`/api/tickets/${t.id}`)).body.data.deposit_reservations).toEqual([expect.objectContaining({ amount_cents: 60_000, status: "reserved" })]);
  });

  it("two full-deposit charges cannot both be approved (the original reproduction)", async () => {
    const first = await chargeTicket(DEPOSIT);
    const second = await chargeTicket(DEPOSIT);
    const b1 = await briefFor(first);
    const b2 = await briefFor(second); // drafted while the deposit was still free
    await approve(b1.brief_id).expect(200);
    // The earlier brief for the second charge is now stale...
    expect((await approve(b2.brief_id).expect(409)).body.error.code).toBe("STALE_BRIEF");
    // ...and a fresh one is blocked by the deposit cap.
    const again = await recheck(second.id);
    expect(again.result.exceptions.map((e: { code: string }) => e.code)).toContain("DEPOSIT_CAP_EXCEEDED");
    const b3 = await briefFor({ id: second.id, codes: again.result.exceptions.map((e: { code: string }) => e.code) });
    expect((await approve(b3.brief_id).expect(409)).body.error.code).toBe("POLICY_BLOCKED");
    expectPosition(DEPOSIT, 0);
  });

  it("collecting moves the amount from reserved to collected exactly once", async () => {
    const { ticket, reservation } = await approvedCharge(60_000);
    await collect(pm, reservation).expect(200);
    expectPosition(0, 60_000);
    expect((await collect(pm, reservation).expect(409)).body.error.code).toBe("RESERVATION_NOT_ACTIVE");
    expect((await release(pm, reservation).expect(409)).body.error.code).toBe("RESERVATION_NOT_ACTIVE");
    expectPosition(0, 60_000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM deposit_ledger WHERE entry_type = 'deduction'").get() as { n: number }).n).toBe(1);
    // Re-checking the ticket does not count its own collected charge against it.
    const r = await recheck(ticket.id);
    expect(r.facts.remainingDepositCents).toBe(DEPOSIT);
    expect(r.result.exceptions.map((e: { code: string }) => e.code)).not.toContain("DEPOSIT_CAP_EXCEEDED");
    expectPosition(0, 60_000);
  });

  it("a reserved charge is not counted against its own ticket, but is against other tickets", async () => {
    const { ticket } = await approvedCharge(DEPOSIT);
    expect((await recheck(ticket.id)).facts.remainingDepositCents).toBe(DEPOSIT);
    const other = await chargeTicket(1);
    expect((await recheck(other.id)).facts.remainingDepositCents).toBe(0);
    expect(other.codes).toContain("DEPOSIT_CAP_EXCEEDED");
  });

  it("releasing frees the amount, needs a reason, and keeps the history", async () => {
    const { reservation } = await approvedCharge(60_000);
    await release(pm, reservation, "  ").expect(400);
    await release(pm, reservation).expect(200);
    expectPosition(0, 0);
    expect((await collect(pm, reservation).expect(409)).body.error.code).toBe("RESERVATION_NOT_ACTIVE");
    expect(db.prepare("SELECT status, release_reason FROM deposit_reservations").get()).toEqual({ status: "released", release_reason: "Charge cancelled" });
  });

  it("collect and release require the ticket's approval tier, and every step is audited", async () => {
    const { reservation } = await approvedCharge(60_000);
    db.exec("DROP TRIGGER deposit_reservations_final");
    db.prepare("UPDATE deposit_reservations SET required_tier = 'REGIONAL_DIRECTOR'").run();
    expect((await collect(pm, reservation).expect(403)).body.error.code).toBe("APPROVER_ROLE_REQUIRED");
    expect((await release(pm, reservation).expect(403)).body.error.code).toBe("APPROVER_ROLE_REQUIRED");
    await collect(rd, reservation).expect(200);
    const events = (db.prepare("SELECT event_type FROM audit_logs WHERE event_type LIKE 'deposit_%' OR event_type = 'approval_denied' ORDER BY audit_id").all() as { event_type: string }[]).map((r) => r.event_type);
    expect(events).toEqual(["deposit_reserved", "approval_denied", "approval_denied", "deposit_collected"]);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("correcting the recorded deposit never double-counts, and never collects more than is held", async () => {
    const { reservation } = await approvedCharge(60_000);
    await pm.patch("/api/leases/1/fields/security_deposit").send({ value: 50_000, reason: "Typo in lease" }).expect(200);
    expect(position()).toEqual({ held_cents: 50_000, reserved_cents: 60_000, collected_cents: 0, available_cents: 0 });
    expect((await collect(pm, reservation).expect(409)).body.error.code).toBe("DEPOSIT_INSUFFICIENT");
    await pm.patch("/api/leases/1/fields/security_deposit").send({ value: DEPOSIT, reason: "Restore" }).expect(200);
    await collect(pm, reservation).expect(200);
    expectPosition(0, 60_000);
  });

  it("the database refuses duplicates, edits of settled rows, deletions and removing the lease", async () => {
    const { reservation } = await approvedCharge(60_000);
    const dup = "INSERT INTO deposit_reservations (lease_id, ticket_id, amount_cents, required_tier, reserved_by) SELECT lease_id, ticket_id, amount_cents, required_tier, reserved_by FROM deposit_reservations";
    expect(() => db.prepare(dup).run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE deposit_reservations SET amount_cents = 1").run()).toThrow(/final/);
    expect(() => db.prepare("UPDATE deposit_reservations SET status = 'collected'").run()).toThrow(/constraint/);
    await release(pm, reservation).expect(200);
    expect(() => db.prepare("UPDATE deposit_reservations SET status = 'reserved'").run()).toThrow(/final/);
    expect(() => db.prepare("DELETE FROM deposit_reservations").run()).toThrow(/cannot be deleted/);
    expect(() => db.prepare("DELETE FROM source_documents").run()).toThrow(/FOREIGN KEY/);
  });
});
