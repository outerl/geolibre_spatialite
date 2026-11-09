# Native C SpatiaLite WebAssembly Build Pipeline

This directory contains the automated compilation pipeline that builds **true upstream C `libspatialite`** (statically linked with **GEOS**, **PROJ**, and **SQLite**) into an optimized WebAssembly module (`spatialite.wasm` + ES6 module loader `spatialite.js`).

---

## 1. Upstream Components & Pinned Versions

| Component | Upstream Source | Version | License | Role |
| :--- | :--- | :--- | :--- | :--- |
| **SQLite** | [sqlite.org](https://www.sqlite.org) | 3.46.1 | Public Domain | R*Tree, FTS5, Column Metadata, Core SQL Engine |
| **GEOS** | [libgeos.org](https://libgeos.org) | 3.12.2 | LGPL-2.1 | Topology, Buffers, Intersections, Validity, Predicates |
| **PROJ** | [proj.org](https://proj.org) | 9.4.1 | MIT / X11 | Cartographic datum transformations & projections |
| **libspatialite** | [gaia-gis.it](https://www.gaia-gis.it) | 5.1.0 | LGPL-2.1+ | Spatial SQL functions, BLOB codecs, VirtualSpatialIndex |

---

## 2. Licensing Boundary & Isolation Policy

`libspatialite` can optionally link `librttopo` (which is strictly GPL-2.0+). To prevent GPL copyleft contamination and keep the compiled WebAssembly binary compliant with **LGPL-2.1-or-later**, the configure step explicitly mandates:

```bash
--disable-rttopo --disable-freexl --disable-libxml2 --disable-gcp
```

This ensures downstream plugins (such as **AequilibraE**, which is licensed under MIT) can link dynamically to `geolibre-spatialite` under LGPL Section 5/6 without copyleft restrictions.

---

## 3. Building with Docker (Recommended)

Ensure Docker Desktop or the Docker daemon is running:

```bash
# On Linux / macOS / WSL
bash build-wasm/build-wasm.sh

# Or directly with Docker:
docker build -t spatialite-wasm-builder -f build-wasm/Dockerfile .
docker create --name temp-builder spatialite-wasm-builder
docker cp temp-builder:/dist/spatialite.js ./src/wasm/
docker cp temp-builder:/dist/spatialite.wasm ./src/wasm/
docker rm temp-builder
```

The resulting `spatialite.js` and `spatialite.wasm` are written to `src/wasm/`.

---

## 4. Automated GitHub Actions CI Pipeline

The repository includes a dedicated workflow [`.github/workflows/build-wasm.yml`](../.github/workflows/build-wasm.yml) that:
1. Runs on an `ubuntu-latest` GitHub runner with full Docker and Emscripten capabilities.
2. Compiles upstream C SpatiaLite, GEOS, PROJ, and SQLite.
3. Runs a Node.js verification test to confirm `SELECT spatialite_version()` reports `5.1.0` and that GEOS functions (`ST_Buffer`, `ST_Intersects`) execute properly.
4. Uploads the build artifacts and attaches them to releases.

To trigger manually from the GitHub CLI:
```bash
gh workflow run build-wasm.yml
```
