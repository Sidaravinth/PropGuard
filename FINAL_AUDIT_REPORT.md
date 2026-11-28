# PropGuard: Final Audit Report

**Audit date:** 27 November 2026
**Specification:** `Technical Assessment.PDF` (one folder above the repository)
**Code audited:** `main` at `38e919a`, plus the uncommitted working tree
**Verdict:** **NOT READY** (see section 15)

No source code, test, schema or configuration was changed. This report is the only file added.

## 1. Executive summary

The foundation is strong. Extraction, the deterministic policy engine, role gating, injection resistance and audit immutability all held up when run. The **human decision step**, which is the point of Day 2, is broken.

| Area | PASS | PARTIAL | FAIL | Total |
|---|---:|---:|---:|---:|
| Day 1 | 14 | 3 | 0 | 17 |
| Day 2 | 9 | 5 | 3 | 17 |
| Deliverables | 8 | 4 | 1 | 13 |
| **All** | **31** | **12** | **4** | **47** |

These counts are requirement rows, not a weighted score. A few failures affect the whole demo.

### Critical blockers (all reproduced)

| # | Blocker |
|---|---|
| **B1** | **Approve, Reject and Request Revision each leave a blank screen.** The server saves the decision, then the UI crashes. |
| **B2** | **The wrong message can be sent.** Approving "Request a revised quote" marked as sent a message saying the quote was *"reviewed and approved by management. Please proceed."* |
| **B3** | **Spend can be approved twice.** An approved ticket accepted a second brief and approval. One lease got two renewal offers. |
| **B4** | **A stale brief can be approved.** The live balance was $1,050, but the approved message demanded $3,150. |
| **B5** | **The configured agent model never produced a brief.** `gemini-3.5-flash` gave no first reply within 150 s, 150 s and 300 s. The app sets no timeout. |
| **B6** | **`npm test` fails today:** 201 passed, 16 failed. `npm run eval` also fails. |

### How this was tested

- The existing test suite, type check, production build and evaluation script.
- The real application with the real Gemini API, against throwaway databases. This covered the 5 sample leases, 10 seeded tickets and several agent briefs.
- The built UI in headless Edge, on a separate server (port 3999).
- Scripted-model runs for repeatable edge cases (B4, deposit cap, grounding gate).
- Read-only inspection of the live database. The running `dev:all` servers received only GET requests.

**Model caveat:** because of B5, successful live agent and evaluation runs set `AGENT_MODEL=gemini-3.5-flash-lite` for that process only. They show that the workflows work. They do **not** show that the submitted default configuration works.

## 2. Day 1 completion matrix

Paths are relative to `server/src/` unless noted.

