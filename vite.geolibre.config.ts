import { resolve } from "node:path";

import { defineConfig } from "vite";

import { inlineSqlWasmPlugin } from "./build/inline-sql-wasm-plugin.ts";

export default defineConfig({
  publicDir: false,
  plugins: [inlineSqlWasmPlugin()],
  build: {
    target: "es2022",
    lib: {
      entry: resolve(process.cwd(), "src/geolibre.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: "geolibre-plugin/dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: [],
      output: {
        assetFileNames: () => "style.css",
      },
    },
  },
});
