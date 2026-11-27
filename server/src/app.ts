import express from "express";
import swaggerUi from "swagger-ui-express";
import { errorHandler, unknownRoute } from "./api/errors.js";
import { openapi } from "./api/openapi.js";
import { createRouter } from "./api/routes.js";
import type { DB } from "./db/connection.js";
import { createGeminiLlmCall, type LlmCall } from "./extraction/extractor.js";

export interface AppDeps {
  db: DB;
  /** Factory so the LLM client is only created when an ingest actually happens. */
  llm?: () => LlmCall;
}

export function createApp({ db, llm }: AppDeps) {
  const app = express();
  let defaultLlm: LlmCall | null = null;
  const getLlm = llm ?? (() => (defaultLlm ??= createGeminiLlmCall()));

  app.use(express.json({ limit: "1mb" }));
  app.get("/openapi.json", (_req, res) => {
    res.json(openapi);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi as object));
  app.use("/api", createRouter(db, { llm: getLlm }));
  app.use(unknownRoute);
  app.use(errorHandler);
  return app;
}
