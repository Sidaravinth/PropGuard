import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Architectural guard: the policy engine must stay pure and AI-free. */
const policyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "policy");

describe("module boundaries", () => {
  const files = fs.readdirSync(policyDir).filter((f) => f.endsWith(".ts"));

  it.each(files)("%s imports nothing (no AI SDK, DB, network, or extraction code)", (file) => {
    const src = fs.readFileSync(path.join(policyDir, file), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    const forbidden = imports.filter((i) => !i!.startsWith("./"));
    expect(forbidden).toEqual([]);
    expect(src).not.toMatch(/genai|gemini|anthropic|fetch\(|node:sqlite|Date\.now|new Date\(/i);
  });
});
