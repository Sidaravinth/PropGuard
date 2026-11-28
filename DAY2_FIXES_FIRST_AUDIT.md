# Day 2 Fixes: First Audit

## Context

The first audit (`FINAL_AUDIT_REPORT.md`) found the project **NOT READY**. Day 1 works. The Day 2 decision step is broken. You approved the six blocker fixes, the outdated-figures fix and five decisions. This plan covers that work (Part A). It also lists what else the assessment needs but is **not yet approved** (Part B).

**Rules:** no rewrite of Day 1, no change to business rules, no unrelated refactoring, no Git commits or pushes. `policy/policyEngine.ts` and `policy/renewalPolicy.ts` are not edited.

Paths are relative to `server/src/` unless noted.

## Approval conditions (binding)

Part A, Phases 0–11, is approved. **Part B is not.**

1. Before any change, back up the working tree, live database, uploaded documents and existing state.
2. **Never run migration 006 against the live database** during development or testing. Use copies.
   - Every server, script, seed or migration run sets `DB_PATH` and `UPLOADS_DIR` to scratch or copy paths. Tests and the evaluation use in-memory or temporary databases.
   - The live server stays stopped during the work. **Please don't restart it until you have reviewed the results**, because starting it applies migration 006.
3. Preserve all live records and uploaded files. Compare file hashes and row counts before and after.
4. Reservations and collected deductions are never double-counted. Tests check that available = held − deductions − reserved through reserve, collect, repeat collect, release, a policy re-check and a deposit correction.
5. Automatic renewal never overwrites or supersedes a human decision.
6. Rejected and revision-requested cycles are never regenerated automatically.
7. Do not modify `policyEngine.ts` or `renewalPolicy.ts`.
8. No Day 1 rewrite and no unrelated refactoring.
9. No features beyond the approved scope.
10. No Git commits or pushes.

Passing tests alone do not count as completion. Actual application behaviour is verified too.

## Part A: approved work, in phases

I complete the phases in order and report each phase's actual results before starting the next.

