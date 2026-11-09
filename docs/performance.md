# Large database performance

These are historical measurements of the sql.js-based engine before the native SpatiaLite migration. They do not establish performance for the current C runtime. Repeat the benchmark with the compiled native artifacts before publishing native performance figures.

Measured on 2026-11-09 using a local transport-network database: 479,125,504 bytes (456.93 MiB), 451,535 link features. The database was read without changing its file. All columns and every feature were loaded in both versions; the baseline's limit was explicitly raised to avoid comparing against its old 10,000-row default.

Medians of three separate Node.js 24.20.0 processes per configuration on the same Windows machine, using the same installed dependencies:

| Measurement | Original code | Revised code | Change |
| --- | ---: | ---: | ---: |
| Open database from resident bytes | 275.88 ms | 7.35 ms | 37.5x faster |
| 25 metadata reads | 34.06 ms | 10.69 ms | 3.2x faster |
| All links to GeoJSON, synchronous | 3.609 s | 1.228 s | 2.94x faster |
| All links to GeoJSON, yielding/cancellable path | 3.609 s (blocking) | 1.355 s | 2.66x faster |
| Peak process RSS, synchronous | 3,705.95 MiB | 1,501.81 MiB | 59.5% lower |
| Heap at end of conversion, synchronous | 2,312.09 MiB | 799.48 MiB | 65.4% lower |

The revised asynchronous path had virtually the same peak RSS (1,501.20 MiB). Eight multipart country-border features were also loaded from the same database with eight non-NULL geometries.

## Why it improved

- Passing a Uint8Array no longer makes an extra full-file JavaScript copy before SQLite opens it.
- Opening no longer scans every table or tries to replace a real SpatialIndex. Ordinary writes do not rebuild a spatial view.
- Metadata is cached against SQLite schema version. SpatiaLite metadata discovery reads geometry_columns directly, without per-table PRAGMAs.
- A prepared cursor converts each row straight into its final feature, avoiding the intermediate array of SQL row objects and retained BLOBs.
- The map decoder omits the previously unused per-feature WKB allocation.
- Shared attribute-object shapes keep wide tables compact. Consumers can further reduce work by selecting specific attributes or geometry only.
- Asynchronous loading yields using the browser scheduler or MessageChannel, avoiding timer-clamping overhead while permitting cancellation.

The complete feature JSON has the same SHA-256 in every baseline, synchronous, and asynchronous run:

`1f5125a607bda2a3c159a79831c440858fdfad1ee322f917aece92a30c50e5d0`

Raw measurements are in [performance-results.json](performance-results.json).

## Reproduce

```sh
npm run benchmark -- /path/to/database.sqlite links
npm run benchmark -- /path/to/database.sqlite links . async
# Compare a separate snapshot of the original sources (with its dependencies installed):
npm run benchmark -- /path/to/database.sqlite links /path/to/original/source
```

Disk reads, Vite source transformation, checksum computation, and map rendering are outside the timed conversion. Runtime initialization is measured separately. Peak RSS includes the Node/Vite harness, resident input, WASM runtime, GeoJSON, and checksum work; it is not a browser-only memory measurement. OS caches were not flushed. These results measure database opening and data conversion, not total time from choosing a file to displaying a map.

Those historical runs held the entire database in memory. They do not measure
the new worker-backed paged API or establish a native speedup.

## Benchmark an actual file with the native paged backend

After building current native artifacts and the library, use Chrome, Chromium,
or Edge (`CHROME_BIN` can name the executable):

```sh
npm run build:wasm
npm run build
npm run benchmark:paged -- /path/to/project_database.sqlite links --properties link_id,distance
```

The harness selects the original file through a browser file input. It does not
read or serve the complete database merely to pass it to the browser. It opens a
read-only connection with a 32 MiB SQLite cache and consumes feature batches
without retaining a complete GeoJSON layer. The input must be a consistent
standalone rollback-format snapshot; see the README's paged-file requirements.

To compare an indexed spatial subset with the full layer, supply a bounding box
in the layer's **source CRS**, and require a usable existing index if desired:

```sh
npm run benchmark:paged -- /path/to/database.sqlite places --column geometry --properties id,name --bbox 152,-28,154,-27 --require-index
```

Add `--compare-memory` to run equivalent reads through the native in-memory
backend. That option explicitly reads the whole file into memory. The harness
compares feature counts and order-independent FNV fingerprints of geometry and
the same selected properties; these fingerprints are a regression check, not a
cryptographic equivalence proof.

JSON output separates worker/native startup and mount/open timings (reported by
the connection), total open time, selective and full conversion, fingerprint
overhead, and requested Blob slice counts/bytes. Slice statistics are not
physical disk IO: ranges can be served by browser/OS caches or requested more
than once. The selective and full reads share a connection and page cache, so
repeat in fresh browser processes and report ordering and cache conditions.
The default timeout is ten minutes. Timings exclude host map rendering.

The benchmark does not measure total/peak browser memory: `memoryMeasurement`
is null. Cache size excludes WASM/runtime, SQLite sorting/spatial scratch work,
and consumer-held results. It also does not compare AequilibraE's existing paged
reader. That comparison and actual large-file native measurements remain
required before recommending an AequilibraE migration or publishing speedups.
