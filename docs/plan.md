# Version 0.1.0 release review

The implementation now targets offline SpatiaLite viewing and a documented subset of spatial SQL. The original plan's full native SpatiaLite runtime, arbitrary AequilibraE editing, and official marketplace availability are not implemented and must not be advertised as shipped features.

Completed in this review:

- Removed schema mutation and repeated spatial-index scans from opening and ordinary writes.
- Added schema-aware metadata caching, zero-extra-copy Uint8Array opening, cursor-to-feature conversion, compact attributes, and cancellable asynchronous layer loading.
- Removed the silent 10,000-feature map limit and unused WKB allocations; added selected-attribute loading.
- Added ordinary 2D multipart/collection BLOB and WKB handling, strict coordinate/WKT validation, projected-layer conversion, and explicit errors for unsupported mapped geometry.
- Corrected spatial SQL distance/length units, SRID defaults and mismatch handling, and false positive spatial-index checks.
- Added bound exec parameters, nested synchronous savepoints, bounded SQL previews with CTE/multi-statement support, safe error rendering, and failed-open preservation.
- Added activation/deactivation cleanup, late-open protection, connection disposal, version consistency, and restricted development-server file access.
- Included source/build inputs and dependency notices in the ZIP. Package verification now checks structure, entry CRCs, SHA-256, and an offline bundled WASM/service smoke test.
- Expanded regression tests and added a read-only large-database benchmark with feature-output checksums. See performance.md and performance-results.json.

Remaining release boundary:

- Install the ZIP in the exact intended GeoLibre Web/Desktop release and run the host integration checklist in geolibre-plugin-store-submission.md. Current automated host integration uses a mock API and jsdom.
- Do not claim full C libspatialite, GEOS, native VirtualSpatialIndex/VirtualKNN, compressed/TinyPoint/Z/M geometry, or arbitrary AequilibraE network editing compatibility. See README.md and c-wasm-compilation.md.
- Plugin-store location, schema, and minimum host version must be checked against the intended GeoLibre distribution before submission. No publication or upstream registry change has been performed.

The original source directory did not contain Git metadata. Changes were applied in place; no commit, tag, or push was created.
