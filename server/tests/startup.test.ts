/** Starts the real server process (src/index.ts) against a temporary database. */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { SAMPLE_LEASES } from "../src/db/seedData.js";
import { TEST_ENV, TEST_USERS } from "./authHelpers.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "propguard-start-"));
const dbPath = path.join(tmp, "live.db");
let child: ChildProcess | null = null;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

async function start(): Promise<string> {
  const port = await freePort();
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    // Explicit paths: these override anything in .env, so a developer's live database is never opened.
    env: { ...process.env, ...TEST_ENV, DB_PATH: dbPath, UPLOADS_DIR: path.join(tmp, "uploads"), PORT: String(port), RENEWAL_AUTO_ENABLED: "false", BCRYPT_ROUNDS: "4" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return base;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

async function stop() {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  const exited = new Promise((r) => c.once("exit", r));
  c.kill();
  await exited;
}

const rows = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const n = Object.fromEntries(
    ["users", "properties", "units", "tenants", "leases", "payment_ledger", "maintenance_tickets", "deposit_reservations"].map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
  );
  db.close();
  return n;
};

afterAll(async () => {
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("application startup", () => {
  it("inserts no sample data, and user data survives a restart", async () => {
    let base = await start();
    const empty = { users: 2, properties: 0, units: 0, tenants: 0, leases: 0, payment_ledger: 0, maintenance_tickets: 0, deposit_reservations: 0 };
    expect(rows()).toEqual(empty);

    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: TEST_USERS.pm.email, password: TEST_USERS.pm.password }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const send = (p: string, body: unknown) => fetch(`${base}/api${p}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
    expect((await send("/units", { property_name: "My Property", unit_number: "7", base_rent_cents: 120_000 })).status).toBe(201);
    expect((await send("/tenants", { name: "Real Tenant", unit_id: "U001" })).status).toBe(201);

    await stop();
    base = await start();
    expect(rows()).toEqual({ ...empty, properties: 1, units: 1, tenants: 1 });
    const units = (await (await fetch(`${base}/api/units`, { headers: { Cookie: cookie } })).json()) as { data: { property_name: string }[] };
    expect(units.data.map((u) => u.property_name)).toEqual(["My Property"]);
  }, 90_000);

  it("the seed command's documents are exactly the five assessment leases", () => {
    expect(fs.readdirSync(config.leasesDir).sort()).toEqual([...SAMPLE_LEASES].sort());
  });
});
