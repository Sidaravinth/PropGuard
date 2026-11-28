/**
 * Clean-start reset: removes every application record and uploaded file, and keeps the login accounts,
 * their sessions and the schema. A backup of the database and the uploads folder is written first.
 *
 * The tables to clear are read from the schema at run time, so tables added by later migrations are
 * included automatically. Triggers that block DELETE (the append-only audit log and deposit
 * reservations) are lifted for the duration of one transaction and recreated before it commits.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DB } from "./connection.js";

/** Login accounts, their sessions and migration bookkeeping are kept. */
export const KEPT_TABLES = ["users", "sessions", "schema_migrations"] as const;

export interface ResetReport {
  dryRun: boolean;
  backupDir: string | null;
  /** Rows per cleared table before the reset (and after, when not a dry run). */
  before: Record<string, number>;
  after: Record<string, number> | null;
  kept: Record<string, number>;
  liftedTriggers: string[];
  uploadsRemoved: number;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;

/** Every application table: all user tables except the kept ones and SQLite's internal tables. */
export function tablesToClear(db: DB): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return rows.map((r) => r.name).filter((n) => !(KEPT_TABLES as readonly string[]).includes(n));
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

/** Copy the database (including WAL content) and the uploads folder, then check the copy. */
export function backup(db: DB, uploadsDir: string, backupDir: string): void {
  fs.mkdirSync(backupDir, { recursive: true });
  const dbCopy = path.join(backupDir, "propguard.db");
  if (fs.existsSync(dbCopy)) throw new Error(`Backup target already exists: ${dbCopy}`);
  db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(dbCopy, { readOnly: true });
  try {
    const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (check.integrity_check !== "ok") throw new Error(`Backup integrity check failed: ${check.integrity_check}`);
  } finally {
    copy.close();
  }
  if (fs.existsSync(uploadsDir)) fs.cpSync(uploadsDir, path.join(backupDir, "uploads"), { recursive: true });
}

export function resetData(db: DB, opts: { uploadsDir: string; backupDir: string | null; dryRun: boolean }): ResetReport {
  const tables = tablesToClear(db);
  const before = Object.fromEntries(tables.map((t) => [t, count(db, t)]));
  const kept = Object.fromEntries(KEPT_TABLES.filter((t) => tableExists(db, t)).map((t) => [t, count(db, t)]));
  const report: ResetReport = { dryRun: opts.dryRun, backupDir: null, before, after: null, kept, liftedTriggers: [], uploadsRemoved: countFiles(opts.uploadsDir) };
  if (opts.dryRun) return report;

  if (!opts.backupDir) throw new Error("A backup directory is required for a real reset");
  backup(db, opts.uploadsDir, opts.backupDir);
  report.backupDir = opts.backupDir;

  // Triggers that refuse DELETE on a table being cleared. Their exact SQL is restored afterwards.
  const blocking = (db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all() as { name: string; tbl_name: string; sql: string }[]).filter(
    (t) => tables.includes(t.tbl_name) && /\bBEFORE\s+DELETE\b/i.test(t.sql),
  );
  report.liftedTriggers = blocking.map((t) => t.name);

  // Foreign-key enforcement can only be switched outside a transaction. Every referencing table is
  // cleared in the same transaction, and foreign_key_check proves nothing dangles before commit.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of blocking) db.exec(`DROP TRIGGER ${quoteIdent(t.name)}`);
      for (const t of tables) db.exec(`DELETE FROM ${quoteIdent(t)}`);
      if (tableExists(db, "sqlite_sequence")) {
        const del = db.prepare("DELETE FROM sqlite_sequence WHERE name = ?");
        for (const t of tables) del.run(t);
      }
      for (const t of blocking) db.exec(t.sql);
      const dangling = db.prepare("PRAGMA foreign_key_check").all();
      if (dangling.length) throw new Error(`Reset would leave ${dangling.length} broken reference(s); nothing was changed`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  report.after = Object.fromEntries(tables.map((t) => [t, count(db, t)]));

  // Original files: no document row references them any more (and the backup holds a copy).
  if (fs.existsSync(opts.uploadsDir)) {
    for (const e of fs.readdirSync(opts.uploadsDir)) fs.rmSync(path.join(opts.uploadsDir, e), { recursive: true, force: true });
  }
  return report;
}

function tableExists(db: DB, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
