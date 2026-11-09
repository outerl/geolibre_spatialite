import { defineConfig } from "vitest/config";

import { inlineSqlWasmPlugin } from "./build/inline-sql-wasm-plugin.ts";

export default defineConfig({
  plugins: [inlineSqlWasmPlugin()],
  test: {
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
