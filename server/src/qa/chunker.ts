/**
 * Split a lease's page text into retrieval chunks. Pure function, no I/O.
 *
 * Chunks follow the document's own structure (section headings and paragraphs), never span two pages,
 * and keep their page number and the nearest section heading, so every answer can cite "page N, Section X".
 */
export interface Chunk {
  /** Stable within one document: "p<page>c<n>". */
  chunk_id: string;
  page: number;
  section_ref: string | null;
  text: string;
}

const TARGET_MAX = 1200;
/** A chunk that is only a heading line ("SECTION 3. RENT") stays with the text that follows it. */
const HEADING_ONLY = 80;

/**
 * "SECTION 4. SECURITY DEPOSIT", "Section 3.1", "Clause 7.", "ARTICLE II", "§2 RENT", "5.2 Repair Deductible.",
 * and "4. REPAIRS." (a number followed by a short title ending in a period or colon, not an ordinary sentence).
 */
const HEADING_RE =
  /^\s*(?:(SECTION|Section|CLAUSE|Clause|ARTICLE|Article|§)\s*([0-9IVXLC]+(?:\.[0-9]+)*)|([0-9]+(?:\.[0-9]+)+)\s|([0-9]{1,2})\.\s+[A-Z][A-Za-z' -]{1,40}[.:](?:\s|$))/;

export function sectionRefOf(block: string): string | null {
  const m = HEADING_RE.exec(block);
  if (!m) return null;
  if (m[1]) return `${m[1] === "§" ? "§" : m[1][0]!.toUpperCase() + m[1].slice(1).toLowerCase()} ${m[2]}`.replace("§ ", "§");
  return `Section ${m[3] ?? m[4]}`;
}

/** Paragraph blocks; a heading line also starts a new block even without a blank line before it (common in OCR text). */
function blocksOf(page: string): string[] {
  const out: string[] = [];
  for (const para of page.split(/\n\s*\n/)) {
    let cur: string[] = [];
    for (const line of para.split("\n")) {
      if (cur.length && HEADING_RE.test(line)) {
        out.push(cur.join("\n"));
        cur = [];
      }
      cur.push(line);
    }
    if (cur.length) out.push(cur.join("\n"));
  }
  return out.map((b) => b.trim()).filter(Boolean);
}

/** Split an over-long block at sentence ends so no chunk exceeds the maximum. */
function splitLong(block: string): string[] {
  if (block.length <= TARGET_MAX) return [block];
  const sentences = block.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [block];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > TARGET_MAX) {
      out.push(cur.trim());
      cur = "";
    }
    // A single sentence longer than the maximum is cut at a space.
    let rest = s;
    while (rest.length > TARGET_MAX) {
      const cut = rest.lastIndexOf(" ", TARGET_MAX) > 0 ? rest.lastIndexOf(" ", TARGET_MAX) : TARGET_MAX;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    cur += rest;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function chunkPages(pages: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  let lastSection: string | null = null;
  pages.forEach((pageText, i) => {
    const page = i + 1;
    let n = 0;
    let cur = "";
    let curSection: string | null = lastSection;
    const flush = () => {
      if (!cur.trim()) return;
      chunks.push({ chunk_id: `p${page}c${++n}`, page, section_ref: curSection, text: cur.trim() });
      cur = "";
    };
    for (const block of blocksOf(pageText).flatMap(splitLong)) {
      const heading = sectionRefOf(block);
      // Every section starts its own chunk, so a citation names the right section; paragraphs within a
      // section are kept together up to the size limit.
      const headingOnly = cur.length < HEADING_ONLY && !cur.includes("\n") && !/[.!?;]["')]?$/.test(cur);
      if (cur && ((heading && !headingOnly) || cur.length + block.length + 2 > TARGET_MAX)) flush();
      if (!cur) curSection = heading ?? lastSection;
      if (heading) lastSection = heading;
      cur = cur ? `${cur}\n\n${block}` : block;
    }
    flush();
  });
  return chunks;
}
