/**
 * Automatic renewal identification: every lease cycle that enters its renewal window gets a Decision Brief,
 * without anyone clicking a button. The scan only drafts. It never decides, and it never touches a cycle
 * that a person has decided, so a rejected or revision-requested cycle stays as the human left it.
 * A pending brief drafted from incomplete lease data is redrafted once the lease has been fixed.
 */
import type { AgentLlm } from "../agent/llm.js";
import { ApiError } from "../api/errors.js";
import type { DB } from "../db/connection.js";
import * as repo from "../db/repo.js";
import { automaticBlock, generateBrief, renewalCandidates } from "./briefs.js";

export interface ScanResult {
  created: { lease_id: number; brief_id: number }[];
  skipped: number;
  failed: { lease_id: number; error: string }[];
  /** True when the model could not be reached; the rest waits for the next scan. */
  stopped: boolean;
}

export async function scanRenewals(db: DB, llm: AgentLlm): Promise<ScanResult> {
  const result: ScanResult = { created: [], skipped: 0, failed: [], stopped: false };
  for (const c of renewalCandidates(db)) {
    const cycle = repo.getLeaseRow(db, c.lease_id)?.end_date;
    if (!cycle || automaticBlock(db, c.lease_id, cycle)) {
      result.skipped++;
      continue;
    }
    try {
      const brief = await generateBrief(db, llm, "renewal", c.lease_id, null);
      result.created.push({ lease_id: c.lease_id, brief_id: brief.brief_id });
    } catch (err) {
      // 409: a person got there first (or is drafting it now). Not a failure.
      if (err instanceof ApiError && err.status === 409) result.skipped++;
      else {
        result.failed.push({ lease_id: c.lease_id, error: (err as Error).message });
        if (err instanceof ApiError && err.status === 503) {
          result.stopped = true;
          break;
        }
      }
    }
  }
  return result;
}

/** Delay before a scan requested by a lease change, so a burst of corrections triggers one scan. */
const NUDGE_DELAY_MS = 3_000;
let nudge: (() => void) | null = null;

/**
 * Ask the running scheduler to scan soon instead of at its next interval: called after a lease is
 * corrected or linked, so a brief waiting on that fix is redrafted right away. Does nothing when no
 * scheduler is running (tests, or automatic renewals turned off).
 */
export function requestRenewalScan(): void {
  nudge?.();
}

/**
 * Scan once right away (without delaying startup) and then on an interval. Errors are logged, never thrown.
 * Returns a function that stops the schedule.
 */
export function startRenewalScheduler(db: DB, llm: AgentLlm, opts: { intervalMinutes: number; log?: (line: string) => void }): () => void {
  const log = opts.log ?? console.log;
  let running = false;
  let again = false;
  const run = async () => {
    if (running) {
      again = true; // never overlap a slow scan; run once more when it ends
      return;
    }
    running = true;
    try {
      const r = await scanRenewals(db, llm);
      if (r.created.length || r.failed.length) {
        log(`Renewal scan: ${r.created.length} brief(s) created, ${r.skipped} already covered, ${r.failed.length} failed${r.stopped ? " (model unavailable; will retry at the next scan)" : ""}.`);
        for (const f of r.failed) log(`  lease ${f.lease_id}: ${f.error.slice(0, 300)}`);
      }
    } catch (err) {
      log(`Renewal scan failed: ${(err as Error).message}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        void run();
      }
    }
  };
  let pendingNudge: ReturnType<typeof setTimeout> | null = null;
  const onNudge = () => {
    if (pendingNudge) clearTimeout(pendingNudge);
    pendingNudge = setTimeout(() => {
      pendingNudge = null;
      void run();
    }, NUDGE_DELAY_MS);
  };
  nudge = onNudge;
  const first = setTimeout(() => void run(), 0);
  const timer = setInterval(() => void run(), opts.intervalMinutes * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    if (pendingNudge) clearTimeout(pendingNudge);
    if (nudge === onNudge) nudge = null;
  };
}
