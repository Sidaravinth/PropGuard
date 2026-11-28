/**
 * Append-only, hash-chained audit log. Every row's hash covers the previous row's hash, so any edit to
 * history is detectable (verifyAuditChain); DB triggers additionally reject UPDATE and DELETE.
 * There is deliberately no API to modify or delete audit entries.
 */
import crypto from "node:crypto";
import type { DB } from "../db/connection.js";
import type { PublicUser } from "../auth/authService.js";
import { ENGINE_VERSION } from "../policy/policyEngine.js";

export type Actor = { type: "human"; id: string; user_id: number } | { type: "agent"; id: string } | { type: "system"; id: string };

export const humanActor = (u: Pick<PublicUser, "user_id" | "role" | "display_name">): Actor => ({
  type: "human",
  id: `${u.role.toUpperCase()}:${u.display_name}`,
  user_id: u.user_id,
});
export const SYSTEM: Actor = { type: "system", id: "system" };
export const POLICY_ENGINE: Actor = { type: "system", id: `policy-engine@${ENGINE_VERSION}` };
export const agentActor = (model: string): Actor => ({ type: "agent", id: model });

export interface AuditEvent {
  event_type: string;
  actor: Actor;
  subject?: { type: "lease" | "ticket" | "brief" | "document" | "import" | "tenant" | "unit" | "property"; id: string | number };
  brief_id?: number | null;
  payload: Record<string, unknown>;
}

export interface AuditRow {
  audit_id: number;
  occurred_at: string;
  event_type: string;
  actor_type: string;
  actor_id: string;
  subject_type: string | null;
  subject_id: string | null;
  brief_id: number | null;
  payload_json: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

export function rowHash(r: Omit<AuditRow, "audit_id" | "hash">): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([r.prev_hash, r.occurred_at, r.event_type, r.actor_type, r.actor_id, r.subject_type, r.subject_id, r.brief_id, r.payload_json]))
    .digest("hex");
}

/** Append one event. Call inside the same transaction as the change it records when there is one. */
export function audit(db: DB, e: AuditEvent): number {
  const prev = (db.prepare("SELECT hash FROM audit_logs ORDER BY audit_id DESC LIMIT 1").get() as { hash: string } | undefined)?.hash ?? GENESIS;
  const payload = e.actor.type === "human" ? { ...e.payload, user_id: e.actor.user_id } : e.payload;
  const row = {
    prev_hash: prev,
    occurred_at: new Date().toISOString(),
    event_type: e.event_type,
    actor_type: e.actor.type,
    actor_id: e.actor.id,
    subject_type: e.subject?.type ?? null,
    subject_id: e.subject ? String(e.subject.id) : null,
    brief_id: e.brief_id ?? null,
    payload_json: JSON.stringify(payload),
  };
  const r = db
    .prepare(
      `INSERT INTO audit_logs (occurred_at, event_type, actor_type, actor_id, subject_type, subject_id, brief_id, payload_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.occurred_at, row.event_type, row.actor_type, row.actor_id, row.subject_type, row.subject_id, row.brief_id, row.payload_json, row.prev_hash, rowHash(row));
  return Number(r.lastInsertRowid);
}

/** Recompute the whole chain. Returns the first broken row, if any. */
export function verifyAuditChain(db: DB): { ok: boolean; checked: number; first_broken_audit_id: number | null } {
  const rows = db.prepare("SELECT * FROM audit_logs ORDER BY audit_id").all() as unknown as AuditRow[];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || rowHash(r) !== r.hash) return { ok: false, checked: rows.length, first_broken_audit_id: r.audit_id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, first_broken_audit_id: null };
}

export interface AuditQuery {
  event_type?: string;
  actor_type?: string;
  actor?: string;
  subject_type?: string;
  subject_id?: string;
  brief_id?: number;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export function listAudit(db: DB, q: AuditQuery = {}) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, v: string | number | undefined) => {
    if (v === undefined || v === "") return;
    where.push(sql);
    args.push(v);
  };
  add("event_type = ?", q.event_type);
  add("actor_type = ?", q.actor_type);
  add("actor_id LIKE ?", q.actor ? `%${q.actor}%` : undefined);
  add("subject_type = ?", q.subject_type);
  add("subject_id = ?", q.subject_id);
  add("brief_id = ?", q.brief_id);
  add("occurred_at >= ?", q.from);
  add("occurred_at < ?", q.to ? `${q.to}T23:59:59.999Z` : undefined);
  add("payload_json LIKE ?", q.q ? `%${q.q}%` : undefined);
  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${sqlWhere}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM audit_logs ${sqlWhere} ORDER BY audit_id DESC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(q.limit ?? 50, 200), q.offset ?? 0) as unknown as AuditRow[];
  const eventTypes = (db.prepare("SELECT DISTINCT event_type FROM audit_logs ORDER BY event_type").all() as { event_type: string }[]).map((r) => r.event_type);
  return { total, event_types: eventTypes, rows: rows.map(({ payload_json, ...r }) => ({ ...r, payload: JSON.parse(payload_json) as unknown })) };
}
