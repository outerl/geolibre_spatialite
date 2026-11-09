import { resolve } from "node:path";

import { defineConfig } from "vite";

import { inlineSqlWasmPlugin } from "./build/inline-sql-wasm-plugin.ts";
import { nativeSpatialitePlugin } from "./build/native-spatialite-plugin.ts";

export default defineConfig({
  plugins: [inlineSqlWasmPlugin(), nativeSpatialitePlugin()],
  build: {
    emptyOutDir: false,
    target: "es2022",
    sourcemap: true,
    lib: {
      entry: resolve(process.cwd(), "src/index.ts"),
      formats: ["es"],
      fileName: "geolibre-spatialite",
    },
  },
});
