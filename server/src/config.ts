import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..");

dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

/** A whole number from the environment; unset, empty or invalid values fall back to the default. */
export function intFromEnv(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name]?.trim() || NaN);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  dbPath: process.env.DB_PATH ?? path.join(REPO_ROOT, "data", "propguard.db"),
  leasesDir: path.join(REPO_ROOT, "data", "leases"),
  /** Where uploaded originals are kept (local document store). */
  uploadsDir: process.env.UPLOADS_DIR ?? path.join(REPO_ROOT, "data", "uploads"),
  /** Development/evaluation database written by `npm run seed`; never the live database by default. */
  sampleDbPath: process.env.SEED_DB_PATH ?? path.join(REPO_ROOT, "data", "propguard-sample.db"),
  extractionModel: process.env.EXTRACTION_MODEL ?? "gemini-3.5-flash-lite",
  /** Model for the agent workflows (tool calling + structured brief drafting). */
  agentModel: process.env.AGENT_MODEL || "gemini-3.5-flash-lite",
  /** Time limit for ONE model request attempt, and how many times a transient failure is retried. */
  agentTimeoutMs: intFromEnv("AGENT_TIMEOUT_MS", 60_000, 1),
  extractionTimeoutMs: intFromEnv("EXTRACTION_TIMEOUT_MS", 60_000, 1),
  llmMaxRetries: intFromEnv("LLM_MAX_RETRIES", 2, 0),
  /** MINIMAL | LOW | MEDIUM | HIGH. Higher is slower and costlier; LOW is enough for grounded drafting. */
  agentThinkingLevel: (process.env.AGENT_THINKING_LEVEL ?? "LOW").toUpperCase(),
  /** Automatic renewal briefs: on unless RENEWAL_AUTO_ENABLED=false; scans at startup and on this interval. */
  renewalAutoEnabled: (process.env.RENEWAL_AUTO_ENABLED || "true").trim().toLowerCase() !== "false",
  renewalScanIntervalMinutes: intFromEnv("RENEWAL_SCAN_INTERVAL_MINUTES", 60, 1),
  /** Max LLM attempts per document (1 initial + retries) before the doc is stored as needs_review. */
  extractionMaxAttempts: Number(process.env.EXTRACTION_MAX_ATTEMPTS ?? 3),
  /** Local OCR (tesseract.js) for scanned PDFs and images: on unless OCR_ENABLED=false. */
  ocrEnabled: (process.env.OCR_ENABLED || "true").trim().toLowerCase() !== "false",
  /** Longest document accepted for text extraction or OCR, in pages. */
  ocrMaxPages: intFromEnv("OCR_MAX_PAGES", 50, 1),
  /** Time limit for recognising one page. */
  ocrPageTimeoutMs: intFromEnv("OCR_PAGE_TIMEOUT_MS", 120_000, 1),
  /** Model for the grounded Q&A chat; defaults to the agent model. */
  qaModel: process.env.QA_MODEL || process.env.AGENT_MODEL || "gemini-3.5-flash-lite",
  auth: {
    /** Absolute session lifetime. */
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 8),
    /** A session unused for this long expires even before its absolute lifetime. */
    sessionIdleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 60),
    bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 12),
    /** Set the Secure flag on the session cookie (requires HTTPS). On by default in production. */
    secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production",
  },
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