| ID | Expected behaviour | Source | Status | Verification and actual result | Remaining work |
|---|---|---|---|---|---|
| D1-01 | Normalized relational schema with keys | `db/migrations/001–005` | PASS | Fresh migration; 0 foreign-key violations. `units.property_name` is a deliberate copy of `properties.name`, synced by triggers. | None |
| D1-02 | Six required tables | `001_init.sql` | PASS | All six exist with the required columns (money as `_cents`). | None |
| D1-03 | Five realistic leases, varied terms | `data/leases/` | PASS | The 5 samples include a PDF and 30/45/60-day notices. A sixth, untracked file is also there. | See R1 |
| D1-04 | Matching records, 2+ mismatches, overdue tenant | `db/seedData.ts` | PASS | Tickets #3 (+27.8%) and #7 (+20%); tenant T003 is overdue. | None |
| D1-05 | Missing-field and expired edge cases | `data/leases/` | PASS | Rodriguez: deposit missing. O'Connor: expired. Patel: contradictory rent. | None |
| D1-06 | Ingestion endpoint or CLI | `extraction/`, `api/routes.ts` | PASS | Real model processed 5 of 5 uploads. A new lease was also uploaded through the UI. | Audit gap, section 8 |
| D1-07 | LLM extraction, strict schema, retry | `extractor.ts`, `leaseSchema.ts` | PASS | Real runs, about 3–5 s each. Retry paths pass offline tests (scripted model). | None |
| D1-08 | Exact excerpts and references stored | `ingest.ts`, `verify.ts` | PASS | All six term fields had citations when extracted. Some name and unit fields lacked a section or page. | Minor |
| D1-09 | Missing or ambiguous values flagged | `verify.ts` | PASS | 2 of 2 flagged with empty values. The demo lease lacks deposit and deductible; both were marked missing. | None |
| D1-10 | Three-way verification | `policy/policyEngine.ts` | PASS | Run on all 10 tickets; cost split uses the deductible. | None |
| D1-11 | Flag a quote more than 10% over | same | PASS | Integer comparison; tests cover exactly 10% and one cent over. | None |
| D1-12 | Flag an unpaid balance | same | PASS | Flagged on #3 and #9. | None |
| D1-13 | Thresholds $200 and $1,000 | same | PASS | $200 auto, $201 PM, $1,000 PM, $1,001 RD. An exception raises auto to PM. | None |
| D1-14 | Charge cannot exceed remaining deposit | same, `services/decisions.ts` | PARTIAL | A single charge is capped and a missing deposit blocks it. But **two $1,500 charges were both approved against one $1,500 deposit**; remaining stayed $1,500. No approval records a deduction. | Question Q2 |
| D1-15 | Required REST endpoints, clear errors | `api/` | PASS | Lists, clauses, tickets and policy check work. Correct 400, 401 and 404 responses. | None |
| D1-16 | Swagger documentation | `api/openapi.ts` | PARTIAL | `/docs` loads with 37 paths, but **no agent, brief or audit endpoints**. | Add Day 2 paths |
| D1-17 | Policy unit tests pass 100% | `server/tests/` | PARTIAL | Policy and boundary tests pass. The full suite fails today (section 9). | B6 |

## 3. Day 2 completion matrix

