# Inter-plugin integration

Production builds expose upstream C SpatiaLite with GEOS, PROJ, and native spatial-index/constraint triggers. Read the map-codec and memory limits in the README. Existing AequilibraE project editing still requires validation against that project's complete trigger set.

## Open and query

```ts
import type { GeoLibreSpatialiteService } from "geolibre-spatialite";

const spatialite: GeoLibreSpatialiteService | undefined = window.geolibreSpatialite;
if (!spatialite?.isReady()) throw new Error("Enable the SpatiaLite plugin first.");
const db = await spatialite.openDatabase(databaseBytes);
try {
  const rows = db.query("SELECT name FROM places WHERE id = ?", [placeId]);
  console.log(rows);
} finally {
  db.close();
}
```

The plugin dispatches `geolibre:spatialite:ready` after successful activation. `isReady()` indicates that the API is available; the WASM runtime initializes on the first open. The host service registry is optional. Disabling the plugin removes its global service registration and closes its panel-owned connection. Connections explicitly opened by consumers belong to those consumers and must be closed by them.

`getEngineType()` reports `native-c-wasm` in production. `getSpatialiteVersion()` reports the loaded upstream version after the first successful open, or `not initialized` before loading. A failed initialization can be retried; it does not silently switch engines.

## Parameterized writes and transactions

```ts
const db = await spatialite.createDatabase();
db.exec("CREATE TABLE places(id INTEGER PRIMARY KEY, name TEXT, geometry BLOB)");
db.transaction(() => {
  db.exec("INSERT INTO places VALUES (?, ?, GeomFromText(?, 4326))", [
    1, "O'Brien", "POINT(153 -27.5)",
  ]);
});
const updatedBytes = db.export(); // save this copy through your application's file workflow
db.close();
```

Use bound parameters for values. Quote dynamic identifiers by doubling embedded double quotes and surrounding the name with double quotes. Do not interpolate user-entered values into SQL. Nested synchronous transactions use SQLite savepoints. Returning a Promise is rejected; never use an async transaction callback.

Use bigint for integers outside JavaScript's safe range. Native queries return such values as bigint, while map attributes use decimal strings. Finish prepared statements and transactions before exporting. Export serializes the live database through SQLite, including committed WAL pages, and returns a standalone file in rollback-journal format.

## Load only a selected spatial table

```ts
const abort = new AbortController();
const layer = await db.getTableGeoJsonAsync("places", "geometry", undefined, {
  propertyColumns: ["id", "name"], // omit for all attributes, or [] for geometry only
  signal: abort.signal,
  onProgress: (count) => console.log(`${count} features loaded`),
});
// abort.abort() cancels loading. No partial layer is returned.
```

There is no default feature limit. Pass a positive integer as the third argument to request a subset (0 returns no rows). Both the synchronous `getTableGeoJson()` and the asynchronous variant return WGS84 GeoJSON, resolving projected SRIDs through `spatial_ref_sys.proj4text` or built-in Proj4js definitions. Unknown SRIDs and unsupported BLOB encodings throw an error. Non-spatial BLOB attributes become descriptive strings.

An active asynchronous cursor blocks wrapper SQL, writes, export, and close operations until it finishes or cancellation settles. Do not bypass that guard through `rawDb`. Progress callbacks should update UI or request cancellation, not query the connection. Schema metadata is cached by SQLite schema version; call `refreshSpatialIndex()` if changing geometry metadata through the low-level handle. Native spatial indexes are managed by SpatiaLite. The old exact-equality TEMP view is only a compatibility helper for the source-test fallback and is never installed over a native index.

## Read a large file without importing it into memory

`openFile()` is a separate asynchronous read-only API for a `Blob` or `File`. It mounts the original object with native Emscripten WORKERFS in a dedicated worker, opens SQLite with `SQLITE_OPEN_READONLY`, disables mmap, and uses a 32 MiB page cache by default (configurable from 1–512 MiB). The worker is bundled inline, so it can run offline. The host Content Security Policy must allow `worker-src blob:`. Older native artifacts without the WORKERFS and `sqlite3_open_v2` capability metadata are rejected.

