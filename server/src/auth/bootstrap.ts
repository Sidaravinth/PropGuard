/**
 * Creates the two initial accounts (one Property Manager, one Regional Director) from environment
 * variables. Runs at server start and via `npm run bootstrap-users`.
 *
 * - Only acts when the users table is empty, so later edits to .env never overwrite real passwords.
 * - Needs all six variables; creates both accounts in one transaction or neither.
 * - No passwords live in source code. After the first start the two *_PASSWORD variables can be
 *   deleted from .env; passwords are then changed in Settings.
 */
import { tx, type DB } from "../db/connection.js";
import { AuthService } from "./authService.js";
import type { Role } from "./permissions.js";

const ACCOUNTS: { prefix: string; role: Role }[] = [
  { prefix: "PROPGUARD_PM", role: "property_manager" },
  { prefix: "PROPGUARD_RD", role: "regional_director" },
];

export type BootstrapResult =
  | { status: "skipped"; reason: "users_exist"; userCount: number }
  | { status: "created"; emails: string[] }
  | { status: "not_configured"; missing: string[] };

export function bootstrapUsers(db: DB, auth: AuthService, env: NodeJS.ProcessEnv = process.env): BootstrapResult {
  const userCount = auth.countUsers();
  if (userCount > 0) return { status: "skipped", reason: "users_exist", userCount };

  const missing: string[] = [];
  const specs = ACCOUNTS.map(({ prefix, role }) => {
    const get = (k: string) => {
      const v = env[`${prefix}_${k}`]?.trim();
      if (!v) missing.push(`${prefix}_${k}`);
      return v ?? "";
    };
    return { role, email: get("EMAIL"), displayName: get("NAME"), password: get("PASSWORD") };
  });
  if (missing.length) return { status: "not_configured", missing };
  if (specs[0]!.email.toLowerCase() === specs[1]!.email.toLowerCase()) {
    throw new Error("PROPGUARD_PM_EMAIL and PROPGUARD_RD_EMAIL must be different");
  }

  const created = tx(db, () => specs.map((s) => auth.createUser(s)));
  return { status: "created", emails: created.map((u) => u.email) };
}

export function describeBootstrap(r: BootstrapResult): string {
  switch (r.status) {
    case "created":
      return `Created initial accounts: ${r.emails.join(", ")}. You can now remove the *_PASSWORD variables from .env.`;
    case "skipped":
      return `User accounts already exist (${r.userCount}); bootstrap skipped.`;
    case "not_configured":
      return `No user accounts exist and bootstrap is not configured. Set ${r.missing.join(", ")} in .env (see .env.example), then restart.`;
  }
}
