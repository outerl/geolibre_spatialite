# GeoLibre SpatiaLite Engine

A standalone, in-browser SpatiaLite database engine and Spatial SQL plugin for [GeoLibre](https://github.com/opengeos/GeoLibre).

`geolibre-spatialite` provides first-class SpatiaLite support in GeoLibre: open SQLite/SpatiaLite databases, run arbitrary spatial SQL queries, inspect tables and geometry metadata, visualize spatial layers on the map, and power downstream plugins (such as AequilibraE trigger-backed network editing) through an exposed inter-plugin service.

---

## Features

- **In-Browser SQLite + SpatiaLite Runtime**: Fully offline, zero-network runtime using inlined WebAssembly.
- **SpatiaLite 2D Geometry Codec**: Native encoding and decoding for SpatiaLite BLOBs (Point, LineString, Polygon) and standard OGC WKB/WKT.
- **SpatiaLite SQL Functions Suite**:
  - Constructors & Accessors: `StartPoint()`, `EndPoint()`, `PointN()`, `NumPoints()`, `X()`, `Y()`, `SRID()`, `MakePoint()` / `ST_Point()`
  - Coordinate & Vertex Modifiers: `SetStartPoint()`, `SetEndPoint()` (vital for topological cascades)
  - Measurements: `GeodesicLength()` (WGS84 ellipsoidal distance in meters), `ST_Length()`, `ST_Distance()`
  - Conversions: `GeomFromWKB()`, `GeomFromText()`, `AsBinary()`, `AsText()`, `AsGeoJSON()`
  - Spatial Index Interface: Automatic `SpatialIndex` view emulation for point queries (`search_frame = ...`) and `CheckSpatialIndex()`.
- **First-Class GeoLibre UI**:
  - Right panel explorer displaying all database tables, geometry columns, SRIDs, and feature types.
  - "Add to Map" button to convert any SpatiaLite table directly into a native GeoLibre layer with auto-zoom bounds.
  - Interactive Spatial SQL Console with formatted result tables and SQL error reporting.
  - Database file export (`.sqlite`).
- **Inter-Plugin Service Provider**:
  - Registers on `window.geolibreSpatialite` and `app.registerService('spatialite')`.
  - Enables plugins like **AequilibraE** to execute complex SQL transactions and database triggers directly in the browser.

---

## Installation in GeoLibre

### From the Official GeoLibre Plugin Store
1. Open GeoLibre Web or Desktop.
2. Navigate to **Settings → Manage Plugins**.
3. Under the **Not Installed** or **All** tab, search for **SpatiaLite**.
4. Click **Install** and toggle the plugin on.

### From Local ZIP Archive
1. Build the plugin package:
   ```bash
   npm run package:geolibre
   ```
2. In GeoLibre, go to **Settings → Manage Plugins → Settings → Choose .zip…**
3. Select `geolibre-plugin/dist/geolibre-spatialite-0.1.0.zip` and activate **SpatiaLite Spatial SQL Engine**.

---

## Using the Inter-Plugin Service (e.g. in AequilibraE)

Other GeoLibre plugins can check for the SpatiaLite service to execute spatial queries and run trigger-enforced database edits:

```typescript
import type { GeoLibreSpatialiteService } from "geolibre-spatialite";

// 1. Check if the SpatiaLite engine is available
const spatialite = window.geolibreSpatialite;

if (!spatialite) {
  // Prompt user to install from GeoLibre Plugin Store
  alert("Editing AequilibraE networks requires the SpatiaLite plugin. Please install it from Settings → Manage Plugins.");
  return;
}

// 2. Open an AequilibraE project database from file bytes
const db = await spatialite.openDatabase(projectDatabaseBuffer);

// 3. Perform network edits inside a transaction — all AequilibraE triggers fire automatically!
db.transaction(() => {
  // Inserting a link triggers automatic a_node/b_node creation and geodesic length computation:
  db.exec(`
    INSERT INTO links (modes, link_type, direction, geometry)
    VALUES ('c', 'default', 1, GeomFromWKB(?, 4326));
  `);
});

// 4. Export updated database bytes to save back to disk
const updatedBytes = db.export();
db.close();
```

See [Inter-Plugin Integration Guide](docs/inter-plugin-guide.md) for full details.

---

## Development

Requires Node.js 22 or newer.

```bash
# Install dependencies
npm ci

# Run all quality checks (lint, typecheck, tests with coverage, and build)
npm run check

# Build the installable GeoLibre ZIP package
npm run package:geolibre

# Verify package checksum integrity
npm run test:package

# Start local plugin development server
npm run serve:geolibre
```

---

## Repository Structure

- `src/spatialite/`: Core SpatiaLite WASM engine, BLOB codec, geodesic math, and SQL functions.
- `src/api/`: Public TypeScript types and singleton service for inter-plugin consumers.
- `src/geolibre/`: GeoLibre host UI controller, CSS styling, and layer bridge.
- `geolibre-plugin/`: Official plugin manifest (`plugin.json`) and build outputs.
- `docs/`: Store contribution guide, AequilibraE integration guide, and C compilation guide.

---

## License

GNU Lesser General Public License v2.1 or later (`LGPL-2.1-or-later`).  
See [LICENSE](LICENSE) for details.
