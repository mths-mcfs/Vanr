// Dev server and build of the web app. In development `/api` goes to the fake server
// (`bun run dev:api`) or to a real one named by VANR_API_URL.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.VANR_API_URL ?? "http://127.0.0.1:4319";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // lucide-react and radix-ui ship "use client"; that is meaningless in a static SPA bundle.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
  server: {
    strictPort: true,
    proxy: { "/api": { target: api, ws: true } },
  },
});
