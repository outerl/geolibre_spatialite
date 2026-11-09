# Inter-Plugin Integration Guide: AequilibraE & SpatiaLite

This guide outlines how client plugins (specifically the **AequilibraE GeoLibre Plugin**) consume the **SpatiaLite Plugin** service to perform trigger-backed network editing without duplicating database engines or bundling heavy WebAssembly binaries.

---

## 1. Architecture Overview

```
                      GeoLibre Browser / Desktop Host
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          ▼                                                   ▼
┌───────────────────────────┐                       ┌───────────────────────────┐
│     AequilibraE Plugin    │                       │     SpatiaLite Plugin     │
│  (aequilibrae_geolibre)   │                       │   (geolibre_spatialite)   │
│                           │                       │                           │
│ • Network Visualisation   │                       │ • SQLite + SpatiaLite WASM│
│ • Assignment Flow Maps    │                       │ • SpatiaLite SQL Functions│
│ • Digitizing Tools (Draw) │                       │ • SpatialIndex Provider   │
│ • Attribute Edit Forms    │                       │ • Database Manager Panel  │
└─────────────┬─────────────┘                       └─────────────▲─────────────┘
              │                                                   │
              │  Calls window.geolibreSpatialite                  │
              └───────────────────────────────────────────────────┘
```

- **Read-Only / Visualization Mode**: AequilibraE runs completely standalone using lightweight pure-TypeScript readers (`sqlite-file.ts`).
- **Edit Mode**: When the user requests to edit links, move vertices, or delete elements, AequilibraE connects to the active `window.geolibreSpatialite` service to execute SQL statements within a transaction so database triggers enforce network topology.

---

## 2. Checking Service Availability & Prompting the User

When the user activates "Edit Network" in AequilibraE:

```typescript
import type { GeoLibreSpatialiteService } from "geolibre-spatialite";

function checkSpatiaLiteAvailable(): GeoLibreSpatialiteService | null {
  if (typeof window !== "undefined" && window.geolibreSpatialite?.isReady()) {
    return window.geolibreSpatialite;
  }
  return null;
}

export async function enterNetworkEditMode(app: GeoLibreAppAPI): Promise<void> {
  const spatialite = checkSpatiaLiteAvailable();

  if (!spatialite) {
    showSpatiaLitePrompt(app);
    return;
  }

  // Proceed with edit session initialization
  await startEditingSession(spatialite);
}

function showSpatiaLitePrompt(app: GeoLibreAppAPI): void {
  const userConfirmed = confirm(
    "Editing AequilibraE networks requires the SpatiaLite plugin to enforce graph topology, auto-generate nodes, and execute database triggers.\n\n" +
    "Would you like to open the Plugin Manager to install it now?"
  );

  if (userConfirmed && app.openRightPanel) {
    // Direct user to plugin manager or display install guidance
    alert("In GeoLibre, go to Settings → Manage Plugins, find 'SpatiaLite', and click Install.");
  }
}
```

---

## 3. The Editing Transaction Lifecycle

Once the service is available, AequilibraE initializes the editing database:

```typescript
// 1. Hand the raw project_database.sqlite bytes to SpatiaLite
const db = await spatialite.openDatabase(projectDatabaseBuffer);

// 2. Digitizing a new link:
// As the user draws a LineString on the MapLibre canvas:
export function onUserDigitizedLink(coordinates: [number, number][], modes = 'c', linkType = 'default') {
  try {
    db.transaction(() => {
      // Create SpatiaLite LineString BLOB (or pass WKB)
      const wkb = linestringToWkb(coordinates);

      // Issue standard INSERT
      db.exec(`
        INSERT INTO links (modes, link_type, direction, geometry)
        VALUES ('${modes}', '${linkType}', 1, GeomFromWKB(X'${wkbToHex(wkb)}', 4326));
      `);
    });

    // 3. Re-read the modified nodes and links from SQLite
    const updatedLinks = db.getTableGeoJson("links");
    const updatedNodes = db.getTableGeoJson("nodes");

    // 4. Update GeoLibre MapLibre layer data in-place
    map.getSource("aequilibrae-links").setData(updatedLinks);
    map.getSource("aequilibrae-nodes").setData(updatedNodes);

  } catch (error) {
    // If an AequilibraE trigger aborts (e.g., centroid collision or invalid mode),
    // SQLite rolls back the transaction and throws a descriptive message
    alert(`Edit rejected by database trigger: ${(error as Error).message}`);
  }
}
```

---

## 4. Moving Nodes & Topological Cascades

When a user drags an existing node vertex:

```typescript
export function onUserMovedNode(nodeId: number, newLngLat: [number, number]) {
  try {
    db.transaction(() => {
      const pointWkb = pointToWkb(newLngLat);
      // Moving the node activates AequilibraE's `aequilibrae_update_node_geometry` trigger:
      // - Attached links have their StartPoint or EndPoint automatically updated via SetStartPoint/SetEndPoint!
      // - If dragged onto an existing node, cannibalization merges them automatically.
      db.exec(`
        UPDATE nodes
        SET geometry = GeomFromWKB(X'${wkbToHex(pointWkb)}', 4326)
        WHERE node_id = ${nodeId};
      `);
    });

    // Refresh map layers
    refreshMapLayers();
  } catch (error) {
    alert(`Move failed: ${(error as Error).message}`);
  }
}
```

---

## 5. Saving Edits Back to Disk

When the user clicks "Save Project":

```typescript
export async function saveProjectEdits(fileHandle: FileSystemFileHandle): Promise<void> {
  // 1. Export binary SQLite file from SpatiaLite
  const updatedBuffer = db.export();

  // 2. Write back to disk using File System Access API
  const writable = await fileHandle.createWritable();
  await writable.write(updatedBuffer);
  await writable.close();

  alert("Project successfully saved.");
}
```

---

## 6. Summary of Benefits

1. **Zero front-end topology code**: All graph connectivity, node creation, link stretching, and centroid validation are handled by AequilibraE's SQLite triggers.
2. **Guaranteed Consistency**: Networks edited in GeoLibre remain 100% compatible with QGIS, QAequilibraE, and Python AequilibraE.
3. **Clean Licensing Boundary**: AequilibraE remains MIT-licensed while delegating LGPL database operations to `geolibre_spatialite`.
