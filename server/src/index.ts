import path from "node:path";
import { createGeminiAgentLlm } from "./agent/llm.js";
import { createApp } from "./app.js";
import { AuthService } from "./auth/authService.js";
import { bootstrapUsers, describeBootstrap } from "./auth/bootstrap.js";
import { config, REPO_ROOT } from "./config.js";
import { migrate, openDb } from "./db/connection.js";
import { recoverInterruptedAgentRuns } from "./services/briefs.js";
import { recoverInterruptedUploads } from "./services/leaseDocuments.js";
import { startRenewalScheduler } from "./services/renewalScheduler.js";

const db = openDb(config.dbPath);
migrate(db);

const auth = new AuthService(db);
console.log(describeBootstrap(bootstrapUsers(db, auth)));
const interrupted = recoverInterruptedUploads(db);
if (interrupted) console.log(`Marked ${interrupted} interrupted upload(s) as failed; retry them from Lease Management.`);
const interruptedRuns = recoverInterruptedAgentRuns(db);
if (interruptedRuns) console.log(`Marked ${interruptedRuns} interrupted agent run(s) as failed.`);

const webDist = path.join(REPO_ROOT, "web", "dist");
createApp({ db, auth, webDist }).listen(config.port, () => {
  console.log(`PropGuard API on http://localhost:${config.port}  (Swagger: http://localhost:${config.port}/docs)`);
  console.log(`DB: ${config.dbPath}`);
  if (!config.renewalAutoEnabled) console.log("Automatic renewal briefs are off (RENEWAL_AUTO_ENABLED=false).");
  else if (!process.env.GEMINI_API_KEY) console.log("Automatic renewal briefs are off: GEMINI_API_KEY is not set.");
  else {
    startRenewalScheduler(db, createGeminiAgentLlm(), { intervalMinutes: config.renewalScanIntervalMinutes });
    console.log(`Automatic renewal briefs: scanning now, then every ${config.renewalScanIntervalMinutes} minute(s).`);
  }
});
