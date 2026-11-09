// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import type { Geometry, Position } from "geojson";

export const START_MARKER = 0x00;
export const LITTLE_ENDIAN = 0x01;
export const BIG_ENDIAN = 0x00;
export const MBR_END_MARKER = 0x7c;
export const END_MARKER = 0xfe;
export const GEOM_TYPE_POINT = 1;
export const GEOM_TYPE_LINESTRING = 2;
export const GEOM_TYPE_POLYGON = 3;
export const GEOM_TYPE_MULTIPOINT = 4;
export const GEOM_TYPE_MULTILINESTRING = 5;
export const GEOM_TYPE_MULTIPOLYGON = 6;
export const GEOM_TYPE_GEOMETRYCOLLECTION = 7;
const NAMES = ["", "Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection"];
export interface BoundingBox { minX: number; minY: number; maxX: number; maxY: number }
export interface DecodedSpatialiteGeometry {
  srid: number;
  byteOrder: "little-endian" | "big-endian";
  geometryType: number;
  geometryName: string;
  bounds: BoundingBox;
  geometry: Geometry;
  wkb: Uint8Array;
}

class Reader {
  offset = 0;
  constructor(readonly view: DataView, readonly end: number, readonly spatialite: boolean) {}
  require(bytes: number): void {
    if (bytes > this.end - this.offset) throw new Error("Geometry payload truncated.");
  }
  byte(): number { this.require(1); return this.view.getUint8(this.offset++); }
  uint(little: boolean): number { this.require(4); const n = this.view.getUint32(this.offset, little); this.offset += 4; return n; }
  point(little: boolean): [number, number] {
    this.require(16);
    const x = this.view.getFloat64(this.offset, little), y = this.view.getFloat64(this.offset + 8, little);
    this.offset += 16;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Non-finite geometry coordinates are unsupported.");
    return [x, y];
  }
  points(little: boolean): [number, number][] {
    const count = this.uint(little);
    this.require(count * 16);
    const points = new Array<[number, number]>(count);
    for (let i = 0; i < count; i++) points[i] = this.point(little);
    return points;
  }
  geometry(type: number, little: boolean, depth = 0): Geometry {
    if (depth > 32) throw new Error("Geometry nesting exceeds 32 levels.");
    switch (type) {
      case 1: return { type: "Point", coordinates: this.point(little) };
      case 2: return { type: "LineString", coordinates: this.points(little) };
      case 3: {
        const count = this.uint(little); this.require(count * 4);
        const rings: Position[][] = [];
        for (let i = 0; i < count; i++) rings.push(this.points(little));
        return { type: "Polygon", coordinates: rings };
      }
      case 4: case 5: case 6: case 7: {
        const count = this.uint(little); this.require(count * 5);
        const children: Geometry[] = [];
        for (let i = 0; i < count; i++) {
          const marker = this.byte();
          if (this.spatialite ? marker !== 0x69 : marker !== 0 && marker !== 1) throw new Error("Invalid geometry entity marker.");
          const childLittle = this.spatialite ? little : marker === 1;
          const childType = this.uint(childLittle);
          if (type !== 7 && childType !== type - 3) throw new Error("Invalid multipart geometry member type.");
          children.push(this.geometry(childType, childLittle, depth + 1));
        }
        if (type === 4) return { type: "MultiPoint", coordinates: children.map((g) => g.type === "Point" ? g.coordinates : []) };
        if (type === 5) return { type: "MultiLineString", coordinates: children.map((g) => g.type === "LineString" ? g.coordinates : []) };
        if (type === 6) return { type: "MultiPolygon", coordinates: children.map((g) => g.type === "Polygon" ? g.coordinates : []) };
        return { type: "GeometryCollection", geometries: children };
      }
      default: throw new Error(`Unsupported geometry type ${type}; only uncompressed 2D geometries are supported.`);
    }
  }
}

function readBlob(blob: Uint8Array): Omit<DecodedSpatialiteGeometry, "wkb"> {
  if (blob.length < 44) throw new Error(`SpatiaLite BLOB is too short (${blob.length} bytes; min 44).`);
  if (blob[0] !== START_MARKER) throw new Error("Invalid SpatiaLite start marker.");
  if (blob[1] !== 0 && blob[1] !== 1) throw new Error("Unsupported byte order or TinyPoint encoding.");
  if (blob[38] !== MBR_END_MARKER || blob[blob.length - 1] !== END_MARKER) throw new Error("Invalid SpatiaLite boundary marker.");
  const little = blob[1] === 1;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const reader = new Reader(view, blob.length - 1, true);
  reader.offset = 39;
  const geometryType = reader.uint(little);
  const geometry = reader.geometry(geometryType, little);
  if (reader.offset !== reader.end) throw new Error("Unexpected trailing geometry payload.");
  return {
    srid: view.getInt32(2, little), byteOrder: little ? "little-endian" : "big-endian",
    geometryType, geometryName: NAMES[geometryType] ?? "Unknown", geometry,
    bounds: { minX: view.getFloat64(6, little), minY: view.getFloat64(14, little), maxX: view.getFloat64(22, little), maxY: view.getFloat64(30, little) },
  };
}

/** Fast map path: decode once, without allocating an unused WKB copy per feature. */
export function decodeSpatialiteGeometry(blob: Uint8Array): { geometry: Geometry; srid: number } {
  return readBlob(blob);
}

