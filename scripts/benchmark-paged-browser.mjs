// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting
// Browser module served only by benchmark-paged.mjs.
import { getSpatialiteService, loadNativeSpatialiteWasm } from "/dist/geolibre-spatialite.js";

const input = document.getElementById("database");
const params = new URLSearchParams(location.search);
const service = getSpatialiteService();
const table = params.get("table") || "links";
const column = params.get("column") || "geometry";
const properties = params.has("properties") ? params.get("properties").split(",").filter(Boolean) : undefined;
const bbox = params.has("bbox") ? params.get("bbox").split(",").map(Number) : undefined;
let running = false;

async function measureLayer(db, options) {
  let count = 0, sum = 0, xor = 0, fingerprintMs = 0;
  const started = performance.now();
  for await (const batch of db.streamTableGeoJson(table, column, undefined, options)) {
    const hashStart = performance.now();
    for (const feature of batch) {
      let hash = 2166136261;
      const text = JSON.stringify(feature);
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
      sum = (sum + hash) >>> 0;
      xor = (xor ^ hash) >>> 0;
      count++;
    }
    fingerprintMs += performance.now() - hashStart;
  }
  const elapsedMs = performance.now() - started;
  return { count, elapsedMs, fingerprintMs, conversionMs: elapsedMs - fingerprintMs, fingerprint: `${count}:${sum}:${xor}` };
}

async function run() {
  if (running || !input.files.length) return;
  running = true;
  let paged, memory;
  try {
    if (service.getEngineType() !== "native-c-wasm") throw new Error("Build the native runtime before benchmarking paged reads.");
    const file = input.files[0];
    const base = { propertyColumns: properties, batchSize: 512 };
    const started = performance.now();
    paged = await service.openFile(file, { cacheMiB: 32 });
    const openFileElapsedMs = performance.now() - started;
    const afterOpen = await paged.getStats();
    const selective = bbox ? await measureLayer(paged, { ...base, bbox, requireSpatialIndex: params.has("require-index") }) : null;
    const afterSelective = await paged.getStats();
    const fullLayer = await measureLayer(paged, base);
    const afterFull = await paged.getStats();
    await paged.close(); paged = null;
    let inMemory = null;
    if (params.has("compare-memory")) {
      const runtimeStart = performance.now();
      await loadNativeSpatialiteWasm();
      const nativeFactoryMs = performance.now() - runtimeStart;
      const readStart = performance.now();
      const bytes = await file.arrayBuffer();
      const readWholeFileMs = performance.now() - readStart;
      const memoryStart = performance.now();
      memory = await service.openDatabase(bytes);
      const openMs = performance.now() - memoryStart;
      const memorySelective = bbox ? await measureLayer(memory, { ...base, bbox, requireSpatialIndex: params.has("require-index") }) : null;
      const memoryFull = await measureLayer(memory, base);
      if (memoryFull.fingerprint !== fullLayer.fingerprint || memorySelective?.fingerprint !== selective?.fingerprint) {
        throw new Error("Paged and in-memory runs returned different feature fingerprints.");
      }
      inMemory = { nativeFactoryMs, readWholeFileMs, openMs, selective: memorySelective, fullLayer: memoryFull };
    }
    globalThis.__geolibreTest = { done: true, result: {
      engine: service.getEngineType(), file: file.name, fileBytes: file.size, table, column,
      propertyColumns: properties ?? "all", bbox: bbox ?? null,
      paged: { openFileElapsedMs, afterOpen, selective, afterSelective, fullLayer, afterFull }, inMemory,
      memoryMeasurement: null,
      notes: [
        "Slice statistics measure requested Blob ranges, not physical disk IO.",
        "Page cache is bounded; runtime, SQL scratch, and consumer memory are additional.",
        "No whole-file buffer is made by this harness unless --compare-memory is requested.",
        "Selective and full reads share an open connection and cache; repeat in fresh processes for cold runs.",
        "Feature fingerprints are order-independent count/sum/xor of FNV-1a hashes, not a cryptographic equivalence proof.",
        "This compares the shared native backends, not AequilibraE's existing paged reader.",
      ],
    } };
  } catch (error) {
    globalThis.__geolibreTest = { done: true, error: error.stack || String(error) };
  } finally {
    try {
      await paged?.close();
      memory?.close();
    } catch (error) {
      if (!globalThis.__geolibreTest?.error) globalThis.__geolibreTest = { done: true, error: error.stack || String(error) };
    }
  }
}
input.addEventListener("change", () => { void run(); });
void run();
