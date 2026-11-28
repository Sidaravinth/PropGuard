import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentLlm } from "../src/agent/llm.js";
import { createApp } from "../src/app.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import { seedStructured } from "../src/db/seed.js";
import { LlmUnavailableError } from "../src/extraction/extractor.js";
import { verifyAuditChain } from "../src/services/audit.js";
import { scanRenewals, startRenewalScheduler } from "../src/services/renewalScheduler.js";
import { LocalDocumentStore } from "../src/storage/documentStore.js";
import { renewalDraft, scriptedAgent } from "./agentFixtures.js";
import { signedIn, testAuth } from "./authHelpers.js";
import { readLease, scriptedLlm, sharmaExtraction } from "./fixtures.js";

let tmp: string;
let db: DB;
let routeLlm: AgentLlm;
let pm: Agent;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "propguard-scan-"));
  db = openDb(":memory:");
  migrate(db);
  seedStructured(db);
  const app = createApp({ db, auth: testAuth(db), store: new LocalDocumentStore(path.join(tmp, "uploads")), llm: () => scriptedLlm([JSON.stringify(sharmaExtraction())]), agentLlm: () => routeLlm });
  pm = await signedIn(app, "pm");
  // Lease #1 ends 2027-01-15: 50 days after the tests' "today", so it is in its renewal window.
  await pm.post("/api/documents/leases").attach("file", readLease("lease_maple_101_sharma.txt"), "lease_maple_101_sharma.txt").expect(201);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const agent = () => scriptedAgent({ drafts: [renewalDraft(1)] });
const briefs = () => db.prepare("SELECT brief_id, status, renewal_cycle FROM decision_briefs ORDER BY brief_id").all();
const slow = (inner: AgentLlm): AgentLlm => async (req) => {
  await new Promise((r) => setTimeout(r, 30));
  return inner(req);
};

describe("automatic renewal briefs", () => {
  it("generates one pending brief per cycle without any user action, however often it runs", async () => {
    expect((await scanRenewals(db, agent())).created).toEqual([{ lease_id: 1, brief_id: 1 }]);
    expect(await scanRenewals(db, agent())).toMatchObject({ created: [], skipped: 1 });
    expect(briefs()).toEqual([{ brief_id: 1, status: "pending", renewal_cycle: "2027-01-15" }]);
    expect(db.prepare("SELECT triggered_by FROM agent_runs").get()).toEqual({ triggered_by: null });
    const run = db.prepare("SELECT payload_json FROM audit_logs WHERE event_type = 'agent_run'").get() as { payload_json: string };
    expect(JSON.parse(run.payload_json).triggered_by).toBe("renewal-scheduler");
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'human_decision'").get() as { n: number }).n).toBe(0);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it.each([
    ["approve", "approved"],
    ["reject", "rejected"],
    ["request_revision", "revision_requested"],
  ])("never regenerates or overwrites a cycle after a human chose %s", async (decision, status) => {
    await scanRenewals(db, agent());
    await pm.post("/api/briefs/1/decision").send({ decision, option_key: decision === "approve" ? "standard" : null, comment: "mine" }).expect(200);
    const r = await scanRenewals(db, agent());
    expect(r.created).toEqual([]);
    expect(briefs()).toEqual([{ brief_id: 1, status, renewal_cycle: "2027-01-15" }]);
    expect(db.prepare("SELECT decision_comment FROM decision_briefs").get()).toEqual({ decision_comment: "mine" });
  });

  it("leaves a brief a person generated alone", async () => {
    routeLlm = agent();
    await pm.post("/api/agent/renewals/1").expect(201);
    expect(await scanRenewals(db, agent())).toMatchObject({ created: [], skipped: 1 });
    expect(briefs()).toHaveLength(1);
  });

  it("does not create a duplicate when a manual run overlaps the scan", async () => {
    routeLlm = slow(agent());
    const scan = scanRenewals(db, slow(agent()));
    const manual = pm.post("/api/agent/renewals/1");
    const [s, m] = await Promise.all([scan, manual]);
    expect(s.created.length + (m.status === 201 ? 1 : 0)).toBe(1);
    expect(briefs()).toHaveLength(1);
  });

  it("starts a new cycle only when the lease's end date changes", async () => {
    await scanRenewals(db, agent());
    await pm.post("/api/briefs/1/decision").send({ decision: "reject" }).expect(200);
    db.prepare("UPDATE leases SET end_date = '2027-01-20' WHERE lease_id = 1").run();
    expect((await scanRenewals(db, agent())).created).toHaveLength(1);
    expect(briefs()).toEqual([
      { brief_id: 1, status: "rejected", renewal_cycle: "2027-01-15" },
      { brief_id: 2, status: "pending", renewal_cycle: "2027-01-20" },
    ]);
  });

  it("survives an unavailable model and succeeds at a later scan", async () => {
    const down: AgentLlm = async () => {
      throw new LlmUnavailableError("quota exhausted");
    };
    expect(await scanRenewals(db, down)).toMatchObject({ created: [], stopped: true });
    expect(briefs()).toEqual([]);
    expect((await scanRenewals(db, agent())).created).toHaveLength(1);
  });

  it("the scheduler runs at startup without blocking and can be stopped", async () => {
    const lines: string[] = [];
    const stop = startRenewalScheduler(db, agent(), { intervalMinutes: 60, log: (l) => lines.push(l) });
    expect(briefs()).toEqual([]); // returned before scanning
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(briefs()).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/1 brief\(s\) created/);
  });
});
