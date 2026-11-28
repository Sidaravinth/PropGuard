/**
 * OCR-first extraction. OCR runs for real (tesseract.js, locally, offline); the AI extraction step uses
 * the scripted test double, so no model is called.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { migrate, openDb, type DB } from "../src/db/connection.js";
import { seedStructured } from "../src/db/seed.js";
import { detectFormat, loadDocument, UnsupportedDocumentError } from "../src/extraction/documentText.js";
import { ingestLeaseDocument, type IngestStage } from "../src/extraction/ingest.js";
import type { OcrEngine } from "../src/extraction/ocr/ocrEngine.js";
import type { LlmCall } from "../src/extraction/extractor.js";
import { LocalDocumentStore } from "../src/storage/documentStore.js";
import { signedIn, testAuth } from "./authHelpers.js";
import { readLease, scriptedLlm, sharmaExtraction } from "./fixtures.js";
import { docx, pdf, textJpeg, textPng } from "./ocrFixtures.js";

const OCR_TIMEOUT = 90_000;
const SHARMA = "lease_maple_101_sharma.txt";
const sharmaLines = () => readLease(SHARMA).toString("utf8").replace(/\r\n/g, "\n").split("\n");
const RENT_LINES = ["SECTION 3. RENT", "3.1 Tenant shall pay monthly rent of $1,500.00 due on the first day.", "The term ends on January 15, 2027."];
const norm = (s: string) => s.replace(/\s+/g, " ");

/** A stand-in OCR engine for cases where the result itself is under test (fast and deterministic). */
function fakeOcr(text: string, confidence: number): OcrEngine & { calls: number } {
  const e = { name: "fake", calls: 0, recognize: async (images: Buffer[]) => (e.calls++, images.map(() => ({ text, confidence }))) };
  return e;
}

