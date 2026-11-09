# Inter-plugin integration

The plugin exposes a SQLite connection with a subset of spatial SQL, not the full C SpatiaLite engine. Read the compatibility limits in the README before using a database with native SpatiaLite constraint/index triggers. Existing AequilibraE project editing has not been certified by the synthetic trigger tests.

## Open and query

```ts
import type { GeoLibreSpatialiteService } from "geolibre-spatialite";

const spatialite: GeoLibreSpatialiteService | undefined = window.geolibreSpatialite;
if (!spatialite?.isReady()) throw new Error("Enable the SpatiaLite plugin first.");
const db = await spatialite.openDatabase(databaseBytes);
try {
  const rows = db.query("SELECT name FROM places WHERE id = ?", [placeId]);
  console.log(rows);
} finally {
  db.close();
}
```

The plugin dispatches `geolibre:spatialite:ready` after successful activation. `isReady()` indicates that the API is available; the WASM runtime initializes on the first open. The host service registry is optional. Disabling the plugin removes its global service registration and closes its panel-owned connection. Connections explicitly opened by consumers belong to those consumers and must be closed by them.

## Parameterized writes and transactions

```ts
const db = await spatialite.createDatabase();
db.exec("CREATE TABLE places(id INTEGER PRIMARY KEY, name TEXT, geometry BLOB)");
db.transaction(() => {
  db.exec("INSERT INTO places VALUES (?, ?, GeomFromText(?, 4326))", [
    1, "O'Brien", "POINT(153 -27.5)",
  ]);
});
const updatedBytes = db.export(); // save this copy through your application's file workflow
db.close();
```

Use bound parameters for values. Quote dynamic identifiers by doubling embedded double quotes and surrounding the name with double quotes. Do not interpolate user-entered values into SQL. Nested synchronous transactions use SQLite savepoints. Returning a Promise is rejected; never use an async transaction callback.

## Load only a selected spatial table

```ts
const abort = new AbortController();
const layer = await db.getTableGeoJsonAsync("places", "geometry", undefined, {
  propertyColumns: ["id", "name"], // omit for all attributes, or [] for geometry only
  signal: abort.signal,
  onProgress: (count) => console.log(`${count} features loaded`),
});
// abort.abort() cancels loading. No partial layer is returned.
```

There is no default feature limit. Pass a positive integer as the third argument to request a subset (0 returns no rows). Both the synchronous `getTableGeoJson()` and the asynchronous variant return WGS84 GeoJSON, resolving projected SRIDs through `spatial_ref_sys.proj4text` or built-in Proj4js definitions. Unknown SRIDs and unsupported BLOB encodings throw an error. Non-spatial BLOB attributes become descriptive strings.

An active asynchronous cursor blocks wrapper SQL, writes, export, and close operations until it finishes or cancellation settles. Do not bypass that guard through `rawDb`. Progress callbacks should update UI or request cancellation, not query the connection. Schema metadata is cached by SQLite schema version; call `refreshSpatialIndex()` if changing geometry metadata through the low-level handle. That helper only creates a temporary exact-equality endpoint view in schemas that do not already contain a SpatialIndex; it does not implement the native spatial index.

The entire SQLite file and the resulting GeoJSON still reside in memory. For wide tables, request only the properties needed by the map.

## Licensing for consumer plugins (LGPL-2.1 Section 6)

`geolibre-spatialite` is distributed under **LGPL-2.1-or-later**. 

Consumer plugins (such as the **AequilibraE** GeoLibre plugin, licensed under MIT) interact with `geolibre-spatialite` via runtime dynamic dispatch (`window.geolibreSpatialite` or `app.getService('spatialite')`). Under Section 5 and Section 6 of LGPL 2.1:
- A consumer plugin that calls into `geolibre-spatialite` at runtime constitutes a **"work that uses the Library"**.
- The consumer plugin **does not become a derivative work** and is **not infected by copyleft**. It may remain under MIT or any other license of its author's choice.
- Users have the right under LGPL 2.1 to replace, modify, and rebuild `geolibre-spatialite` independently of the consumer plugin using the source inputs included in the plugin package.
