# PropGuard — Day 2 Notes

Day 2 was built in groups. This file records Groups A and B as they landed. The agent, Decision Inbox, audit trail and evaluation that followed, and all later fixes, are described in [README.md](README.md), which is the current reference.

## Group A — Authentication and application shell

### Running it

```bash
npm install
# In .env (see .env.example), set the two initial accounts:
#   PROPGUARD_PM_EMAIL / _NAME / _PASSWORD    Property Manager
#   PROPGUARD_RD_EMAIL / _NAME / _PASSWORD    Regional Director
# Passwords need 12+ characters mixing three of: lowercase, uppercase, digits, symbols.

npm run dev:all   # API (:3001) and UI (http://localhost:5173) together. On first start the API creates the two accounts.
# or in two terminals:
npm run dev        # API on :3001
npm run dev:web    # UI on http://localhost:5173 (proxies /api to :3001)
```

The UI must be started through `npm run dev:web` or `dev:all`, which run Vite inside `web/` so its `/api` proxy config is loaded. A Vite started from the repo root has no proxy, and every API call returns 404. If port 5173 is busy, `dev:web` stops instead of switching ports. On Windows, stopping a dev command can leave its servers running. To find what holds a port, run `Get-NetTCPConnection -LocalPort 5173 -State Listen`. Ports can be overridden with `PORT` (API), `WEB_PORT` (UI) and `PROPGUARD_API` (proxy target).

To run everything on one port, run `npm run build` and then `npm start`. The API then serves the built UI at http://localhost:3001.

The accounts are created only while the `users` table is empty, either at server start or with `npm run bootstrap-users`. Editing `.env` afterwards never overwrites a password. Once the accounts exist, you can delete the `*_PASSWORD` lines and change passwords in **Settings**. There is no registration endpoint.

### How it works

| Concern | Implementation |
|---|---|
| Passwords | bcrypt (`bcryptjs`, cost `BCRYPT_ROUNDS`, default 12). Passwords over 72 bytes are rejected rather than silently truncated. Unknown emails are still compared against a dummy hash, so response timing does not reveal which accounts exist. |
| Sessions | Server-side rows in `sessions`. The browser gets a random 256-bit token in an `httpOnly`, `SameSite=Strict` cookie (`Secure` in production); the database stores only its SHA-256. A session ends at its absolute lifetime (`SESSION_TTL_HOURS`, default 8), after `SESSION_IDLE_MINUTES` (default 60) of inactivity, on logout, or when revoked. |
| Failed logins | Unlimited attempts. There is no lockout or rate limit, by product decision. Every failure returns the same 401, whether the email or the password was wrong. |
| CSRF | `SameSite=Strict` cookie, plus a check that rejects state-changing requests whose `Origin` is a different host. |
| Password change | Requires the current password and signs out every other session. |
| RBAC | `server/src/auth/permissions.ts` is the single source of truth, and the server checks it on every route. The UI only uses it to hide controls. |

Both roles have the same operational permissions: view and edit records, upload documents, run policy checks and generate briefs. They differ only in approval authority, which follows repair cost:

| Repair cost (higher of work order and quote) | Tier set by the policy engine | Property Manager | Regional Director |
|---|---|:-:|:-:|
| ≤ $200, no exceptions | `AUTO_APPROVE` | ✓ | ✓ |
| > $200 and ≤ $1,000, or ≤ $200 with an exception | `PROPERTY_MANAGER` | ✓ | ✓ |
| > $1,000 | `REGIONAL_DIRECTOR` | — | ✓ |

The approval tier always comes from the policy engine's evaluation. No request can supply or change it. Exceptions still prevent auto-approval.

### API

```
POST /api/auth/login            public; sets the session cookie
POST /api/auth/logout           GET /api/auth/me
POST /api/auth/change-password  GET /api/auth/sessions    DELETE /api/auth/sessions/:id
GET  /api/health                public
everything else under /api      401 without a session; 403 without the needed permission
```

### Database

`002_auth.sql` adds `users` and `sessions`. Existing tables are unchanged.

## Group B, part 1 — Lease Management

### Using it

Open **Lease Management** and choose **Upload leases**. You can drop several `.pdf` or `.txt` files at once. Each file shows its upload progress and then its extraction result. Open a lease to review it:

- **Lease terms.** Each term has a status badge (Verified, Needs review, Missing, Corrected). Click a source reference to highlight the exact excerpt in the document text beside it.
- **Correct / Review.** Enter the right value and a reason. Tick "Not in the document" to confirm that a value is absent; the field then stays flagged as missing.
- **Link records.** Choose the unit and tenant, or create them from the dialog. The dialog is prefilled from the lease.
- **Clauses** are expandable verbatim excerpts with their section and page. **Correction history** lists every change.
- **View original / Download** returns the uploaded file byte for byte.

Failed uploads appear under **Uploads that need attention**, with a **Retry** button.

### Upload pipeline

1. Validate the type (`.pdf`, `.txt`) and size (10 MB). Reject identical content (SHA-256) with 409, linking to the existing lease.
2. Save the original to the document store, then create a `documents` row with status `processing`.
3. Run the Day 1 pipeline unchanged: page text, LLM extraction with Zod validation and retry, deterministic verification, linking, and storage of fields, clauses and evidence.
4. Set the status to `extracted`, `needs_review` or `failed`, with an error code. A failure never deletes the original, and **Retry** re-runs extraction from the stored file. An upload still `processing` when the server stops is marked `failed` (`INTERRUPTED`) at the next start.

A different file with an existing name is stored as `name (2).pdf`. The Day 1 endpoint `POST /api/leases/ingest` and `npm run ingest` still work but skip the document store. Both are audited, and they refuse to replace a lease that has history (`LEASE_HAS_HISTORY`).