describe("document inspection", () => {
  it("detects formats from their bytes, not only the extension", async () => {
    expect(detectFormat("a.pdf", Buffer.from("%PDF-1.7"))?.format).toBe("pdf");
    expect(detectFormat("scan.png", textPng(["x"]))).toEqual({ format: "image", mimeType: "image/png" });
    expect(detectFormat("photo.jpg", textJpeg(["x"]))).toEqual({ format: "image", mimeType: "image/jpeg" });
    expect(detectFormat("lease.docx", await docx(["x"]))?.format).toBe("docx");
    expect(detectFormat("lease.txt", Buffer.from("hello"))?.format).toBe("text");
    expect(detectFormat("lease.exe", Buffer.from("MZ"))).toBeNull();
    expect(detectFormat("notes.png", Buffer.from("not an image"))).toBeNull();
  });

  it("reads text-based PDFs directly, without OCR", async () => {
    const ocr = fakeOcr("should not be used", 99);
    const doc = await loadDocument("lease_oakwood_301_patel.pdf", readLease("lease_oakwood_301_patel.pdf"), { ocr });
    expect(ocr.calls).toBe(0);
    expect(doc.textMethod).toBe("text");
    expect(doc.pageMeta).toEqual([{ method: "text", confidence: null }, { method: "text", confidence: null }]);
  });

  it("reads DOCX text directly as one page", async () => {
    const bytes = await docx(["SECTION 3. RENT", "Tenant shall pay monthly rent of $1,500.00."]);
    const doc = await loadDocument("lease.docx", bytes, { ocr: null });
    expect(doc).toMatchObject({ format: "docx", textMethod: "text", pages: ["SECTION 3. RENT\n\nTenant shall pay monthly rent of $1,500.00."] });
  });

  it("refuses scanned pages when OCR is turned off, and corrupt files with a clear reason", async () => {
    const scanned = await pdf([{ image: textPng(RENT_LINES) }]);
    await expect(loadDocument("scan.pdf", scanned, { ocr: null })).rejects.toThrow(/scanned.*OCR.*turned off/i);
    await expect(loadDocument("photo.png", textPng(RENT_LINES), { ocr: null })).rejects.toThrow(UnsupportedDocumentError);
    await expect(loadDocument("bad.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("junk")]), { ocr: null })).rejects.toThrow(/Word document could not be read/);
  });

  it("enforces the page limit", async () => {
    const two = await pdf([{ text: "page one text that is long enough" }, { text: "page two text that is long enough" }]);
    await expect(loadDocument("long.pdf", two, { maxPages: 1 })).rejects.toThrow(/2 pages; the limit is 1/);
  });

  it("an empty OCR result is refused rather than passed on as a document", async () => {
    await expect(loadDocument("blank.png", textPng([""]), { ocr: fakeOcr("   ", 10) })).rejects.toThrow(/No readable text/);
  });
});

describe("local OCR (tesseract.js)", () => {
  it("reads a PNG image", { timeout: OCR_TIMEOUT }, async () => {
    const doc = await loadDocument("photo.png", textPng(RENT_LINES));
    expect(doc).toMatchObject({ format: "image", mimeType: "image/png", textMethod: "ocr" });
    expect(doc.pageMeta[0]!.method).toBe("ocr");
    expect(doc.pageMeta[0]!.confidence).toBeGreaterThan(80);
    expect(norm(doc.pages[0]!)).toContain("monthly rent of $1,500.00");
    expect(norm(doc.pages[0]!)).toContain("January 15, 2027");
  });

  it("reads a JPEG image", { timeout: OCR_TIMEOUT }, async () => {
    const doc = await loadDocument("photo.jpg", textJpeg(RENT_LINES));
    expect(doc.mimeType).toBe("image/jpeg");
    expect(norm(doc.pages[0]!)).toContain("$1,500.00");
  });

  it("reads a scanned (image-only) PDF and keeps page order", { timeout: OCR_TIMEOUT }, async () => {
    const bytes = await pdf([{ image: textPng(["SECTION 1. PREMISES", "Unit 101, Maple Court Apartments."]) }, { image: textPng(RENT_LINES) }]);
    const stages: string[] = [];
    const doc = await loadDocument("scan.pdf", bytes, { onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["text_extraction", "ocr"]);
    expect(doc.textMethod).toBe("ocr");
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0]).toContain("PREMISES");
    expect(norm(doc.pages[1]!)).toContain("$1,500.00");
  });

  it("OCRs only the scanned pages of a mixed PDF", { timeout: OCR_TIMEOUT }, async () => {
    const bytes = await pdf([{ text: "SECTION 1. PREMISES. Unit 101, Maple Court Apartments, 1420 Maple Avenue." }, { image: textPng(RENT_LINES) }]);
    const doc = await loadDocument("mixed.pdf", bytes);
    expect(doc.textMethod).toBe("mixed");
    expect(doc.pageMeta.map((m) => m.method)).toEqual(["text", "ocr"]);
    expect(doc.pages[0]).toContain("1420 Maple Avenue");
    expect(norm(doc.pages[1]!)).toContain("monthly rent of $1,500.00");
  });
});

describe("OCR text through the extraction pipeline", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db);
    seedStructured(db);
  });

  it("reports each stage, stores per-page OCR details, and verifies snippets against the OCR text", { timeout: OCR_TIMEOUT }, async () => {
    const llm = scriptedLlm([JSON.stringify(sharmaExtraction())]);
    const stages: IngestStage[] = [];
    const bytes = await pdf([{ image: textPng(sharmaLines(), { wrapAt: 95 }) }]);
    const r = await ingestLeaseDocument(db, { docName: "sharma_scanned.pdf", bytes }, llm, { onStage: (s) => stages.push(s) });

    expect(stages).toEqual(["text_extraction", "ocr", "ai_extraction"]);
    expect(r.text).toMatchObject({ format: "pdf", page_count: 1, text_method: "ocr" });
    // The model was told the text came from OCR.
    expect(JSON.stringify(llm.lastMessages)).toMatch(/came from OCR/);
    const pages = db.prepare("SELECT page, method, ocr_confidence FROM source_document_pages").all() as { page: number; method: string; ocr_confidence: number }[];
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 1, method: "ocr" });
    expect(pages[0]!.ocr_confidence).toBeGreaterThan(70);
    // Key terms survive OCR and are verified verbatim against the recognised text.
    const lease = db.prepare("SELECT monthly_rent_cents, end_date, repair_deductible_cents FROM leases WHERE lease_id = ?").get(r.lease_id);
    expect(lease).toEqual({ monthly_rent_cents: 150000, end_date: "2027-01-15", repair_deductible_cents: 10000 });
  });

  it("flags pages read with low OCR confidence for review", async () => {
    const llm = scriptedLlm([JSON.stringify(sharmaExtraction())]);
    const text = readLease(SHARMA).toString("utf8");
    const r = await ingestLeaseDocument(db, { docName: "blurry.png", bytes: textPng(["x"]) }, llm, { ocr: fakeOcr(text, 55) });
    expect(r.extraction_status).toBe("needs_review");
    expect(r.gaps).toContainEqual({ field: "ocr_page:1", status: "needs_review", reason: expect.stringMatching(/low confidence \(55%\)/) });
  });
});

