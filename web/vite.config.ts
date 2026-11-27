import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.PROPGUARD_API ?? "http://localhost:3001";

// In development the API is proxied so the browser sees one origin (the session cookie is SameSite=Strict).
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    // Fail instead of silently moving to 5174: a stale server on 5173 would otherwise be the one you open.
    strictPort: true,
    proxy: {
      "/api": { target: api, xfwd: true },
      "/docs": { target: api },
      "/openapi.json": { target: api },
    },
  },
});
