/** `npm run bootstrap-users`: create the two initial accounts from .env (only if none exist). */
import { config } from "../config.js";
import { migrate, openDb } from "../db/connection.js";
import { AuthService } from "./authService.js";
import { bootstrapUsers, describeBootstrap } from "./bootstrap.js";

const db = openDb(config.dbPath);
migrate(db);
try {
  const result = bootstrapUsers(db, new AuthService(db));
  console.log(describeBootstrap(result));
  if (result.status === "not_configured") process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
