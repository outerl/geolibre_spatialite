# Release and GeoLibre submission

Native compilation, integration tests, and packaged-runtime validation must pass before publication. Plugin-store registration is a separate action.

1. Keep `package.json` and `geolibre-plugin/plugin.json` versions aligned. The library, plugin, and service versions all derive from `package.json`.
2. Run `npm ci`, `npm run build:wasm`, `npm run check`, `npm run package:geolibre`, and `npm run test:package` on the release sources, or use the same tested native artifacts downloaded by CI. Source-only tests are insufficient.
3. Install the resulting ZIP in the intended GeoLibre Web/Desktop version. Verify enable/disable/re-enable, opening a real database, SQL error display, mapping a projected layer, cancelling a large layer, and exporting/reopening a copy.
4. Publish the ZIP together with its `.zip.sha256.json`. The ZIP contains native build metadata, license notices, source/build inputs, and upstream source archives. Its offline smoke test must assert native SpatiaLite, GEOS, and PROJ execution. Do not claim arbitrary AequilibraE editing or extended map-codec support without the relevant application tests.
5. Check the current official GeoLibre distribution documentation to identify its registry location and submission schema. The previous draft's registry URL, repository paths, minimum-version assumptions, and hard-coded checksums were not verified and must not be used as authoritative submission instructions.
6. Use the SHA-256 generated for the exact published ZIP. Never copy a checksum from an example or a previous build.

No release, tag, upload, or registry submission is performed by the local packaging scripts. `.github/workflows/ci.yml` runs checks and retains the verified ZIP and checksum as build artifacts.
