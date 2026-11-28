import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth/authService.js";
import { bootstrapUsers } from "../src/auth/bootstrap.js";
import { canApproveTier, hasPermission } from "../src/auth/permissions.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import { seedStructured } from "../src/db/seed.js";
import type { LlmCall } from "../src/extraction/extractor.js";
import { signedIn, TEST_ENV, TEST_USERS, testAuth } from "./authHelpers.js";
import { readLease, scriptedLlm, sharmaExtraction } from "./fixtures.js";

let db: DB;
let clock: number;
let auth: AuthService;
let llm: LlmCall & { calls: number };
const now = () => new Date(clock);
// The server clock is injected, but the test client expires cookies against the real clock,
// so the injected clock must start at the real time.
const START = Math.floor(Date.now() / 1000) * 1000;
const makeApp = () => createApp({ db, llm: () => llm, auth });

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  seedStructured(db);
  clock = START;
  auth = testAuth(db, { now, sessionTtlHours: 8, sessionIdleMinutes: 60 });
  llm = scriptedLlm([JSON.stringify(sharmaExtraction())]);
});

const login = (email: string, password: string) => request(makeApp()).post("/api/auth/login").send({ email, password });
const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0]!;
const tokenOf = (res: request.Response) => cookieOf(res).split(";")[0]!.split("=")[1]!;

describe("bootstrap of the two initial accounts", () => {
  it("creates exactly one Property Manager and one Regional Director with bcrypt hashes", () => {
    const users = db.prepare("SELECT email, role, password_hash FROM users ORDER BY user_id").all() as { email: string; role: string; password_hash: string }[];
    expect(users.map((u) => [u.email, u.role])).toEqual([
      [TEST_USERS.pm.email, "property_manager"],
      [TEST_USERS.rd.email, "regional_director"],
    ]);
    for (const u of users) {
      expect(u.password_hash).toMatch(/^\$2[aby]\$/);
      expect(u.password_hash).not.toContain(TEST_USERS.pm.password);
    }
  });

  it("does nothing once accounts exist, even if .env changes", () => {
    const r = bootstrapUsers(db, auth, { ...TEST_ENV, PROPGUARD_PM_PASSWORD: "Different-Passw0rd!" });
    expect(r.status).toBe("skipped");
    expect(auth.countUsers()).toBe(2);
  });

  it("creates nothing when variables are missing", () => {
    const fresh = openDb(":memory:");
    migrate(fresh);
    const a = new AuthService(fresh, { bcryptRounds: 4 });
    const r = bootstrapUsers(fresh, a, { PROPGUARD_PM_EMAIL: "x@y.z" });
    expect(r.status).toBe("not_configured");
    expect(a.countUsers()).toBe(0);
  });

  it("is all-or-nothing: a weak second password creates neither account", () => {
    const fresh = openDb(":memory:");
    migrate(fresh);
    const a = new AuthService(fresh, { bcryptRounds: 4 });
    expect(() => bootstrapUsers(fresh, a, { ...TEST_ENV, PROPGUARD_RD_PASSWORD: "short" })).toThrow(/at least 12/);
    expect(a.countUsers()).toBe(0);
  });

  it("rejects the same email for both accounts", () => {
    const fresh = openDb(":memory:");
    migrate(fresh);
    const a = new AuthService(fresh, { bcryptRounds: 4 });
    expect(() => bootstrapUsers(fresh, a, { ...TEST_ENV, PROPGUARD_RD_EMAIL: TEST_ENV.PROPGUARD_PM_EMAIL })).toThrow(/different/);
  });

  it("has no registration endpoint", async () => {
    await request(makeApp()).post("/api/auth/register").send({ email: "new@x.io", password: "Whatever-Passw0rd!" }).expect(401);
    const pm = await signedIn(makeApp(), "pm");
    await pm.post("/api/auth/register").send({ email: "new@x.io", password: "Whatever-Passw0rd!" }).expect(404);
    expect(auth.countUsers()).toBe(2);
  });
});

