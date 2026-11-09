import type { Database } from "sql.js";
import type { Geometry, Position } from "geojson";
import { decodeSpatialiteBlob, decodeSpatialiteGeometry, encodeSpatialitePoint, geoJsonToSpatialiteBlob, wkbToSpatialiteBlob } from "./blob-codec.js";
import { haversineDistance, lineStringGeodesicLength, vincentyDistance } from "./geodesic.js";

function splitParts(text: string): string[] {
  const parts: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")") depth--;
    if (depth < 0) throw new Error("Invalid WKT parentheses.");
    if (text[i] === "," && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (depth !== 0) throw new Error("Invalid WKT parentheses.");
  parts.push(text.slice(start).trim()); return parts;
}
function unwrap(text: string): string {
  if (!text.startsWith("(") || !text.endsWith(")")) throw new Error("Invalid WKT parentheses.");
  return text.slice(1, -1).trim();
}
function parseWkt(text: string, depth = 0): Geometry {
  if (depth > 32) throw new Error("WKT nesting exceeds 32 levels.");
  const match = /^\s*([A-Z]+)\s*(\(.*\))\s*$/is.exec(text);
  if (!match?.[1] || !match[2]) throw new Error("Unsupported or invalid WKT.");
  const body = unwrap(match[2]);
  const point = (str: string): Position => {
    const parts = str.trim().split(/\s+/);
    if (parts.length !== 2 || parts.some((n) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(n))) throw new Error("Invalid 2D WKT coordinate.");
    return parts.map(Number);
  };
  const line = (str: string): Position[] => splitParts(str).map(point);
  const polygon = (str: string): Position[][] => splitParts(str).map((ring) => line(unwrap(ring)));
  switch (match[1].toUpperCase()) {
    case "POINT": return { type: "Point", coordinates: point(body) };
    case "LINESTRING": return { type: "LineString", coordinates: line(body) };
    case "POLYGON": return { type: "Polygon", coordinates: polygon(body) };
    case "MULTIPOINT": return { type: "MultiPoint", coordinates: splitParts(body).map((part) => point(part.startsWith("(") ? unwrap(part) : part)) };
    case "MULTILINESTRING": return { type: "MultiLineString", coordinates: splitParts(body).map((part) => line(unwrap(part))) };
    case "MULTIPOLYGON": return { type: "MultiPolygon", coordinates: splitParts(body).map((part) => polygon(unwrap(part))) };
    case "GEOMETRYCOLLECTION": return { type: "GeometryCollection", geometries: splitParts(body).map((part) => parseWkt(part, depth + 1)) };
    default: throw new Error("Unsupported WKT geometry type.");
  }
}
function toWkt(geometry: Geometry): string {
  const point = (p: Position): string => p.join(" ");
  const line = (p: Position[]): string => `(${p.map(point).join(", ")})`;
  const polygon = (p: Position[][]): string => `(${p.map(line).join(", ")})`;
  switch (geometry.type) {
    case "Point": return `POINT(${point(geometry.coordinates)})`;
    case "LineString": return `LINESTRING${line(geometry.coordinates)}`;
    case "Polygon": return `POLYGON${polygon(geometry.coordinates)}`;
    case "MultiPoint": return `MULTIPOINT${line(geometry.coordinates)}`;
    case "MultiLineString": return `MULTILINESTRING${polygon(geometry.coordinates)}`;
    case "MultiPolygon": return `MULTIPOLYGON(${geometry.coordinates.map(polygon).join(", ")})`;
    case "GeometryCollection": return `GEOMETRYCOLLECTION(${geometry.geometries.map(toWkt).join(", ")})`;
  }
}
function decode(value: unknown): ReturnType<typeof decodeSpatialiteGeometry> {
  if (!(value instanceof Uint8Array)) throw new Error("Expected a geometry BLOB.");
  return decodeSpatialiteGeometry(value);
}
function srid(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("Invalid SRID.");
  return value;
}
function fromWkb(value: unknown, projection: number): Uint8Array {
  if (typeof value === "string") {
    if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("Invalid WKB hex.");
    value = Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  }
  if (!(value instanceof Uint8Array)) throw new Error("Expected WKB bytes.");
  return wkbToSpatialiteBlob(value, projection);
}
function lines(geometry: Geometry): Position[][] {
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(lines);
  return [];
}
function planarLength(geometry: Geometry): number {
  let result = 0;
  for (const line of lines(geometry)) for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    if (a && b) result += Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0));
  }
  return result;
}

