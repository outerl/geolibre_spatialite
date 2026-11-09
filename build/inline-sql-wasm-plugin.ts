// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Plugin } from "vite";

const VIRTUAL_MODULE = "virtual:sql-wasm-base64";
const RESOLVED_VIRTUAL_MODULE = `\0${VIRTUAL_MODULE}`;
const require = createRequire(import.meta.url);

/** Inline sql.js WebAssembly so a GeoLibre plugin entry stays self-contained. */
export function inlineSqlWasmPlugin(): Plugin {
  return {
    name: "inline-sql-wasm",
    enforce: "pre",
    resolveId(source) {
      return source === VIRTUAL_MODULE ? RESOLVED_VIRTUAL_MODULE : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE) return null;
      const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
      const base64 = readFileSync(wasmPath).toString("base64");
      return `export default ${JSON.stringify(base64)};`;
    },
  };
}
