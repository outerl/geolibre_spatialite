import { describe, expect, it } from "vitest";

import {
  decodeSpatialiteBlob,
  encodeSpatialiteLineString,
  encodeSpatialitePoint,
  encodeSpatialitePolygon,
  geoJsonToSpatialiteBlob,
  wkbToSpatialiteBlob,
  GEOM_TYPE_LINESTRING,
  GEOM_TYPE_POINT,
  GEOM_TYPE_POLYGON,
} from "../src/spatialite/blob-codec.js";

describe("SpatiaLite BLOB Codec", () => {
  it("encodes and decodes a 2D Point correctly", () => {
    const blob = encodeSpatialitePoint(153.0251, -27.4698, 4326);
    expect(blob.length).toBe(60);

    const decoded = decodeSpatialiteBlob(blob);
    expect(decoded.srid).toBe(4326);
    expect(decoded.geometryType).toBe(GEOM_TYPE_POINT);
    expect(decoded.geometry.type).toBe("Point");
    if (decoded.geometry.type === "Point") {
      expect(decoded.geometry.coordinates).toEqual([153.0251, -27.4698]);
    }
    expect(decoded.bounds).toEqual({
      minX: 153.0251,
      minY: -27.4698,
      maxX: 153.0251,
      maxY: -27.4698,
    });
  });

  it("encodes and decodes a 2D LineString correctly", () => {
    const coords: [number, number][] = [
      [153.0, -27.0],
      [153.1, -27.1],
      [153.2, -27.2],
    ];
    const blob = encodeSpatialiteLineString(coords, 4326);
    const decoded = decodeSpatialiteBlob(blob);

    expect(decoded.srid).toBe(4326);
    expect(decoded.geometryType).toBe(GEOM_TYPE_LINESTRING);
    expect(decoded.geometry.type).toBe("LineString");
    if (decoded.geometry.type === "LineString") {
      expect(decoded.geometry.coordinates).toEqual(coords);
    }
    expect(decoded.bounds.minX).toBe(153.0);
    expect(decoded.bounds.maxX).toBe(153.2);
    expect(decoded.bounds.minY).toBe(-27.2);
    expect(decoded.bounds.maxY).toBe(-27.0);
  });

  it("encodes and decodes a Polygon correctly", () => {
    const ring: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    const blob = encodeSpatialitePolygon([ring], 4326);
    const decoded = decodeSpatialiteBlob(blob);

    expect(decoded.srid).toBe(4326);
    expect(decoded.geometryType).toBe(GEOM_TYPE_POLYGON);
    expect(decoded.geometry.type).toBe("Polygon");
    if (decoded.geometry.type === "Polygon") {
      expect(decoded.geometry.coordinates).toEqual([ring]);
    }
  });

  it("converts GeoJSON to SpatiaLite BLOB and back", () => {
    const pointGeoJson = { type: "Point" as const, coordinates: [10, 20] };
    const blob = geoJsonToSpatialiteBlob(pointGeoJson, 4326);
    const decoded = decodeSpatialiteBlob(blob);
    expect(decoded.geometry).toEqual(pointGeoJson);
  });

  it("converts WKB to SpatiaLite BLOB", () => {
    const pointBlob = encodeSpatialitePoint(5.0, 10.0, 4326);
    const decodedPoint = decodeSpatialiteBlob(pointBlob);
    const wkbBlob = wkbToSpatialiteBlob(decodedPoint.wkb, 4326);
    const decodedWkb = decodeSpatialiteBlob(wkbBlob);
    expect(decodedWkb.geometry).toEqual(decodedPoint.geometry);
  });

  it("throws on invalid or truncated SpatiaLite BLOB", () => {
    expect(() => decodeSpatialiteBlob(new Uint8Array([0, 1, 2]))).toThrow(/too short/);
    const badStart = encodeSpatialitePoint(0, 0);
    badStart[0] = 0x99;
    expect(() => decodeSpatialiteBlob(badStart)).toThrow(/start marker/);
  });
});
