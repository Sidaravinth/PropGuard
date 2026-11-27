import path from "node:path";
import { createApp } from "./app.js";
import { AuthService } from "./auth/authService.js";
import { bootstrapUsers, describeBootstrap } from "./auth/bootstrap.js";
import { config, REPO_ROOT } from "./config.js";
import { migrate, openDb } from "./db/connection.js";
import { recoverInterruptedUploads } from "./services/leaseDocuments.js";

const db = openDb(config.dbPath);
migrate(db);

const auth = new AuthService(db);
console.log(describeBootstrap(bootstrapUsers(db, auth)));
const interrupted = recoverInterruptedUploads(db);
if (interrupted) console.log(`Marked ${interrupted} interrupted upload(s) as failed; retry them from Lease Management.`);

const webDist = path.join(REPO_ROOT, "web", "dist");
createApp({ db, auth, webDist }).listen(config.port, () => {
  console.log(`PropGuard API on http://localhost:${config.port}  (Swagger: http://localhost:${config.port}/docs)`);
  console.log(`DB: ${config.dbPath}`);
});
