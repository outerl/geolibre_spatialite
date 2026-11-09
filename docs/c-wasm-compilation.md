# Future native libspatialite runtime

Version 0.1.0 ships sql.js plus TypeScript geometry/SQL implementations. There is no compiled C libspatialite runtime or native spatial-index module in this project.

The earlier draft Docker recipe was a concept, not a working runtime: exporting a handful of SQLite C functions does not produce the sql.js JavaScript database API, register per-connection SpatiaLite state, package projection databases, or provide compatible memory and function bindings. It has been removed to avoid implying that the recipe can replace the shipped engine.

A future native runtime needs a reproducible, pinned Emscripten build of SQLite, libspatialite, GEOS, and PROJ; the complete JavaScript connection/statement/transaction bridge; per-connection initialization/cleanup; projection-data packaging; browser memory and concurrency design; all dependency notices and corresponding source; and tests against original database files and unmodified native trigger suites.

When compiling upstream `libspatialite` for WebAssembly, `--disable-rttopo` must be used to preserve LGPL-2.1 licensing and prevent `librttopo`'s strict GPL-2.0+ copyleft from contaminating the binary. See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for details.

Until that work exists, use the compatibility scope in the README. In particular, full AequilibraE project editing, VirtualSpatialIndex, VirtualKNN, GEOS operations, and 3D/compressed geometry support remain outside the current runtime.
