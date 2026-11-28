/**
 * Generates OCR demo documents from the Sharma sample lease, made only of images (no text layer), as a
 * scanner or phone would produce them:
 *   data/demo/lease_maple_101_sharma_scanned.pdf   two scanned pages
 *   data/demo/lease_maple_101_sharma_photo.png     a single photographed page
 * Run: npm run make-scanned -w server
 *
 * Uploading one of these uses the same tenant as the .txt sample, so upload only one variant per database.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import PDFDocument from "pdfkit";
import { config, REPO_ROOT } from "../src/config.js";

const WIDTH = 1700; // ≈ 200 dpi across a Letter page
const FONT_PX = 30;
const LINE = Math.round(FONT_PX * 1.6);

function wrap(line: string, width = 90): string[] {
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

/** Draw lines like a slightly grey, imperfect scan. */
function scanImage(lines: string[]): Buffer {
  const rows = lines.flatMap((l) => (l ? wrap(l) : [""]));
  const canvas = createCanvas(WIDTH, Math.max(2200, 160 + rows.length * LINE));
  const g = canvas.getContext("2d");
  g.fillStyle = "#f7f6f2";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#1b1b1b";
  g.font = `${FONT_PX}px serif`;
  g.rotate(0.002); // scanners rarely feed perfectly straight
  rows.forEach((r, i) => g.fillText(r, 110, 120 + i * LINE));
  return canvas.toBuffer("image/png");
}

const text = fs.readFileSync(path.join(config.leasesDir, "lease_maple_101_sharma.txt"), "utf8").replace(/\r\n/g, "\n").split("\n");
const split = text.findIndex((l) => l.startsWith("SECTION 5."));
const pages = [text.slice(0, split), text.slice(split)].map(scanImage);

const outDir = path.join(REPO_ROOT, "data", "demo");
fs.mkdirSync(outDir, { recursive: true });

const doc = new PDFDocument({ size: "LETTER", autoFirstPage: false, info: { Title: "Residential Lease (scanned)" } });
const pdfPath = path.join(outDir, "lease_maple_101_sharma_scanned.pdf");
doc.pipe(fs.createWriteStream(pdfPath));
for (const png of pages) {
  doc.addPage({ margin: 0 });
  doc.image(png, 0, 0, { fit: [612, 792] });
}
doc.end();

const pngPath = path.join(outDir, "lease_maple_101_sharma_photo.png");
fs.writeFileSync(pngPath, scanImage(text));
console.log(`Wrote ${pdfPath}\nWrote ${pngPath}`);