describe("upload API with OCR", () => {
  let tmp: string;
  let db: DB;
  let llm: LlmCall;
  let pm: Agent;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "propguard-ocr-"));
    db = openDb(":memory:");
    migrate(db);
    seedStructured(db);
    llm = scriptedLlm([JSON.stringify(sharmaExtraction())]);
    const store = new LocalDocumentStore(path.join(tmp, "uploads"));
    pm = await signedIn(createApp({ db, llm: () => llm, auth: testAuth(db), store }), "pm");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  async function waitForDocument(id: number) {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const d = (await pm.get(`/api/documents/${id}`).expect(200)).body.data;
      if (d.processing_stage) seen.add(d.processing_stage);
      if (d.status !== "processing") return { doc: d, seen };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("document never finished processing");
  }

  it("async mode answers 202 at once, then processes a scanned PDF in the background", { timeout: OCR_TIMEOUT }, async () => {
    const bytes = await pdf([{ image: textPng(sharmaLines(), { wrapAt: 95 }) }]);
    const r = await pm.post("/api/documents/leases?mode=async").attach("file", bytes, "sharma_scan.pdf").expect(202);
    expect(r.body.data.document).toMatchObject({ status: "processing", processing_stage: "uploaded", mime_type: "application/pdf" });
    expect(r.body.data.lease).toBeNull();

    const { doc } = await waitForDocument(r.body.data.document.document_id);
    expect(["extracted", "needs_review"]).toContain(doc.status);
    expect(doc).toMatchObject({ processing_stage: null, page_count: 1, text_method: "ocr" });

    const lease = (await pm.get(`/api/leases/${doc.lease_id}`).expect(200)).body.data;
    expect(lease.text_source).toMatchObject({ method: "ocr", page_count: 1, ocr_pages: [1] });
    expect(lease.monthly_rent_cents).toBe(150000);

    const events = (db.prepare("SELECT event_type FROM audit_logs ORDER BY audit_id").all() as { event_type: string }[]).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(["document_uploaded", "extraction_completed"]));
  });

  it("accepts PNG and DOCX uploads and serves the original with its own type", { timeout: OCR_TIMEOUT }, async () => {
    const png = await pm.post("/api/documents/leases").attach("file", textPng(RENT_LINES), "page.png").expect(201);
    expect(png.body.data.document).toMatchObject({ mime_type: "image/png", text_method: "ocr", page_count: 1 });
    const file = await pm.get(`/api/documents/${png.body.data.document.document_id}/file`).expect(200);
    expect(file.headers["content-type"]).toBe("image/png");

    const d = await pm.post("/api/documents/leases").attach("file", await docx(["Tenant shall pay monthly rent of $1,500.00."]), "lease.docx").expect(201);
    expect(d.body.data.document).toMatchObject({ mime_type: expect.stringContaining("wordprocessingml"), text_method: "text" });
  });

  it("refuses a file whose contents do not match its extension, before storing it", async () => {
    const r = await pm.post("/api/documents/leases").attach("file", Buffer.from("plain text pretending"), "scan.png").expect(422);
    expect(r.body.error.code).toBe("UNSUPPORTED_DOCUMENT");
    expect((db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(0);
  });
});
