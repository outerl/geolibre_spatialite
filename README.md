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

## Features

- Open `.sqlite`, `.sqlite3`, `.db`, and `.spatialite` files. Export an independent SQLite snapshot, including committed WAL changes.
- Execute upstream SpatiaLite spatial SQL, GEOS operations, native spatial-index queries, and PROJ transformations using the embedded projection database. Optional RTTOPO, FreeXL, libxml2, minizip, GCP, and iconv support is disabled.
- Inspect metadata without loading feature tables. Only **Add to Map** on a selected table converts its features.
- Load all features with progress and cancellation. Cursor streaming avoids retaining an intermediate result table; callers can select only the attributes needed by the map.
- Preserve signed 64-bit integers: safe integers are numbers, larger integers are bigint. Mapped attributes outside the safe range become decimal strings so GeoJSON stays serializable.
- Run a bounded SQL-console preview, including CTEs and multiple statements; bind values for application queries and writes.
- Use nested synchronous transactions and the typed `window.geolibreSpatialite` service from other plugins.

## Install

In GeoLibre's plugin manager, choose `geolibre-plugin/dist/geolibre-spatialite-0.1.0.zip`, then enable the plugin. The host must support right panels, toolbar menus, and GeoJSON layers. The ZIP includes runtime code, styles, licenses, build inputs, and corresponding upstream source archives.

`npm run serve:geolibre` serves an already built plugin at `http://127.0.0.1:4174/plugin.json`.

The package test validates archive structure, CRCs and SHA-256, then imports the actual packaged entry and exercises native SpatiaLite, GEOS, and PROJ with networking disabled. Installation in the intended GeoLibre Web/Desktop release remains a separate integration check. See [release notes](docs/geolibre-plugin-store-submission.md).

## Scope and limits

- The map codec currently reads ordinary, uncompressed 2D Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon, and GeometryCollection BLOBs. Native spatial SQL supports additional encodings; adding such results directly to the map can still fail explicitly.
- The entire database and final GeoJSON reside in memory. This is not a paged, disk-backed engine; very large files/layers can exceed browser memory. A single very large geometry can delay cancellation.
- Export returns a standalone snapshot in rollback-journal format; it never overwrites the input. Finish transactions and prepared statements before exporting.
- `query()` and parameterized writes accept one SQL statement. Unbound `exec()` accepts multiple statements. Transaction callbacks must be synchronous.
- Native spatial-index/constraint triggers are available. The complete trigger suite of a particular AequilibraE project still needs application-level compatibility testing before claiming support for its editing workflows.
- The earlier [performance figures](docs/performance.md) measured the previous sql.js-based implementation and are not native-runtime benchmarks.

See [native build details](docs/c-wasm-compilation.md) and [inter-plugin integration](docs/inter-plugin-guide.md).

## License

LGPL-2.1-or-later; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The native build excludes RTTOPO. Release ZIPs contain dependency notices and corresponding source archives under `sources/`, plus plugin sources and build inputs under `source/`.
