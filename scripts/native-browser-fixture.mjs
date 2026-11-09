// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

const testResult = { done: false };
globalThis.__geolibreTest = testResult;

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function check(value, message) {
  if (!value) throw new Error(message);
}

async function getService() {
  const packageMode = new URLSearchParams(location.search).has("package");
  if (packageMode) {
    const { default: plugin } = await import("/dist/index.js");
    const app = {
      addGeoJsonLayer: () => "browser-test-layer",
      registerRightPanel: () => () => {},
      registerToolbarMenu: () => () => {},
      registerService: () => () => {},
    };
    if (!plugin.activate(app)) throw new Error("The packaged GeoLibre plugin did not activate.");
    const service = window.geolibreSpatialite;
    if (!service) throw new Error("The packaged plugin did not register its service.");
    return { service, cleanup: () => plugin.deactivate(app) };
  }
  const library = await import("/dist/geolibre-spatialite.js");
  return { service: library.getSpatialiteService(), cleanup: () => {} };
}

async function makeDatabase(service, withIndex) {
  const db = await service.createDatabase();
  db.query("SELECT InitSpatialMetaData(1)");
  db.exec("CREATE TABLE places (id INTEGER PRIMARY KEY, label TEXT, category TEXT, exact_id INTEGER)");
  db.query("SELECT AddGeometryColumn('places', 'geometry', 4326, 'POINT', 'XY')");
  if (withIndex) db.query("SELECT CreateSpatialIndex('places', 'geometry')");
  db.transaction(() => {
    for (let index = 0; index < 32; index += 1) {
      const x = index;
      const category = index % 2 === 0 ? "keep" : "skip";
      const exactId = index === 0 ? 9007199254740993n : BigInt(index + 100);
      db.exec(
        "INSERT INTO places (id, label, category, exact_id, geometry) VALUES (?, ?, ?, ?, GeomFromText(?, 4326))",
        [index + 1, `place-${index}`, category, exactId, `POINT(${x} ${x})`],
      );
    }
    // RTree stores outward-rounded float32 bounds. This row can be a bbox candidate
    // for [0,0,8,8] while its exact geometry envelope falls just outside.
    db.exec("INSERT INTO places (id, label, category, exact_id, geometry) VALUES (?, ?, ?, ?, GeomFromText(?,4326))",
      [99, "near-boundary", "keep", 99, "POINT(8.00000001 8.00000001)"]);
  });
  db.exec("CREATE TABLE padding (id INTEGER PRIMARY KEY, payload BLOB)");
  db.exec("INSERT INTO padding VALUES (1, zeroblob(4194304))");
  const bytes = db.export();
  db.close();
  return bytes;
}

