// SPDX-License-Identifier: LGPL-2.1-or-later
import { describe, expect, it } from "vitest";

import { SpatialiteDatabase } from "../src/spatialite/database.js";
import { decodeSpatialiteGeometry, encodeSpatialitePoint } from "../src/spatialite/blob-codec.js";
import {
  buildFeatureReadPlan,
  geometryEnvelope,
  geometryEnvelopeIntersects,
  validSpatialIndexObject,
} from "../src/spatialite/feature-read-plan.js";

describe("selective feature reads", () => {
  it("uses bound filters, selected attributes, source-CRS bbox, limits, and pull batches", async () => {
    const db = await SpatialiteDatabase.open();
    try {
      db.exec("CREATE TABLE places (id INTEGER PRIMARY KEY, label TEXT, category TEXT, geometry BLOB)");
      const rows = [
        [1, "first", "keep", encodeSpatialitePoint(1, 1)],
        [2, "second", "skip", encodeSpatialitePoint(2, 2)],
        [3, "third", "keep", encodeSpatialitePoint(3, 3)],
        [4, "outside", "keep", encodeSpatialitePoint(8.0000001, 8.0000001)],
        [5, "empty", "keep", null],
      ] as const;
      for (const row of rows) db.exec("INSERT INTO places VALUES (?, ?, ?, ?)", [...row]);

      const options = {
        propertyColumns: ["label"],
        bbox: [0, 0, 2, 2] as const,
        filters: [{ column: "category", operator: "=", value: "keep" }] as const,
        batchSize: 1,
      };
      const result = db.getTableGeoJson("places", "geometry", undefined, options);
      expect(result.features.map((feature) => String(feature.properties?.label))).toEqual(["first"]);
      expect(result.features[0]?.geometry).toEqual({ type: "Point", coordinates: [1, 1] });
      expect(db.getTableGeoJson("places", "geometry", 0, options).features).toEqual([]);
      expect(db.getTableGeoJson("places", "geometry", 1, { propertyColumns: ["label"] }).features).toHaveLength(1);

      const batches: number[] = [];
      for await (const batch of db.streamTableGeoJson("places", "geometry", undefined, { ...options, filters: [] })) {
        batches.push(batch.length);
      }
      expect(batches).toEqual([1, 1]);
    } finally { db.close(); }
  });

  it("validates bbox, attribute filters, columns, and required-index mode", async () => {
    const db = await SpatialiteDatabase.open();
    try {
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, geometry BLOB)");
      db.exec("INSERT INTO items VALUES (1, ?)", [encodeSpatialitePoint(0, 0)]);
      expect(() => db.getTableGeoJson("items", "geometry", undefined, { bbox: [0, 0, Number.NaN, 1] })).toThrow("finite");
      expect(() => db.getTableGeoJson("items", "geometry", undefined, { bbox: new Array(4) as never })).toThrow("finite");
      expect(() => db.getTableGeoJson("items", "geometry", undefined, { bbox: [2, 0, 1, 3] })).toThrow("minimum");
      expect(() => db.getTableGeoJson("items", "geometry", undefined, {
        filters: [{ column: "missing", operator: "=", value: 1 }],
      })).toThrow("does not exist");
      expect(() => db.getTableGeoJson("items", "geometry", undefined, {
        filters: [{ column: "id", operator: "LIKE", value: 1 }],
      } as never)).toThrow("LIKE");
      expect(() => db.getTableGeoJson("items", "geometry", undefined, {
        bbox: [0, 0, 1, 1], requireSpatialIndex: true,
      })).toThrow("valid SpatiaLite spatial index");

      db.exec("CREATE TABLE no_rowid (id INTEGER PRIMARY KEY, geometry BLOB) WITHOUT ROWID");
      expect(() => db.getTableGeoJson("no_rowid", "geometry", undefined, {
        bbox: [0, 0, 1, 1], requireSpatialIndex: true,
      })).toThrow("valid SpatiaLite spatial index");

      db.exec("CREATE TABLE geometry_columns(f_table_name TEXT, f_geometry_column TEXT, type TEXT, coord_dimension TEXT, srid INT, spatial_index_enabled INT)");
      db.exec("INSERT INTO geometry_columns VALUES('shadowed','geometry','POINT','XY',4326,1)");
      db.exec('CREATE TABLE shadowed (label TEXT, "rowid" INT, "_rowid_" TEXT, oid TEXT, geometry BLOB)');
      db.exec("INSERT INTO shadowed VALUES('scan me', 77, 'shadow', 'oid', ?)", [encodeSpatialitePoint(0.5, 0.5)]);
      db.exec("CREATE TABLE idx_shadowed_geometry (pkid INTEGER PRIMARY KEY, xmin REAL, xmax REAL, ymin REAL, ymax REAL)");
      expect(db.getTableGeoJson("shadowed", "geometry", undefined, { bbox: [0, 0, 1, 1] }).features[0]?.properties?.label).toBe("scan me");
      expect(() => db.getTableGeoJson("shadowed", "geometry", undefined, {
        bbox: [0, 0, 1, 1], requireSpatialIndex: true,
      })).toThrow("valid SpatiaLite spatial index");
    } finally { db.close(); }
  });

  it("includes generated feature properties in default and selected reads", async () => {
    const db = await SpatialiteDatabase.open();
    try {
      db.exec("CREATE TABLE generated_places (label TEXT, generated_label TEXT GENERATED ALWAYS AS (upper(label)) STORED, geometry BLOB)");
      db.exec("INSERT INTO generated_places (label, geometry) VALUES (?, ?)", ["park", encodeSpatialitePoint(1, 2)]);
      expect(db.getTableGeoJson("generated_places").features[0]?.properties).toEqual({ label: "park", generated_label: "PARK" });
      expect(db.getTableGeoJson("generated_places", "geometry", undefined, { propertyColumns: ["generated_label"] }).features[0]?.properties).toEqual({ generated_label: "PARK" });
    } finally { db.close(); }
  });

  it("keeps the scan and RTree candidate paths equivalent at float boundaries", async () => {
    const db = await SpatialiteDatabase.open();
    try {
      db.exec("CREATE TABLE places (id INTEGER PRIMARY KEY, label TEXT, geometry BLOB)");
      // sql.js is SQLite without the RTree extension. This regular test table
      // supplies real SQLite candidate-query results; native WORKERFS/RTree ABI
      // coverage is owned by the compiled Chromium smoke gate.
      db.exec("CREATE TABLE idx_places_geometry (pkid INTEGER PRIMARY KEY, xmin REAL, xmax REAL, ymin REAL, ymax REAL)");
      const values = [
        [1, "near-outside", 1.0000001, 1.0000001],
        [2, "inside", 1, 1],
        [3, "away", 4, 4],
      ] as const;
      for (const [id, label, x, y] of values) {
        db.exec("INSERT INTO places VALUES (?, ?, ?)", [id, label, encodeSpatialitePoint(x, y)]);
        // Model outward float32 rounding for the near-boundary candidate: the
        // index admits it, then the production exact-envelope check rejects it.
        const minX = id === 1 ? 1 : x;
        const minY = id === 1 ? 1 : y;
        db.exec("INSERT INTO idx_places_geometry VALUES (?, ?, ?, ?, ?)", [id, minX, x, minY, y]);
      }
      const bbox = [1, 1, 1, 1] as const;
      const common = { table: "places", geometryColumn: "geometry", schemaColumns: ["id", "label", "geometry"], bbox, srid: 4326 };
      const indexed = buildFeatureReadPlan({ ...common, useSpatialIndex: true, rowIdColumn: "_rowid_", spatialIndexTable: "idx_places_geometry", limit: 1 });
      const scan = buildFeatureReadPlan({ ...common, useSpatialIndex: false, rowIdColumn: null, limit: 1 });
      const propertyAlias = indexed.propertyAliases[0];
      if (propertyAlias === undefined) throw new Error("Missing test property alias.");
      expect(indexed.sql).not.toMatch(/LIMIT\s+\?/i);
      const collect = (plan: typeof indexed): number[] => db.query(plan.sql, plan.params)
        .filter((row) => {
          const blob = row[plan.geometryAlias];
          if (!(blob instanceof Uint8Array)) return false;
          return geometryEnvelopeIntersects(geometryEnvelope((awaitDecode(blob))), bbox);
        }).map((row) => row[propertyAlias]).filter((id): id is number => typeof id === "number");
      expect(collect(indexed)).toEqual([2]);
      expect(collect(scan)).toEqual([2]);
      expect(validSpatialIndexObject("table", "CREATE VIRTUAL TABLE idx_places_geometry USING rtree(pkid,xmin,xmax,ymin,ymax)")).toBe(true);
      expect(validSpatialIndexObject("table", "CREATE TABLE idx_places_geometry (pkid INTEGER, xmin REAL)")).toBe(false);
      expect(validSpatialIndexObject("table", "CREATE VIRTUAL TABLE idx_places_geometry USING rtree_i32(pkid,xmin,xmax,ymin,ymax)")).toBe(false);
    } finally { db.close(); }
  });
});

function awaitDecode(blob: Uint8Array) {
  // The test uses SpatiaLite's real geometry BLOB decoder through the production helper.
  return decodeSpatialiteGeometry(blob).geometry;
}
