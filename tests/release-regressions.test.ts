// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Geometry } from "geojson";
import { SpatialiteDatabase } from "../src/spatialite/database.js";
import { decodeSpatialiteBlob, encodeSpatialitePoint, geoJsonToSpatialiteBlob, wkbToSpatialiteBlob } from "../src/spatialite/blob-codec.js";
import { SpatialiteController } from "../src/geolibre/spatialite-controller.js";
import { plugin } from "../src/geolibre.js";
import type { GeoLibreAppAPI } from "../src/geolibre/host-api.js";

const connections: SpatialiteDatabase[] = [];
async function open(): Promise<SpatialiteDatabase> { const db = await SpatialiteDatabase.open(); connections.push(db); return db; }
afterEach(() => { connections.splice(0).forEach((db) => { db.close(); }); document.body.replaceChildren(); });

describe("release regressions", () => {
  it("loads all 12,000 rows and can select attributes or geometry only", async () => {
    const db = await open();
    db.exec("CREATE TABLE places(id INTEGER, label TEXT, geometry BLOB)");
    db.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<12000) INSERT INTO places SELECT i, 'place', MakePoint(i/1000.0, 0, 4326) FROM n");
    expect(db.getTableGeoJson("places").features).toHaveLength(12000);
    expect(db.getTableGeoJson("places", "geometry", 2, { propertyColumns: [] }).features[0]?.properties).toEqual({});
    expect(db.getTableGeoJson("places", "geometry", 2, { propertyColumns: ["label"] }).features[0]?.properties).toEqual({ label: "place" });
    expect(() => db.getTableGeoJson("places", "geometry", -1)).toThrow("Invalid feature limit");
  });

  it("caches metadata until schema or metadata changes without rewriting the source", async () => {
    const db = await open();
    db.exec("CREATE TABLE places(geometry BLOB)");
    const schema = db.query("SELECT * FROM sqlite_master");
    const rawExec = vi.spyOn(db.rawDb, "exec");
    db.getGeometryColumns(); db.getTableNames();
    const query = vi.spyOn(db, "query");
    for (let i = 0; i < 10; i++) { db.getGeometryColumns(); db.getTableNames(); db.exec("INSERT INTO places VALUES (NULL)"); }
    expect(query).not.toHaveBeenCalled();
    expect(rawExec.mock.calls.every(([sql]) => !/CREATE|DROP/i.test(sql))).toBe(true);
    expect(db.query("SELECT * FROM sqlite_master")).toEqual(schema);
    db.exec('CREATE TABLE "more""places"(geometry BLOB)');
    expect(db.getGeometryColumns()).toHaveLength(2);
    db.refreshSpatialIndex();
    expect(db.query("SELECT name FROM sqlite_temp_master WHERE name='SpatialIndex'")).toHaveLength(1);
    const bytes = db.export();
    const reopened = await SpatialiteDatabase.open(bytes); connections.push(reopened);
    expect(reopened.query("SELECT name FROM sqlite_master WHERE name='SpatialIndex'")).toHaveLength(0);
  });

  it("supports quoted identifiers, nested transactions, rollback and bound parameters", async () => {
    const db = await open();
    db.exec('CREATE TABLE "odd""table" ("geo""metry" BLOB, name TEXT)');
    db.exec('INSERT INTO "odd""table" VALUES (?, ?)', [encodeSpatialitePoint(1, 2), "O'Brien"]);
    expect(db.getTableGeoJson('odd"table', 'geo"metry').features[0]?.geometry).toEqual({ type: "Point", coordinates: [1, 2] });
    db.transaction(() => {
      expect(() => db.transaction(() => { db.exec('DELETE FROM "odd""table"'); throw new Error("abort"); })).toThrow("abort");
      expect(db.query('SELECT * FROM "odd""table"')).toHaveLength(1);
    });
    expect(() => db.transaction(() => Promise.resolve(1))).toThrow("synchronous");
  });

  it("invalidates legacy geometry metadata even when a later SQL statement fails", async () => {
    const db = await open();
    db.exec("CREATE TABLE geometry_columns(f_table_name TEXT, f_geometry_column TEXT, type TEXT, coord_dimension TEXT, srid INT, spatial_index_enabled INT); INSERT INTO geometry_columns VALUES ('places','geometry','POINT','XY',0,0)");
    expect(db.getGeometryColumns()[0]?.srid).toBe(0);
    expect(() => { db.exec("UPDATE geometry_columns SET srid=7; SELECT * FROM missing_table"); }).toThrow();
    expect(db.getGeometryColumns()[0]?.srid).toBe(7);
    expect(() => db.executePreview("UPDATE geometry_columns SET srid=9; SELECT * FROM missing_table")).toThrow();
    expect(db.getGeometryColumns()[0]?.srid).toBe(9);
    db.query("UPDATE geometry_columns SET srid=11 RETURNING srid");
    expect(db.getGeometryColumns()[0]?.srid).toBe(11);
    expect(db.getGeometryColumns()[0]?.coordDimension).toBe(2);
  });

  it("reprojects known CRS and rejects unknown CRS or bad geometry rather than silently omitting it", async () => {
    const db = await open();
    db.exec("CREATE TABLE mercator(geometry BLOB)");
    db.exec("INSERT INTO mercator VALUES (?)", [encodeSpatialitePoint(1113194.9079327357, 0, 3857)]);
    const geometry = db.getTableGeoJson("mercator").features[0]?.geometry;
    expect(geometry?.type).toBe("Point");
    if (geometry?.type === "Point") expect(geometry.coordinates[0]).toBeCloseTo(10);
    db.exec("UPDATE mercator SET geometry=?", [encodeSpatialitePoint(1, 2, 0)]);
    expect(() => db.getTableGeoJson("mercator")).toThrow("Unknown SRID");
    db.exec("UPDATE mercator SET geometry=X'FF'");
    expect(() => db.getTableGeoJson("mercator")).toThrow("too short");
  });

  it("cancels an asynchronous read, frees its statement, and blocks concurrent writes", async () => {
    const db = await open();
    db.exec("CREATE TABLE places(geometry BLOB)");
    db.exec("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<30000) INSERT INTO places SELECT MakePoint(i/1000.0,0,4326) FROM n");
    const abort = new AbortController();
    const pending = db.getTableGeoJsonAsync("places", "geometry", undefined, { signal: abort.signal,
      onProgress: () => { expect(() => { db.exec("DELETE FROM places"); }).toThrow("loading"); abort.abort(); },
    });
    await expect(pending).rejects.toThrow();
    db.exec("DELETE FROM places");
    expect(db.query("SELECT * FROM places")).toHaveLength(0);
  });

  it.each<Geometry>([
    { type: "MultiPoint", coordinates: [[1,2],[3,4]] },
    { type: "MultiLineString", coordinates: [[[1,2],[3,4]],[[5,6],[7,8]]] },
    { type: "MultiPolygon", coordinates: [[[[0,0],[1,0],[1,1],[0,0]]]] },
    { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [3,4] }] },
  ])("round-trips $type through genuine SpatiaLite entity markers and standard WKB", (geometry) => {
    const blob = geoJsonToSpatialiteBlob(geometry);
    expect(blob[47]).toBe(0x69);
    const decoded = decodeSpatialiteBlob(blob);
    expect(decoded.geometry).toEqual(geometry);
    expect(decodeSpatialiteBlob(wkbToSpatialiteBlob(decoded.wkb)).geometry).toEqual(geometry);
  });

  it("validates WKT and geometry SRIDs and uses planar length/distance correctly", async () => {
    const db = await open();
    expect(db.query("SELECT AsText(GeomFromText('POLYGON((0 0,1 0,1 1,0 0))')) AS wkt")[0]?.wkt).toBe("POLYGON((0 0, 1 0, 1 1, 0 0))");
    expect(db.query("SELECT GeomFromText('POINT(1junk 2)') AS geom")[0]?.geom).toBeNull();
    expect(db.query("SELECT ST_Length(GeomFromText('LINESTRING(0 0,3 4)',3857)) AS length")[0]?.length).toBe(5);
    expect(db.query("SELECT ST_Distance(MakePoint(0,0,3857),MakePoint(3,4,3857)) AS distance")[0]?.distance).toBe(5);
    expect(db.query("SELECT SetStartPoint(GeomFromText('LINESTRING(0 0,1 1)',4326),MakePoint(0,0,3857)) AS geom")[0]?.geom).toBeNull();
    expect(db.query("SELECT GeodesicLength(GeomFromText('LINESTRING(0 0,1 1)',3857)) AS length")[0]?.length).toBeNull();
    expect(db.query("SELECT SRID(MakePoint(1,2)) AS srid")[0]?.srid).toBe(0);
    db.export();
    expect(db.query("SELECT AsText(MakePoint(1,2)) AS wkt")[0]?.wkt).toBe("POINT(1 2)");
    expect(db.executePreview("-- leading comment\nWITH x AS (SELECT 42 AS answer) SELECT * FROM x; SELECT 2 AS last;")).toEqual([{ last: 2 }]);
  });

  it("keeps a valid connection when another file fails and escapes SQL errors", async () => {
    const app: GeoLibreAppAPI = { addGeoJsonLayer: vi.fn().mockReturnValue("layer") };
    const controller = new SpatialiteController(app);
    const container = document.createElement("div"); document.body.append(container);
    controller.render(container);
    await controller.openDatabaseFromBuffer(new Uint8Array());
    const original = controller.getDatabase();
    await expect(controller.openDatabaseFromBuffer(new Uint8Array(100).fill(255))).rejects.toThrow();
    expect(controller.getDatabase()).toBe(original);
    const editor = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!editor) throw new Error("Missing editor");
    editor.value = 'SELECT * FROM "<img src=x onerror=alert(1)>"';
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Run SQL")?.click();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("no such table");
    controller.dispose();
    expect(() => original?.getTableNames()).toThrow("closed");
  });

  it("unregisters service and UI on deactivation and supports reactivation", () => {
    const app: GeoLibreAppAPI = { addGeoJsonLayer: vi.fn(), registerRightPanel: vi.fn(() => vi.fn()), registerToolbarMenu: vi.fn(() => vi.fn()), registerService: vi.fn(), unregisterService: vi.fn() };
    const activated = plugin.activate(app);
    expect(activated).toBe(true);
    plugin.deactivate(app);
    expect(window.geolibreSpatialite).toBeUndefined();
    expect(app.unregisterService).toHaveBeenCalledWith("spatialite");
    expect(plugin.activate(app)).toBe(true);
    plugin.deactivate(app);
  });

  it("cleans up partial activation and closes an open that completes after disposal", async () => {
    const dispose = vi.fn();
    const app: GeoLibreAppAPI = {
      addGeoJsonLayer: vi.fn(), registerRightPanel: () => dispose,
      registerToolbarMenu: () => { throw new Error("host registration failed"); },
    };
    expect(() => plugin.activate(app)).toThrow("host registration failed");
    expect(dispose).toHaveBeenCalled();
    expect(window.geolibreSpatialite).toBeUndefined();
    const controller = new SpatialiteController(app);
    const pending = controller.openDatabaseFromBuffer(new Uint8Array());
    controller.dispose();
    await pending;
    expect(controller.getDatabase()).toBeNull();
  });
});


