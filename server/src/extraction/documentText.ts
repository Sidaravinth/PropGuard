/**
 * Document inspection and text extraction, the step before AI extraction:
 *
 *   inspect (format from magic bytes, page count)
 *     -> text-based PDF pages and DOCX: read their own text
 *     -> scanned/image-only PDF pages and JPG/PNG: render to an image and OCR locally
 *   -> page-indexed text (page numbers and reading order preserved) + per-page method/confidence.
 *
 * The result feeds the unchanged extraction pipeline; every snippet is later verified against this text.
 */
import crypto from "node:crypto";
import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";
import { config } from "../config.js";
import { defaultOcrEngine, OcrFailedError, type OcrEngine } from "./ocr/ocrEngine.js";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type DocumentMime = "application/pdf" | "text/plain" | "image/png" | "image/jpeg" | typeof DOCX_MIME;
export type DocumentFormat = "pdf" | "text" | "image" | "docx";

export interface PageMeta {
  method: "text" | "ocr";
  /** OCR mean confidence 0–100; null for pages read from their own text. */
  confidence: number | null;
}

export interface LoadedDocument {
  docName: string;
  mimeType: DocumentMime;
  format: DocumentFormat;
  sha256: string;
  /** Text per page (plain-text, image and DOCX files are a single page). */
  pages: string[];
  pageMeta: PageMeta[];
  textMethod: "text" | "ocr" | "mixed";
}

/** Processing stages reported while a document is read. */
export type TextStage = "text_extraction" | "ocr";

export interface LoadOptions {
  /** OCR engine; defaults to the configured one. null disables OCR (scanned pages are then refused). */
  ocr?: OcrEngine | null;
  onStage?: (stage: TextStage) => void;
  maxPages?: number;
}

export class UnsupportedDocumentError extends Error {}

/** A PDF page with fewer non-space characters than this is treated as scanned and OCR'd. */
export const MIN_TEXT_CHARS = 20;
/** Render scale for OCR: 3 × 72 dpi = 216 dpi, enough for typical lease print. */
const OCR_RENDER_SCALE = 3;

export const SUPPORTED_EXTENSIONS = [".pdf", ".txt", ".md", ".png", ".jpg", ".jpeg", ".docx"] as const;

/** Identify the format from the file's own bytes first, then its extension (plain text has no signature). */
export function detectFormat(docName: string, bytes: Buffer): { format: DocumentFormat; mimeType: DocumentMime } | null {
  const lower = docName.toLowerCase();
  const head = bytes.subarray(0, 8);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return { format: "pdf", mimeType: "application/pdf" };
  if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { format: "image", mimeType: "image/png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { format: "image", mimeType: "image/jpeg" };
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && lower.endsWith(".docx")) return { format: "docx", mimeType: DOCX_MIME };
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return { format: "text", mimeType: "text/plain" };
  // A damaged PDF: let the PDF reader report what is wrong with it.
  if (lower.endsWith(".pdf")) return { format: "pdf", mimeType: "application/pdf" };
  return null;
}

const nonSpaceLength = (s: string) => s.replace(/\s+/g, "").length;

function textMethodOf(meta: PageMeta[]): LoadedDocument["textMethod"] {
  const ocr = meta.filter((m) => m.method === "ocr").length;
  return ocr === 0 ? "text" : ocr === meta.length ? "ocr" : "mixed";
}

