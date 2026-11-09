// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import { describe, expect, it } from "vitest";

import {
  decodeSpatialiteBlob,
  encodeSpatialiteLineString,
  encodeSpatialitePoint,
} from "../src/spatialite/blob-codec.js";
import { createSpatialiteDatabase } from "../src/spatialite/sqlite-engine.js";

describe("SpatiaLite SQL Functions", () => {
  it("evaluates StartPoint, EndPoint, and PointN correctly", async () => {
    const db = await createSpatialiteDatabase();
    const lineBlob = encodeSpatialiteLineString([
      [10, 20],
      [30, 40],
      [50, 60],
    ]);

    db.run("CREATE TABLE test_lines (id INT, geom BLOB);");
    db.run("INSERT INTO test_lines VALUES (1, ?);", [lineBlob]);

    const startRes = db.exec("SELECT StartPoint(geom) FROM test_lines;");
    const startBlob = startRes[0]?.values[0]?.[0] as Uint8Array;
    expect(startBlob).toBeInstanceOf(Uint8Array);
    const decodedStart = decodeSpatialiteBlob(startBlob);
    expect(decodedStart.geometry).toEqual({ type: "Point", coordinates: [10, 20] });

    const endRes = db.exec("SELECT EndPoint(geom) FROM test_lines;");
    const endBlob = endRes[0]?.values[0]?.[0] as Uint8Array;
    const decodedEnd = decodeSpatialiteBlob(endBlob);
    expect(decodedEnd.geometry).toEqual({ type: "Point", coordinates: [50, 60] });

    const p2Res = db.exec("SELECT PointN(geom, 2) FROM test_lines;");
    const p2Blob = p2Res[0]?.values[0]?.[0] as Uint8Array;
    const decodedP2 = decodeSpatialiteBlob(p2Blob);
    expect(decodedP2.geometry).toEqual({ type: "Point", coordinates: [30, 40] });

    const numRes = db.exec("SELECT NumPoints(geom) FROM test_lines;");
    expect(numRes[0]?.values[0]?.[0]).toBe(3);

    db.close();
  });

  it("modifies vertices with SetStartPoint and SetEndPoint", async () => {
    const db = await createSpatialiteDatabase();
    const lineBlob = encodeSpatialiteLineString([
      [0, 0],
      [10, 10],
    ]);
    const newStart = encodeSpatialitePoint(5, 5);
    const newEnd = encodeSpatialitePoint(15, 15);

    db.run("CREATE TABLE test_mod (id INT, geom BLOB);");
    db.run("INSERT INTO test_mod VALUES (1, ?);", [lineBlob]);

    const resStart = db.exec("SELECT SetStartPoint(geom, ?) FROM test_mod;", [newStart]);
    const modStartBlob = resStart[0]?.values[0]?.[0] as Uint8Array;
    const decodedStartMod = decodeSpatialiteBlob(modStartBlob);
    expect(decodedStartMod.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [5, 5],
        [10, 10],
      ],
    });

    const resEnd = db.exec("SELECT SetEndPoint(geom, ?) FROM test_mod;", [newEnd]);
    const modEndBlob = resEnd[0]?.values[0]?.[0] as Uint8Array;
    const decodedEndMod = decodeSpatialiteBlob(modEndBlob);
    expect(decodedEndMod.geometry).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0],
        [15, 15],
      ],
    });

    db.close();
  });

  it("computes GeodesicLength and ST_Distance", async () => {
    const db = await createSpatialiteDatabase();
    const p1 = encodeSpatialitePoint(0, 0);
    const p2 = encodeSpatialitePoint(0, 1);
    const line = encodeSpatialiteLineString([
      [0, 0],
      [0, 1],
    ]);

    db.run("CREATE TABLE test_dist (p1 BLOB, p2 BLOB, l BLOB);");
    db.run("INSERT INTO test_dist VALUES (?, ?, ?);", [p1, p2, line]);

    const resLength = db.exec("SELECT GeodesicLength(l), ST_Length(l) FROM test_dist;");
    const len1 = resLength[0]?.values[0]?.[0] as number;
    const len2 = resLength[0]?.values[0]?.[1] as number;
    expect(len1).toBeGreaterThan(110000);
    expect(len1).toBeLessThan(112000);
    expect(len2).toBe(1);

    const resDist = db.exec("SELECT ST_Distance(p1, p2) FROM test_dist;");
    const dist = resDist[0]?.values[0]?.[0] as number;
    expect(dist).toBe(1);
    const geodesic = db.exec("SELECT ST_Distance(p1, p2, 1) FROM test_dist;")[0]?.values[0]?.[0] as number;
    expect(geodesic).toBeGreaterThan(110000);
    expect(geodesic).toBeLessThan(112000);

    db.close();
  });

  it("handles GeomFromWKB, GeomFromText, AsText, AsBinary, and AsGeoJSON with overloads", async () => {
    const db = await createSpatialiteDatabase();

    const wktRes1 = db.exec("SELECT AsText(GeomFromText('POINT(153.0 -27.5)', 4326));");
    expect(wktRes1[0]?.values[0]?.[0]).toBe("POINT(153 -27.5)");

    const wktRes2 = db.exec("SELECT ST_AsText(ST_GeomFromText('LINESTRING(0 0, 1 1)'));");
    expect(wktRes2[0]?.values[0]?.[0]).toBe("LINESTRING(0 0, 1 1)");

    const geoJsonRes = db.exec("SELECT ST_AsGeoJSON(GeomFromText('POINT(153.0 -27.5)'));");
    expect(JSON.parse(geoJsonRes[0]?.values[0]?.[0] as string)).toEqual({
      type: "Point",
      coordinates: [153, -27.5],
    });

    const sridRes = db.exec("SELECT ST_SRID(GeomFromText('POINT(153.0 -27.5)', 3857));");
    expect(sridRes[0]?.values[0]?.[0]).toBe(3857);

    const xyRes = db.exec("SELECT ST_X(ST_Point(12.3, 45.6)), ST_Y(ST_Point(12.3, 45.6, 4326));");
    expect(xyRes[0]?.values[0]?.[0]).toBe(12.3);
    expect(xyRes[0]?.values[0]?.[1]).toBe(45.6);

    const asBinRes = db.exec("SELECT AsBinary(MakePoint(1, 2)), ST_AsBinary(MakePoint(1, 2, 4326));");
    expect(asBinRes[0]?.values[0]?.[0]).toBeInstanceOf(Uint8Array);
    expect(asBinRes[0]?.values[0]?.[1]).toBeInstanceOf(Uint8Array);

    const checkIdx = db.exec("SELECT CheckSpatialIndex('nodes', 'geometry');");
    expect(checkIdx[0]?.values[0]?.[0]).toBe(0);

    db.close();
  });
});
