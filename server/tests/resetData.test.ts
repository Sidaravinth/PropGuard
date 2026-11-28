import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/authService.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import { resetData, tablesToClear } from "../src/db/resetData.js";
import { seedStructured } from "../src/db/seed.js";
import { audit, SYSTEM } from "../src/services/audit.js";
import { testAuth, TEST_USERS } from "./authHelpers.js";

let dir: string;
let db: DB;
let uploads: string;

const triggers = () => (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string; sql: string }[]);
const n = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "propguard-reset-"));
  db = openDb(path.join(dir, "live.db"));
  migrate(db);
  seedStructured(db);
  const auth = testAuth(db);
  await auth.login(TEST_USERS.pm.email, TEST_USERS.pm.password);
  audit(db, { event_type: "ticket_created", actor: SYSTEM, subject: { type: "ticket", id: 1 }, payload: { test: true } });
  uploads = path.join(dir, "uploads");
  fs.mkdirSync(path.join(uploads, "ab"), { recursive: true });
  fs.writeFileSync(path.join(uploads, "ab", "file.pdf"), "x");
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("clean data reset", () => {
  it("a dry run changes nothing", () => {
    const before = n("tenants");
    const r = resetData(db, { uploadsDir: uploads, backupDir: null, dryRun: true });
    expect(r.before.tenants).toBe(before);
    expect(n("tenants")).toBe(before);
    expect(fs.existsSync(path.join(uploads, "ab", "file.pdf"))).toBe(true);
  });

  it("clears every application table, keeps users and sessions, and backs up first", () => {
    const users = db.prepare("SELECT user_id, email, password_hash, role FROM users ORDER BY user_id").all();
    const sessions = n("sessions");
    expect(sessions).toBeGreaterThan(0);
    expect(n("audit_logs")).toBeGreaterThan(0);
    const triggersBefore = triggers();
    const backupDir = path.join(dir, "backup");

    const r = resetData(db, { uploadsDir: uploads, backupDir, dryRun: false });

    for (const t of tablesToClear(db)) expect(r.after![t], t).toBe(0);
    expect(db.prepare("SELECT user_id, email, password_hash, role FROM users ORDER BY user_id").all()).toEqual(users);
    expect(n("sessions")).toBe(sessions);
    expect(r.liftedTriggers).toEqual(expect.arrayContaining(["audit_logs_no_delete", "deposit_reservations_no_delete"]));
    // Protection is back, exactly as it was.
    expect(triggers()).toEqual(triggersBefore);
    expect(() => db.exec("DELETE FROM audit_logs")).not.toThrow(); // empty table: nothing to block
    audit(db, { event_type: "ticket_created", actor: SYSTEM, subject: { type: "ticket", id: 1 }, payload: {} });
    expect(() => db.exec("DELETE FROM audit_logs")).toThrow(/append-only|not allowed|immutable/i);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    // Uploaded originals are removed; the backup keeps the database and the files.
    expect(fs.readdirSync(uploads)).toEqual([]);
    expect(fs.existsSync(path.join(backupDir, "propguard.db"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "uploads", "ab", "file.pdf"))).toBe(true);
    const copy = openDb(path.join(backupDir, "propguard.db"));
    expect((copy.prepare("SELECT COUNT(*) AS n FROM tenants").get() as { n: number }).n).toBe(r.before.tenants);
    copy.close();
  });

  it("restarts id counters and the app keeps working with the kept accounts", async () => {
    resetData(db, { uploadsDir: uploads, backupDir: path.join(dir, "backup"), dryRun: false });
    db.prepare("INSERT INTO properties (name) VALUES ('Fresh Court')").run();
    expect((db.prepare("SELECT property_id FROM properties").get() as { property_id: number }).property_id).toBe(1);
    const auth = new AuthService(db, { bcryptRounds: 4 });
    await expect(auth.login(TEST_USERS.rd.email, TEST_USERS.rd.password)).resolves.toBeTruthy();
  });
});
