/**
 * Audited wrapper for ingestion that does not go through the upload flow (POST /api/leases/ingest and the
 * CLI): every attempt is recorded, whether it stores a lease, replaces one, or fails.
 */
import crypto from "node:crypto";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import type { LlmCall } from "../extraction/extractor.js";
import { ingestLeaseDocument, type IngestResult } from "../extraction/ingest.js";
import { audit, type Actor } from "./audit.js";

export async function auditedIngest(db: DB, input: { docName: string; bytes: Buffer }, llm: LlmCall, actor: Actor, source: "api" | "cli"): Promise<IngestResult> {
  const base = { source, doc_name: input.docName, sha256: crypto.createHash("sha256").update(input.bytes).digest("hex"), size_bytes: input.bytes.length };
  const previous = db.prepare("SELECT lease_id FROM leases WHERE source_doc_name = ?").get(input.docName) as { lease_id: number } | undefined;
  let result: IngestResult;
  try {
    result = await ingestLeaseDocument(db, input, llm);
  } catch (err) {
    audit(db, {
      event_type: "extraction_failed",
      actor,
      ...(previous ? { subject: { type: "lease" as const, id: previous.lease_id } } : {}),
      payload: { ...base, error: (err as Error).message },
    });
    throw err;
  }
  audit(db, {
    event_type: "extraction_completed",
    actor,
    subject: { type: "lease", id: result.lease_id },
    payload: {
      ...base,
      status: result.extraction_status,
      lease_id: result.lease_id,
      model: repo.getLeaseRow(db, result.lease_id)?.extraction_model ?? null,
      attempts: result.attempts,
      gaps: result.gaps.map((g) => `${g.field}:${g.status}`),
      linked: result.linked,
      replaced_existing: result.replaced_existing,
      replaced_lease_id: result.replaced_existing ? (previous?.lease_id ?? null) : null,
    },
  });
  return result;
}