async function run() {
  const { service, cleanup } = await getService();
  const started = performance.now();
  const indexedBytes = await makeDatabase(service, true);
  const scanBytes = await makeDatabase(service, false);
  const source = new File([indexedBytes.slice()], "indexed.sqlite", { type: "application/vnd.sqlite3" });
  const sourceBefore = new Uint8Array(await source.arrayBuffer());
  const openStarted = performance.now();
  const paged = await service.openFile(source, { cacheMiB: 8 });
  const firstOpenElapsedMs = performance.now() - openStarted;

  try {
    check(paged.getTableNames instanceof Function, "Paged connection metadata methods are missing.");
    const layerOptions = {
      propertyColumns: ["id", "label", "exact_id"],
      bbox: [0, 0, 8, 8],
      filters: [{ column: "category", operator: "=", value: "keep" }],
      requireSpatialIndex: true,
      batchSize: 2,
    };
    const indexed = await paged.getTableGeoJsonAsync("places", "geometry", 5, layerOptions);
    check(indexed.features.length === 5, `Expected 5 indexed features, got ${indexed.features.length}.`);
    check(indexed.features.every((feature) => Object.keys(feature.properties ?? {}).sort().join(",") === "exact_id,id,label"), "Selected property columns were not preserved.");
    check(indexed.features.some((feature) => feature.properties?.exact_id === "9007199254740993"), "Large integer attribute lost exactness.");
    check(indexed.features.every((feature) => feature.properties?.label !== "near-boundary"), "RTree float rounding leaked an outside envelope candidate.");

    const narrowStarted = performance.now();
    const narrow = await paged.getTableGeoJsonAsync("places", "geometry", undefined, {
      propertyColumns: ["id", "label", "exact_id"], batchSize: 32,
    });
    const narrowReadMs = performance.now() - narrowStarted;
    const fullStarted = performance.now();
    const full = await paged.getTableGeoJsonAsync("places");
    const fullLayerMs = performance.now() - fullStarted;
    check(narrow.features.length === full.features.length, "Selective and full layer reads returned different feature counts.");
    check(narrow.features.every((feature, index) => JSON.stringify(feature.geometry) === JSON.stringify(full.features[index]?.geometry)), "Selective and full reads returned different geometries.");

    const featureBatches = [];
    for await (const batch of paged.streamTableGeoJson("places", "geometry", 5, layerOptions)) featureBatches.push(batch);
    check(featureBatches.every((batch) => batch.length <= 2), "Feature stream exceeded its batch size.");
    check(featureBatches.flat().length === indexed.features.length, "Feature batches differed from the materialized result.");

    const exact = await paged.query("SELECT exact_id FROM places WHERE id = ?", [1]);
    check(exact[0]?.exact_id === 9007199254740993n, "Bound query did not preserve the exact SQLite integer.");
    let writeRejected = false;
    try { await paged.query("DELETE FROM places"); } catch { writeRejected = true; }
    check(writeRejected, "The paged connection accepted a write statement.");
    const rowBatches = [];
    for await (const batch of paged.streamQuery("SELECT id, label FROM places ORDER BY id", [], { batchSize: 3 })) rowBatches.push(batch);
    check(rowBatches.every((batch) => batch.length <= 3), "Row stream exceeded its pull batch size.");
    check(rowBatches.flat().length === 33, "Row stream did not return every row.");

    const scan = await service.openFile(new Blob([scanBytes]), { cacheMiB: 4 });
    let scanFeatures;
    try {
      scanFeatures = await scan.getTableGeoJsonAsync("places", "geometry", 5, {
        propertyColumns: ["id", "label", "exact_id"], bbox: [0, 0, 8, 8],
        filters: [{ column: "category", operator: "=", value: "keep" }], batchSize: 2,
      });
      const boundary = { propertyColumns: ["id", "label"], bbox: [8, 8, 8, 8],
        filters: [{ column: "category", operator: "=", value: "keep" }] };
      const indexedBoundary = await paged.getTableGeoJsonAsync("places", "geometry", undefined, boundary);
      const scanBoundary = await scan.getTableGeoJsonAsync("places", "geometry", undefined, boundary);
      check(JSON.stringify(ids(indexedBoundary)) === JSON.stringify(ids(scanBoundary)), "Indexed and scan bbox boundary results differ.");
      check(JSON.stringify(ids(indexedBoundary)) === JSON.stringify([9]), "Exact envelope post-filter did not remove the float-rounded near-boundary candidate.");
    } finally { await scan.close(); }
    const ids = (collection) => collection.features.map((feature) => feature.properties?.id).sort((a, b) => a - b);
    check(JSON.stringify(ids(scanFeatures)) === JSON.stringify(ids(indexed)), "RTree and scan fallback results differ.");

    const early = paged.streamQuery("SELECT id FROM places ORDER BY id", [], { batchSize: 1 });
    check((await early.next()).value?.length === 1, "Early-exit stream did not return its first row.");
    await early.return();
    check((await paged.query("SELECT count(*) AS n FROM places"))[0]?.n === 33, "Early iterator return left the read connection unusable.");

    const stats = await paged.getStats();
    check(stats.fileSize === source.size, "Paged file size metadata does not match the Blob.");
    check(stats.sliceBytesRequested < stats.fileSize, "Selective reads requested the entire Blob through WORKERFS.");
    check(stats.cacheBytes === 8 * 1024 * 1024, "Configured SQLite cache size was not reported.");
    const sourceAfter = new Uint8Array(await source.arrayBuffer());
    check(equalBytes(sourceBefore, sourceAfter), "The source Blob changed during read-only access.");

    const cancelConnection = await service.openFile(new Blob([indexedBytes]), { cacheMiB: 4 });
    const abort = new AbortController();
    const pendingRows = cancelConnection.streamQuery(
      "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 1000000) SELECT i FROM n",
      [], { batchSize: 1, signal: abort.signal },
    );
    check((await pendingRows.next()).value?.length === 1, "Cancellation query did not start.");
    abort.abort();
    let cancelled = false;
    try { await pendingRows.next(); } catch { cancelled = true; }
    check(cancelled, "AbortSignal did not cancel the active read.");
    let rejectedAfterCancel = false;
    try { await cancelConnection.query("SELECT 1"); } catch { rejectedAfterCancel = true; }
    check(rejectedAfterCancel, "The hard-cancelled worker accepted more work.");
    await cancelConnection.close();

    const bad = new Blob([new Uint8Array(128)]);
    let failedOpen = false;
    try { await service.openFile(bad); } catch { failedOpen = true; }
    check(failedOpen, "Invalid SQLite input did not fail opening.");
    const walHeader = indexedBytes.slice();
    walHeader[18] = 2;
    let walRejected = false;
    try { await service.openFile(new Blob([walHeader])); } catch { walRejected = true; }
    check(walRejected, "A WAL-format database was accepted without its sidecar snapshot.");

    const resources = performance.getEntriesByType("resource").map((item) => item.name);
    check(resources.every((url) => new URL(url, location.href).origin === location.origin), "The browser loaded a runtime asset from the network.");
    const totalMs = performance.now() - started;
    return {
      backend: service.getEngineType(), packageMode: new URLSearchParams(location.search).has("package"),
      fileBytes: source.size, featureCount: indexed.features.length, rowCount: rowBatches.flat().length,
      selectedProperties: ["id", "label", "exact_id"], scanParity: true,
      firstOpenElapsedMs, workerNativeFactoryMs: stats.nativeFactoryMs, sqliteMountOpenMs: stats.sqliteMountOpenMs,
      openElapsedMs: stats.openElapsedMs, fileOpenWallMs: firstOpenElapsedMs,
      selectiveReadRows: narrow.features.length, selectiveReadMs: narrowReadMs,
      fullLayerFeatures: full.features.length, fullLayerConversionMs: fullLayerMs,
      sliceBytesRequested: stats.sliceBytesRequested,
      sliceRequestCount: stats.sliceRequestCount, cacheBytes: stats.cacheBytes,
      totalMs, sourceUnchanged: true,
      cancellation: "worker terminated; subsequent work rejected", earlyReturn: "cursor finalized",
    };
  } finally {
    await paged.close();
    let closedRejected = false;
    try { await paged.query("SELECT 1"); } catch { closedRejected = true; }
    check(closedRejected, "Closed worker accepted another request.");
    cleanup();
  }
}

run().then((result) => {
  globalThis.__geolibreTest = { done: true, result };
}).catch((error) => {
  globalThis.__geolibreTest = { done: true, error: error instanceof Error ? error.stack ?? error.message : String(error) };
});
