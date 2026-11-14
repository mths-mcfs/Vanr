// Dev server and build for the component gallery. The gallery is a proof sheet and is not published.
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
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
  },
});
