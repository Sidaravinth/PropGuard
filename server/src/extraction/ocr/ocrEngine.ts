/**
 * OCR behind a small interface, so the engine can be replaced (PaddleOCR service, cloud OCR, ...)
 * without touching the loader. The default engine is Tesseract (tesseract.js, WebAssembly) running in
 * this process: page images never leave the machine, and the English model ships as an npm package
 * (@tesseract.js-data/eng), so nothing is downloaded at runtime.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "../../config.js";

export interface OcrPageResult {
  text: string;
  /** Mean word confidence reported by the engine, 0–100. */
  confidence: number;
}

export interface OcrEngine {
  readonly name: string;
  /** Recognise one image per page (PNG or JPEG bytes), in order. */
  recognize(images: Buffer[]): Promise<OcrPageResult[]>;
}

export class OcrFailedError extends Error {}

const require = createRequire(import.meta.url);

/** OCR is CPU-heavy: documents are processed one at a time, in arrival order. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

export class TesseractOcrEngine implements OcrEngine {
  readonly name = "tesseract.js/eng";

  constructor(private readonly pageTimeoutMs: number = config.ocrPageTimeoutMs) {}

  recognize(images: Buffer[]): Promise<OcrPageResult[]> {
    return serial(async () => {
      const { createWorker } = await import("tesseract.js");
      const langPath = path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0");
      const worker = await createWorker("eng", 1, { langPath, gzip: true, cacheMethod: "none" });
      try {
        const out: OcrPageResult[] = [];
        for (const [i, image] of images.entries()) {
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new OcrFailedError(`OCR of page ${i + 1} took longer than ${this.pageTimeoutMs / 1000} s`)), this.pageTimeoutMs);
          });
          try {
            const r = await Promise.race([worker.recognize(image), timedOut]);
            out.push({ text: cleanOcrText(r.data.text), confidence: Math.round(r.data.confidence) });
          } finally {
            clearTimeout(timer);
          }
        }
        return out;
      } finally {
        await worker.terminate().catch(() => undefined);
      }
    });
  }
}

/** Trim trailing spaces and runs of blank lines; keep line breaks (reading order, headings, table rows). */
export function cleanOcrText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let defaultEngine: OcrEngine | null = null;

/** The configured engine, or null when OCR is turned off (OCR_ENABLED=false). */
export function defaultOcrEngine(): OcrEngine | null {
  if (!config.ocrEnabled) return null;
  return (defaultEngine ??= new TesseractOcrEngine());
}
