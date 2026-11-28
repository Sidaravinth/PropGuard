/**
 * Grounded Q&A over one lease agreement (read-only).
 *
 * Retrieval only ever reads the selected lease's own source text, so an answer cannot draw on another
 * tenant's agreement. Conversations are kept per user and per lease; clearing removes only the caller's.
 * Every answer is audited with the question, the excerpts retrieved and the citations used.
 */
import { ApiError } from "../api/errors.js";
import type { PublicUser } from "../auth/authService.js";
import { config } from "../config.js";
import { tx, type DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { LlmUnavailableError, type LlmCall } from "../extraction/extractor.js";
import { answerQuestion, type GroundedAnswer } from "../qa/answer.js";
import { chunkPages } from "../qa/chunker.js";
import { retrieve } from "../qa/retrieve.js";
import { audit, humanActor } from "./audit.js";
import { documentForLease, leaseSourcePages } from "./leaseDocuments.js";

export const MAX_QUESTION_LENGTH = 500;

/** One stored assistant answer as the UI shows it, citations resolved to the agreement's name and page. */
export interface QaAnswerView {
  status: GroundedAnswer["status"];
  text: string;
  statements: (GroundedAnswer["statements"][number] & {
    citations: (GroundedAnswer["statements"][number]["citations"][number] & { doc_name: string; document_id: number | null })[];
  })[];
  notice: string | null;
}

export interface QaMessage {
  message_id: number;
  role: "user" | "assistant";
  content: string;
  answer: QaAnswerView | null;
  created_at: string;
}

type Row = { message_id: number; role: "user" | "assistant"; content: string; answer_json: string | null; created_at: string };

export function qaHistory(db: DB, leaseId: number, userId: number): QaMessage[] {
  const rows = db
    .prepare("SELECT message_id, role, content, answer_json, created_at FROM qa_messages WHERE lease_id = ? AND user_id = ? ORDER BY message_id")
    .all(leaseId, userId) as unknown as Row[];
  return rows.map((r) => ({ message_id: r.message_id, role: r.role, content: r.content, answer: r.answer_json ? (JSON.parse(r.answer_json) as QaAnswerView) : null, created_at: r.created_at }));
}

/** One question in flight per user and lease: a double-click must not spend two model calls. */
const inFlight = new Set<string>();

export async function askLeaseQuestion(db: DB, llm: LlmCall, leaseId: number, user: PublicUser, question: string): Promise<QaMessage[]> {
  const lease = repo.getLeaseRow(db, leaseId);
  if (!lease) throw new ApiError(404, "NOT_FOUND", `Lease ${leaseId} not found`);
  const q = question.trim();
  if (!q) throw new ApiError(400, "VALIDATION_ERROR", "Ask a question");
  if (q.length > MAX_QUESTION_LENGTH) throw new ApiError(400, "VALIDATION_ERROR", `Questions are limited to ${MAX_QUESTION_LENGTH} characters`);
  const source = leaseSourcePages(db, lease);
  if (!source) throw new ApiError(422, "NO_SOURCE_TEXT", "This lease has no stored source text to answer from");

  const key = `${user.user_id}:${leaseId}`;
  if (inFlight.has(key)) throw new ApiError(409, "QUESTION_IN_PROGRESS", "Your previous question about this lease is still being answered");
  inFlight.add(key);
  try {
    const chunks = retrieve(q, chunkPages(source.pages));
    let answer: GroundedAnswer;
    try {
      answer = await answerQuestion(q, chunks, llm, { docName: source.doc_name, model: config.qaModel });
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        throw new ApiError(503, "LLM_UNAVAILABLE", `${err.message} (check GEMINI_API_KEY / QA_MODEL in .env, or your free-tier quota)`);
      }
      throw err;
    }

    const doc = documentForLease(db, leaseId);
    const view: QaAnswerView = {
      status: answer.status,
      text: answer.text,
      notice: answer.notice,
      statements: answer.statements.map((s) => ({
        ...s,
        citations: s.citations.map((c) => ({ ...c, doc_name: source.doc_name, document_id: doc?.document_id ?? null })),
      })),
    };

    tx(db, () => {
      const ins = db.prepare("INSERT INTO qa_messages (lease_id, user_id, role, content, answer_json) VALUES (?, ?, ?, ?, ?)");
      ins.run(leaseId, user.user_id, "user", q, null);
      ins.run(leaseId, user.user_id, "assistant", view.text, JSON.stringify(view));
      audit(db, {
        event_type: "qa_answered",
        actor: humanActor(user),
        subject: { type: "lease", id: leaseId },
        payload: {
          question: q,
          status: answer.status,
          model: answer.model,
          doc_name: source.doc_name,
          retrieved_chunk_ids: answer.retrieved_chunk_ids,
          citations: answer.statements.flatMap((s) => s.citations.map((c) => ({ chunk_id: c.chunk_id, page: c.page, quote: c.quote }))),
          interpretation: answer.statements.some((s) => s.kind === "interpretation"),
          attempts: answer.attempts,
          rejected_reason: answer.rejected_reason,
        },
      });
    });
    return qaHistory(db, leaseId, user.user_id);
  } finally {
    inFlight.delete(key);
  }
}

export function clearLeaseConversation(db: DB, leaseId: number, user: PublicUser): number {
  if (!repo.getLeaseRow(db, leaseId)) throw new ApiError(404, "NOT_FOUND", `Lease ${leaseId} not found`);
  return tx(db, () => {
    const r = db.prepare("DELETE FROM qa_messages WHERE lease_id = ? AND user_id = ?").run(leaseId, user.user_id);
    const removed = Number(r.changes);
    if (removed) audit(db, { event_type: "qa_cleared", actor: humanActor(user), subject: { type: "lease", id: leaseId }, payload: { messages_removed: removed } });
    return removed;
  });
}
