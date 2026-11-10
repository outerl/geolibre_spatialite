# GeoLibre SpatiaLite

An offline GeoLibre plugin for opening SQLite/SpatiaLite files, running spatial SQL, and adding selected tables to the map.

Production builds bundle upstream **libspatialite 5.1.0**, **GEOS 3.12.2**, **PROJ 9.4.1**, and **SQLite 3.46.1**, compiled with Emscripten 3.1.64. The WebAssembly and PROJ database are embedded in the JavaScript module: the installed plugin makes no runtime requests for those resources.

## Build and validate

Node.js 22.18+ (22.x) or 24+, plus Docker with Buildx, are required to build from scratch:

```sh
npm ci
npm run build:wasm
npm run check
npm run package:geolibre
npm run test:package
```

`build:wasm` exports the native runtime, build metadata, dependency licenses, and upstream source archives into `src/wasm/`. Alternatively, download the native artifact produced by CI into that directory. Generated artifacts are not committed.

Production library/plugin builds and packaging fail if those inputs are absent, incomplete, or fail their checksums. They cannot silently produce a sql.js-only release. CI builds and tests the native module before the platform test matrix and packaging jobs.

For source development without Docker, `npm run check:source` runs lint, TypeScript, source regression tests, and development-server tests. These checks do not certify a native release. Source tests use the existing SQLite fallback and exercise the C adapter against real SQLite WASM; `npm run test:native` exercises the actual compiled SpatiaLite module after a production build.

## Linting

Run the linter with Node.js and the installed dependencies; Docker and native WASM artifacts are not required:

```sh
npm ci
npm run lint
```

ESLint checks TypeScript and JavaScript, including tests, build configuration, and Node.js scripts. TypeScript uses the strict type-aware rules in `eslint.config.js`. Errors and warnings fail the check; generated bundles, coverage, dependencies, and `src/wasm/` are excluded.

Use `npm run lint:fix` to apply automatic fixes, then review the changes and resolve any remaining diagnostics. `npm run check:source` and `npm run check` also run linting.

CI starts with a dedicated **Lint** job. It must pass before native compilation, the platform test matrix, and packaging can run. The standalone native-build workflow also runs linting as part of its source checks.

## Features

- Open `.sqlite`, `.sqlite3`, `.db`, and `.spatialite` files. Export an independent SQLite snapshot, including committed WAL changes.
- Execute upstream SpatiaLite spatial SQL, GEOS operations, native spatial-index queries, and PROJ transformations using the embedded projection database. Optional RTTOPO, FreeXL, libxml2, minizip, GCP, and iconv support is disabled.
- Inspect metadata without loading feature tables. Only **Add to Map** on a selected table converts its features.
- Load all features with progress and cancellation. Cursor streaming avoids retaining an intermediate result table; callers can select only the attributes needed by the map.
- Preserve signed 64-bit integers: safe integers are numbers, larger integers are bigint. Mapped attributes outside the safe range become decimal strings so GeoJSON stays serializable.
- Run a bounded SQL-console preview, including CTEs and multiple statements; bind values for application queries and writes.
- Use nested synchronous transactions and the typed `window.geolibreSpatialite` service from other plugins.
- Open large local database files through the separate asynchronous, read-only `openFile(Blob)` worker API. WORKERFS reads file slices lazily; existing byte-backed connections remain available for editing and export.

## Install

In GeoLibre's plugin manager, choose `geolibre-plugin/dist/geolibre-spatialite-0.1.1.zip`, then enable the plugin. The host must support right panels, toolbar menus, and GeoJSON layers. The ZIP includes runtime code, styles, licenses, build inputs, and corresponding upstream source archives.

`npm run serve:geolibre` serves an already built plugin at `http://127.0.0.1:4174/plugin.json`.

The package test validates archive structure, CRCs and SHA-256, then imports the actual packaged entry and exercises native SpatiaLite, GEOS, and PROJ with networking disabled. Installation in the intended GeoLibre Web/Desktop release remains a separate integration check. See [release notes](docs/geolibre-plugin-store-submission.md).

## Large-file read API

Use `openFile()` for a consistent, closed SQLite file when copying the complete database into JavaScript and WASM memory is too expensive. It requires native SpatiaLite artifacts with WORKERFS support and browser Web Workers. The worker is inlined into the offline library/plugin bundle; deployments using a Content Security Policy must allow `worker-src blob:`.

```ts
const paged = await spatialite.openFile(fileBlob, { cacheMiB: 32 });
try {
  const page = await paged.query(
    "SELECT id, name FROM places WHERE category = ?",
    ["park"],
    { maxRows: 10_000, maxBytes: 4 * 1024 * 1024 },
  );
  for await (const rows of paged.streamQuery("SELECT id, name FROM places", [], { batchSize: 256 })) {
    consume(rows); // the next batch is read only when the loop asks for it
  }
  const features = await paged.getTableGeoJsonAsync("places", "geometry", undefined, {
    propertyColumns: ["id", "name"],
    bbox: [-123, 36, -121, 38], // source CRS of the layer
    filters: [{ column: "category", operator: "=", value: "park" }],
    requireSpatialIndex: true,
    batchSize: 256,
  });
} finally {
  await paged.close();
}
```

