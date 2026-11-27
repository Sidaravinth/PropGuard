import fs from "node:fs";
import path from "node:path";
import express from "express";
import swaggerUi from "swagger-ui-express";
import { createAuthRouter } from "./api/authRoutes.js";
import { createLeaseRouter } from "./api/leaseRoutes.js";
import { createRecordsRouter } from "./api/recordsRoutes.js";
import { config } from "./config.js";
import { LocalDocumentStore, type DocumentStore } from "./storage/documentStore.js";
import { errorHandler, unknownRoute } from "./api/errors.js";
import { openapi } from "./api/openapi.js";
import { createRouter } from "./api/routes.js";
import { AuthService } from "./auth/authService.js";
import { sameOriginWrites, sessionMiddleware } from "./auth/middleware.js";
import type { DB } from "./db/connection.js";
import { createGeminiLlmCall, type LlmCall } from "./extraction/extractor.js";

export interface AppDeps {
  db: DB;
  /** Factory so the LLM client is only created when an ingest actually happens. */
  llm?: () => LlmCall;
  /** Injectable for tests (clock, bcrypt cost); defaults to one built from config. */
  auth?: AuthService;
  /** Built frontend (web/dist). When present it is served at / with SPA fallback. */
  webDist?: string;
  /** Where uploaded originals are kept; defaults to a local directory (config.uploadsDir), created on first use. */
  store?: DocumentStore;
}

export function createApp({ db, llm, auth = new AuthService(db), webDist, store }: AppDeps) {
  const app = express();
  let defaultLlm: LlmCall | null = null;
  const getLlm = llm ?? (() => (defaultLlm ??= createGeminiLlmCall()));
  let defaultStore: DocumentStore | null = null;
  const getStore = () => store ?? (defaultStore ??= new LocalDocumentStore(config.uploadsDir));

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" });
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/openapi.json", (_req, res) => {
    res.json(openapi);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi as object));

  app.use("/api", sameOriginWrites, sessionMiddleware(auth), (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api/auth", createAuthRouter(auth));
  app.use("/api", createRouter(db, { llm: getLlm }));
  app.use("/api", createLeaseRouter(db, { llm: getLlm, store: getStore }));
  app.use("/api", createRecordsRouter(db, { store: getStore }));

  if (webDist && fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: false }));
    app.get(/^\/(?!api\/|docs|openapi\.json).*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use(unknownRoute);
  app.use(errorHandler);
  return app;
}
