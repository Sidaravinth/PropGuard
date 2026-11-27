/** CLI ingestion: npm run ingest -- <path/to/lease.pdf|txt> [more files...] */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { migrate, openDb } from "../db/connection.js";
import { createGeminiLlmCall } from "./extractor.js";
import { ingestLeaseDocument } from "./ingest.js";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: npm run ingest -- <lease file> [more files...]");
  process.exit(2);
}

const db = openDb(config.dbPath);
migrate(db);
const llm = createGeminiLlmCall();

for (const file of files) {
  const abs = path.resolve(process.cwd(), file);
  try {
    const result = await ingestLeaseDocument(db, { docName: path.basename(abs), bytes: fs.readFileSync(abs) }, llm);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Failed to ingest ${file}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
