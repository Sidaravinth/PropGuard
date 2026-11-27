import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: { PROPGUARD_TODAY: "2026-11-26" },
  },
});
