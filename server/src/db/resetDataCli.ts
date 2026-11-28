/**
 * `npm run reset-data`            dry run: shows what would be removed
 * `npm run reset-data -- --yes`   backs up, then removes every application record and uploaded file.
 * Login accounts, sessions and the schema are kept. Stop the server first.
 */
import path from "node:path";
import { config, REPO_ROOT } from "../config.js";
import { migrate, openDb } from "./connection.js";
import { resetData } from "./resetData.js";

const confirmed = process.argv.includes("--yes");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(REPO_ROOT, "data", "backups", stamp);

const db = openDb(config.dbPath);
migrate(db);
try {
  const r = resetData(db, { uploadsDir: config.uploadsDir, backupDir: confirmed ? backupDir : null, dryRun: !confirmed });
  console.log(`Database: ${config.dbPath}`);
  console.log(`Uploads:  ${config.uploadsDir} (${r.uploadsRemoved} file(s))`);
  console.log(`Kept:     ${Object.entries(r.kept).map(([t, n]) => `${t}=${n}`).join(", ")}`);
  console.log("\nTable                        before  after");
  for (const [t, n] of Object.entries(r.before)) {
    console.log(`${t.padEnd(28)} ${String(n).padStart(6)}  ${r.after ? String(r.after[t]).padStart(5) : "    -"}`);
  }
  if (r.dryRun) {
    console.log("\nDry run: nothing was changed. Stop the server, then run `npm run reset-data -- --yes`.");
  } else {
    console.log(`\nBackup:   ${r.backupDir}`);
    console.log(`Protection triggers lifted and restored: ${r.liftedTriggers.join(", ") || "none"}`);
    console.log(`Removed ${r.uploadsRemoved} uploaded file(s). Reset complete.`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  db.close();
}
