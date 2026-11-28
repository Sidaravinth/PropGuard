/**
 * Lightweight retrieval for one lease: BM25 over the lease's own chunks, with a small synonym map for
 * the ways people ask about lease terms. Pure function, no I/O, no embeddings service.
 */
import type { Chunk } from "./chunker.js";

export interface RankedChunk extends Chunk {
  score: number;
}

/** Send the whole document when it is this short (characters), so a short lease never loses a relevant clause. */
export const SEND_ALL_CHARS = 12_000;
export const TOP_K = 8;

const STOPWORDS = new Set(
  "a an and are as at be by can could do does for from has have how i if in is it its may me my of on or our shall should so that the their them there this to us was we what when where which who whom why will with would you your about any there".split(
    " ",
  ),
);

/** Groups of words that mean the same thing in a lease question. Each word expands to its whole group. */
const SYNONYMS: string[][] = [
  ["pet", "pets", "animal", "animals", "dog", "dogs", "cat", "cats"],
  ["deposit", "security", "deposits"],
  ["notice", "notify", "terminate", "termination", "vacate", "move", "end", "non-renewal"],
  ["repair", "repairs", "maintenance", "maintain", "plumbing", "fix", "damage", "heating", "electrical"],
  ["late", "fee", "fees", "penalty", "overdue"],
  ["rent", "payment", "pay", "paid", "monthly"],
  ["expire", "expires", "expiry", "expiration", "end", "term", "ends"],
  ["deductible", "deductibles", "excess"],
  ["deduct", "deduction", "deductions", "withhold", "apply", "applied"],
  ["renew", "renewal", "extend", "extension"],
  ["early", "break", "terminate", "termination"],
  ["landlord", "lessor", "owner"],
  ["tenant", "lessee", "resident"],
];

/** Light stemming: enough to match "repairs"/"repair" and "terminated"/"terminate". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9$][a-z0-9$.,-]*[a-z0-9]|[a-z0-9]/g) ?? [])
    .map((t) => t.replace(/[.,]+$/, ""))
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

const SYNONYM_INDEX = (() => {
  const m = new Map<string, Set<string>>();
  for (const group of SYNONYMS) {
    const stems = group.map(stem);
    for (const s of stems) {
      const set = m.get(s) ?? new Set<string>();
      for (const t of stems) set.add(t);
      m.set(s, set);
    }
  }
  return m;
})();

/** Query terms with their synonyms; synonyms count half as much as the words actually asked. */
function queryTerms(question: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const t of tokenize(question)) {
    terms.set(t, 1);
    for (const syn of SYNONYM_INDEX.get(t) ?? []) if (!terms.has(syn)) terms.set(syn, 0.5);
  }
  return terms;
}

export function rankChunks(question: string, chunks: Chunk[]): RankedChunk[] {
  const k1 = 1.2;
  const b = 0.75;
  const docs = chunks.map((c) => tokenize(`${c.section_ref ?? ""} ${c.text}`));
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const terms = queryTerms(question);
  const n = chunks.length;

  return chunks
    .map((c, i) => {
      const d = docs[i]!;
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const [t, weight] of terms) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        score += weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgLen)));
      }
      return { ...c, score: Math.round(score * 1000) / 1000 };
    })
    .sort((a, b2) => b2.score - a.score || chunks.indexOf(a) - chunks.indexOf(b2));
}

/** The chunks sent to the model, best first. Small documents are sent whole (still in ranked order). */
export function retrieve(question: string, chunks: Chunk[]): RankedChunk[] {
  const ranked = rankChunks(question, chunks);
  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  return total <= SEND_ALL_CHARS ? ranked : ranked.slice(0, TOP_K);
}
