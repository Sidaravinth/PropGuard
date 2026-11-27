import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { UnsupportedDocumentError } from "../extraction/documentText.js";
import { LlmUnavailableError } from "../extraction/extractor.js";
import { PolicyInputError } from "../policy/policyEngine.js";
import { NotFoundError } from "../services/policyService.js";

/** Uniform error body: { error: { code, message, details? } } */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`);

export function parseOr400<T extends z.ZodType>(schema: T, data: unknown, where = "request"): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_ERROR", `Invalid ${where}`, r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

export const unknownRoute: RequestHandler = (req, _res, next) => next(new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${req.path}`));

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let e: ApiError;
  if (err instanceof ApiError) e = err;
  else if (err instanceof NotFoundError) e = new ApiError(404, "NOT_FOUND", err.message);
  else if (err instanceof UnsupportedDocumentError) e = new ApiError(422, "UNSUPPORTED_DOCUMENT", err.message);
  else if (err instanceof PolicyInputError) e = new ApiError(422, "POLICY_INPUT_INVALID", err.message);
  else if (err instanceof multer.MulterError) e = new ApiError(400, "UPLOAD_ERROR", err.message);
  else if (err instanceof LlmUnavailableError) e = new ApiError(503, "LLM_UNAVAILABLE", `${err.message} (check GEMINI_API_KEY / EXTRACTION_MODEL in .env, or your free-tier quota)`);
  else if (err?.type === "entity.parse.failed") e = new ApiError(400, "INVALID_JSON", "Request body is not valid JSON");
  else if (typeof err?.message === "string" && err.message.includes("constraint failed")) e = new ApiError(409, "CONSTRAINT_VIOLATION", err.message);
  else {
    console.error(err);
    e = new ApiError(500, "INTERNAL_ERROR", "Unexpected server error");
  }
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } });
};
