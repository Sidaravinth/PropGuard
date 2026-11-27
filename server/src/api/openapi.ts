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
    version: "1.0.0-day1",
    description:
      "Lease ingestion, structured lease data with source citations, maintenance tickets and the deterministic policy engine.\n\n" +
      "**All money values are integer cents** (e.g. 150000 = $1,500.00).",
  },
  servers: [{ url: "/api" }],
  components: {
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
    "/health": { get: { tags: ["system"], summary: "Liveness check", responses: { 200: ok("OK") } } },
    "/units": { get: { tags: ["units"], summary: "List units", responses: { 200: ok("Units") } } },
    "/units/{id}": {
      get: { tags: ["units"], summary: "Get a unit", parameters: [idParam("id", "Unit id, e.g. U101", "string")], responses: { 200: ok("Unit"), 404: err("Not found") } },
    },
    "/tenants": {
      get: {
        tags: ["tenants"], summary: "List tenants",
        parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["active", "notice_given", "holdover", "former", "pending"] } }],
        responses: { 200: ok("Tenants") },
      },
    },
    "/tenants/{id}": {
      get: { tags: ["tenants"], summary: "Get a tenant with unpaid balance", parameters: [idParam("id", "Tenant id, e.g. T003", "string")], responses: { 200: ok("Tenant"), 404: err("Not found") } },
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
