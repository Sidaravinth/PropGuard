import crypto from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";

export interface LoadedDocument {
  docName: string;
  mimeType: "application/pdf" | "text/plain";
  sha256: string;
  /** Text per page (plain-text files are a single page). */
  pages: string[];
}

export class UnsupportedDocumentError extends Error {}

/** Turn an uploaded/loaded file into page-indexed text. Only .pdf and .txt/.md are accepted. */
export async function loadDocument(docName: string, bytes: Buffer): Promise<LoadedDocument> {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const lower = docName.toLowerCase();
  const isPdf = lower.endsWith(".pdf") || bytes.subarray(0, 5).toString("latin1") === "%PDF-";

  if (isPdf) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map((p) => p.replace(/[ \t]+\n/g, "\n").trim());
    if (pages.every((p) => p.length === 0)) {
      throw new UnsupportedDocumentError("PDF contains no extractable text (scanned PDFs need OCR, which is not supported).");
    }
    return { docName, mimeType: "application/pdf", sha256, pages };
  }

  if (lower.endsWith(".txt") || lower.endsWith(".md")) {
    const text = bytes.toString("utf8").replace(/\r\n/g, "\n").trim();
    if (!text) throw new UnsupportedDocumentError("Document is empty.");
    return { docName, mimeType: "text/plain", sha256, pages: [text] };
  }

  throw new UnsupportedDocumentError("Unsupported file type: upload a .pdf or .txt lease document.");
}

/** Render pages with explicit markers so the model can cite page numbers. */
export function renderForModel(doc: LoadedDocument): string {
  return doc.pages.map((p, i) => `<page number="${i + 1}">\n${p}\n</page>`).join("\n");
}