`query()` is a one-statement, read-only query. It defaults to at most 10,000 rows and 4 MiB of row payload, with limits up to 10,000 rows and 16 MiB. If more rows or bytes are available it throws and directs callers to `streamQuery()`. Streaming reads one pull batch at a time; `batchSize` defaults to 256, and an optional `maxRows` caps the complete stream. One row cannot exceed 16 MiB. Result payload bounds do not bound SQLite sorts, one `sqlite3_step()`, conversion scratch, or total WASM memory.

The SQLite page cache defaults to 32 MiB and accepts 1–512 MiB. `getStats()` reports the file size, configured cache, open timing phases, and **requested Blob slice bytes/count**. Slice totals measure JavaScript read requests; they are not physical disk I/O or total process memory. The cache setting is not a limit on total WASM, query, sort, geometry, or returned-result memory. A complete GeoJSON collection still retains every returned feature; use `streamTableGeoJson()` when consumers can process batches.

`AbortSignal` cancellation terminates the dedicated worker to interrupt SQLite even if one step is busy. That closes the entire read-only connection and rejects all outstanding operations; reopen the file to continue. Returning early from `streamQuery()` or `streamTableGeoJson()` finalizes its statement while keeping the connection usable. `close()` finalizes cursors, unmounts WORKERFS, closes SQLite, and terminates the worker.

Paged reads reject WAL-format database headers because the API receives only one Blob and cannot load WAL/SHM sidecars. Give it a standalone rollback-format snapshot from a closed, checkpointed database; checkpointing while the header remains in WAL mode is not sufficient. A checkpoint followed by switching `journal_mode` to `DELETE` while no writers are active, or a standalone copy made with `export()`, produces the appropriate format. A lone Blob cannot prove whether an unseen rollback-journal sidecar existed, so callers must provide a consistent snapshot. The paged connection never writes to or normalizes the source file.

Feature `bbox` coordinates are in the layer's source CRS. Reads select geometries whose decoded **envelopes overlap** the box; this is not an exact geometry/box intersection test. The RTree is used only when the geometry metadata, rowid access, virtual-table SQL, and expected RTree columns are present. RTree candidates are checked against the exact BLOB envelope to remove float32 boundary false positives. If the index is unavailable or structurally stale, bbox reads scan rows; `requireSpatialIndex: true` rejects instead. The reader relies on a maintained SpatiaLite index's contents and does not perform a full index consistency scan for every query. Returned geometries are still transformed to WGS84, and large integer attributes remain decimal strings in GeoJSON.

The native browser smoke runs with `npm run test:native:browser` after `npm run build`. It creates a deterministic 4 MiB fixture and checks result parity, file immutability, batching, and cleanup; its timings are smoke diagnostics, not a large-file benchmark.

To measure a real local database, run `npm run benchmark:paged -- path/to/database.sqlite [table]` after the native build and library build. It opens the original file in Chromium through a file input and reports runtime/open/selective/full-layer phases, counts, and requested Blob slice bytes. `--compare-memory` opts into a separate whole-file memory baseline. See [performance notes](docs/performance.md) for options and interpretation; earlier sql.js measurements remain historical and do not establish a native speedup.

## Scope and limits

- The map codec currently reads ordinary, uncompressed 2D Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon, and GeometryCollection BLOBs. Native spatial SQL supports additional encodings; adding such results directly to the map can still fail explicitly.
- The existing byte-backed connection still copies the database into WASM memory. The separate paged API avoids that whole-file import, but cache, SQL work, a single geometry, and full GeoJSON output can still exceed browser memory. A single very large geometry can delay cancellation.
- Export returns a standalone snapshot in rollback-journal format; it never overwrites the input. Finish transactions and prepared statements before exporting.
- `query()` and parameterized writes accept one SQL statement. Unbound `exec()` accepts multiple statements. Transaction callbacks must be synchronous.
- Native spatial-index/constraint triggers are available. The complete trigger suite of a particular AequilibraE project still needs application-level compatibility testing before claiming support for its editing workflows.
- The earlier [performance figures](docs/performance.md) measured the previous sql.js-based implementation and are not native-runtime benchmarks.

See [native build details](docs/c-wasm-compilation.md) and [inter-plugin integration](docs/inter-plugin-guide.md).

## License

LGPL-2.1-or-later; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The native build excludes RTTOPO. Release ZIPs contain dependency notices and corresponding source archives under `sources/`, plus plugin sources and build inputs under `source/`.
