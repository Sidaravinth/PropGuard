/** OpenAPI 3.1 description of the API (served at /openapi.json, UI at /docs). tests/openapi.test.ts keeps it complete. */
const idParam = (name: string, desc: string, type: "string" | "integer" = "integer") => ({
  name, in: "path", required: true, description: desc, schema: { type },
});
const ok = (description: string) => ({ description, content: { "application/json": { schema: { type: "object" } } } });
const err = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "PropGuard API",
    version: "2.3.0",
    description:
      "Lease ingestion, structured lease data with source citations, maintenance tickets, the deterministic policy engine, " +
      "AI-drafted Decision Briefs, human decisions, deposit reservations and the audit trail.\n\n" +
      "**All money values are integer cents** (e.g. 150000 = $1,500.00).",
  },
  servers: [{ url: "/api" }],
  security: [{ sessionCookie: [] }],
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey", in: "cookie", name: "pg_session",
        description: "Set by POST /auth/login (httpOnly, SameSite=Strict). Sign in through the web app or the login endpoint below, and Swagger will send the cookie automatically.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
            required: ["code", "message"],
          },
        },
      },
      NewTicket: {
        type: "object",
        additionalProperties: false,
        required: ["unit_id", "issue_summary", "work_order_amount_cents", "technician_quote_amount_cents"],
        properties: {
          unit_id: { type: "string", example: "U201" },
          tenant_id: { type: ["string", "null"], example: "T003" },
          issue_summary: { type: "string", example: "Water heater leaking from base" },
          work_order_amount_cents: { type: "integer", minimum: 0, example: 50000 },
          technician_quote_amount_cents: { type: "integer", minimum: 0, example: 62000 },
          proposed_tenant_charge_cents: { type: ["integer", "null"], minimum: 0, example: null },
        },
      },
    },
  },
  paths: {
    "/auth/login": {
      post: {
        tags: ["auth"], summary: "Sign in (sets the session cookie)", security: [],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string", format: "password" } } } } },
        },
        responses: { 200: ok("Profile, permissions and session expiry"), 401: err("Invalid email or password") },
      },
    },
    "/auth/logout": { post: { tags: ["auth"], summary: "Sign out (revokes the session server-side)", responses: { 204: { description: "Signed out" }, 401: err("Not signed in") } } },
    "/auth/me": { get: { tags: ["auth"], summary: "Current user, role, permissions and approval tiers", responses: { 200: ok("Profile"), 401: err("Not signed in") } } },
    "/auth/change-password": {
      post: {
        tags: ["auth"], summary: "Change your password (signs out your other sessions)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["current_password", "new_password"], properties: { current_password: { type: "string", format: "password" }, new_password: { type: "string", format: "password", minLength: 12 } } } } },
        },
        responses: { 200: ok("Changed"), 400: err("Weak password"), 401: err("Current password incorrect") },
      },
    },
    "/auth/sessions": { get: { tags: ["auth"], summary: "Your active sessions", responses: { 200: ok("Sessions") } } },
    "/auth/sessions/{id}": {
      delete: { tags: ["auth"], summary: "Revoke one of your other sessions", parameters: [idParam("id", "Session id", "string")], responses: { 204: { description: "Revoked" }, 404: err("Not found") } },
    },
    "/health": {
      get: { tags: ["system"], summary: "Liveness check (public)", security: [], responses: { 200: ok("OK") } } },
    "/units": {
      get: { tags: ["units"], summary: "List units", responses: { 200: ok("Units") } },
      post: {
        tags: ["units"], summary: "Create a unit",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["property_name", "unit_number", "base_rent_cents"], properties: { property_name: { type: "string" }, unit_number: { type: "string" }, base_rent_cents: { type: "integer", minimum: 0 } } } } } },
        responses: { 201: ok("Unit"), 409: err("Duplicate unit") },
      },
    },
    "/units/{id}": {
      get: { tags: ["units"], summary: "A unit with occupancy, tenants, leases and tickets", parameters: [idParam("id", "Unit id, e.g. U101", "string")], responses: { 200: ok("Unit"), 404: err("Not found") } },
      patch: {
        tags: ["units"], summary: "Edit a unit", parameters: [idParam("id", "Unit id", "string")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { property_id: { type: "integer" }, unit_number: { type: "string" }, base_rent_cents: { type: "integer", minimum: 0 } } } } } },
        responses: { 200: ok("Unit"), 409: err("Duplicate unit") },
      },
    },
    "/tenants": {
      get: {
        tags: ["tenants"], summary: "List tenants",
        parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["active", "notice_given", "holdover", "former", "pending"] } }],
        responses: { 200: ok("Tenants") },
      },
      post: {
        tags: ["tenants"], summary: "Create a tenant (duplicate email, or same name in the same unit, is rejected)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" }, email: { type: ["string", "null"], format: "email" }, unit_id: { type: ["string", "null"] } } } } } },
        responses: { 201: ok("Tenant"), 409: err("Duplicate tenant"), 422: err("Unknown unit") },
      },
    },
    "/tenants/{id}": {
      get: { tags: ["tenants"], summary: "Tenant profile: unit, unpaid balance, leases, ledger, tickets", parameters: [idParam("id", "Tenant id, e.g. T003", "string")], responses: { 200: ok("Tenant"), 404: err("Not found") } },
      patch: {
        tags: ["tenants"], summary: "Edit a tenant", parameters: [idParam("id", "Tenant id", "string")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, email: { type: ["string", "null"] }, phone: { type: ["string", "null"] }, unit_id: { type: ["string", "null"] }, status: { type: "string", enum: ["active", "notice_given", "holdover", "former", "pending"] } } } } } },
        responses: { 200: ok("Tenant"), 409: err("Duplicate") },
      },
    },
    "/tenants/{id}/ledger": {
      get: { tags: ["tenants"], summary: "Tenant payment ledger", parameters: [idParam("id", "Tenant id", "string")], responses: { 200: ok("Ledger entries"), 404: err("Not found") } },
    },
    "/leases": {
      get: { tags: ["leases"], summary: "List leases with state flags (EXPIRED, IN_NOTICE_WINDOW, HAS_DATA_GAPS) and data gaps", responses: { 200: ok("Leases") } },
    },
    "/leases/ingest": {
      post: {
        tags: ["leases"],
        summary: "Ingest a lease document (PDF or text) via the LLM extraction pipeline",
        description:
          "Extracts structured terms + clauses with schema validation and retry, verifies every value against the source text, " +
          "links the lease to a unit/tenant and stores field-level source references. Missing/ambiguous values are flagged, never guessed. " +
          "Re-uploading a file with the same name replaces the earlier version, unless that lease has history (a UI upload, corrections, briefs, renewal offers or deposit charges). Every attempt is audited.",
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } } },
        },
        responses: {
          201: ok("Ingest result with lease, per-field sources, clauses and gaps"),
          400: err("No file"),
          409: err("LEASE_HAS_HISTORY: replacing this document would destroy or detach human work"),
          422: err("Unsupported/empty document"),
          503: err("LLM unavailable (not configured, quota exhausted or provider error)"),
        },
      },
    },
    "/leases/{id}": {
      get: { tags: ["leases"], summary: "Lease with per-field source references, clauses, flags and gaps", parameters: [idParam("id", "Lease id")], responses: { 200: ok("Lease"), 400: err("Bad id"), 404: err("Not found") } },
    },
    "/leases/{id}/clauses": {
      get: {
        tags: ["leases"], summary: "Extracted clauses with verbatim text and section/page references",
        parameters: [idParam("id", "Lease id"), { name: "type", in: "query", schema: { type: "string", enum: ["rent", "deposit", "repair", "pet", "notice", "renewal", "late_fee", "other"] } }],
        responses: { 200: ok("Clauses"), 404: err("Not found") },
      },
    },
    "/leases/{id}/source": {
      get: { tags: ["leases"], summary: "Extracted text of the source document, per page", parameters: [idParam("id", "Lease id")], responses: { 200: ok("Pages"), 404: err("Not found") } },
    },
    "/leases/{id}/qa": {
      get: { tags: ["leases"], summary: "Your grounded Q&A conversation about this lease", parameters: [idParam("id", "Lease id")], responses: { 200: ok("Messages, oldest first"), 404: err("Not found") } },
      post: {
        tags: ["leases"], summary: "Ask a question answered only from this lease's text, with citations",
        description:
          "Retrieves the most relevant excerpts of this lease's own text (BM25), asks the model for structured statements that each cite an excerpt with an exact quote, " +
          "and checks every quote, citation and number in code. Answers that fail the checks are retried once, then replaced by the fixed not-found sentence. Read-only.",
        parameters: [idParam("id", "Lease id")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["question"], properties: { question: { type: "string", maxLength: 500 } } } } } },
        responses: { 200: ok("Updated conversation"), 409: err("A question about this lease is already being answered"), 422: err("Lease has no source text"), 503: err("Model unavailable") },
      },
      delete: { tags: ["leases"], summary: "Clear your conversation about this lease (others' are untouched)", parameters: [idParam("id", "Lease id")], responses: { 200: ok("Number of messages removed"), 404: err("Not found") } },
    },
    "/leases/{id}/corrections": {
      get: { tags: ["leases"], summary: "Correction history (who changed what, when, why)", parameters: [idParam("id", "Lease id")], responses: { 200: ok("Corrections") } },
    },
    "/leases/{id}/fields/{field}": {
      patch: {
        tags: ["leases"], summary: "Correct or confirm one extracted field (recorded)",
        description: "Money in integer cents, dates as YYYY-MM-DD, notice in days. `value: null` confirms the value is not in the document (stays flagged as missing).",
        parameters: [idParam("id", "Lease id"), idParam("field", "start_date | end_date | monthly_rent | security_deposit | notice_period_days | repair_deductible | tenant_name | property_name | unit_number", "string")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["value", "reason"], properties: { value: { type: ["string", "integer", "null"] }, reason: { type: "string", minLength: 3 } } } } } },
        responses: { 200: ok("Updated lease"), 400: err("Invalid value"), 422: err("End date not after start date") },
      },
    },
    "/leases/{id}/link": {
      put: {
        tags: ["leases"], summary: "Link a lease to a unit and (optionally) a tenant of that unit",
        parameters: [idParam("id", "Lease id")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["unit_id", "tenant_id"], properties: { unit_id: { type: "string" }, tenant_id: { type: ["string", "null"] }, reason: { type: "string" } } } } } },
        responses: { 200: ok("Updated lease"), 422: err("Unknown unit/tenant or tenant not in unit") },
      },
    },
    "/documents": {
      get: { tags: ["documents"], summary: "Uploaded documents with processing status", parameters: [{ name: "kind", in: "query", schema: { type: "string", enum: ["lease", "tenant_import", "ledger_import"] } }], responses: { 200: ok("Documents") } },
    },
    "/documents/leases": {
      post: {
        tags: ["documents"], summary: "Upload a lease (saves original, reads text with OCR where needed, then extracts)",
        description:
          "Accepts .pdf (text or scanned), .txt, .docx, .png and .jpg. The original file is stored before extraction. Identical files are rejected (409). " +
          "Scanned PDF pages and images are read with local OCR (tesseract.js) before AI extraction. If extraction fails the document is kept with status `failed` and can be retried. " +
          "With `mode=async` the response is 202 as soon as the file is stored; poll GET /documents/{id} for `processing_stage` (uploaded, text_extraction, ocr, ai_extraction) and the final status.",
        parameters: [{ name: "mode", in: "query", schema: { type: "string", enum: ["sync", "async"] } }],
        requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } } } } },
        responses: { 201: ok("Document record and extracted lease (if any)"), 202: ok("Stored; processing continues in the background"), 409: err("Duplicate file"), 422: err("Unsupported file type or contents do not match the extension") },
      },
    },
    "/documents/{id}": {
      get: { tags: ["documents"], summary: "One document record", parameters: [idParam("id", "Document id")], responses: { 200: ok("Document"), 404: err("Not found") } },
      delete: {
        tags: ["documents"],
        summary: "Delete a lease document, its stored original and the lease extracted from it",
        description:
          "Removes the document record, the original file, and the lease extracted from it (fields, clauses, corrections, Q&A history, deposit held). Units and tenants are kept. " +
          "Refused (409) while the document is processing, or when the lease has Decision Briefs, a renewal offer or deposit charges. Audited as document_deleted.",
        parameters: [idParam("id", "Document id")],
        responses: { 200: ok("What was removed"), 404: err("Not found"), 409: err("Still processing, or the lease has history"), 422: err("Not a lease document") },
      },
    },
    "/documents/{id}/file": {
      get: { tags: ["documents"], summary: "Original uploaded file, byte for byte", parameters: [idParam("id", "Document id"), { name: "download", in: "query", schema: { type: "string", enum: ["1"] } }], responses: { 200: { description: "The file" }, 404: err("Not found") } },
    },
    "/documents/{id}/retry": {
      post: { tags: ["documents"], summary: "Retry extraction of a failed upload from its stored original", parameters: [idParam("id", "Document id")], responses: { 200: ok("Document and lease"), 409: err("Not in failed state") } },
    },
    "/dashboard": { get: { tags: ["dashboard"], summary: "Dashboard figures, computed from stored records", responses: { 200: ok("Summary, lease/maintenance/payment overviews, recent activity") } } },
    "/properties": {
      get: { tags: ["properties"], summary: "Properties with unit and occupancy counts", responses: { 200: ok("Properties") } },
      post: {
        tags: ["properties"], summary: "Create a property",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" }, address: { type: ["string", "null"] } } } } } },
        responses: { 201: ok("Property"), 409: err("Duplicate name") },
      },
    },
    "/properties/{id}": {
      get: { tags: ["properties"], summary: "A property with its units", parameters: [idParam("id", "Property id")], responses: { 200: ok("Property"), 404: err("Not found") } },
      patch: {
        tags: ["properties"], summary: "Rename or re-address a property (units follow the new name)", parameters: [idParam("id", "Property id")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, address: { type: ["string", "null"] } } } } } },
        responses: { 200: ok("Property"), 409: err("Duplicate name") },
      },
    },
    "/ledger": {
      get: {
        tags: ["ledger"], summary: "Ledger entries with outstanding and overdue flags",
        parameters: [{ name: "tenant_id", in: "query", schema: { type: "string" } }, { name: "filter", in: "query", schema: { type: "string", enum: ["all", "overdue", "outstanding", "settled"] } }],
        responses: { 200: ok("Entries") },
      },
      post: {
        tags: ["ledger"], summary: "Add a ledger entry (status derived from amounts)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["tenant_id", "month", "amount_due_cents", "amount_paid_cents"], properties: { tenant_id: { type: "string" }, month: { type: "string", example: "2026-12" }, amount_due_cents: { type: "integer" }, amount_paid_cents: { type: "integer" }, status: { type: ["string", "null"], description: "optional: late_paid, or a status consistent with the amounts" } } } } } },
        responses: { 201: ok("Entry"), 409: err("Entry for that tenant and month exists"), 422: err("Unknown tenant or contradictory status") },
      },
    },
    "/ledger/{id}": {
      patch: {
        tags: ["ledger"], summary: "Update amounts on a ledger entry", parameters: [idParam("id", "Entry id")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { amount_due_cents: { type: "integer" }, amount_paid_cents: { type: "integer" }, status: { type: ["string", "null"] } } } } } },
        responses: { 200: ok("Entry") },
      },
    },
    "/ledger/summary": { get: { tags: ["ledger"], summary: "Outstanding balance, overdue tenants, this month's collection", responses: { 200: ok("Summary") } } },
    "/imports/{kind}/preview": {
      post: {
        tags: ["imports"], summary: "Parse a CSV/XLSX, suggest a column mapping and validate every row (writes nothing)",
        parameters: [idParam("kind", "tenants | ledger", "string")],
        requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" }, mapping: { type: "string", description: 'JSON: {"field": columnIndex | null}' } } } } } },
        responses: { 200: ok("Headers, mapping, per-row result and summary"), 422: err("Unreadable or unsupported file") },
      },
    },
    "/imports/{kind}/commit": {
      post: {
        tags: ["imports"], summary: "Re-validate and import the valid, non-duplicate rows; stores the original file",
        parameters: [idParam("kind", "tenants | ledger", "string")],
        requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file", "mapping"], properties: { file: { type: "string", format: "binary" }, mapping: { type: "string" } } } } } },
        responses: { 201: ok("Import report"), 409: err("File already imported"), 422: err("Nothing importable") },
      },
    },
    "/tickets": {
      get: {
        tags: ["tickets"], summary: "List maintenance tickets",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["open", "flagged", "pending_approval", "approved", "rejected", "completed"] } },
          { name: "unit_id", in: "query", schema: { type: "string" } },
        ],
        responses: { 200: ok("Tickets") },
      },
      post: {
        tags: ["tickets"], summary: "Create a ticket (the deterministic policy check runs automatically)",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewTicket" } } } },
        responses: { 201: ok("Ticket + policy evaluation"), 400: err("Validation error"), 422: err("Unknown unit/tenant") },
      },
    },
    "/tickets/{id}": {
      get: { tags: ["tickets"], summary: "Get a ticket with its latest policy evaluation", parameters: [idParam("id", "Ticket id")], responses: { 200: ok("Ticket"), 404: err("Not found") } },
    },
    "/tickets/{id}/policy-check": {
      post: {
        tags: ["policy"], summary: "Run the deterministic policy engine on a ticket",
        description: "3-way verification (work order vs quote vs lease deductible + ledger), approval threshold gating and security-deposit cap. Pure code — no AI involved.",
        parameters: [idParam("id", "Ticket id")],
        responses: { 200: ok("Policy evaluation with inputs, sources, verdict, approver and rule trace"), 404: err("Not found") },
      },
    },
    "/agent/candidates": {
      get: { tags: ["agent"], summary: "What the agent can draft: leases in their renewal window and flagged tickets, with any pending brief", responses: { 200: ok("Renewal and maintenance candidates") } },
    },
    "/agent/renewals/run": {
      post: { tags: ["agent"], summary: "Draft a renewal brief for every candidate without a pending one", responses: { 200: ok("Per-lease result: brief id, skipped or error"), 503: err("Model unavailable") } },
    },
    "/agent/maintenance/run": {
      post: { tags: ["agent"], summary: "Draft a resolution brief for every flagged ticket without a pending one", responses: { 200: ok("Per-ticket result: brief id, skipped or error"), 503: err("Model unavailable") } },
    },
    "/agent/renewals/{leaseId}": {
      post: {
        tags: ["agent"], summary: "Draft a renewal brief for one lease (replaces its pending brief)",
        description: "Read-only tools gather evidence; prices and dates are computed in code. Three options, each with its own notice. The agent cannot approve anything.",
        parameters: [idParam("leaseId", "Lease id")],
        responses: { 201: ok("Brief with figures, evidence, grounding report and audit entries"), 409: err("This term's renewal is already approved, or a run is in progress"), 422: err("Lease is not in its renewal window"), 502: err("Model produced no valid brief"), 503: err("Model unavailable") },
      },
    },
    "/agent/maintenance/{ticketId}": {
      post: {
        tags: ["agent"], summary: "Draft a resolution brief for one flagged ticket (replaces its pending brief)",
        description: "Explains the policy engine's exceptions and proposes two options, each with its own follow-up message.",
        parameters: [idParam("ticketId", "Ticket id")],
        responses: { 201: ok("Brief with figures, evidence, policy result, grounding report and audit entries"), 409: err("Ticket already closed, or a run is in progress"), 422: err("Ticket has no policy exceptions"), 502: err("Model produced no valid brief"), 503: err("Model unavailable") },
      },
    },
    "/briefs": {
      get: {
        tags: ["briefs"], summary: "Decision Inbox: briefs with priority and required approver",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "approved", "rejected", "revision_requested", "superseded"] } },
          { name: "type", in: "query", schema: { type: "string", enum: ["renewal", "maintenance"] } },
        ],
        responses: { 200: ok("Briefs") },
      },
    },
    "/briefs/{id}": {
      get: { tags: ["briefs"], summary: "One brief: options, evidence citations, policy result, charge warning, agent tool calls and audit history", parameters: [idParam("id", "Brief id")], responses: { 200: ok("Brief"), 404: err("Not found") } },
    },
    "/briefs/{id}/decision": {
      post: {
        tags: ["decisions"], summary: "Approve (selecting an option), reject or request revision. The only way a brief is finalised",
        description:
          "On approval the server re-checks the caller's role, re-verifies every figure and policy amount against current records, applies the deposit cap, " +
          "executes the simulated action (only the selected option's message is sent) and audits it in one transaction. Rejecting a brief does not close its ticket.",
        parameters: [idParam("id", "Brief id")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["decision"], properties: { decision: { type: "string", enum: ["approve", "reject", "request_revision"] }, option_key: { type: ["string", "null"] }, comment: { type: ["string", "null"] } } } } } },
        responses: { 200: ok("Brief with its decision and audit entries"), 400: err("Option required"), 403: err("Role does not cover the required tier"), 409: err("Not pending, stale, blocked by policy, ungrounded, outdated format, or already decided") },
      },
    },
    "/audit": {
      get: {
        tags: ["audit"], summary: "Audit trail (read-only; no endpoint edits or deletes entries)",
        parameters: [
          ...["event_type", "actor", "subject_type", "subject_id", "q"].map((name) => ({ name, in: "query", schema: { type: "string" } })),
          { name: "actor_type", in: "query", schema: { type: "string", enum: ["human", "agent", "system"] } },
          { name: "brief_id", in: "query", schema: { type: "integer" } },
          { name: "from", in: "query", schema: { type: "string", format: "date" } },
          { name: "to", in: "query", schema: { type: "string", format: "date" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
        ],
        responses: { 200: ok("Total, event types and matching entries with hashes") },
      },
    },
    "/audit/verify": {
      get: { tags: ["audit"], summary: "Recompute the hash chain and report the first broken entry, if any", responses: { 200: ok("Chain status") } },
    },
    "/tickets/{id}/decision": {
      post: {
        tags: ["decisions"], summary: "Approve or reject a ticket that is over the auto-approval limit and has no exceptions",
        description:
          "The policy engine is re-run first. The caller's role must cover the engine's tier (> $200 Property Manager, > $1,000 Regional Director). " +
          "Approval records the cost basis (higher of work order and quote) and reserves any proposed tenant charge. Tickets with exceptions are decided through a Decision Brief.",
        parameters: [idParam("id", "Ticket id")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["decision"], properties: { decision: { type: "string", enum: ["approve", "reject"] }, comment: { type: ["string", "null"] } } } } } },
        responses: { 200: ok("Decision, ticket and any deposit reservation"), 403: err("Role does not cover the required tier"), 409: err("Has exceptions, needs no approval, or already closed") },
      },
    },
    "/deposit-reservations/{id}/collect": {
      post: {
        tags: ["deposit"], summary: "Record collection of a reserved tenant charge",
        description: "Moves the amount from reserved to collected by adding one deposit deduction in the same transaction. Requires the ticket's approval tier.",
        parameters: [idParam("id", "Reservation id")],
        responses: { 200: ok("Reservation"), 403: err("Role does not cover the required tier"), 409: err("Not reserved, or the recorded deposit no longer covers it") },
      },
    },
    "/deposit-reservations/{id}/release": {
      post: {
        tags: ["deposit"], summary: "Release a reserved tenant charge that was cancelled",
        parameters: [idParam("id", "Reservation id")],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 3 } } } } } },
        responses: { 200: ok("Reservation"), 403: err("Role does not cover the required tier"), 409: err("Not reserved") },
      },
    },
    "/tickets/{id}/policy-evaluations": {
      get: { tags: ["policy"], summary: "History of policy evaluations for a ticket", parameters: [idParam("id", "Ticket id")], responses: { 200: ok("Evaluations"), 404: err("Not found") } },
    },
  },
} as const;