async function runOcr(engine: OcrEngine, images: Buffer[]) {
  try {
    return await engine.recognize(images);
  } catch (err) {
    if (err instanceof OcrFailedError) throw new UnsupportedDocumentError(err.message);
    throw new UnsupportedDocumentError(`OCR failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function requireOcr(engine: OcrEngine | null, what: string): OcrEngine {
  if (!engine) throw new UnsupportedDocumentError(`${what} needs OCR, which is turned off (OCR_ENABLED=false).`);
  return engine;
}

/** Turn an uploaded/loaded file into page-indexed text, using OCR where a page has no text of its own. */
export async function loadDocument(docName: string, bytes: Buffer, opts: LoadOptions = {}): Promise<LoadedDocument> {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const detected = detectFormat(docName, bytes);
  if (!detected) throw new UnsupportedDocumentError("Unsupported file type: upload a .pdf, .txt, .docx, .png or .jpg lease document.");
  const engine = opts.ocr === undefined ? defaultOcrEngine() : opts.ocr;
  const maxPages = opts.maxPages ?? config.ocrMaxPages;
  const base = { docName, sha256, ...detected };

  if (detected.format === "pdf") {
    opts.onStage?.("text_extraction");
    let text: string[];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      if (pdf.numPages > maxPages) throw new UnsupportedDocumentError(`The PDF has ${pdf.numPages} pages; the limit is ${maxPages}.`);
      ({ text } = await extractText(pdf, { mergePages: false }));
    } catch (err) {
      if (err instanceof UnsupportedDocumentError) throw err;
      throw new UnsupportedDocumentError(`The PDF could not be read (${err instanceof Error ? err.message : "invalid file"}).`);
    }
    const pages = text.map((p) => p.replace(/[ \t]+\n/g, "\n").trim());
    const pageMeta: PageMeta[] = pages.map(() => ({ method: "text", confidence: null }));
    const scanned = pages.flatMap((p, i) => (nonSpaceLength(p) < MIN_TEXT_CHARS ? [i] : []));
    if (scanned.length) {
      const ocr = requireOcr(engine, scanned.length === pages.length ? "This PDF is scanned (it has no text layer) and" : `${scanned.length} scanned page(s) of this PDF`);
      opts.onStage?.("ocr");
      const images: Buffer[] = [];
      for (const i of scanned) {
        try {
          // A fresh copy each time: PDF.js takes ownership of (detaches) the buffer it is given.
          const png = await renderPageAsImage(new Uint8Array(bytes), i + 1, { canvasImport: () => import("@napi-rs/canvas"), scale: OCR_RENDER_SCALE });
          images.push(Buffer.from(png));
        } catch (err) {
          throw new UnsupportedDocumentError(`Page ${i + 1} could not be rendered for OCR (${err instanceof Error ? err.message : "render error"}).`);
        }
      }
      const results = await runOcr(ocr, images);
      scanned.forEach((pageIndex, k) => {
        pages[pageIndex] = results[k]!.text;
        pageMeta[pageIndex] = { method: "ocr", confidence: results[k]!.confidence };
      });
    }
    if (pages.every((p) => nonSpaceLength(p) === 0)) {
      throw new UnsupportedDocumentError("No readable text was found in the PDF, even with OCR (blank pages or an unreadable scan).");
    }
    return { ...base, pages, pageMeta, textMethod: textMethodOf(pageMeta) };
  }

  if (detected.format === "image") {
    const ocr = requireOcr(engine, "An image");
    opts.onStage?.("ocr");
    const [r] = await runOcr(ocr, [bytes]);
    if (!r || nonSpaceLength(r.text) === 0) throw new UnsupportedDocumentError("No readable text was found in the image.");
    return { ...base, pages: [r.text], pageMeta: [{ method: "ocr", confidence: r.confidence }], textMethod: "ocr" };
  }

  if (detected.format === "docx") {
    opts.onStage?.("text_extraction");
    let value: string;
    try {
      const mammoth = await import("mammoth");
      ({ value } = await mammoth.extractRawText({ buffer: bytes }));
    } catch (err) {
      throw new UnsupportedDocumentError(`The Word document could not be read (${err instanceof Error ? err.message : "invalid file"}).`);
    }
    // DOCX has no fixed pages (layout depends on the viewer), so the whole document is page 1.
    const text = value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new UnsupportedDocumentError("The Word document contains no text.");
    return { ...base, pages: [text], pageMeta: [{ method: "text", confidence: null }], textMethod: "text" };
  }

  opts.onStage?.("text_extraction");
  const text = bytes.toString("utf8").replace(/\r\n/g, "\n").trim();
  if (!text) throw new UnsupportedDocumentError("Document is empty.");
  return { ...base, pages: [text], pageMeta: [{ method: "text", confidence: null }], textMethod: "text" };
}

/** Render pages with explicit markers so the model can cite page numbers. */
export function renderForModel(doc: Pick<LoadedDocument, "pages">): string {
  return doc.pages.map((p, i) => `<page number="${i + 1}">\n${p}\n</page>`).join("\n");
}
