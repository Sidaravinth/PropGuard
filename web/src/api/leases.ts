import { api, ApiRequestError, notifyUnauthorized } from "./client";

export type FieldStatus = "extracted" | "missing" | "needs_review" | "corrected";
export type ClauseType = "rent" | "deposit" | "repair" | "pet" | "notice" | "renewal" | "late_fee" | "termination" | "payment" | "other";
export type LeaseFieldName =
  | "tenant_name" | "landlord_name" | "property_name" | "unit_number" | "start_date" | "end_date"
  | "monthly_rent" | "security_deposit" | "notice_period_days" | "repair_deductible";

export interface DataGap { field: string; status: "missing" | "needs_review"; reason: string }

export interface LeaseSummary {
  lease_id: number;
  tenant_id: string | null;
  unit_id: string | null;
  start_date: string | null;
  end_date: string | null;
  monthly_rent_cents: number | null;
  security_deposit_cents: number | null;
  notice_period_days: number | null;
  repair_deductible_cents: number | null;
  source_doc_name: string;
  extraction_status: "complete" | "needs_review";
  extraction_model: string;
  created_at: string;
  lease_state: "active" | "expired" | "upcoming" | "unknown";
  days_until_end: number | null;
  /** Available = held - collected - reserved. */
  remaining_deposit_cents: number | null;
  deposit: { held_cents: number; collected_cents: number; reserved_cents: number; available_cents: number } | null;
  flags: string[];
  gaps: DataGap[];
  unit: { unit_id: string; property_name: string; unit_number: string } | null;
  tenant: { tenant_id: string; name: string; status: string } | null;
  document: { document_id: number; doc_name: string; mime_type: string; uploaded_at: string } | null;
}

export interface FieldSource {
  lease_id: number;
  field_name: LeaseFieldName;
  value_text: string | null;
  status: FieldStatus;
  section_ref: string | null;
  page: number | null;
  verbatim_snippet: string | null;
  note: string | null;
}

export interface Clause {
  clause_id: number;
  lease_id: number;
  clause_type: ClauseType;
  extracted_text: string;
  section_ref: string | null;
  page: number | null;
  verified: number;
}

/** How the lease text was read: from the file's own text, by OCR, or both. */
export interface TextSource {
  method: "text" | "ocr" | "mixed";
  page_count: number;
  ocr_pages: number[];
  average_ocr_confidence: number | null;
  pages: { page: number; method: "text" | "ocr"; confidence: number | null }[];
}

export interface LeaseDetail extends LeaseSummary {
  fields: FieldSource[];
  clauses: Clause[];
  /** null for leases ingested before OCR support. */
  text_source: TextSource | null;
}

export interface DocumentRecord {
  document_id: number;
  kind: string;
  doc_name: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  status: "processing" | "extracted" | "needs_review" | "failed";
  /** While processing: the step under way. */
  processing_stage: "uploaded" | "text_extraction" | "ocr" | "ai_extraction" | null;
  page_count: number | null;
  text_method: "text" | "ocr" | "mixed" | null;
  error_code: string | null;
  error_message: string | null;
  lease_id: number | null;
  uploaded_by: number | null;
  uploaded_by_name?: string | null;
  uploaded_at: string;
  processed_at: string | null;
}

export interface Correction {
  correction_id: number;
  field_name: string;
  previous_value_text: string | null;
  previous_status: string | null;
  new_value_text: string | null;
  new_status: string;
  reason: string;
  corrected_by_name: string;
  corrected_at: string;
}

export interface Unit { unit_id: string; property_name: string; unit_number: string; base_rent_cents: number }
export interface Tenant { tenant_id: string; name: string; email: string | null; unit_id: string | null; status: string }

export interface UploadResult { document: DocumentRecord; lease: LeaseDetail | null }

/** A grounded Q&A citation: the agreement, page, section and the exact quoted text. */
export interface QaCitation {
  chunk_id: string;
  page: number;
  section_ref: string | null;
  quote: string;
  doc_name: string;
  document_id: number | null;
}

