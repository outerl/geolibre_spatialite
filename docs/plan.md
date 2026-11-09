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

## Large-file backend and selective reads

Goal: let consumer plugins read large local SpatiaLite files without first copying
the whole file into JavaScript/WASM memory. Keep AequilibraE's existing reader in
place until equivalent end-to-end benchmarks justify migration. Complete-network
flow maps still require all links, so paging is a memory/startup improvement, not
a promise of faster full-network conversion.

### Implementation order

1. Preserve the native compilation/integration/package gates above. Native build
   verification is a release prerequisite; develop and test the new source path
   while local Docker permissions remain unavailable.
2. Add a separate asynchronous, read-only `openFile(Blob, options)` service API.
   Keep the current synchronous byte-backed connection API compatible for editing
   and small databases. Fail explicitly when workers or the required native
   filesystem support are unavailable; never silently load the entire file.
3. Mount the Blob in a dedicated Web Worker using Emscripten WORKERFS. This exposes
   sliced synchronous file reads to SQLite without a whole-file import. Open with
   SQLite's read-only flags, disable mmap, and configure a bounded SQLite page
   cache (default 32 MiB). The cache is not a limit on total WASM, query/sort, or
   result memory. Do not duplicate AequilibraE's SQLite file parser.
4. Keep worker code self-contained in the offline release. Add required native
   exports, filesystem linkage, and artifact capability validation so an older
   compiled module cannot masquerade as a paged-capable runtime. Clean up mounts,
   statements, worker promises, and workers on failures and close. Reject files
   requiring WAL/journal recovery rather than silently omitting sidecar changes.
5. Add parameterized bounded queries and pull-based row/feature batches with
   backpressure. Include cancellation and early iterator-return cleanup. A hard
   cancellation may terminate the read-only connection to interrupt SQLite that
   is busy inside one step; document that consumers reopen it afterward. Keep
   synchronous transactions/writes/export out of the paged API.
6. Add shared selective feature reads: selected property columns, validated
   bounding boxes in the layer's source CRS, bound attribute predicates, limits,
   and optional streaming batches. Explicitly use a valid existing spatial index
   where available; offer a clear required-index mode and a correct scan fallback.
   State whether bounding boxes select envelope candidates or exact intersections.
   Continue producing WGS84 GeoJSON and preserving exact large integer attributes.
7. Document the public API, cache/lifecycle/cancellation behavior, bounding-box
   semantics, offline worker requirements, and consistent-snapshot requirement.
   Do not migrate or edit the AequilibraE plugin as part of this work.

### Acceptance and review

- Source tests must cover actual SQLite query/filter results, index/scan parity,
  selected columns, exact integers, malformed options, batching/backpressure,
  cancellation, early exit, failed open, and close. Test filesystem reads do not
  call `arrayBuffer()` on the full file or write its bytes into MEMFS.
- The compiled-native gate must exercise real WORKERFS in a browser worker with
  an actual file, native spatial-index selection, source immutability, offline
  startup, and cleanup. Test doubles do not certify the filesystem/worker ABI.
- Add a reproducible benchmark separating runtime startup, file open, selective
  reads, full-layer conversion, and memory/read-volume measurements. Compare
  equivalent features/attributes; record the backend and file/feature counts.
  Preserve historical measurements and publish no unmeasured native speedup.
- The primary agent reviews implementation and tests independently after the
  requested Luna extra-high-effort implementation pass, runs available checks,
  and records any remaining native/browser verification blocker.

Design references: [Emscripten WORKERFS](https://emscripten.org/docs/api_reference/Filesystem-API.html#workerfs),
[SQLite read-only opening](https://www.sqlite.org/c3ref/open.html), and
[SQLite page-cache sizing](https://www.sqlite.org/pragma.html#pragma_cache_size).
