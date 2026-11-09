import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { inlineSqlWasmPlugin } from "../build/inline-sql-wasm-plugin.ts";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const databasePath = process.argv[2];
if (!databasePath) throw new Error("Usage: node --expose-gc scripts/benchmark.mjs <database.sqlite> [table=links] [source-root]");
const table = process.argv[3] || "links";
const root = resolve(process.argv[4] || project);
const asyncRead = process.argv[5] === "async";
const server = await createServer({ root, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [inlineSqlWasmPlugin()], server: { middlewareMode: true }, logLevel: "error" });
try {
  const { SpatialiteDatabase } = await server.ssrLoadModule("/src/spatialite/database.ts");
  const { loadSqliteWasm } = await server.ssrLoadModule("/src/spatialite/sqlite-engine.ts");
  const input = await readFile(databasePath);
  const startRuntime = performance.now();
  await loadSqliteWasm();
  const runtimeMs = performance.now() - startRuntime;
  global.gc?.();
  const startOpen = performance.now();
  const db = await SpatialiteDatabase.open(input);
  const openMs = performance.now() - startOpen;
  const startMetadata = performance.now();
  for (let i = 0; i < 25; i++) { db.getGeometryColumns(); db.getTableNames(); }
  const metadataMs = performance.now() - startMetadata;
  const column = db.getGeometryColumns().find((col) => col.tableName === table)?.columnName || "geometry";
  const startLayer = performance.now();
  // Explicit limit makes the comparison include every feature in both versions.
  const data = asyncRead
    ? await db.getTableGeoJsonAsync(table, column, Number.MAX_SAFE_INTEGER)
    : db.getTableGeoJson(table, column, Number.MAX_SAFE_INTEGER);
  const layerMs = performance.now() - startLayer;
  const rssMiB = process.memoryUsage().rss / 1048576;
  const heapMiB = process.memoryUsage().heapUsed / 1048576;
  const checksum = createHash("sha256");
  for (const feature of data.features) checksum.update(JSON.stringify(feature));
  console.log(JSON.stringify({
    source: root, mode: asyncRead ? "async" : "sync", table, databaseMiB: input.length / 1048576, features: data.features.length,
    nonNullGeometries: data.features.filter((feature) => feature.geometry !== null).length,
    runtimeMs, openMs, metadata25Ms: metadataMs, layerMs, featureSha256: checksum.digest("hex"),
    rssMiB, heapMiB,
    maxRssMiB: process.resourceUsage().maxRSS / 1024,
  }, null, 2));
  db.close();
} finally { await server.close(); }
