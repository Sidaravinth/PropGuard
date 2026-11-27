/**
 * Generates data/leases/lease_oakwood_301_patel.pdf — the 5th sample lease, deliberately a 2-page PDF
 * with an ambiguous rent clause (numerals and words disagree) to exercise the needs_review path.
 * Run: npm run make-pdf -w server
 */
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { config } from "../src/config.js";

const PAGE_1 = [
  ["title", "OAKWOOD TERRACE RESIDENTIAL LEASE"],
  ["p", "This Lease is made between Oakwood Terrace Residences LP (\"Lessor\") and Aisha Patel (\"Lessee\")."],
  ["h", "Clause 1. Premises"],
  ["p", "Lessor leases to Lessee Unit 301, Oakwood Terrace, 7 Oakwood Drive, Springfield, together with one assigned parking space."],
  ["h", "Clause 2. Term"],
  ["p", "The lease term runs from February 1, 2026 through January 31, 2027."],
  ["h", "Clause 3. Rent"],
  [
    "p",
    "Lessee shall pay monthly rent of $1,800.00 (One Thousand Eight Hundred Fifty Dollars) on the first day of each month. Rent includes one parking space.",
  ],
  ["h", "Clause 4. Security Deposit"],
  ["p", "Lessee has deposited $1,800.00 with Lessor as a security deposit, to be held and returned in accordance with state law."],
] as const;

const PAGE_2 = [
  ["h", "Clause 5. Maintenance and Repairs"],
  [
    "p",
    "Lessee shall keep the Premises clean and sanitary. For each repair to appliances, fixtures or plumbing within the Premises, Lessee shall pay a deductible of $75.00 and Lessor shall pay the remaining cost of the repair.",
  ],
  ["h", "Clause 6. Pets"],
  ["p", "Pets are not permitted, with the exception of service animals as required by law."],
  ["h", "Clause 7. Notice"],
  [
    "p",
    "Lessee shall give Lessor written notice of non-renewal no less than forty-five (45) days before the end of the term. Lessor shall give written notice of any renewal terms within the same period.",
  ],
  ["p", "IN WITNESS WHEREOF, the parties have executed this Lease on January 22, 2026."],
  ["p", "Lessor: Oakwood Terrace Residences LP          Lessee: Aisha Patel"],
] as const;

function render(doc: PDFKit.PDFDocument, blocks: readonly (readonly [string, string])[]) {
  for (const [kind, text] of blocks) {
    if (kind === "title") doc.font("Helvetica-Bold").fontSize(16).text(text, { align: "center" }).moveDown();
    else if (kind === "h") doc.font("Helvetica-Bold").fontSize(12).text(text).moveDown(0.3);
    else doc.font("Helvetica").fontSize(11).text(text, { align: "left" }).moveDown();
  }
}

const out = path.join(config.leasesDir, "lease_oakwood_301_patel.pdf");
const doc = new PDFDocument({ size: "LETTER", margin: 72, info: { Title: "Oakwood Terrace Residential Lease — Unit 301" } });
doc.pipe(fs.createWriteStream(out));
render(doc, PAGE_1);
doc.addPage();
render(doc, PAGE_2);
doc.end();
console.log(`wrote ${out}`);
