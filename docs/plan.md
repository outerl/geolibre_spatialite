# Native runtime release work

The production path now bundles upstream SpatiaLite/GEOS/PROJ/SQLite. It requires checksummed native artifacts; source-test fallback code cannot produce a release on its own.

Review issues addressed:

1. Native runtime selection and packaging: import the self-contained compiled module automatically, fail on missing/stale artifacts, and require native execution in the ZIP smoke test.
2. Cross-build prerequisites: target SQLite and pkg-config metadata precede PROJ; host sqlite3 generates proj.db; target zlib and explicit GEOS/static C++ linkage support SpatiaLite configuration.
3. Artifact layout: export the artifact-stage root directly to src/wasm; the local script uses Buildx export instead of creating an unusable scratch container.
4. SQL execution: execute every unbound statement, support bound exec results, and reject multiple statements in a parameterized query before executing it.
5. Integer fidelity: build with WASM_BIGINT=1, bind/read i64 without Number conversion, and retain safe integers as ordinary numbers.
6. Export: use SQLite serialization to include committed WAL pages; emit a standalone rollback-format image and reject unfinished transactions/statements.
7. Binding: reset and clear previous values, preserve empty BLOBs and embedded NUL text, and surface binding/range errors.
8. Lifetime management: free SQL buffers on completion/error/early exit, finalize statements on close, and clean up failed opening/initialization.
9. Projection resources: embed proj.db at the native search path and test a real EPSG transformation.

Validation paths:

- npm run check:source: source lint/type checks, regression tests including the adapter against real SQLite WASM, and development-server tests.
- npm run check: additionally requires native artifacts, builds both production bundles, and runs the compiled-engine integration tests.
- npm run test:package: checks the ZIP and asserts native SpatiaLite/GEOS/PROJ execution offline through its actual entry point.

CI builds the native artifact first and runs native SQL, GEOS, PROJ, native spatial-index/constraint triggers, exact integers, allocation cleanup, and WAL export/reopen before the platform matrix can package a release. The same tested artifact is reused across jobs.

Native compilation and live GeoLibre host installation must still be observed successfully in the build environment. A source-only pass is not a native release certification. Earlier performance figures refer to the previous sql.js engine; native measurements must be repeated before making performance claims.