describe("login and sessions", () => {
  it("sets an httpOnly SameSite=Strict cookie and stores only a hash of the token", async () => {
    const r = await login(TEST_USERS.pm.email, TEST_USERS.pm.password).expect(200);
    expect(r.body.data.user).toMatchObject({ email: TEST_USERS.pm.email, role: "property_manager", role_label: "Property Manager" });
    expect(r.body.data.user.password_hash).toBeUndefined();
    const cookie = cookieOf(r);
    expect(cookie).toMatch(/^pg_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const token = tokenOf(r);
    const stored = db.prepare("SELECT session_id FROM sessions").all() as { session_id: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.session_id).not.toBe(token);
    expect(stored[0]!.session_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("email is case-insensitive", async () => {
    await login(TEST_USERS.rd.email.toUpperCase(), TEST_USERS.rd.password).expect(200);
  });

  it("wrong password and unknown email give the same 401", async () => {
    const a = await login(TEST_USERS.pm.email, "Wrong-Passw0rd!!").expect(401);
    const b = await login("nobody@propguard.test", "Wrong-Passw0rd!!").expect(401);
    expect(a.body.error).toEqual(b.body.error);
    expect(a.headers["set-cookie"]).toBeUndefined();
  });

  it("never locks an account out, however many attempts fail", async () => {
    for (let i = 0; i < 20; i++) await login(TEST_USERS.pm.email, "Wrong-Passw0rd!!").expect(401);
    await login(TEST_USERS.pm.email, TEST_USERS.pm.password).expect(200);
  });

  it("GET /me returns the role and its permissions", async () => {
    const rd = await signedIn(makeApp(), "rd");
    const me = (await rd.get("/api/auth/me").expect(200)).body.data;
    expect(me.user.role).toBe("regional_director");
    expect(me.permissions).toEqual(["records.read", "records.write", "policy.run", "briefs.generate"]);
    expect(me.approvalTiers).toEqual(["AUTO_APPROVE", "PROPERTY_MANAGER", "REGIONAL_DIRECTOR"]);
  });

  it("logout revokes the session server-side", async () => {
    const r = await login(TEST_USERS.pm.email, TEST_USERS.pm.password).expect(200);
    const cookie = cookieOf(r).split(";")[0]!;
    await request(makeApp()).post("/api/auth/logout").set("Cookie", cookie).expect(204);
    // Replaying the old cookie no longer works.
    await request(makeApp()).get("/api/units").set("Cookie", cookie).expect(401);
  });

  it("expires sessions after the absolute lifetime even when active", async () => {
    const pm = await signedIn(makeApp(), "pm");
    for (let i = 0; i < 10; i++) {
      clock += 50 * 60_000; // keep it under the idle timeout
      if (clock - START < 8 * 3_600_000) await pm.get("/api/units").expect(200);
    }
    const r = await pm.get("/api/units").expect(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("expires idle sessions", async () => {
    const pm = await signedIn(makeApp(), "pm");
    clock += 59 * 60_000;
    await pm.get("/api/units").expect(200); // activity resets the idle timer
    clock += 59 * 60_000;
    await pm.get("/api/units").expect(200);
    clock += 61 * 60_000;
    await pm.get("/api/units").expect(401);
  });

  it("rejects forged and malformed cookies", async () => {
    await request(makeApp()).get("/api/units").set("Cookie", "pg_session=forged-token").expect(401);
    await request(makeApp()).get("/api/units").set("Cookie", "pg_session=%E0%A4%A").expect(401);
  });

  it("lists active sessions and revokes another one", async () => {
    const other = await login(TEST_USERS.pm.email, TEST_USERS.pm.password).expect(200);
    const pm = await signedIn(makeApp(), "pm");
    const list = (await pm.get("/api/auth/sessions").expect(200)).body.data as { session_id: string; current: boolean }[];
    expect(list).toHaveLength(2);
    const target = list.find((s) => !s.current)!;
    await pm.delete(`/api/auth/sessions/${list.find((s) => s.current)!.session_id}`).expect(400);
    await pm.delete(`/api/auth/sessions/${target.session_id}`).expect(204);
    await request(makeApp()).get("/api/units").set("Cookie", cookieOf(other).split(";")[0]!).expect(401);
    await pm.get("/api/units").expect(200);
  });

  it("cannot revoke another user's session", async () => {
    await login(TEST_USERS.rd.email, TEST_USERS.rd.password).expect(200);
    const rdSession = (db.prepare("SELECT session_id FROM sessions").get() as { session_id: string }).session_id;
    const pm = await signedIn(makeApp(), "pm");
    await pm.delete(`/api/auth/sessions/${rdSession}`).expect(404);
  });
});

describe("password change", () => {
  it("requires the current password and a strong new one", async () => {
    const pm = await signedIn(makeApp(), "pm");
    await pm.post("/api/auth/change-password").send({ current_password: "Wrong-Passw0rd!!", new_password: "New-Strong-Passw0rd!" }).expect(401);
    const weak = await pm.post("/api/auth/change-password").send({ current_password: TEST_USERS.pm.password, new_password: "alllowercaseletters" }).expect(400);
    expect(weak.body.error.code).toBe("WEAK_PASSWORD");
  });

  it("changes the password and signs out every other session", async () => {
    const other = await login(TEST_USERS.pm.email, TEST_USERS.pm.password).expect(200);
    const pm = await signedIn(makeApp(), "pm");
    await pm.post("/api/auth/change-password").send({ current_password: TEST_USERS.pm.password, new_password: "New-Strong-Passw0rd!" }).expect(200);
    await pm.get("/api/units").expect(200);
    await request(makeApp()).get("/api/units").set("Cookie", cookieOf(other).split(";")[0]!).expect(401);
    await login(TEST_USERS.pm.email, TEST_USERS.pm.password).expect(401);
    await login(TEST_USERS.pm.email, "New-Strong-Passw0rd!").expect(200);
  });
});

describe("protected endpoints", () => {
  const PROTECTED: [string, string][] = [
    ["get", "/api/units"],
    ["get", "/api/units/U101"],
    ["get", "/api/tenants"],
    ["get", "/api/tenants/T001/ledger"],
    ["get", "/api/leases"],
    ["get", "/api/leases/1/clauses"],
    ["get", "/api/tickets"],
    ["get", "/api/tickets/1/policy-evaluations"],
    ["post", "/api/tickets"],
    ["post", "/api/tickets/1/policy-check"],
    ["post", "/api/leases/ingest"],
    ["get", "/api/auth/me"],
    ["get", "/api/auth/sessions"],
    ["post", "/api/auth/logout"],
    ["post", "/api/auth/change-password"],
  ];

  it.each(PROTECTED)("%s %s returns 401 without a session", async (method, path) => {
    const r = await (request(makeApp()) as unknown as Record<string, (p: string) => request.Test>)[method]!(path).expect(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("health check stays public", async () => {
    await request(makeApp()).get("/api/health").expect(200);
  });

  it("rejects cross-origin writes", async () => {
    const pm = await signedIn(makeApp(), "pm");
    const r = await pm.post("/api/tickets/1/policy-check").set("Origin", "https://evil.example").expect(403);
    expect(r.body.error.code).toBe("BAD_ORIGIN");
  });
});

describe("role-based access control (enforced on the backend)", () => {
  const ticket = { unit_id: "U101", tenant_id: "T001", issue_summary: "Leaky faucet", work_order_amount_cents: 10_000, technician_quote_amount_cents: 10_000 };

  it("both roles can read operational records", async () => {
    for (const who of ["pm", "rd"] as const) {
      const a = await signedIn(makeApp(), who);
      await a.get("/api/units").expect(200);
      await a.get("/api/tickets").expect(200);
    }
  });

  it("both roles can create tickets and upload leases (no extra role restrictions)", async () => {
    for (const who of ["pm", "rd"] as const) {
      const a = await signedIn(makeApp(), who);
      await a.post("/api/tickets").send(ticket).expect(201);
      await a.post("/api/leases/ingest").attach("file", readLease("lease_maple_101_sharma.txt"), "lease_maple_101_sharma.txt").expect(201);
    }
  });

  it("both roles can re-run the deterministic policy check", async () => {
    for (const who of ["pm", "rd"] as const) await (await signedIn(makeApp(), who)).post("/api/tickets/1/policy-check").expect(200);
  });

  it("approval follows the repair-cost hierarchy: PM up to $1,000, RD above", () => {
    expect(canApproveTier("property_manager", "AUTO_APPROVE")).toBe(true);
    expect(canApproveTier("property_manager", "PROPERTY_MANAGER")).toBe(true);
    expect(canApproveTier("property_manager", "REGIONAL_DIRECTOR")).toBe(false);
    expect(canApproveTier("regional_director", "AUTO_APPROVE")).toBe(true);
    expect(canApproveTier("regional_director", "PROPERTY_MANAGER")).toBe(true);
    expect(canApproveTier("regional_director", "REGIONAL_DIRECTOR")).toBe(true);
    expect(hasPermission("regional_director", "records.write")).toBe(true);
  });

  it.each([
    [200_00, 200_00, "AUTO_APPROVE", false],
    [201_00, 201_00, "PROPERTY_MANAGER", false],
    [1_000_00, 1_000_00, "PROPERTY_MANAGER", false],
    [1_001_00, 1_001_00, "REGIONAL_DIRECTOR", true],
    [150_00, 180_00, "PROPERTY_MANAGER", false], // small repair, quote +20% exception escalates past auto-approval
  ] as const)("ticket WO %i / quote %i needs %s; PM blocked: %s", async (wo, quote, tier, pmBlocked) => {
    const pm = await signedIn(makeApp(), "pm");
    // A governing lease (deductible) must exist, or the engine fails closed with LEASE_NOT_FOUND.
    await pm.post("/api/leases/ingest").attach("file", readLease("lease_maple_101_sharma.txt"), "lease_maple_101_sharma.txt").expect(201);
    const r = await pm.post("/api/tickets").send({ ...ticket, work_order_amount_cents: wo, technician_quote_amount_cents: quote }).expect(201);
    expect(r.body.data.policy.result.approverRequired).toBe(tier);
    expect(canApproveTier("property_manager", tier)).toBe(!pmBlocked);
    expect(canApproveTier("regional_director", tier)).toBe(true);
  });
});