| ID | Expected behaviour | Source | Status | Verification and actual result | Remaining work |
|---|---|---|---|---|---|
| D2-01 | Four read-only database tools | `agent/tools.ts` | PASS | Live calls observed. An invented `approve_brief` tool is rejected (test). `run_policy_check` records an evaluation and may toggle open/flagged, as Day 1 does; it cannot approve. | Describe that write accurately |
| D2-02 | Renewal brief generator | `agent/workflows.ts`, `services/briefs.ts` | PARTIAL | With flash-lite: grounded in 6 s. Default model failed (B5). It re-briefs an already-renewed lease (B3). Started by a button, not automatically. | B3, B5, Q3 |
| D2-03 | Maintenance exception resolver | same | PARTIAL | Briefs for tickets #3, #7, #9 and an injection ticket, 6–7 s each. The draft message fits only the AI's recommended option (B2). | B2, B3, B5 |
| D2-04 | Every number grounded and cited | `agent/grounding.ts`, `figures.ts` | PARTIAL | Live briefs passed and all figures matched when generated. Two holes: B4, and the gate **accepts** "5000 dollars", "1,975 per month", "sixty days", "ten percent", "nine hundred dollars" and "€500". It also checks that a literal value exists, not that its label is right. | Fix B4; widen gate |
| D2-05 | Three priced renewal options | `policy/renewalPolicy.ts` | PASS | $1,500, $1,545 (+3%) and $1,500 month-to-month, computed in code, with risks and email. | None |
| D2-06 | Two resolution options | `agent/briefSchemas.ts` | PASS | Exactly two distinct actions in every live brief, with explanations and a draft. | See B2 |
| D2-07 | Evidence-backed briefs | `agent/evidence.ts` | PASS | 27–30 evidence items per brief, including the repair clause. One aggregate citation cannot be resolved by the eval (D2-15). | Fix that citation |
| D2-08 | Inbox with priority and approver | `web/src/pages/inbox/InboxPage.tsx` | PASS | Rendered with no errors. Maintenance tiers come from the policy engine; renewal tier from a code constant. | None |
| D2-09 | Responsive detail and evidence panel | `BriefDetailPage.tsx` | PARTIAL | Desktop is clear; snippets expand with section and page. At 390 px it **overflows by 279 px**. Evidence also shows raw cents ("Value: 10000"). | CSS and formatting |
| D2-10 | Approve, Reject, Request Revision | same, `api/briefRoutes.ts` | **FAIL** | All three clicked in a browser. Each saved, then showed **a blank page** (`TypeError … reading 'map'`). | B1 |
| D2-11 | Correct state transitions | `services/decisions.ts` | **FAIL** | Role gate and double-click guard work. B2, B3 and B4 reproduce. Rejecting leaves the ticket `flagged`. The approved amount lives only in the brief's JSON. | B2–B4 |
| D2-12 | Log every significant event | `services/audit.ts` | PARTIAL | Required agent, policy and human events are logged. Some paths are not (section 8). | Close gaps |
| D2-13 | Audit Trail UI or API | `AuditPage.tsx`, `briefRoutes.ts` | PASS | UI and filters render; chain verified over 92 entries. | None |
| D2-14 | Extraction accuracy evaluation | `server/eval/evalSuite.ts` | PASS | **100% (30/30)**; dates, rent and notice each 100%. | None |
| D2-15 | Numerical grounding evaluation | same | **FAIL** | The citation check fails on `ledger:tenant:T001`. **No maintenance brief is evaluated**, because eval tickets are never policy-checked, so none are flagged. Only `$`/`USD` amounts are checked. | Fix all three |
| D2-16 | Injection safety evaluation | same | PASS | All injection checks passed, live agent included. | None |
| D2-17 | $5,000 injection needs Regional Director | policy and approval code | PASS | RD required, no auto-approval, PM gets 403. The live draft said approval was pending. | See Q1 |
| Bonus | Grounded Q&A chat | not built | NOT APPLICABLE | Optional; the README says so. Not counted. | None |

## 4. Frontend verification

| Check | Result |
|---|---|
| Type check and `npm run build` | Pass (424 kB JS, 122 kB gzipped) |
| Running dev server on 5173 | HTTP 200 |
| 15 routes at 1366 px, including Not Found | All render with no console or HTTP errors; no horizontal overflow |
| PM viewing an RD brief | Approve disabled, with an explanation |
| 390 px width | Dashboard, inbox and audit fit; **brief detail overflows 279 px** |
| New lease upload in UI | Saved as `needs_review`, as expected for its two gaps |
| Approve, Reject, Request Revision | **All crash to a blank page** |
| Frontend tests | None exist; no `test` script |

**B1 root cause:** `POST /api/briefs/:id/decision` returns `briefView()` without `audit`; only `GET /api/briefs/:id` adds it (`briefRoutes.ts:55` and `:60`). The page stores the POST response (`onDecided={setData}`), then runs `b.audit.map(...)`. The client type claims `audit` is always present, so type checking cannot catch it.

## 5. Backend verification

| Check | Result |
|---|---|
| Type check | Pass |
| Startup | Audit server started on 3999; your server's health check on 3001 returned 200 |
| Authentication | Anonymous requests get 401. Session behaviour passes tests once the clock problem is removed. |
| Role-based access | PM refused on RD-tier approvals (403, audited); RD approved |
| Input validation | Smuggled `approverRequired`, float cents and bad JSON all rejected |
| Model calls | **No timeout.** Backoff covers only 429 and 5xx errors; a stalled request waits indefinitely. |
| Interrupted agent runs | **Never recovered.** Startup repairs only interrupted uploads (`index.ts`). |

**Model measurements**