export interface QaAnswer {
  status: "answered" | "not_found" | "conflict";
  text: string;
  statements: { text: string; kind: "explicit" | "interpretation"; citations: QaCitation[] }[];
  /** Code-written notice when the answer includes interpretation. */
  notice: string | null;
}

export interface QaMessage {
  message_id: number;
  role: "user" | "assistant";
  content: string;
  answer: QaAnswer | null;
  created_at: string;
}

export const leasesApi = {
  list: () => api<{ data: LeaseSummary[] }>("/leases").then((r) => r.data),
  get: (id: number) => api<{ data: LeaseDetail }>(`/leases/${id}`).then((r) => r.data),
  source: (id: number) => api<{ data: { doc_name: string; mime_type: string; pages: string[] } }>(`/leases/${id}/source`).then((r) => r.data),
  corrections: (id: number) => api<{ data: Correction[] }>(`/leases/${id}/corrections`).then((r) => r.data),
  correct: (id: number, field: string, value: string | number | null, reason: string) =>
    api<{ data: LeaseDetail }>(`/leases/${id}/fields/${field}`, { method: "PATCH", json: { value, reason } }).then((r) => r.data),
  link: (id: number, unit_id: string, tenant_id: string | null, reason?: string) =>
    api<{ data: LeaseDetail }>(`/leases/${id}/link`, { method: "PUT", json: { unit_id, tenant_id, ...(reason ? { reason } : {}) } }).then((r) => r.data),
  documents: () => api<{ data: DocumentRecord[] }>("/documents?kind=lease").then((r) => r.data),
  document: (id: number) => api<{ data: DocumentRecord }>(`/documents/${id}`).then((r) => r.data),
  deleteDocument: (documentId: number) =>
    api<{ data: { document_id: number; lease_id: number | null; removed: { corrections: number; clauses: number; qa_messages: number } } }>(`/documents/${documentId}`, {
      method: "DELETE",
    }).then((r) => r.data),
  retry: (documentId: number) => api<{ data: UploadResult }>(`/documents/${documentId}/retry`, { method: "POST" }).then((r) => r.data),
  fileUrl: (documentId: number, download = false) => `/api/documents/${documentId}/file${download ? "?download=1" : ""}`,
  qa: {
    list: (leaseId: number) => api<{ data: QaMessage[] }>(`/leases/${leaseId}/qa`).then((r) => r.data),
    ask: (leaseId: number, question: string) => api<{ data: QaMessage[] }>(`/leases/${leaseId}/qa`, { method: "POST", json: { question } }).then((r) => r.data),
    clear: (leaseId: number) => api<{ data: { removed: number } }>(`/leases/${leaseId}/qa`, { method: "DELETE" }).then((r) => r.data),
  },
  units: () => api<{ data: Unit[] }>("/units").then((r) => r.data),
  tenants: () => api<{ data: Tenant[] }>("/tenants").then((r) => r.data),
  createUnit: (body: { property_name: string; unit_number: string; base_rent_cents: number }) =>
    api<{ data: Unit }>("/units", { method: "POST", json: body }).then((r) => r.data),
  createTenant: (body: { name: string; email: string | null; unit_id: string }) =>
    api<{ data: Tenant }>("/tenants", { method: "POST", json: body }).then((r) => r.data),
};

/**
 * Upload one lease file with upload-progress events (fetch cannot report upload progress). Uses async
 * mode: the server answers as soon as the file is stored, and processing is followed with waitForDocument.
 */
export function uploadLease(file: File, onProgress: (fraction: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents/leases?mode=async");
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.upload.onload = () => onProgress(1);
    xhr.onerror = () => reject(new ApiRequestError(0, "NETWORK_ERROR", "Network error while uploading"));
    xhr.onload = () => {
      let body: { data?: UploadResult; error?: { code: string; message: string; details?: unknown } } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.data) return resolve(body.data);
      if (xhr.status === 401) notifyUnauthorized();
      const err = body?.error;
      reject(new ApiRequestError(xhr.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Upload failed (HTTP ${xhr.status})`, err?.details));
    };
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
