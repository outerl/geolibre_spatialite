# Contributing to the Official GeoLibre Plugin Repository

This guide details the end-to-end process and requirements for submitting `geolibre-spatialite` to the official GeoLibre Plugin Registry (`plugins.geolibre.app/plugin-registry.json`).

---

## 1. Overview of the GeoLibre Plugin Marketplace

GeoLibre exposes an in-app marketplace under **Settings → Manage Plugins**. The marketplace dynamically pulls its list of verified plugins from:
`https://plugins.geolibre.app/plugin-registry.json` (maintained in the [`opengeos/GeoLibre`](https://github.com/opengeos/GeoLibre) repository).

When a user clicks "Install", GeoLibre:
1. Downloads the specified `.zip` archive from the distribution URL.
2. Verifies the SHA-256 integrity checksum against the registry entry.
3. Extracts the archive into the user's plugin storage (IndexedDB / OPFS in the browser, or local AppData in Tauri Desktop).
4. Reads `plugin.json` from the root of the archive and mounts the entry script (`dist/index.js`).

---

## 2. Release & Packaging Workflow

Before submitting a PR to the GeoLibre registry, a public release archive must be published.

### Step 1: Build and Package Locally
```bash
npm run check
npm run package:geolibre
npm run test:package
```
This produces:
- `geolibre-plugin/dist/geolibre-spatialite-0.1.0.zip`
- `geolibre-plugin/dist/geolibre-spatialite-0.1.0.zip.sha256.json`

### Step 2: Publish GitHub Release
1. Tag the release on the main branch:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
2. Create a GitHub Release at `https://github.com/outerl/geolibre_spatialite/releases/tag/v0.1.0`:
   - Title: `v0.1.0 - SpatiaLite Spatial SQL Engine for GeoLibre`
   - Attach the built ZIP: `geolibre-spatialite-0.1.0.zip`
   - Note the resulting download URL:
     `https://github.com/outerl/geolibre_spatialite/releases/download/v0.1.0/geolibre-spatialite-0.1.0.zip`
   - Record the SHA-256 hash from `geolibre-spatialite-0.1.0.zip.sha256.json`.

---

## 3. GeoLibre Plugin Manifest Specification

The archive must contain a valid `plugin.json` at its root:

```json
{
  "id": "geolibre-spatialite",
  "name": "SpatiaLite Spatial SQL Engine",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "style": "dist/style.css",
  "description": "SpatiaLite database engine and Spatial SQL support for GeoLibre, enabling spatial queries, SpatiaLite layer viewing, and trigger-backed network editing.",
  "geolibre": ">=0.2.0",
  "capabilities": ["right-panel", "native-layers", "map-access", "service-provider"],
  "author": {
    "name": "Outer Loop Consulting",
    "url": "https://outerloop.io"
  },
  "license": "LGPL-2.1-or-later",
  "repository": "https://github.com/outerl/geolibre_spatialite"
}
```

---

## 4. Submitting to the GeoLibre Registry

### Step 1: Fork the Upstream Registry
Fork `https://github.com/opengeos/GeoLibre` (or the dedicated registry repository if separated).

### Step 2: Add Entry to `plugin-registry.json`
Add the following entry under the `plugins` array:

```json
{
  "id": "geolibre-spatialite",
  "name": "SpatiaLite Spatial SQL Engine",
  "version": "0.1.0",
  "description": "SpatiaLite database engine and Spatial SQL support for GeoLibre. Open SQLite/SpatiaLite databases, query with spatial SQL, view layers, and power trigger-backed network editors.",
  "category": "Database & Analysis",
  "author": "Outer Loop Consulting",
  "homepage": "https://github.com/outerl/geolibre_spatialite",
  "repository": "https://github.com/outerl/geolibre_spatialite",
  "license": "LGPL-2.1-or-later",
  "url": "https://github.com/outerl/geolibre_spatialite/releases/download/v0.1.0/geolibre-spatialite-0.1.0.zip",
  "sha256": "fdcca8e6c3f566ddad93632c20bbf7191a8a0621725e413823d746f8ecdbf93d",
  "minAppVersion": "0.2.0",
  "tags": ["spatialite", "sqlite", "sql", "database", "aequilibrae", "vector"]
}
```

### Step 3: Open Pull Request
Create a PR with title:
`feat(plugins): add geolibre-spatialite plugin`

**PR Description Template:**
```markdown
### Summary
This PR adds the **SpatiaLite Spatial SQL Engine** (`geolibre-spatialite`) to the GeoLibre plugin registry.

### Plugin Details
- **Plugin ID**: `geolibre-spatialite`
- **Version**: `0.1.0`
- **Repository**: https://github.com/outerl/geolibre_spatialite
- **License**: LGPL-2.1-or-later
- **Capabilities**: Right-panel database explorer, Spatial SQL console, SpatiaLite table-to-map layer rendering, and global `window.geolibreSpatialite` service provider for downstream plugins (e.g. AequilibraE network editing).

### Quality Verification
- [x] Passes strict linting and TypeScript checks (0 warnings).
- [x] Vitest unit and integration test suite passing (including AequilibraE trigger tests).
- [x] SHA-256 checksum verified against published release asset.
- [x] Offline runtime: SQLite WebAssembly binary is fully inlined with zero runtime network calls.
```

---

## 5. Maintenance & Version Updates

When releasing a new version:
1. Update `version` in `package.json` and `geolibre-plugin/plugin.json`.
2. Run `npm run package:geolibre` to generate the new archive and SHA-256 file.
3. Publish a new GitHub release tag.
4. Submit a bump PR to `plugin-registry.json` updating `version`, `url`, and `sha256`.