| Model | Request | Result |
|---|---|---|
| flash-lite | "Reply OK" / tool call | 0.7 s / 0.8 s |
| flash | "Reply OK" / one raw tool call | 42 s / 19 s |
| flash | Three real workflow attempts | No first reply in 150 s, 150 s, 300 s |

The cause of the slowness was **not determined**. It may be free-tier throttling or provider load on this day. The missing timeout is a code defect either way.

## 6. Database verification

| Check | Result |
|---|---|
| `npm run migrate` on an empty path | Applies 001–005 |
| `npm run seed -- --no-ingest` on a scratch path | 6 units, 5 tenants, 30 ledger rows, 10 tickets |
| Seeding the live path | Correctly refused |
| `npm run seed` with ingestion | NOT VERIFIED as a command; the same pipeline was verified on the 5 samples. It would also ingest the sixth file. |
| Live database | Integrity `ok`; 0 foreign-key violations |

**Findings in the live database** (`data/propguard.db`; nothing was changed):

1. **It holds the sample data** (seeded tenants, 10 tickets, 30 ledger rows) plus one uploaded lease. The README says it starts empty, and your decision 5 says sample data is not the operational source. All 10 tickets are `flagged`, likely because most have no lease there. (Q5)
2. **It applied a migration that is not in the repository** (`002_day2.sql`). The only schema difference from a fresh build is an unused `maintenance_tickets.approved_amount_cents` column.
3. **Two agent runs are stuck in `running`** (ticket #1, 16:56 and 16:57 UTC), with no tool calls, error or audit entry. The dev server process restarted at 16:58 UTC, which likely interrupted them.

**Unused states:** ticket statuses `pending_approval`, `rejected` and `completed` are never set by application code, so the dashboard's "completed" count stays 0. The app also never writes a deposit `deduction`.

## 7. AI grounding and safety verification

**Held up**

- No agent tool can approve, and the model never sets a tier or a price.
- The live injection test could not lower the tier or bypass approval.
- Maintenance drafts that invent or omit exception codes are rejected (tests).
- Ungrounded briefs and briefs with missing data cannot be approved (tests).

**Did not hold up**

- **B2:** one message serves both options, and `decisions.ts` sends it whichever is chosen. The live draft behind this also claimed approval **before** any human had approved. A related, milder case: the renewal email lists all three options, and is sent unchanged after one is approved.
- **B4:** maintenance figures such as unpaid balance point to the **old stored policy evaluation**. Re-verifying them always succeeds. The re-run compares only exception **codes**. If amounts change but codes do not, the brief is not stale. This contradicts the README's claim that every figure is re-checked against the current database.
- **Gate coverage:** see D2-04. No live brief used these forms to state a false number; the gate was tested directly.

Smaller point: a live technician message contained the internal ID `unit:U101`.

## 8. Audit trail verification

| Required record | Result |
|---|---|
| Agent runs: time, workflow, tools, outputs, evidence IDs, brief ID | Present (`agent_run`, `tool_call`, `brief_created`) |
| Policy evaluations: inputs, rules, verdict, approver | Present |
| Human decisions: role, action, option, comment, time | Present; refusals logged too |
| UPDATE and DELETE | Blocked by triggers |
| Hash chain | Verified; tamper detection passes its test. Removing the newest rows would not be detected (documented). |

**Gaps** (the README says every step is logged):

- `POST /api/leases/ingest` writes **no upload or extraction event**. Re-using a file name also **replaces the earlier lease and its correction history** (found in code review).
- CLI ingestion writes no audit event (code review).
- Creating or editing properties, units or tenants writes nothing: **0 rows** after three test writes. Tenant moves can change which lease and ledger policy checks use.
- A run killed mid-way leaves no final `agent_run` event.

## 9. Automated testing results

| Command | Result |
|---|---|
| `npm test` | **FAIL: 201 passed, 16 failed** (217); all failures in `auth.test.ts` |
| Same tests, process clock shifted back | 217 of 217 passed |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm run eval` (flash-lite override) | **FAIL: 15 passed, 2 failed**, 0 skipped, 113 s |
| `npm run eval` (default model) | NOT VERIFIED to completion. One run was stopped on your instruction. An older run (started 22:25) was still going after 15 minutes and was stopped too. |
| Frontend tests | None |
| Separate integration command | None; API tests are part of `npm test` |

**Why 16 fail:** `auth.test.ts` fixes the server clock at `2026-11-27T09:00Z`, so cookies expire at 17:00 UTC. The test client checks expiry against the **real** clock. After 17:00 UTC (22:30 IST) the tests get 401. This is a **faulty test, not a login defect**, but a reviewer will see failures. The clock-shift run used a temporary config, since removed.

**Evaluation failures:** (1) the `ledger:tenant:T001` citation; (2) the 16 tests above.

**Saved report is misleading:** `server/eval/last-report.md` says **PASSED**, but it skipped extraction, grounding and the live agent, and predates the time-bomb failure. Skips still exit successfully. I restored your saved files after my run.

**What the tests are worth**

- **Real functional tests:** in-memory SQLite and real HTTP handlers, covering policy, extraction checks, records and approvals.
- **Model is scripted:** these tests say nothing about real model behaviour or latency.
- **Static guards:** module-boundary tests match source text. Useful, but not proof of isolation.
- **Missing:** nothing tests the UI, option-to-message match, repeat approval, same-code stale data or cumulative deposit charges. This is why B1–B4 slipped through.
- **Loosened Day 1 test:** `schema.test.ts` changed from "exactly 5 lease files" to "contains the 5". This accommodates the extra file.

## 10. Unnecessary features report

Classes: **A** mandatory, **B** useful, **C** optional, **D** unnecessary, **E** harmful.

### Optional or supporting: keep

Removing working code now adds risk and little value.

| Feature | Class | Why it exists; used? | Conflict | If removed | Recommendation |
|---|---|---|---|---|---|
| Authentication, sessions, roles | B | Enforces approver roles; used | None | Breaks approval authorization | Keep (decision 7) |
| Session list, password change, Settings | C | Account care; used | None | Auth routes, tests, Settings page | Keep |
| Properties, units, tenants, ledger screens | B | Enter real operational data; used | None; supports decisions 5–6 | Linking and policy inputs | Keep; add audit events |
| CSV/XLSX import (`csv-parse`, `read-excel-file`) | C | Bulk entry; wired to UI | None | Wizard, service, tests, 2 packages | Keep; XLSX is NOT VERIFIED |
| Dashboard | C | Overview and home page | None | Home route, API, service | Keep; stop adding to it |
| Lease corrections, document store | B | Resolve flagged gaps; keep originals | None | Review flow and retry | Keep |
| Audit hash chain | C | Extra tamper evidence | None | Verify endpoint, badge, tests | Keep |
| `pdfkit`, `makeSamplePdf.ts` | C | Generates a sample PDF; dev only | None | Loses regeneration | Keep |
| Day 1 and Day 2 notes | B | Day 1 notes are required | Some text is stale | Loses a deliverable | Update stale lines |

No unnecessary external service, background worker or model provider was found. The two-phase agent is reasonable.

**Duplication (low priority, do not refactor now):** money formatting (server twice, plus web), ISO-date validation (twice), day arithmetic (three places), and a separate 60-day dashboard constant.

### Duplicate or harmful items

| ID | Item | Class | Used? | Conflict and dependencies | Recommendation | Removal risk |
|---|---|---|---|---|---|---|
| R1 | `data/leases/lease_oakwood_302_okafor.pdf` | E | A copy was uploaded to the live DB; `seed` would ingest it | Muddies the "5 samples" set and led to a looser test | **Move to `data/demo/`**, restore the strict test | Low: the app keeps its own copy |
| R2 | Unused `ModulePage` export | D | No; `NotFoundPage` in that file is used | None | Remove the unused export only | Very low |
| R3 | Saved skip-mode eval report | E | Reads as evidence of success | Overstates results | Regenerate after fixes | None |
| R4 | `POST /api/leases/ingest` beside `/documents/leases` | E as built | Tests and CLI-style use | **The PDF names this endpoint**, so removal would conflict | **Do not remove.** Add auditing; prevent silent replacement | Removal breaks Day 1 compliance |

## 11. Security and reliability findings

| Severity | Finding |
|---|---|
| Critical | Wrong approval message (B2), repeat approval (B3), stale approval (B4) |
| High | UI crash (B1); no model timeout (B5); stuck runs not recovered |
| Medium | Cumulative deposit cap (D1-14); audit gaps; silent lease replacement |
| Medium | Free-tier Gemini content may be used by the provider (noted in `.env.example`): use sample data only |
| Low | `/docs` and `/openapi.json` need no sign-in |
| Accepted | No login lockout or rate limit, **per decision 1**. Not treated as a defect. |

**Observed good practice:** bcrypt; hashed session tokens; httpOnly, SameSite=Strict cookies; origin check on writes; strict request schemas. A scan for the Google API-key pattern found nothing in committable files or Git history. Exact `.env` secrets were not found in current committable files. `.env` is not tracked.

**NOT VERIFIED:** dependency vulnerability scan, load behaviour, production HTTPS settings.

## 12. Regression findings

| Check | Result |
|---|---|
| Day 1 extraction, API and policy rules | Intact in live runs; `policyEngine.ts` has no uncommitted change |
| Day 2 database changes | Migration 005 changes no Day 1 table; its guard stops if draft tables hold data. Upgrade of a populated Day 1 database was NOT VERIFIED separately. |
| Policy service changes | Adds auditing and records who triggered a check; same results |
| `tx()` changes | Adds nested transactions; tests pass with the clock shifted |
| Agent uses the Day 1 engine | Yes, through `runTicketPolicyCheck` |
| Briefs reference real records | Yes, apart from the aggregate ledger citation format |
| Audit rows match actions | Yes where logged; see the gaps |
| Existing tests | One Day 1 test loosened; 16 auth tests are time-dependent |

**Conclusion:** no broken Day 1 behaviour was found. The serious defects are in the new Day 2 code. The UI, test clock and lease-file issues still need attention.

## 13. Missing documentation and deliverables

| ID | Deliverable | Status | Evidence and remaining work |
|---|---|---|---|
| FD-01 | README, accurate | PARTIAL | Thorough, but overstates figure re-verification, audit coverage and an empty live DB |
| FD-02 | Architecture diagram | PASS | ASCII diagram covers all parts |
| FD-03 | Setup instructions | PASS | Present; a clean-clone `npm install` was NOT VERIFIED |
| FD-04 | Environment variables | PASS | `BCRYPT_ROUNDS` and `COOKIE_SECURE` appear only in `.env.example` |
| FD-05 | Database initialization | PASS | Commands verified (section 6) |
| FD-06 | Backend and frontend commands | PASS | Servers running; build verified. `npm start` itself was not run. |
| FD-07 | Test and eval commands | PARTIAL | Documented, but both fail today |
| FD-08 | Engineering trade-offs | PASS | Present |
| FD-09 | Failure modes | PASS | Present; add timeouts and interrupted runs |
| FD-10 | Scaling to 10,000 documents | PASS | Present |
| FD-11 | Git repository | PARTIAL | History shows Day 1 and part of Day 2; **most Day 2 work is uncommitted**. Yours to commit. |
| FD-12 | 5–10 minute demo | **FAIL** | Blank screen at approval; default model produced no brief. No recording was found. |
| FD-13 | Model cost and latency | PARTIAL | Section exists, but "30 seconds to a few minutes" does not cover what was observed; cost is qualitative only |

Also update stale text: `DAY2_NOTES.md` refers to a future README and later groups, and `DAY1_NOTES.md` names a `002_day2.sql` plan.

## 14. Prioritized action plan

These are **proposals**. Nothing has been applied.

### P0: critical blockers

| # | Smallest fix | Add a test for |
|---|---|---|
| 1 | Include `audit` in the decision response | The response has the same shape as GET; click all three buttons |
| 2 | Draft one message **per option** and send only the selected one. Forbid claims that approval already happened. | Approving B sends B's message |
| 3 | Refuse new briefs and approvals for approved tickets. Refuse a second offer for the same lease term, and drop that lease from candidates. | A second approval gets 409 |
| 4 | At approval, compare the new policy evaluation's **amounts** with the brief's; any change means stale | Balance changes while codes stay the same |
| 5 | Add a per-call timeout, and choose an agent model that completes reliably (Q4) | A stalled call fails cleanly |
| 6 | Make the auth test clock relative to the current time, keeping every assertion | Passes at any time of day |

### P1: assessment requirements

7. Fix the eval: resolve the ledger citation, policy-check tickets so a maintenance brief is tested, and never report PASS when required sections were skipped.
8. Widen the grounding gate to number words, other currency forms and bare amounts.
9. Enforce the deposit cap across approved charges (after Q2).
10. Close the audit gaps, including `/api/leases/ingest`, and stop silent lease replacement.
11. Add Day 2 endpoints to OpenAPI.
12. Mark interrupted agent runs as failed at startup, with an audit event.
13. Correct the README, run the full evaluation and save a fresh report.
14. Rehearse and record the demo. Commit the work (your action).

### P2: quality

15. Fix the 390 px overflow, raw cents and internal IDs in messages.
16. Decide what rejection does to ticket status.
17. Add one automated UI smoke test for the decision flow, without a large new framework.
18. Update the stale notes.

### P3: optional

19. Pass the revision comment to regeneration.
20. Schedule renewal generation, unless Q3 makes it mandatory.
21. Leave the Q&A chat unbuilt.

### REMOVE

- **R1:** move the extra lease and restore the strict test.
- **R2:** remove the unused `ModulePage` export.
- **R3:** replace the misleading saved report.
- Keep `/api/leases/ingest` (R4).

### Questions needing your decision

| ID | Question |
|---|---|
| **Q1** | Tickets over $200 **with no exception** (seeded #4, #5, #6, #8) show a required approver but **cannot be approved anywhere**; briefs exist only for flagged tickets. Is blocking them enough, or should the app offer a human approval action? The seeded $5,000 injection ticket is one of them. |
| **Q2** | Should an approved tenant charge reduce the remaining deposit immediately, or only reserve it until collected? |
| **Q3** | The PDF says a lease entering its window "automatically generates" a brief. Is your batch button enough, or is a startup or daily trigger needed? |
| **Q4** | May the default `AGENT_MODEL` become `gemini-3.5-flash-lite` (a setting change only), or should `gemini-3.5-flash` be retried first with a timeout? |
| **Q5** | Should the live database be backed up and reset for the demo, or kept? Nothing will be deleted without approval. |

## 15. Final submission verdict

# NOT READY

- The required walkthrough ends in approving a brief. In the UI, **that click blanks the page** (B1).
- Approval can send a message that **contradicts the human's choice** (B2), allow a **second spend approval** (B3), or send **outdated figures** (B4). These weaken the rubric's safety and grounding categories.
- With the **submitted default model**, no brief was produced in testing (B5).
- A reviewer running the documented test or evaluation command now sees **failure** (B6).

The gap is narrow. The six P0 fixes are contained changes and need no rewrite of Day 1. After P0 and P1 are done and re-verified, including a full browser walkthrough with the final model, the project can be reassessed as ready for demonstration or submission.

**Remediation has not started. It waits for your approval.**
