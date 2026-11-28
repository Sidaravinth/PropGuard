/** A tenant charge above the deductible share is allowed, but is always shown and never mis-stated. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentLlm } from "../src/agent/llm.js";
import { createApp } from "../src/app.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import { seedStructured } from "../src/db/seed.js";
import { LocalDocumentStore } from "../src/storage/documentStore.js";
import { maintenanceDraft, scriptedAgent } from "./agentFixtures.js";
import { signedIn, testAuth } from "./authHelpers.js";
import { readLease, scriptedLlm, sharmaExtraction } from "./fixtures.js";

let tmp: string;
let db: DB;
let agentLlm: AgentLlm;
let pm: Agent;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "propguard-charge-"));
  db = openDb(":memory:");
  migrate(db);
  seedStructured(db);
  const app = createApp({ db, auth: testAuth(db), store: new LocalDocumentStore(path.join(tmp, "uploads")), llm: () => scriptedLlm([JSON.stringify(sharmaExtraction())]), agentLlm: () => agentLlm });
  pm = await signedIn(app, "pm");
  // Lease #1: $100.00 repair deductible, $1,500.00 deposit.
  await pm.post("/api/documents/leases").attach("file", readLease("lease_maple_101_sharma.txt"), "lease_maple_101_sharma.txt").expect(201);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Seeded ticket #7: work order $400, quote $480, proposed tenant charge $480.
const NOTICE = { proposed_charge_cents: 48_000, deductible_share_cents: 10_000, difference_cents: 38_000 };

function draft(messageA: { recipient: "tenant" | "technician"; body: string }, messageB = { recipient: "tenant" as "tenant" | "technician", body: "We have asked for a revised quote for your window repair." }) {
  const d = maintenanceDraft(7, ["QUOTE_EXCEEDS_WORK_ORDER"]);
  d.options[0]!.message = { recipient: messageA.recipient, subject: "Window repair", body: messageA.body };
  d.options[1]!.message = { recipient: messageB.recipient, subject: "Window repair", body: messageB.body };
  return d;
}
const generate = async (...drafts: object[]) => {
  agentLlm = scriptedAgent({ drafts });
  return (await pm.post("/api/agent/maintenance/7").expect(201)).body.data;
};
const approve = (id: number, key: string) => pm.post(`/api/briefs/${id}/decision`).send({ decision: "approve", option_key: key }).expect(200);
const sentBody = () => (db.prepare("SELECT body FROM outbound_messages").get() as { body: string }).body;

const clean = { recipient: "tenant" as const, body: "Your window repair for {{work_order}} is going ahead with our technician." };

describe("tenant charge above the deductible share", () => {
  it("is reported on the brief and the ticket without changing the policy verdict or tier", async () => {
    const b = await generate(draft(clean));
    expect(b.charge_notice).toEqual(NOTICE);
    expect(b.required_approver).toBe("PROPERTY_MANAGER");
    expect(b.policy.exceptions.map((e: { code: string }) => e.code)).toEqual(["QUOTE_EXCEEDS_WORK_ORDER"]);
    expect((await pm.get("/api/tickets/7")).body.data.charge_notice).toEqual(NOTICE);
  });

  it("evidence shows money as dollars, while tool outputs keep integer cents", async () => {
    const b = await generate(draft(clean));
    const value = (id: string) => b.evidence.find((e: { id: string }) => e.id === id)?.value;
    expect(value("lease:1:field:repair_deductible")).toBe("$100.00");
    expect(value("lease:1:field:notice_period_days")).toBe("30");
    expect(b.evidence.find((e: { kind: string }) => e.kind === "ledger_entry").value).toBe("due $1,500.00 / paid $1,500.00");
    const toolCall = db.prepare("SELECT payload_json FROM audit_logs WHERE event_type = 'tool_call' AND payload_json LIKE '%get_lease_details%'").get() as { payload_json: string };
    expect(JSON.parse(toolCall.payload_json).output.terms.repair_deductible_cents).toBe(10_000);
  });

  it("a tenant message states the amount actually reserved, written by code", async () => {
    const b = await generate(draft(clean));
    await approve(b.brief_id, "A");
    const lines = sentBody().split("\n");
    expect(lines[0]).toMatch(/^Status: repair APPROVED/);
    expect(lines[1]).toBe("Tenant charge: $480.00 has been reserved against your security deposit. This is $380.00 more than your $100.00 share under the lease repair deductible.");
    expect(db.prepare("SELECT amount_cents FROM deposit_reservations").get()).toEqual({ amount_cents: 48_000 });
  });

  it("a non-spend tenant message says nothing has been reserved", async () => {
    const b = await generate(draft(clean));
    await approve(b.brief_id, "B");
    expect(sentBody().split("\n")[1]).toBe("Tenant charge: no amount has been reserved against your security deposit.");
  });

  it("a technician message carries no charge line", async () => {
    const b = await generate(draft({ recipient: "technician", body: "Please carry out the window repair for {{work_order}}." }));
    await approve(b.brief_id, "A");
    expect(sentBody()).not.toMatch(/Tenant charge|\$100\.00|deductible/);
  });

  it.each([
    ["the tenant-share figure", "tenant", "Your cost is {{tenant_share}} for this repair.", /uses \{\{tenant_share\}\}/],
    ["the deductible figure", "tenant", "You are responsible for {{repair_deductible}} of this repair.", /uses \{\{repair_deductible\}\}/],
    ["the deductible amount typed out", "tenant", "This repair costs you $100.00 in total.", /states the deductible share \$100\.00/],
    ["deductible wording", "tenant", "Your charge is capped at your lease deductible.", /describes what the tenant pays or the deductible/],
    ["a tenant charge sent to the technician", "technician", "The tenant will pay {{proposed_tenant_charge}} of this.", /must not include the tenant figure/],
  ] as const)("rejects a draft whose message uses %s, and accepts the retry", async (_label, recipient, body, error) => {
    const b = await generate(draft({ recipient, body }), draft(clean));
    expect(b.grounding.attempts[0].error).toMatch(error);
    expect(b.grounding.attempts).toHaveLength(2);
  });

  it("with no charge above the share there is no warning, and the share may be mentioned", async () => {
    db.prepare("UPDATE maintenance_tickets SET proposed_tenant_charge_cents = 10000 WHERE ticket_id = 7").run();
    const b = await generate(draft({ recipient: "tenant", body: "Under your lease deductible your cost is {{tenant_share}}." }));
    expect(b.charge_notice).toBeNull();
    expect(b.grounding.attempts).toHaveLength(1);
    await approve(b.brief_id, "A");
    expect(sentBody().split("\n")[1]).toBe("Tenant charge: $100.00 has been reserved against your security deposit.");
  });
});
