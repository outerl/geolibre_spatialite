// SPDX-License-Identifier: LGPL-2.1-or-later
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface NativeBuildInfo {
  format: number;
  engine: string;
  singleFile: boolean;
  wasmBigInt: boolean;
  capabilities: { workerFS: true; sqliteOpenV2: true };
  components: Record<string, string>;
  files: Record<string, string>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

/** Reject incomplete/stale native artifacts before producing a distributable. */
export function readNativeArtifacts(directory: string): NativeBuildInfo {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(directory, "build-info.json"), "utf8")); }
  catch { throw new Error("Native SpatiaLite artifacts are missing. Run npm run build:wasm, or download the native artifact from CI into src/wasm."); }
  if (!isRecord(raw) || raw.format !== 1 || raw.engine !== "native-c-wasm" || raw.singleFile !== true || raw.wasmBigInt !== true ||
      !isRecord(raw.capabilities) || raw.capabilities.workerFS !== true || raw.capabilities.sqliteOpenV2 !== true ||
      !isStringRecord(raw.files) || !isStringRecord(raw.components)) throw new Error("Invalid native build metadata.");
  const info: NativeBuildInfo = {
    format: raw.format, engine: raw.engine, singleFile: raw.singleFile, wasmBigInt: raw.wasmBigInt,
    capabilities: { workerFS: true, sqliteOpenV2: true }, components: raw.components, files: raw.files,
  };
  if (!["sqlite", "spatialite", "geos", "proj", "zlib", "emscripten"].every((key) => typeof info.components[key] === "string")) throw new Error("Invalid component metadata.");
  const sqlite = info.components.sqlite?.split(".");
  if (!sqlite || sqlite.length !== 3 || !sqlite.every((part) => /^\d+$/.test(part))) throw new Error("Invalid SQLite build version.");
  const [major = "", minor = "", patch = ""] = sqlite;
  const sqliteArchive = `${major}${minor.padStart(2,"0")}${patch.padStart(2,"0")}00`;
  const version = (name: string): string => info.components[name] ?? "";
  const required = ["spatialite.js", "proj.db", "licenses/libspatialite.txt", "licenses/geos.txt", "licenses/proj.txt", "licenses/zlib.txt",
    `sources/sqlite-amalgamation-${sqliteArchive}.zip`, `sources/libspatialite-${version("spatialite")}.tar.gz`,
    `sources/geos-${version("geos")}.tar.bz2`, `sources/proj-${version("proj")}.tar.gz`, `sources/zlib-${version("zlib")}.tar.gz`];
  if (!required.every((name) => Object.hasOwn(info.files, name))) throw new Error("Native artifacts lack runtime, projection database, licenses, or corresponding sources.");
  for (const [name, expected] of Object.entries(info.files)) {
    if (isAbsolute(name) || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid native artifact path.");
    const actual = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
    if (actual !== expected) throw new Error(`Native artifact checksum mismatch: ${name}`);
  }
  return info;
}
