# GeoLibre SpatiaLite Plugin Implementation Plan

## 1. Project Overview & Objectives

**Target Repository**: `D:\OL\src\geolibre_spatialite`  
**License**: LGPL-2.1 (compliant with SpatiaLite / GEOS ecosystem while permitting dynamic linking by MIT host/consumer plugins)  
**Target Environments**: GeoLibre Web (Chromium, Firefox, Safari) and GeoLibre Desktop (Tauri/WebView)

### Primary Objectives:
1. **SpatiaLite Spatial SQL Engine**: Provide a standalone, in-browser SQLite + SpatiaLite runtime with full support for SpatiaLite BLOB geometry encoding, spatial functions, and spatial index lookups.
2. **First-Class GeoLibre UI**: Offer a database manager right panel, spatial SQL console with interactive result previews, and one-click layer loading into the GeoLibre map.
3. **Inter-Plugin Service Provider for AequilibraE**: Expose a typed, stable service (`window.geolibreSpatialite` and `app.registerService`) allowing consumer plugins to run transactions and execute AequilibraE network triggers (`StartPoint`, `EndPoint`, `GeodesicLength`, `SetStartPoint`, `SpatialIndex`) seamlessly.
4. **Official Plugin Store Submission**: Deliver the exact manifest, metadata, packaging scripts, and contribution documentation required to list the plugin in the curated GeoLibre plugin registry (`plugins.geolibre.app/plugin-registry.json`).

---

## 2. Architecture & File Layout

```
D:\OL\src\geolibre_spatialite\
├── .github/
│   └── workflows/
│       └── ci.yml                      # Automated lint, test, build, packaging verification
├── build/
│   └── inline-sql-wasm-plugin.ts       # Inlines SQLite WASM binary for zero-network execution
├── docs/
│   ├── plan.md                         # Detailed technical implementation blueprint
│   ├── geolibre-plugin-store-submission.md # Submission guide for opengeos/GeoLibre registry
│   ├── inter-plugin-guide.md           # API guide for consumer plugins (e.g., AequilibraE)
│   └── c-wasm-compilation.md           # Full C libspatialite Emscripten compilation guide
├── geolibre-plugin/
│   ├── plugin.json                     # Official GeoLibre plugin manifest
│   └── dist/                           # Built bundle (index.js, style.css, ZIP archive)
├── scripts/
│   ├── package-geolibre-plugin.mjs     # Creates deterministic ZIP and SHA-256 digest
│   └── serve-geolibre-plugin.mjs       # Local testing dev server
├── src/
│   ├── api/
│   │   ├── types.ts                    # Public TypeScript contracts for inter-plugin usage
│   │   └── service.ts                  # Global service registration (window.geolibreSpatialite)
│   ├── geolibre/
│   │   ├── host-api.ts                 # GeoLibre host application interface definition
│   │   ├── plugin.css                  # UI styling (dark/light mode compatible)
│   │   ├── spatialite-controller.ts    # DOM controller for DB explorer & SQL console
│   │   └── layer-manager.ts            # Bridges SpatiaLite query results to GeoLibre map
│   ├── spatialite/
│   │   ├── blob-codec.ts               # Pure TS encoder/decoder for SpatiaLite BLOBs (Point, Line, Poly)
│   │   ├── geodesic.ts                 # Vincenty/Haversine geodesic length and distance math
│   │   ├── spatial-functions.ts        # Comprehensive SpatiaLite UDF suite for SQLite WASM
│   │   ├── spatial-index.ts            # SpatialIndex virtual table / R*Tree trigger emulation
│   │   └── database.ts                 # High-level database wrapper with transaction support
│   ├── geolibre.ts                     # Plugin entry point (GeoLibre plugin lifecycle)
│   └── index.ts                        # Library entry point (npm consumption)
├── tests/
│   ├── blob-codec.test.ts              # SpatiaLite BLOB binary tests
│   ├── geodesic.test.ts                # Geodesic calculation tests
│   ├── spatial-functions.test.ts       # Spatial SQL UDF tests (StartPoint, GeodesicLength, etc.)
│   ├── aequilibrae-triggers.test.ts    # Integration test executing real AequilibraE SQL triggers!
│   ├── database.test.ts                # Database wrapper & transaction tests
│   └── geolibre-plugin.test.ts         # Plugin lifecycle and UI controller tests
├── eslint.config.js
├── LICENSE
├── package.json
├── README.md
├── tsconfig.build.json
├── tsconfig.json
├── vite.config.ts
├── vite.geolibre.config.ts
└── vitest.config.ts
```

---

## 3. Subagent Work Breakdown & Execution Strategy

Tasks are partitioned across specialized subagents:

### Agent 1: Project Scaffolding & Build System
- Initialize `package.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`.
- Set up Vite configs (`vite.config.ts` and `vite.geolibre.config.ts`) with `inline-sql-wasm-plugin.ts`.
- Create `scripts/package-geolibre-plugin.mjs` and `geolibre-plugin/plugin.json`.
- Create `.github/workflows/ci.yml`.

### Agent 2: Core SpatiaLite Engine & AequilibraE Trigger Support
- Implement `blob-codec.ts` (SpatiaLite binary specification: Point, LineString, Polygon, MultiPolygon, MBR, SRID, WKB).
- Implement `geodesic.ts` (Geodesic distance, length calculations for EPSG:4326).
- Implement `spatial-functions.ts` (Registering UDFs into SQLite WASM: `StartPoint`, `EndPoint`, `SetStartPoint`, `SetEndPoint`, `GeodesicLength`, `GeomFromWKB`, `ST_AsBinary`, `ST_AsText`, etc.).
- Implement `spatial-index.ts` (Emulating / integrating `SpatialIndex` table for `search_frame` point queries).
- Implement `database.ts` (Connection management, transactions, table metadata, querying).
- Write comprehensive test suites including a dedicated integration test for AequilibraE network triggers (`BEFORE/AFTER INSERT/UPDATE/DELETE`).

### Agent 3: GeoLibre UI Controller & Inter-Plugin Service
- Implement `host-api.ts` and `src/api/types.ts`, `src/api/service.ts`.
- Implement `spatialite-controller.ts` (Panel UI: file loading, table viewer, SQL console, error reporting).
- Implement `layer-manager.ts` (Map rendering, GeoJSON conversion, selection).
- Implement `src/geolibre/plugin.css`.
- Implement `src/geolibre.ts` (Lifecycle hooks: activate, menu, panel registration).

### Agent 4: Documentation & GeoLibre Store Contribution Deliverables
- Write `README.md` (Overview, features, store listing description).
- Write `LICENSE` (LGPL-2.1).
- Write `docs/geolibre-plugin-store-submission.md` (PR instructions for `opengeos/GeoLibre` and `plugin-registry.json`).
- Write `docs/inter-plugin-guide.md` (Step-by-step for AequilibraE plugin to call SpatiaLite).
- Write `docs/c-wasm-compilation.md` (Compiling upstream C SpatiaLite with Emscripten).
- Write `docs/plan.md`.

---

## 4. Verification & Quality Gates

1. **Static Analysis**: `npm run lint` and `npm run typecheck` with 0 warnings.
2. **Unit & Integration Tests**: `npm test` verifying 100% of spatial functions and real trigger execution.
3. **Packaging**: `npm run package:geolibre` producing a verified `.zip` and `.sha256.json`.
4. **Smoke Testing**: Verifying the packaged zip and manifest structure against GeoLibre plugin specifications.