/** A documented subset of SpatiaLite-compatible SQL functions, not libspatialite. */
export function registerSpatialFunctions(db: Database): void {
  const register = (names: string[], fn: (...args: unknown[]) => unknown): void => {
    const safe = (...args: unknown[]): unknown => { try { return fn(...args); } catch { return null; } };
    Object.defineProperty(safe, "length", { value: fn.length });
    for (const name of names) db.create_function(name, safe);
  };
  const endpoint = (value: unknown, n: number): Uint8Array | null => {
    const d = decode(value);
    if (d.geometry.type !== "LineString" || !Number.isInteger(n)) return null;
    const coords = d.geometry.coordinates;
    const p = coords[n < 0 ? coords.length + n : n];
    return p ? encodeSpatialitePoint(p[0] ?? 0, p[1] ?? 0, d.srid) : null;
  };
  register(["StartPoint", "ST_StartPoint"], (g: unknown) => endpoint(g, 0));
  register(["EndPoint", "ST_EndPoint"], (g: unknown) => endpoint(g, -1));
  register(["PointN", "ST_PointN"], (g: unknown, n: unknown) => typeof n === "number" && n > 0 ? endpoint(g, n - 1) : null);
  register(["NumPoints", "ST_NumPoints"], (g: unknown) => { const d = decode(g); return d.geometry.type === "LineString" ? d.geometry.coordinates.length : null; });
  const setEndpoint = (g: unknown, p: unknown, end: boolean): Uint8Array | null => {
    const line = decode(g), point = decode(p);
    if (line.srid !== point.srid || line.geometry.type !== "LineString" || point.geometry.type !== "Point") return null;
    line.geometry.coordinates[end ? line.geometry.coordinates.length - 1 : 0] = point.geometry.coordinates;
    return geoJsonToSpatialiteBlob(line.geometry, line.srid);
  };
  register(["SetStartPoint", "ST_SetStartPoint"], (g: unknown, p: unknown) => setEndpoint(g, p, false));
  register(["SetEndPoint", "ST_SetEndPoint"], (g: unknown, p: unknown) => setEndpoint(g, p, true));
  register(["GeodesicLength"], (g: unknown) => {
    const d = decode(g); if (d.srid !== 4326) return null;
    return lines(d.geometry).reduce((sum, line) => sum + lineStringGeodesicLength(line as [number, number][]), 0);
  });
  register(["ST_Length", "GLength"], (g: unknown) => planarLength(decode(g).geometry));
  register(["ST_Length", "GLength"], (g: unknown, ellipsoid: unknown) => {
    const d = decode(g); if (d.srid !== 4326) return null;
    const distance = ellipsoid ? vincentyDistance : haversineDistance;
    let total = 0;
    for (const line of lines(d.geometry)) for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i]; if (a && b) total += distance(a as [number, number], b as [number, number]);
    }
    return total;
  });
  register(["GeomFromWKB", "ST_GeomFromWKB"], (g: unknown) => fromWkb(g, 0));
  register(["GeomFromWKB", "ST_GeomFromWKB"], (g: unknown, s: unknown) => fromWkb(g, srid(s)));
  register(["GeomFromText", "ST_GeomFromText"], (g: unknown) => typeof g === "string" ? geoJsonToSpatialiteBlob(parseWkt(g), 0) : null);
  register(["GeomFromText", "ST_GeomFromText"], (g: unknown, s: unknown) => typeof g === "string" ? geoJsonToSpatialiteBlob(parseWkt(g), srid(s)) : null);
  register(["AsBinary", "ST_AsBinary"], (g: unknown) => g instanceof Uint8Array ? decodeSpatialiteBlob(g).wkb : null);
  register(["AsText", "ST_AsText"], (g: unknown) => toWkt(decode(g).geometry));
  register(["AsGeoJSON", "ST_AsGeoJSON"], (g: unknown) => JSON.stringify(decode(g).geometry));
  register(["MakePoint", "ST_Point"], (x: unknown, y: unknown) => typeof x === "number" && typeof y === "number" ? encodeSpatialitePoint(x, y, 0) : null);
  register(["MakePoint", "ST_Point"], (x: unknown, y: unknown, s: unknown) => typeof x === "number" && typeof y === "number" ? encodeSpatialitePoint(x, y, srid(s)) : null);
  register(["X", "ST_X"], (g: unknown) => { const d = decode(g); return d.geometry.type === "Point" ? d.geometry.coordinates[0] : null; });
  register(["Y", "ST_Y"], (g: unknown) => { const d = decode(g); return d.geometry.type === "Point" ? d.geometry.coordinates[1] : null; });
  register(["SRID", "ST_SRID"], (g: unknown) => decode(g).srid);
  const distance = (g: unknown, h: unknown, ellipsoid?: unknown): number | null => {
    const a = decode(g), b = decode(h);
    if (a.srid !== b.srid || a.geometry.type !== "Point" || b.geometry.type !== "Point") return null;
    const p = a.geometry.coordinates as [number, number], q = b.geometry.coordinates as [number, number];
    if (ellipsoid === undefined) return Math.hypot(p[0] - q[0], p[1] - q[1]);
    return a.srid === 4326 ? (ellipsoid ? vincentyDistance : haversineDistance)(p, q) : null;
  };
  register(["Distance", "ST_Distance"], (g: unknown, h: unknown) => distance(g, h));
  register(["Distance", "ST_Distance"], (g: unknown, h: unknown, ellipsoid: unknown) => distance(g, h, ellipsoid));
  // No SpatiaLite R*Tree module is linked. Do not falsely report a valid index.
  register(["CheckSpatialIndex"], (_table: unknown, _column: unknown) => 0);
}
