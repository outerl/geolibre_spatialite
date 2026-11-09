# True Upstream C SpatiaLite WebAssembly Architecture & Pipeline

This repository implements a full building pipeline and runtime wiring for **true upstream C `libspatialite`** (linked with **GEOS**, **PROJ**, and **SQLite**) compiled to WebAssembly.

---

## 1. Upstream Components & Pinned Releases

The native compilation pipeline pulls verified source archives directly from official upstream distributions:

| Library | Version | Upstream Provider | License | Key Features |
| :--- | :--- | :--- | :--- | :--- |
| **SQLite** | `3.46.1` | SQLite Consortium (`sqlite.org`) | Public Domain | R*Tree, FTS5, Column Metadata, JSON1 |
| **GEOS** | `3.12.2` | OSGeo (`libgeos.org`) | LGPL-2.1 | True 2D topology, buffers, intersections, spatial predicates |
| **PROJ** | `9.4.1` | OSGeo (`proj.org`) | MIT / X11 | Ellipsoidal geodesics, datum shifts, coordinate reprojectors |
| **libspatialite** | `5.1.0` | Alessandro Furieri (`gaia-gis.it`) | LGPL-2.1+ | OGC spatial SQL suite, `VirtualSpatialIndex`, SpatiaLite BLOB codec |

---

## 2. Licensing Compliance & GPL Isolation

Upstream `libspatialite` can optionally link `librttopo` (which is strictly GPL-2.0+). To ensure the compiled WebAssembly binary remains strictly under **LGPL-2.1-or-later** and does not infect downstream consumer plugins (such as MIT-licensed **AequilibraE**), the compilation flags strictly mandate:

```bash
--disable-rttopo --disable-freexl --disable-libxml2 --disable-gcp
```

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for full licensing documentation.

---

## 3. Build Pipeline Components

The build pipeline files are located in `build-wasm/`:

- **[`build-wasm/spatialite_bridge.c`](../build-wasm/spatialite_bridge.c)**:
  Exposes the C bridge between SQLite, SpatiaLite, and JavaScript:
  - `spatialite_wasm_init(sqlite3 *db)` initializes the SpatiaLite connection cache and registers all spatial functions.
  - `spatialite_wasm_cleanup(void *cache)` releases the connection state on close.
  - `spatialite_wasm_version()` reports the upstream SpatiaLite version (e.g. `5.1.0`).
  - `spatialite_wasm_has_geos()` and `spatialite_wasm_has_proj()` verify linkage.
- **[`build-wasm/Dockerfile`](../build-wasm/Dockerfile)**:
  Multi-stage Dockerfile based on `emscripten/emsdk:3.1.64` that builds static PROJ, static GEOS, and static SpatiaLite, then links them with SQLite amalgamation into `spatialite.wasm` and `spatialite.js`.
- **[`build-wasm/build-wasm.sh`](../build-wasm/build-wasm.sh)**:
  Command-line build runner for local execution via Docker or local `emcc`.
- **[`.github/workflows/build-wasm.yml`](../.github/workflows/build-wasm.yml)**:
  Automated GitHub Actions CI workflow that compiles the WebAssembly binary on `ubuntu-latest`, verifies it via Node.js smoke tests (`SELECT spatialite_version()`), and publishes build artifacts.

---

## 4. Runtime Wiring in `geolibre-spatialite`

The plugin is architected with a dual-engine adapter that seamlessly supports both native C WebAssembly and inlined SQLite WASM:

1. **[`src/spatialite/c-wasm-adapter.ts`](../src/spatialite/c-wasm-adapter.ts)**:
   A strongly-typed TypeScript C-API bridge that manages the Emscripten memory heap, binds SQL parameters (`bind_text`, `bind_blob`, `bind_double`, `bind_null`), steps statements, mounts virtual files into MEMFS, and exposes the `IDatabaseBackend` contract.
2. **[`src/spatialite/sqlite-engine.ts`](../src/spatialite/sqlite-engine.ts)**:
   Supports pluggable native factory registration via `registerNativeSpatialiteFactory()`. When native WASM is initialized, it instantiates `NativeCDatabase`, providing true C SpatiaLite execution.
3. **[`src/api/service.ts`](../src/api/service.ts) & [`src/api/types.ts`](../src/api/types.ts)**:
   Exposes engine introspection to other plugins:
   ```typescript
   const spatialite = window.geolibreSpatialite;
   console.log(spatialite.getEngineType()); // "native-c-wasm"
   console.log(spatialite.getSpatialiteVersion()); // "5.1.0"
   ```
4. **GeoLibre UI**:
   The right-panel database explorer dynamically displays the active engine in the header:
   `SpatiaLite • Native C WASM (v5.1.0)`.
