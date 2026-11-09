# GeoLibre SpatiaLite

An offline GeoLibre plugin for opening SQLite/SpatiaLite files, exploring spatial tables, running SQL, and adding selected layers to the map.

Version 0.1.0 uses SQLite WebAssembly (sql.js) with TypeScript implementations of a documented subset of SpatiaLite functions. It does not bundle C libspatialite or GEOS.

## Features

- Open `.sqlite`, `.sqlite3`, `.db`, and `.spatialite` files and export an edited copy.
- Inspect spatial metadata without loading feature tables. Only the table selected for **Add to Map** is converted.
- Load all features by default, with progress and cancellation. Large layers use a streaming SQL cursor and periodically yield to the browser.
- Read/write ordinary uncompressed 2D Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon, and GeometryCollection BLOBs and WKB.
- Transform mapped coordinates to WGS84 using Proj4js and definitions from `spatial_ref_sys`; EPSG:3857 is also built in. Unknown projections produce an error.
- Use the Spatial SQL console with a bounded 100-row preview, including CTEs and multiple statements.
- Access the typed `window.geolibreSpatialite` service from another plugin. Optional host service registration uses the name `spatialite`.

## Supported spatial SQL

- `StartPoint`, `EndPoint`, `PointN`, `NumPoints`, `SetStartPoint`, `SetEndPoint`, and their `ST_` aliases.
- `MakePoint` / `ST_Point`, `GeomFromWKB`, `GeomFromText`, `AsBinary`, `AsText`, `AsGeoJSON`, `X`, `Y`, and `SRID`, with corresponding `ST_` aliases.
- `ST_Length` / `GLength`: one argument returns planar length in CRS units; a second ellipsoid flag requests metres for EPSG:4326.
- `ST_Distance` / `Distance`: point-to-point distance in CRS units; a third ellipsoid flag requests metres for EPSG:4326.
- `GeodesicLength`: WGS84 length in metres for EPSG:4326 lines.

Constructors without an explicit SRID use SRID 0. Invalid or unsupported SQL geometry inputs return NULL. Mapping an unsupported non-NULL geometry fails explicitly instead of dropping it silently.

## Version 0.1.0 limits

- Compressed, TinyPoint, Z/M, empty WKT, GeoPackage geometry BLOBs, GEOS predicates/overlays, and the full SpatiaLite function catalogue are not supported.
- SpatiaLite virtual-table modules, including `VirtualSpatialIndex` and `VirtualKNN`, are not linked. `CheckSpatialIndex()` reports 0. Opening does not replace real spatial indexes or modify database schemas.
- `refreshSpatialIndex()` is an explicit compatibility helper for synthetic schemas without a real SpatialIndex. Its TEMP view supports exact BLOB equality for endpoint lookups, not bounding-box searches. It is never exported into the database.
- SQLite triggers execute, but arbitrary AequilibraE/SpatiaLite editing is not guaranteed: native constraint/index triggers may require missing functions or modules. The trigger tests cover a small, synthetic schema. Validate the actual database's complete trigger set before integrating editing.
- The file is still loaded into memory. Row streaming reduces conversion overhead; it is not a disk-backed or paged database engine. Very large databases or layers can exceed browser memory, and opening the SQLite file itself is synchronous. A single exceptionally large geometry can also delay cancellation.
- `query()` executes a single statement; `exec()` accepts multiple unbound statements. Transactions must use synchronous callbacks. File export creates a downloadable copy; it does not overwrite the input file.

See [performance measurements](docs/performance.md) and [inter-plugin integration](docs/inter-plugin-guide.md).

## Install a local ZIP

```sh
npm ci
npm run check
npm run package:geolibre
npm run test:package
```

In GeoLibre's plugin manager, choose the local ZIP at `geolibre-plugin/dist/geolibre-spatialite-0.1.0.zip`, then enable the plugin. The host must support right panels, toolbar menus, and GeoJSON layers. The package includes the runtime, styles, license notices, and corresponding source/build inputs.

The package test extracts and validates the ZIP, checks entry CRCs and its SHA-256, then loads its JavaScript and WebAssembly and exercises the service with networking disabled. Host integration tests use a mock GeoLibre API; a manual installation check in the intended GeoLibre release remains necessary before publishing.

This project has not established a plugin-store listing. See [release and submission notes](docs/geolibre-plugin-store-submission.md).

## Development

Use Node.js 22.18+ (22.x) or 24+. `npm run serve:geolibre` serves an already built plugin at `http://127.0.0.1:4174/plugin.json`.

- `npm run check`: lint, TypeScript, regression tests with coverage, development-server tests, and both builds.
- `npm run package:geolibre`: deterministic ZIP and SHA-256 metadata.
- `npm run test:package`: ZIP validation and offline runtime smoke test.
- `npm run benchmark -- <database.sqlite> [table=links] [source-root] [async]`: read-only load benchmark. File I/O and map rendering are outside the timed conversion.

The core source is under `src/spatialite/`, the public API under `src/api/`, and the GeoLibre UI under `src/geolibre/`.

## License

LGPL-2.1-or-later. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

