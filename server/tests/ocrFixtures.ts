/**
 * Generated documents for OCR tests: text drawn onto a PNG, image-only ("scanned") PDFs, mixed PDFs and
 * DOCX files. Everything is produced locally, so the tests need no binary fixtures and no network.
 */
import { createCanvas, Image } from "@napi-rs/canvas";
import JSZip from "jszip";
import PDFDocument from "pdfkit";

/** Wrap at word boundaries so a long line stays on the image. */
function wrap(line: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(" ")) {
    if (cur && (cur + " " + word).length > width) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  out.push(cur);
  return out;
}

/** Black text on white, like a clean scan at about 200 dpi. */
export function textPng(lines: string[], opts: { width?: number; fontPx?: number; wrapAt?: number } = {}): Buffer {
  const width = opts.width ?? 1700;
  const font = opts.fontPx ?? 30;
  const rows = lines.flatMap((l) => (l ? wrap(l, opts.wrapAt ?? 85) : [""]));
  const lineHeight = Math.round(font * 1.6);
  const canvas = createCanvas(width, 80 + rows.length * lineHeight);
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000000";
  g.font = `${font}px sans-serif`;
  rows.forEach((r, i) => g.fillText(r, 60, 60 + i * lineHeight));
  return canvas.toBuffer("image/png");
}

/** The same drawing, encoded as a JPEG (as a phone photo or scanner would save it). */
export function textJpeg(lines: string[]): Buffer {
  const img = new Image();
  img.src = textPng(lines);
  const c = createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  return c.toBuffer("image/jpeg", 92);
}

/** A PDF whose pages are either real text or a full-page image (a scan, with no text layer). */
export function pdf(pages: ({ text: string } | { image: Buffer })[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on("data", (d: Buffer) => chunks.push(d));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  for (const p of pages) {
    doc.addPage();
    if ("text" in p) doc.fontSize(11).text(p.text, 50, 50, { width: 510 });
    else doc.image(p.image, 20, 20, { fit: [572, 752] });
  }
  doc.end();
  return done;
}

/** A minimal valid .docx with one paragraph per entry. */
export async function docx(paragraphs: string[]): Promise<Buffer> {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
      .map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}
