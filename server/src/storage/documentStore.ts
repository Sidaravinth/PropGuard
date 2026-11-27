/**
 * Original-file storage behind a small interface, so the local directory can later be swapped for
 * S3-compatible object storage without touching callers. Keys are content-addressed (SHA-256), so
 * identical bytes are stored once and a key always refers to the same content.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface DocumentStore {
  /** Store bytes; returns the storage key. Idempotent for identical content. */
  put(bytes: Buffer, ext: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

export class StoredFileMissingError extends Error {}

const KEY_RE = /^[0-9a-f]{2}\/[0-9a-f]{64}(\.[a-z0-9]{1,8})?$/;

export class LocalDocumentStore implements DocumentStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private resolve(key: string): string {
    if (!KEY_RE.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return path.join(this.root, ...key.split("/"));
  }

  async put(bytes: Buffer, ext: string): Promise<string> {
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext.toLowerCase()) ? ext.toLowerCase() : "";
    const key = `${sha.slice(0, 2)}/${sha}${safeExt}`;
    const file = this.resolve(key);
    if (fs.existsSync(file)) return key;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write to a temp file then rename, so a crash never leaves a partial file under the real key.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, bytes, { flag: "wx" });
    await fs.promises.rename(tmp, file);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.promises.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new StoredFileMissingError(`Stored file ${key} is missing`);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.resolve(key));
  }
}