```ts
const paged = await spatialite.openFile(file, { cacheMiB: 64 });
try {
  const rows = await paged.query("SELECT id, name FROM places WHERE category = ?", ["park"], {
    maxRows: 10_000,
    maxBytes: 4 * 1024 * 1024,
  });
  for await (const batch of paged.streamQuery("SELECT id, name FROM places", [], { batchSize: 256 })) {
    await writeBatch(batch); // backpressure: the next query batch starts after this completes
  }
  for await (const features of paged.streamTableGeoJson("places", "geometry", undefined, {
    propertyColumns: ["id", "name"],
    bbox: [-123, 36, -121, 38],
    filters: [{ column: "category", operator: "=", value: "park" }],
    requireSpatialIndex: true,
    batchSize: 256,
  })) {
    await addFeatures(features);
  }
} finally {
  await paged.close();
}
```

Materialized `query()` results default to a maximum of 10,000 rows and 4 MiB, and throw if either bound is exceeded. Pull streams default to 256 rows per batch and continue until exhausted unless `maxRows` is set. The per-batch byte bound defaults to 4 MiB and accepts at most 16 MiB; rows larger than 16 MiB are rejected. These bounds cover returned row payload, not SQLite sorting/work memory or total WASM memory.

The query surface only prepares one read-only SQL statement. It does not expose transactions, writes, export, or synchronous reads. Use an `AbortSignal` to cancel a stream. Cancellation terminates that worker and closes the entire paged connection, rejecting all outstanding work; open the file again to continue. Early iterator return finalizes only that cursor. `getStats()` reports configured cache size, timing, and requested Blob slice bytes; requested slices are not a measurement of physical disk I/O.

The file must be a consistent, standalone snapshot. WAL-format headers are rejected because the API receives no WAL/SHM sidecars. A WAL checkpoint that leaves the database in WAL journal mode is not enough; after checkpointing, switch to DELETE journal mode while no writer is active, or pass a standalone rollback-format snapshot such as the result of the byte-backed connection's `export()`. The API cannot detect a rollback journal that is not included in the Blob, so do not open a file that may need sidecar recovery.

Feature `bbox` coordinates are in the geometry's source CRS. The filter uses envelope overlap, not exact geometry intersection, then removes RTree float-rounding false positives by checking each geometry BLOB's exact envelope. A valid SpatiaLite RTree is selected explicitly when metadata, the conventional `idx_<table>_<geometry>` RTree, and a usable rowid are present. Otherwise bbox reads scan rows; `requireSpatialIndex` makes absence or structural mismatch an error. Index content consistency is the producer's responsibility. Output GeoJSON geometry remains WGS84, and large integer properties remain decimal strings.

The byte-backed API continues to retain its database in WASM memory. The paged API removes that full-file copy, but SQLite cache, query work, one large geometry, and a materialized feature collection can still consume substantial memory. For wide tables, select only the map properties and prefer feature batches when the consumer can process them incrementally.

After building with native artifacts, `npm run test:native:browser` runs the deterministic Chromium worker fixture. It reports runtime initialization, file open, selective reads, full-layer conversion, feature counts, cache size, and requested slice bytes for its generated fixture. These smoke timings are not a benchmark on an application dataset and do not claim a native speedup.

## Licensing for consumer plugins (LGPL-2.1 Section 6)

`geolibre-spatialite` is distributed under **LGPL-2.1-or-later**. 

Consumer plugins (such as the **AequilibraE** GeoLibre plugin, licensed under MIT) interact with `geolibre-spatialite` via runtime dynamic dispatch (`window.geolibreSpatialite` or `app.getService('spatialite')`). Under Section 5 and Section 6 of LGPL 2.1:
- A consumer plugin that calls into `geolibre-spatialite` at runtime constitutes a **"work that uses the Library"**.
- The consumer plugin **does not become a derivative work** and is **not infected by copyleft**. It may remain under MIT or any other license of its author's choice.
- Users have the right under LGPL 2.1 to replace, modify, and rebuild `geolibre-spatialite` independently of the consumer plugin using the source inputs included in the plugin package.
