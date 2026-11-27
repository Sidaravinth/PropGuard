/** OpenAPI 3.1 description of the Day 1 API (served at /openapi.json, UI at /docs). */
const idParam = (name: string, desc: string, type: "string" | "integer" = "integer") => ({
  name, in: "path", required: true, description: desc, schema: { type },
});
const ok = (description: string) => ({ description, content: { "application/json": { schema: { type: "object" } } } });
const err = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "PropGuard API",
    version: "2.2.0-day2b",
    description:
      "Lease ingestion, structured lease data with source citations, maintenance tickets and the deterministic policy engine.\n\n" +
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
          "Re-uploading a file with the same name replaces the earlier version.",
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } } },
        },
        responses: {
          201: ok("Ingest result with lease, per-field sources, clauses and gaps"),
          400: err("No file"),
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
        tags: ["documents"], summary: "Upload a lease (saves original, then extracts)",
        description: "The original file is stored before extraction. Identical files are rejected (409). If extraction fails the document is kept with status `failed` and can be retried.",
        requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } } } } },
        responses: { 201: ok("Document record and extracted lease (if any)"), 409: err("Duplicate file"), 422: err("Unsupported file type") },
      },
    },
    "/documents/{id}": { get: { tags: ["documents"], summary: "One document record", parameters: [idParam("id", "Document id")], responses: { 200: ok("Document"), 404: err("Not found") } } },
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
    "/tickets/{id}/policy-evaluations": {
      get: { tags: ["policy"], summary: "History of policy evaluations for a ticket", parameters: [idParam("id", "Ticket id")], responses: { 200: ok("Evaluations"), 404: err("Not found") } },
    },
  },
} as const;
