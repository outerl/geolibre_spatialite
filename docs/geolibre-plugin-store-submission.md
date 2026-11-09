# Release and GeoLibre submission

The local package workflow is verified; publication and plugin-store registration are separate actions.

1. Keep `package.json` and `geolibre-plugin/plugin.json` versions aligned. The library, plugin, and service versions all derive from `package.json`.
2. Run `npm ci`, `npm run check`, `npm run package:geolibre`, and `npm run test:package` on the release sources.
3. Install the resulting ZIP in the intended GeoLibre Web/Desktop version. Verify enable/disable/re-enable, opening a real database, SQL error display, mapping a projected layer, cancelling a large layer, and exporting/reopening a copy.
4. Publish the ZIP together with its `.zip.sha256.json`. The ZIP contains license notices and source/build inputs. Do not claim full libspatialite, GEOS, native spatial-index, or arbitrary AequilibraE editing support for v0.1.0.
5. Check the current official GeoLibre distribution documentation to identify its registry location and submission schema. The previous draft's registry URL, repository paths, minimum-version assumptions, and hard-coded checksums were not verified and must not be used as authoritative submission instructions.
6. Use the SHA-256 generated for the exact published ZIP. Never copy a checksum from an example or a previous build.

No release, tag, upload, or registry submission is performed by the local packaging scripts. `.github/workflows/ci.yml` runs checks and retains the verified ZIP and checksum as build artifacts.
