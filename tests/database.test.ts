import { describe, expect, it } from "vitest";

import { SpatialiteDatabase } from "../src/spatialite/database.js";
import { encodeSpatialitePoint } from "../src/spatialite/blob-codec.js";

describe("SpatialiteDatabase wrapper", () => {
  it("opens an in-memory database and handles transactions", async () => {
    const db = await SpatialiteDatabase.open();

    db.exec("CREATE TABLE items (id INT, val TEXT);");

    // Successful transaction
    db.transaction(() => {
      db.exec("INSERT INTO items VALUES (1, 'apple');");
      db.exec("INSERT INTO items VALUES (2, 'banana');");
    });
    expect(db.query("SELECT count(*) as count FROM items;")[0]?.count).toBe(2);

    // Failed transaction rolls back
    expect(() => {
      db.transaction(() => {
        db.exec("INSERT INTO items VALUES (3, 'cherry');");
        throw new Error("Deliberate abort");
      });
    }).toThrow(/Deliberate abort/);

    expect(db.query("SELECT count(*) as count FROM items;")[0]?.count).toBe(2);

    db.close();
  });

  it("exports database bytes and can re-open them", async () => {
    const db1 = await SpatialiteDatabase.open();
    db1.exec("CREATE TABLE cities (name TEXT, population INT);");
    db1.exec("INSERT INTO cities VALUES ('Brisbane', 2600000);");

    const exportedBytes = db1.export();
    expect(exportedBytes.length).toBeGreaterThan(0);
    db1.close();

    const db2 = await SpatialiteDatabase.open(exportedBytes);
    const rows = db2.query<{ name: string; population: number }>("SELECT name, population FROM cities;");
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe("Brisbane");
    expect(rows[0]?.population).toBe(2600000);
    db2.close();
  });

  it("extracts GeoJSON from a spatial table", async () => {
    const db = await SpatialiteDatabase.open();
    db.exec("CREATE TABLE pois (id INT, name TEXT, geometry BLOB);");
    const pt = encodeSpatialitePoint(153.0, -27.5);
    db.rawDb.run("INSERT INTO pois VALUES (101, 'Tower', ?);", [pt]);

    const fc = db.getTableGeoJson("pois");
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.length).toBe(1);
    expect(fc.features[0]?.properties?.name).toBe("Tower");
    expect(fc.features[0]?.geometry).toEqual({
      type: "Point",
      coordinates: [153.0, -27.5],
    });

    db.close();
  });
});
