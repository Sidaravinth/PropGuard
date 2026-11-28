import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { config, intFromEnv } from "../src/config.js";
import { migrate, openDb } from "../src/db/connection.js";
import { isTransientLlmError, LlmTimeoutError, withBackoff, withTimeout } from "../src/extraction/extractor.js";
import { verifyAuditChain } from "../src/services/audit.js";
import { recoverInterruptedAgentRuns } from "../src/services/briefs.js";

const noSleep = async () => {};

describe("model settings", () => {
  it("defaults the agent to the lightweight model, with time limits and retries", () => {
    if (!process.env.AGENT_MODEL) expect(config.agentModel).toBe("gemini-3.5-flash-lite");
    expect(config.agentTimeoutMs).toBeGreaterThan(0);
    expect(config.extractionTimeoutMs).toBeGreaterThan(0);
    expect(config.llmMaxRetries).toBeGreaterThanOrEqual(0);
  });

  it("ignores empty or invalid numeric settings", () => {
    for (const bad of ["", "abc", "-1", "1.5"]) {
      process.env.PG_TEST_INT = bad;
      expect(intFromEnv("PG_TEST_INT", 7, 0), bad).toBe(7);
    }
    process.env.PG_TEST_INT = "0";
    expect(intFromEnv("PG_TEST_INT", 7, 0)).toBe(0);
    delete process.env.PG_TEST_INT;
  });
});

describe("timeouts and retries", () => {
  it("a request that never answers fails after the limit and is cancelled", async () => {
    let aborted = false;
    const hang = (signal: AbortSignal) => new Promise<never>(() => signal.addEventListener("abort", () => (aborted = true)));
    await expect(withTimeout(hang, 20)).rejects.toThrow(LlmTimeoutError);
    expect(aborted).toBe(true);
  });

  it("retries a stalled request and returns the later success", async () => {
    let calls = 0;
    const result = await withBackoff(() => withTimeout(async () => (++calls === 1 ? new Promise<string>(() => {}) : "ok"), 20), noSleep, 2);
    expect([result, calls]).toEqual(["ok", 2]);
  });

  it("stops after the configured number of retries", async () => {
    let calls = 0;
    await expect(withBackoff(() => withTimeout(() => (calls++, new Promise<never>(() => {})), 10), noSleep, 2)).rejects.toThrow(/did not reply/);
    expect(calls).toBe(3);
  });

  it("treats rate limits, server errors and dropped connections as transient, but not bad keys or bad requests", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) expect(isTransientLlmError(new ApiError({ status, message: "x" })), String(status)).toBe(true);
    expect(isTransientLlmError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe(true);
    for (const status of [400, 401, 403, 404]) expect(isTransientLlmError(new ApiError({ status, message: "x" })), String(status)).toBe(false);
    expect(isTransientLlmError(new Error("anything else"))).toBe(false);
  });
});

describe("agent runs interrupted by a restart", () => {
  it("are marked failed once, with an audit entry", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.prepare("INSERT INTO agent_runs (workflow, subject_type, subject_id, status) VALUES ('maintenance_exception', 'ticket', '1', 'running'), ('lease_renewal', 'lease', '2', 'completed')").run();
    expect(recoverInterruptedAgentRuns(db)).toBe(1);
    expect(db.prepare("SELECT status FROM agent_runs ORDER BY run_id").all()).toEqual([{ status: "failed" }, { status: "completed" }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'agent_run'").get() as { n: number }).n).toBe(1);
    expect(recoverInterruptedAgentRuns(db)).toBe(0);
    expect(verifyAuditChain(db).ok).toBe(true);
  });
});