### Corrections

`PATCH /api/leases/:id/fields/:field` with `{ value, reason }`:

- **Validation.** Values are checked in code: integer cents, real `YYYY-MM-DD` dates, the end date after the start date, and whole days.
- **What changes.** The corrected value becomes the trusted lease column, and the field status becomes `corrected`, which clears the gap. The original section, page and snippet are kept, and `extraction_status` is recomputed.
- **Effect on policy.** The policy engine uses corrected values, so a corrected deductible changes the 3-way check.
- **Deposit.** A deposit correction replaces the `held` entry in `deposit_ledger`. Deductions already taken are kept.
- **History.** Every correction and link change is a row in `lease_field_corrections`: who, when, the before and after values, and the reason. A database trigger rejects any `UPDATE`.

### Storage

`server/src/storage/documentStore.ts` defines a `DocumentStore` interface (`put`/`get`/`exists`). Today it is a local directory (`UPLOADS_DIR`, default `data/uploads/`, ignored by git) with content-addressed keys (`ab/<sha256>.pdf`) and atomic writes. An S3-compatible store only needs to implement the same three methods. The database holds metadata only, never file bytes.

### Sample data is no longer loaded into the live app

`npm run seed` now writes to `data/propguard-sample.db` (`SEED_DB_PATH`). It refuses to run if that path is the live database. To browse the sample data, run `DB_PATH=data/propguard-sample.db npm run dev`.

### Database

`003_documents_corrections.sql` makes three changes:

- adds the `documents` and `lease_field_corrections` tables (plus the trigger that blocks updates)
- rebuilds `lease_field_sources` so that its status can be `corrected`

No other tables change.

## Group B, part 2 — Properties, Tenants, Payment Ledger, Maintenance, Dashboard

Every module starts empty, and all data comes from users. A fresh database shows empty states and a getting-started list on the Dashboard.

| Module | What you can do |
|---|---|
| **Properties & Units** | Add or edit properties (name, address) and units (number, base rent). Filter by available or occupied, by property, or by search. Each unit page shows its tenants, leases and tickets. Renaming a property renames it on its units, so lease linking keeps working. |
| **Tenants** | Add or edit tenants (name, email, phone, unit, status), or import them from CSV/XLSX. Filter by status, or show only tenants owing rent. The profile shows unit, outstanding rent, lease history, payment history and maintenance history. Duplicates are refused: email is unique, and a name can appear only once per unit. |
| **Payment Ledger** | Add or update monthly entries, or import CSV/XLSX. Shows outstanding balance, overdue tenants and this month's due and collected amounts. Filters: overdue, outstanding, settled, and by tenant. The status comes from the amounts (paid, partial or unpaid, plus "paid late"). A contradictory status is rejected, and so is a second entry for the same tenant and month. |
| **Maintenance** | Create a ticket by choosing property, unit and tenant, then entering the work order estimate, technician quote and an optional tenant charge. The policy check runs on save. The list shows verdict, approver and status, with filters for exceptions and needs-approval. The ticket page shows exceptions, the tenant/owner cost split, the rule trace, the governing lease (deductible and deposit), a re-run button, check history and the ticket's Decision Briefs. |
| **Dashboard** | The 8 summary cards, plus lease, maintenance and payment overviews and recent activity, all from `GET /api/dashboard` at request time. No numbers are stored or invented. |

### Spreadsheet imports

`POST /api/imports/{tenants|ledger}/preview` then `.../commit`, with multipart fields `file` (`.csv` or `.xlsx`, up to 5 MB) and `mapping` (JSON).

1. **Preview** parses the file and suggests a column mapping: an exact header match first, then a header that contains a known word. It validates every row and flags duplicates against the database and within the file. Nothing is written. The UI shows each row as *Import*, *Duplicate* or *Error* with the reason, and re-runs the preview whenever the mapping changes.
2. **Commit** runs the same validation again on the server, so the client's preview is never trusted. It refuses a file already imported (same SHA-256). It stores the original in the document store and creates a `documents` row (`tenant_import` / `ledger_import`, status `imported`, rows imported and skipped). Then it inserts the valid rows in one transaction, each with `source_document_id` pointing to that document.

Parsing is deterministic:

- **Amounts.** `$1,500.00`, `1500` and `1500.5` become integer cents. Negative or non-numeric amounts are errors.
- **Months.** Accepted forms are `YYYY-MM`, `YYYY-MM-DD`, `MM/YYYY`, `Nov 2026`, `November 2026`, and dates whose day is above 12. A date like `03/04/2026` is rejected as ambiguous instead of guessed.
- **Tenants in ledger rows.** A tenant is matched by ID, email, or a name that matches exactly one tenant.
- **Units in tenant rows.** A unit is matched by ID or by property name and unit number, and must already exist.

### Database

`004_records.sql` makes these changes:

- **New `properties` table.** It is filled from the existing units (3 properties for the live database's 6 units, with no FK violations; tested on a copy). `units.property_id` links each unit to it.
- **Triggers** keep `units.property_name` in sync and assign a property when an older code path inserts a unit by name.
- **Tenants** gain `phone`, and tenants and payment ledger rows gain `source_document_id`.
- **Documents** are rebuilt to allow the `imported` status and record the import counts.

### Tests

`tests/records.test.ts` adds 16 tests. They cover:

- an empty start
- properties, units and tenants: create, edit, duplicates, validation, and the Regional Director's write access
- ledger status rules and duplicates
- the policy engine reacting to a user-edited ledger
- import parsing, preview, commit, duplicate files and bad mappings
- ticket and dashboard read models

XLSX parsing goes through `read-excel-file`, but there is no automated XLSX test, because generating an `.xlsx` fixture needs a writer package that wasn't added.
