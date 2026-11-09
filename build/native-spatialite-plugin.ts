// SPDX-License-Identifier: LGPL-2.1-or-later
import { resolve } from "node:path";
import process from "node:process";
import type { Plugin } from "vite";
import { readNativeArtifacts } from "./native-artifacts.ts";

/** Production always includes native SpatiaLite; only source unit tests use the fallback. */
export function nativeSpatialitePlugin(options: { testFallback?: boolean } = {}): Plugin {
  const id = "virtual:spatialite-native";
  return {
    name: "native-spatialite-runtime",
    enforce: "pre",
    resolveId(source) { return source === id ? `\0${id}` : null; },
    load(source) {
      if (source !== `\0${id}`) return null;
      if (options.testFallback) return "export default null;";
      const directory = resolve(process.cwd(), "src/wasm");
      readNativeArtifacts(directory);
      const entry = resolve(directory, "spatialite.js").replace(/\\/g, "/");
      return `export { default } from ${JSON.stringify(entry)};`;
    },
  };
}
