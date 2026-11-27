/** Test accounts are created through the real bootstrap path, from a fake environment. */
import type { Express } from "express";
import request from "supertest";
import { AuthService, type AuthOptions } from "../src/auth/authService.js";
import { bootstrapUsers } from "../src/auth/bootstrap.js";
import type { DB } from "../src/db/connection.js";

export const TEST_USERS = {
  pm: { email: "pm@propguard.test", name: "Pat Manager", password: "Pm-test-Passw0rd!" },
  rd: { email: "rd@propguard.test", name: "Rae Director", password: "Rd-test-Passw0rd!" },
} as const;

export const TEST_ENV = {
  PROPGUARD_PM_EMAIL: TEST_USERS.pm.email,
  PROPGUARD_PM_NAME: TEST_USERS.pm.name,
  PROPGUARD_PM_PASSWORD: TEST_USERS.pm.password,
  PROPGUARD_RD_EMAIL: TEST_USERS.rd.email,
  PROPGUARD_RD_NAME: TEST_USERS.rd.name,
  PROPGUARD_RD_PASSWORD: TEST_USERS.rd.password,
};

/** AuthService with a cheap bcrypt cost (hashes stay real bcrypt) and the two test users. */
export function testAuth(db: DB, opts: AuthOptions = {}): AuthService {
  const auth = new AuthService(db, { bcryptRounds: 4, ...opts });
  bootstrapUsers(db, auth, TEST_ENV);
  return auth;
}

/** A supertest agent that keeps the session cookie, signed in as the given user. */
export async function signedIn(app: Express, who: keyof typeof TEST_USERS) {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: TEST_USERS[who].email, password: TEST_USERS[who].password }).expect(200);
  return agent;
}
