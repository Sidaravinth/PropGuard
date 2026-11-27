import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..");

dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

export const config = {
  port: Number(process.env.PORT ?? 3001),
  dbPath: process.env.DB_PATH ?? path.join(REPO_ROOT, "data", "propguard.db"),
  leasesDir: path.join(REPO_ROOT, "data", "leases"),
  extractionModel: process.env.EXTRACTION_MODEL ?? "gemini-3.5-flash-lite",
  /** Max LLM attempts per document (1 initial + retries) before the doc is stored as needs_review. */
  extractionMaxAttempts: Number(process.env.EXTRACTION_MAX_ATTEMPTS ?? 3),
};

/**
 * "Today" for date-relative logic (expired leases, overdue months). Overridable so tests and
 * demos are reproducible: PROPGUARD_TODAY=2026-11-26.
 */
export function today(): string {
  const override = process.env.PROPGUARD_TODAY;
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  return new Date().toISOString().slice(0, 10);
}
