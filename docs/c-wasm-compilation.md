# Native SpatiaLite build

`npm run build:wasm` runs Docker Buildx with `build-wasm/Dockerfile` and exports the artifact stage directly into `src/wasm/`. `bash build-wasm/build-wasm.sh` delegates to the same command. There is no implicit local-emcc fallback or container extraction step.

Pinned components: Emscripten 3.1.64, SQLite 3.46.1, zlib 1.3.1, PROJ 9.4.1, GEOS 3.12.2, and libspatialite 5.1.0.

1. Build a static target SQLite library, its headers, and pkg-config metadata. A separate host sqlite3 executable generates PROJ's database.
2. Cross-compile zlib, PROJ, and GEOS; configure SpatiaLite against those target libraries. Disable RTTOPO, FreeXL, libxml2, minizip, GCP, and iconv.
3. Compile the C connection bridge, then link with em++ and exception handling for the C++ dependencies. `WASM_BIGINT=1` is required by the adapter's i64 ABI.
4. Generate a self-contained ES module with `SINGLE_FILE=1`. Embed `proj.db` at `/opt/wasm/share/proj/proj.db`, matching PROJ's installed search path. The module performs no runtime resource downloads.
5. Export `spatialite.js`, `proj.db`, component license texts, corresponding source archives, and `build-info.json` at the artifact root. The manifest records file hashes and ABI/runtime options.

The Vite native-runtime plugin verifies those artifacts and imports the module into both production bundles. Missing or mismatched artifacts fail the build. The source-unit-test configuration explicitly selects the fallback; it cannot be used to package a production release.

`npm run check` requires the native artifacts, runs source checks, builds both bundles, and executes `npm run test:native`. Native integration checks real SQL execution, parameter rebinding, i64 values, GEOS predicates, PROJ transformations, geometry-column/index triggers, allocation cleanup, and WAL export/reopen. The ZIP smoke test separately checks native execution through its actual entry point with fetch disabled.

CI invokes the reusable native-build workflow first. Only a successful compiled-engine test uploads the artifact; all test and packaging jobs consume that same artifact. JavaScript mocks or version strings cannot substitute for the native gate.

For source changes, the ZIP includes upstream archives in `sources/` and in `source/src/wasm/sources/`. Docker reuses archives present in `src/wasm/sources/` before downloading missing pinned distributions. Edit/repack the relevant archive, change the bridge or build flags as needed, rebuild, and run the full checks. Do not edit `spatialite.js` independently of its generated build metadata.

The plugin still loads databases fully into memory. The C runtime does not provide paged file I/O, and the JavaScript map codec remains limited to ordinary uncompressed 2D geometries.