export function decodeSpatialiteBlob(blob: Uint8Array): DecodedSpatialiteGeometry {
  const decoded = readBlob(blob);
  return { ...decoded, wkb: geometryToWkb(decoded.geometry) };
}

function typeOf(geometry: Geometry): number { return NAMES.indexOf(geometry.type); }
function childrenOf(geometry: Geometry): Geometry[] {
  switch (geometry.type) {
    case "MultiPoint": return geometry.coordinates.map((coordinates) => ({ type: "Point", coordinates }));
    case "MultiLineString": return geometry.coordinates.map((coordinates) => ({ type: "LineString", coordinates }));
    case "MultiPolygon": return geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
    case "GeometryCollection": return geometry.geometries;
    default: return [];
  }
}
function payloadSize(geometry: Geometry): number {
  switch (geometry.type) {
    case "Point": return 16;
    case "LineString": return 4 + geometry.coordinates.length * 16;
    case "Polygon": return 4 + geometry.coordinates.reduce((sum, ring) => sum + 4 + ring.length * 16, 0);
    default: return 4 + childrenOf(geometry).reduce((sum, child) => sum + 5 + payloadSize(child), 0);
  }
}
function writeGeometry(view: DataView, offset: number, geometry: Geometry, spatialite: boolean, bounds: BoundingBox): number {
  view.setUint32(offset, typeOf(geometry), true); offset += 4;
  const uint = (n: number): void => { view.setUint32(offset, n, true); offset += 4; };
  const point = (p: Position): void => {
    const [x, y] = p;
    if (p.length !== 2 || x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Only finite 2D coordinates are supported.");
    view.setFloat64(offset, x, true); view.setFloat64(offset + 8, y, true); offset += 16;
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  };
  const points = (positions: Position[]): void => { uint(positions.length); positions.forEach(point); };
  switch (geometry.type) {
    case "Point": point(geometry.coordinates); break;
    case "LineString":
      if (geometry.coordinates.length < 2) throw new Error("LineString requires at least 2 points.");
      points(geometry.coordinates); break;
    case "Polygon":
      if (!geometry.coordinates.length) throw new Error("Polygon requires at least an exterior ring.");
      uint(geometry.coordinates.length);
      for (const ring of geometry.coordinates) {
        if (ring.length < 4 || ring[0]?.[0] !== ring[ring.length - 1]?.[0] || ring[0]?.[1] !== ring[ring.length - 1]?.[1]) throw new Error("Polygon rings must be closed and contain at least four coordinates.");
        points(ring);
      }
      break;
    default: {
      const children = childrenOf(geometry); uint(children.length);
      for (const child of children) { view.setUint8(offset++, spatialite ? 0x69 : 1); offset = writeGeometry(view, offset, child, spatialite, bounds); }
    }
  }
  return offset;
}
function emptyBounds(): BoundingBox { return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; }
function geometryToWkb(geometry: Geometry): Uint8Array {
  const bytes = new Uint8Array(5 + payloadSize(geometry)); bytes[0] = 1;
  writeGeometry(new DataView(bytes.buffer), 1, geometry, false, emptyBounds());
  return bytes;
}
export function geoJsonToSpatialiteBlob(geometry: Geometry, srid = 4326): Uint8Array {
  if (!Number.isInteger(srid) || srid < -2147483648 || srid > 2147483647) throw new Error("Invalid SRID.");
  const bytes = new Uint8Array(44 + payloadSize(geometry));
  const view = new DataView(bytes.buffer), bounds = emptyBounds();
  bytes[0] = 0; bytes[1] = 1; bytes[38] = 0x7c; bytes[bytes.length - 1] = 0xfe;
  view.setInt32(2, srid, true);
  writeGeometry(view, 39, geometry, true, bounds);
  view.setFloat64(6, bounds.minX, true); view.setFloat64(14, bounds.minY, true);
  view.setFloat64(22, bounds.maxX, true); view.setFloat64(30, bounds.maxY, true);
  return bytes;
}
export function encodeSpatialitePoint(x: number, y: number, srid = 4326): Uint8Array {
  return geoJsonToSpatialiteBlob({ type: "Point", coordinates: [x, y] }, srid);
}
export function encodeSpatialiteLineString(coordinates: readonly [number, number][], srid = 4326): Uint8Array {
  return geoJsonToSpatialiteBlob({ type: "LineString", coordinates: coordinates as [number, number][] }, srid);
}
export function encodeSpatialitePolygon(rings: readonly (readonly [number, number][])[], srid = 4326): Uint8Array {
  return geoJsonToSpatialiteBlob({ type: "Polygon", coordinates: rings as [number, number][][] }, srid);
}
export function wkbToSpatialiteBlob(wkb: Uint8Array, srid = 4326): Uint8Array {
  if (wkb.length < 5) throw new Error("Invalid WKB buffer: too short.");
  if (wkb[0] !== 0 && wkb[0] !== 1) throw new Error("Invalid WKB byte order.");
  const reader = new Reader(new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength), wkb.length, false);
  reader.offset = 1;
  const little = wkb[0] === 1;
  const geometry = reader.geometry(reader.uint(little), little);
  if (reader.offset !== reader.end) throw new Error("Unexpected trailing WKB payload.");
  return geoJsonToSpatialiteBlob(geometry, srid);
}