### Phase 0: preserve the current state (before any edit)
1. **Stop your `npm run dev:all` server** (ports 3001 and 5173). `tsx watch` restarts on every edit, which would apply the new migration, and later the renewal scan, to the live database partway through the work.
2. Copy the working tree to `d:\Nexavance\propguard-backups\pre-day2-fixes\`, without `node_modules`, `dist` or `.env`. Save `git status`, `git diff` and file hashes with it.
3. Back up the live database with SQLite `VACUUM INTO`, which includes WAL data. Copy `data/uploads`. Check integrity and record row counts.
4. Save this plan as `DAY2_FIXES_FIRST_AUDIT.md` in the project.

The live database is not reset, edited or deleted.

### Phase 1 (B6): green baseline
- `server/tests/auth.test.ts`: base the fixed clock on one `START` taken from the current time, replacing both hard-coded dates. All assertions stay.
- `server/eval/evalSuite.ts`: resolve the aggregate ledger citation (`tenant_id=T001`) by checking that this tenant has ledger rows. The existence check stays.

### Phase 2 (B1): blank screen
- In `api/briefRoutes.ts`, add one `briefDetail()` helper returning `briefView` plus `audit`. GET, the decision POST and the generate POST all use it.
- Test that approve, reject and request-revision responses each include `audit`. Click all three in a browser.

### Phase 3 (B2): wrong message
- `agent/briefSchemas.ts`, `agent/workflows.ts`: each maintenance option gets its own `message`, replacing the shared one.
- `services/decisions.ts`: send only the selected option's message. Code adds a first status line based on the action (approved at an amount, revised quote requested, or on hold).
- Grounding check: reject approval wording ("has been approved", "please proceed", "go ahead") in non-approval messages. This phrase check is a backstop; the code status line is the reliable part.
- `BriefDetailPage.tsx`: preview the selected option's message, or the recommended one before selection.
- **Compatibility:** old briefs with one shared message still display. Approving one returns 409 and asks you to regenerate.

### Phase 4 (B3): repeat approvals
- **Maintenance:** refuse both generation and approval for tickets already `approved`, `completed` or `rejected`. Approving "revised quote" or "hold" leaves the ticket open to a later brief.
- **Renewal cycle:** a cycle is the lease ID plus its current end date.
  - New migration `006_approval_integrity.sql` adds `decision_briefs.renewal_cycle` and fills it from each brief's stored `lease_end` figure.
  - It supersedes older duplicate pending briefs, then adds a unique index allowing one pending brief per cycle.
- Once a cycle is approved, no further brief or offer is allowed, and the lease leaves the candidate list.
- Manual regeneration still replaces a pending brief, and still works after rejection or a revision request.
- An in-progress guard stops two simultaneous runs for the same item. It is checked again when saving.

### Phase 5 (B4): outdated figures
- In `decideInTx`, after the fresh policy run, resolve every evaluation-based figure against the **new** evaluation. Reuse `resolveSource()` from `agent/figures.ts`.
- Any changed amount or approver tier returns `409 STALE_BRIEF` with old and new values, even when exception codes match.
- Test: balance falls from $3,150 to $1,050; approval is refused and no message is recorded.

### Phase 6 (B5): model reliability
- `config.ts`: default `AGENT_MODEL=gemini-3.5-flash-lite`. Add `AGENT_TIMEOUT_MS` and `EXTRACTION_TIMEOUT_MS` (60 s each) and `LLM_MAX_RETRIES` (2).
- `extraction/extractor.ts`, `agent/llm.ts`: time-limit each attempt with `abortSignal`. Extend `withBackoff()` to retry timeouts, network errors, 429 and 5xx. Do not retry bad keys or bad requests. Prompts and extraction checks do not change.
- Failures stay a clear 503. Failed uploads remain retryable.
- Next to `recoverInterruptedUploads`, mark leftover `running` agent runs as failed at startup, and audit it.

### Phase 7: deposit reservations
- Migration 006 also adds `deposit_reservations`:
  - lease, ticket, optional brief, amount, required approver tier
  - status `reserved`, `collected` or `released`
  - who and when, release reason, and the linked deduction entry
- One active reservation per ticket. Deleting a lease that has reservations is blocked, so history cannot silently disappear.
- **Available = held − deductions − reserved**, never below zero. Update `repo.remainingDepositCents()`. A ticket's own policy check excludes its own reservation or deduction, so it is not counted against itself.
- Approving spend with a tenant charge reserves it in the same transaction. This applies to briefs and direct ticket approval.
- **Collect:** in one transaction, change `reserved` to `collected` and add one deduction. A second attempt gets 409.
- **Release:** requires a reason and applies only to `reserved` charges.
- Both actions require a role allowed to approve that ticket's tier. All three events are audited.
- The ticket page gets Collect and Release controls. Lease and ticket views show available, reserved and collected.

### Phase 8: approving tickets without exceptions
- `POST /api/tickets/:id/decision` (approve or reject, optional comment), placed in `services/decisions.ts` so the agent cannot import it.
- It re-runs the policy engine and accepts only an `open` ticket with no exceptions and a PM or RD tier.
  - Flagged tickets still go through briefs.
  - Tickets of $200 or less stay "auto-approve eligible" as today.
- It uses `canApproveTier()`. Refusals and decisions are audited.
- **Assumption:** the approved amount is the cost basis, the higher of work order and quote, which is the amount the tier was checked against.
- `TicketDetailPage.tsx` gets a confirm-first Approve/Reject card.
- Test $200, $201, $1,000, $1,001, and the $5,000 injection ticket: PM gets 403, RD succeeds.

### Phase 9: automatic renewal briefs
- New `services/renewalScheduler.ts`, started only from `index.ts`. It runs after startup without blocking, then every `RENEWAL_SCAN_INTERVAL_MINUTES` (60). `RENEWAL_AUTO_ENABLED` defaults to true.
- It reuses `renewalCandidates()` and `generateBrief()`. The latter will also accept a system actor.
- It skips any cycle that already has a brief, including rejected and revision-requested ones, so a human decision is never undone automatically. The manual button remains.
- Model or key failures are logged and retried at the next scan. The server stays up.

### Phase 10: fixtures, database and documentation
- `db/seed.ts` ingests an **explicit list of the five assessment leases**, with the existing matching records, into the sample database only. `npm run seed` stays the explicit command. Startup creates user accounts only, never sample records.
- Move the sixth file, `lease_oakwood_302_okafor.pdf`, to `data/demo/` and restore the strict five-file test. The live database keeps its own uploaded copy.
- Test that startup adds no sample records and that uploaded data survives a restart.
- Update `README.md` and `.env.example`: model, timeouts, scheduler, reservations, ticket approval, seeding, and measured latency.
  - State that an existing live database keeps its records, **including earlier sample records**.
  - Correct overstated claims and list remaining audit gaps.
- Add the new endpoints to `api/openapi.ts`.

### Phase 11: verification
| Check | Method and pass condition |
|---|---|
| Full suite | `npm test`: existing and new tests pass, with no assertion weakened. The fixture's shape changes for per-option messages. |
| Types and build | `npm run typecheck` and `npm run build` |
| Policy engine unchanged | Hashes match the Phase 0 copy; `git diff --exit-code HEAD -- server/src/policy/policyEngine.ts` |
| Migration | Run on a **copy** of the live backup and on an empty database. Compare row counts; run integrity and foreign-key checks; confirm audit chain. Count earlier approved tenant charges that would lack reservations. |
| Real AI | Both workflows with the new default, no override; `npm run eval` |
| Approval flows | Throwaway database and headless browser on port 3999: all three brief actions, ticket approval, reserve/collect/release, and each original reproduction |
| Automatic renewal | Start twice on a throwaway database: exactly one brief per cycle |

### Final report after Phase 11
- Test results and counts
- Type check and build results
- Migration verification
- Confirmation that live data is preserved
- AI workflow verification
- Approval and deposit lifecycle verification
- Automatic renewal verification
- Remaining failures and incomplete requirements

Migration 006 reaches the live database **only when you next start the server**, which can also start a renewal scan. I won't restart your server against live data.

## Part B: recommended for the assessment, **not approved, not included**

| Priority | Recommended fix | Assessment output it supports |
|---|---|---|
| P1 | Eval: policy-check its tickets so a maintenance brief is tested; skipped sections must not report PASS | Grounding check and clean evaluation run. **It stays incomplete without this**, even if the command passes. |
| P1 | Grounding gate: catch number words, "dollars", other currencies and bare amounts | Zero hallucinated numbers |
| P1 | Audit `/api/leases/ingest`, CLI ingestion and record edits; stop silent lease replacement | Every significant event logged |
| P1 | Document existing agent, brief and audit endpoints in Swagger | API documentation |
| P2 | Fix 390 px overflow (`styles.css:318`: use `minmax(0, 1fr)`), raw cents and internal IDs | Responsive, clear UI |
| P2 | Review the renewal email: after one option is approved, it still lists all three | Notice matches the human decision |
| P2 | Rejecting a maintenance brief leaves the ticket `flagged`; update stale notes | State clarity and documentation |
| Yours | Commit the Day 2 work, record the 5–10 minute demo | Final deliverables |
| Optional | Q&A chat (bonus) | Not required |

I recommend approving the four P1 items right after Part A. The project should be reassessed only after the Part A checks, and the assessment's grounding-check output also depends on the first P1 item.

---

## Results (Part A, verified 27 November 2026)

`FINAL_AUDIT_REPORT.md` describes the state **before** these fixes.

| Check | Result |
|---|---|
| `npm test` | 268 passed, 0 failed, 0 skipped (14 files; was 217 with 16 failing) |
| `npm run typecheck` / `npm run build` | Pass / pass |
| `npm run eval`, default models | 17 passed, 0 failed, 0 skipped |
| Policy files | `policyEngine.ts` and `renewalPolicy.ts` hashes match Phase 0 |
| Migration 006 | Verified on a copy of live, an empty DB, a populated pre-006 DB and a Day-1-only DB |
| Live database and uploads | Byte-identical to Phase 0; migration 006 not applied |
| Browser | Brief approve / reject / revision, per-option preview, deposit collect / release, ticket approval, 16 pages with no errors |
| Automatic renewal | Three real server starts: one brief; a rejected cycle stayed rejected |

Backup: `d:\Nexavance\propguard-backups\pre-day2-fixes`. Part B has not been started.

---

## Part B results (28 November 2026)

| Check | Result |
|---|---|
| `npm test` | 365 passed, 0 failed, 0 skipped (18 files) |
| Type check / build | Pass / pass |
| Clean copy (no `node_modules`, `.env` or databases) | `npm ci`, migrate, offline seed, 365/365, type check and build pass |
| `npm run eval`, default models | 31 passed, 0 failed, 0 skipped; 1 renewal and 2 maintenance briefs; negative control caught |
| `npm run eval -- --skip-llm` | INCOMPLETE, exit 2 |
| Grounding false positives | 20/20 real drafts grounded, all by the second attempt (13 on the first attempt; see note) |
| Policy files | `policyEngine.ts`, `renewalPolicy.ts` unchanged |
| Migrations 006-007 | Pass on a live-data copy, an empty DB, a populated pre-006 DB and a Day-1-only DB |
| Browser | Renewal notices, brief rejection, charge warning, deposits, ticket approval, Swagger, 18 pages at 1366 px and 390 px |
| Part A regressions | Pass (messages, single approval, stale amounts, timeouts, bad key, renewal restarts) |
| README demo as one continuous run on the final build | Pass (rerun with a new API key): all steps, 16 pages, no browser errors |
| `npm run eval` rerun with the new key | 31 passed, 0 failed, 0 skipped |

Note on the false-positive check: the first renewal run failed (8/10) because the model wrote the option code
`twelve_month_3pct` in prose. The code is still rejected, now with a clear instruction; the rerun gave 10/10.

Found and fixed in Part B: `INSERT OR REPLACE` could rewrite audit rows (and deposit reservations); migration 007 blocks it.
Backup: `d:\Nexavance\propguard-backups\pre-part-b`.
