/**
 * Reset + seed the SAMPLE database (data/propguard-sample.db, or SEED_DB_PATH) for development and
 * evaluation. It never touches the live database (DB_PATH): normal operation is user-driven.
 *   npm run seed                 structured records + ingest the five assessment leases via the LLM pipeline
 *   npm run seed -- --no-ingest  structured records only (no API key needed)
 *
 * After leases are ingested, the deterministic policy check runs on every ticket so flagged tickets
 * start in the 'flagged' state.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { createGeminiLlmCall, LlmUnavailableError } from "../extraction/extractor.js";
import { ingestLeaseDocument } from "../extraction/ingest.js";
import { runTicketPolicyCheck } from "../services/policyService.js";
import { migrate, openDb, tx, type DB } from "./connection.js";
import { insertTicket } from "./repo.js";
import { LEDGER, SAMPLE_LEASES, TENANTS, TICKETS, UNITS } from "./seedData.js";

export function seedStructured(db: DB): void {
  tx(db, () => {
    const u = db.prepare("INSERT INTO units (unit_id, property_name, unit_number, base_rent_cents) VALUES (?, ?, ?, ?)");
    for (const r of UNITS) u.run(r.unit_id, r.property_name, r.unit_number, r.base_rent_cents);
    const t = db.prepare("INSERT INTO tenants (tenant_id, name, email, unit_id, status) VALUES (?, ?, ?, ?, ?)");
    for (const r of TENANTS) t.run(r.tenant_id, r.name, r.email, r.unit_id, r.status);
    const l = db.prepare("INSERT INTO payment_ledger (tenant_id, month, amount_due_cents, amount_paid_cents, status) VALUES (?, ?, ?, ?, ?)");
    for (const r of LEDGER) l.run(r.tenant_id, r.month, r.due, r.paid, r.status);
    for (const tk of TICKETS) insertTicket(db, tk);
  });
}

async function main() {
  const skipIngest = process.argv.includes("--no-ingest");

  // Sample data goes to its own database (SEED_DB_PATH), never the live one the app uses (DB_PATH).
  const target = config.sampleDbPath;
  if (path.resolve(target) === path.resolve(config.dbPath)) {
    console.error(`Refusing to seed: SEED_DB_PATH points at the live database (${config.dbPath}).`);
    process.exit(1);
  }
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(target + suffix, { force: true });
  const db = openDb(target);
  migrate(db);
  seedStructured(db);
  console.log(`Seeded ${UNITS.length} units, ${TENANTS.length} tenants, ${LEDGER.length} ledger entries, ${TICKETS.length} tickets.`);

  if (!skipIngest) {
    const llm = createGeminiLlmCall();
    for (const file of SAMPLE_LEASES) {
      const result = await ingestLeaseDocument(db, { docName: file, bytes: fs.readFileSync(path.join(config.leasesDir, file)) }, llm);
      const gapText = result.gaps.length ? result.gaps.map((g) => `${g.field}(${g.status})`).join(", ") : "none";
      console.log(`  ingested ${file} → lease #${result.lease_id} [${result.extraction_status}] tenant=${result.linked.tenant_id} gaps: ${gapText}`);
    }
  } else {
    console.log("Skipped lease ingestion (--no-ingest). Run `npm run ingest -- data/leases/<file>` later.");
  }

  const ids = (db.prepare("SELECT ticket_id FROM maintenance_tickets ORDER BY ticket_id").all() as { ticket_id: number }[]).map((r) => r.ticket_id);
  for (const id of ids) {
    const r = runTicketPolicyCheck(db, id).result;
    console.log(`  ticket #${id}: ${r.verdict.padEnd(9)} approver=${r.approverRequired.padEnd(17)} ${r.exceptions.map((e) => e.code).join(", ")}`);
  }
  console.log(`Sample DB: ${target}\nRun the app against it with: DB_PATH=${target} npm run dev`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    if (err instanceof LlmUnavailableError) {
      console.error("\nSet GEMINI_API_KEY in .env (see .env.example), or run `npm run seed -- --no-ingest`.");
    }
    process.exit(1);
  });
}
