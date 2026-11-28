/** The Swagger document and the registered routes must describe the same API. */
import type { Router } from "express";
import { describe, expect, it } from "vitest";
import { createAuthRouter } from "../src/api/authRoutes.js";
import { createBriefRouter } from "../src/api/briefRoutes.js";
import { createLeaseRouter } from "../src/api/leaseRoutes.js";
import { openapi } from "../src/api/openapi.js";
import { createRecordsRouter } from "../src/api/recordsRoutes.js";
import { createRouter } from "../src/api/routes.js";
import { AuthService } from "../src/auth/authService.js";
import { migrate, openDb } from "../src/db/connection.js";

const db = openDb(":memory:");
migrate(db);
const never = () => {
  throw new Error("not used");
};

type Layer = { route?: { path: string; methods: Record<string, boolean> } };
/** "GET /tickets/{}" for every route; parameter names are ignored. */
const routesOf = (router: Router, prefix = "") =>
  (router as unknown as { stack: Layer[] }).stack.flatMap((l) =>
    l.route ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${(prefix + l.route!.path).replace(/:\w+/g, "{}")}`) : [],
  );

const registered = [
  ...routesOf(createAuthRouter(new AuthService(db)), "/auth"),
  ...routesOf(createRouter(db, { llm: never })),
  ...routesOf(createLeaseRouter(db, { llm: never, store: never })),
  ...routesOf(createRecordsRouter(db, { store: never })),
  ...routesOf(createBriefRouter(db, { agentLlm: never })),
].sort();

const documented = Object.entries(openapi.paths as Record<string, Record<string, unknown>>)
  .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace(/\{\w+\}/g, "{}")}`))
  .sort();

describe("OpenAPI document", () => {
  it("finds the registered routes", () => {
    expect(registered.length).toBeGreaterThan(40);
  });

  it("describes every registered route", () => {
    expect(registered.filter((r) => !documented.includes(r))).toEqual([]);
  });

  it("describes no route that does not exist", () => {
    expect(documented.filter((r) => !registered.includes(r))).toEqual([]);
  });

  it("gives every operation a summary and at least one response", () => {
    for (const [path, ops] of Object.entries(openapi.paths as Record<string, Record<string, { summary?: string; responses?: object }>>)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op.summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(op.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
      }
    }
  });
});
