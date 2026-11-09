import { defineConfig } from "vitest/config";

import { inlineSqlWasmPlugin } from "./build/inline-sql-wasm-plugin.ts";
import { nativeSpatialitePlugin } from "./build/native-spatialite-plugin.ts";

export default defineConfig({
  plugins: [inlineSqlWasmPlugin(), nativeSpatialitePlugin({ testFallback: true })],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "jsdom",
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
    },
  },
});
