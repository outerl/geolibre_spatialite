// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import type { SqlValue } from "./c-wasm-adapter.js";
import type { Geometry } from "geojson";
import { quoteIdentifier } from "./spatial-index.js";

export type FeatureFilterOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "LIKE" | "IS NULL" | "IS NOT NULL";
export type FeatureFilterValue = number | string | bigint | boolean;

export interface AttributeFilter {
  column: string;
  operator: FeatureFilterOperator;
  value?: FeatureFilterValue;
}

export type SourceBoundingBox = readonly [minX: number, minY: number, maxX: number, maxY: number];

export interface FeatureReadOptions {
  /** Omit for all attributes; [] loads geometry only. */
  propertyColumns?: readonly string[];
  /** Source-CRS envelope overlap. This is an envelope test, not exact geometry intersection. */
  bbox?: SourceBoundingBox;
  /** Values are bound. Dynamic column names must match actual layer columns. */
  filters?: readonly AttributeFilter[];
  /** Reject bbox reads unless a valid SpatiaLite RTree index can be used. */
  requireSpatialIndex?: boolean;
  /** Preferred feature batch size for streaming readers. */
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (features: number) => void;
}

export interface FeatureReadPlan {
  sql: string;
  params: SqlValue[];
  propertyColumns: string[];
  propertyAliases: string[];
  geometryAlias: string;
  rowIdAlias: string | null;
  bbox: SourceBoundingBox | null;
  usesSpatialIndex: boolean;
}

function validValue(value: unknown): value is FeatureFilterValue {
  return typeof value === "string" || typeof value === "bigint" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}
function finiteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

function bindValue(value: FeatureFilterValue): SqlValue {
  return typeof value === "boolean" ? Number(value) : value;
}

export function validateBoundingBox(value: unknown): SourceBoundingBox {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("bbox must contain four finite source-CRS coordinates.");
  }
  const coordinates: unknown[] = value;
  const minX = coordinates[0], minY = coordinates[1], maxX = coordinates[2], maxY = coordinates[3];
  if (!finiteNumber(minX) || !finiteNumber(minY) || !finiteNumber(maxX) || !finiteNumber(maxY)) {
    throw new Error("bbox must contain four finite source-CRS coordinates.");
  }
  if (minX > maxX || minY > maxY) throw new Error("bbox minimum coordinates must not exceed the maximum coordinates.");
  return [minX, minY, maxX, maxY];
}

export function normalizeFeatureOptions(options: FeatureReadOptions): { bbox: SourceBoundingBox | null; batchSize: number } {
  const bbox = options.bbox === undefined ? null : validateBoundingBox(options.bbox);
  const batchSize = options.batchSize ?? 256;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error("Invalid feature batch size.");
  if (options.requireSpatialIndex && !bbox) throw new Error("requireSpatialIndex can only be used with bbox.");
  return { bbox, batchSize };
}

export function buildFeatureReadPlan(input: {
  table: string;
  geometryColumn: string;
  schemaColumns: readonly string[];
  propertyColumns?: readonly string[];
  filters?: readonly AttributeFilter[];
  bbox: SourceBoundingBox | null;
  srid: number;
  useSpatialIndex: boolean;
  rowIdColumn: string | null;
  spatialIndexTable?: string | null;
  limit?: number;
}): FeatureReadPlan {
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0)) throw new Error("Invalid feature limit.");
  if (input.bbox !== null) validateBoundingBox(input.bbox);
  const resolve = (requested: string): string => {
    const match = input.schemaColumns.find((name) => name.toLowerCase() === requested.toLowerCase());
    if (!match) throw new Error(`Column ${requested} does not exist in ${input.table}.`);
    return match;
  };
  const geometryColumn = resolve(input.geometryColumn);
  if (input.propertyColumns !== undefined && !Array.isArray(input.propertyColumns)) throw new Error("propertyColumns must be an array of column names.");
  if (input.filters !== undefined && !Array.isArray(input.filters)) throw new Error("filters must be an array.");
  const properties = input.propertyColumns === undefined
    ? input.schemaColumns.filter((name) => name.toLowerCase() !== geometryColumn.toLowerCase())
    : [...new Set(input.propertyColumns.map(resolve))].filter((name) => name.toLowerCase() !== geometryColumn.toLowerCase());
  const occupied = new Set(input.schemaColumns.map((name) => name.toLowerCase()));
  const uniqueAlias = (base: string): string => {
    let alias = base;
    while (occupied.has(alias.toLowerCase())) alias += "_";
    occupied.add(alias.toLowerCase());
    return alias;
  };
  const geometryAlias = uniqueAlias("__geolibre_internal_geometry");
  const rowIdAlias = input.useSpatialIndex && input.rowIdColumn ? uniqueAlias("__geolibre_internal_rowid") : null;
  const propertyAliases = properties.map((_, index) => uniqueAlias(`__geolibre_property_${index}`));
  const filters: readonly unknown[] = input.filters ?? [];
  const params: SqlValue[] = [];
  const clauses: string[] = [];
  const supportedOperators = new Set<string>(["=", "!=", "<", "<=", ">", ">=", "LIKE", "IS NULL", "IS NOT NULL"]);
  for (const candidate of filters) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new Error("Invalid attribute filter.");
    const filter = candidate as Record<string, unknown>;
    if (typeof filter.column !== "string") throw new Error("Invalid attribute filter.");
    const column = resolve(filter.column);
    if (typeof filter.operator !== "string" || !supportedOperators.has(filter.operator)) {
      throw new Error(`Unsupported attribute filter operator: ${String(filter.operator)}.`);
    }
    const operator = filter.operator as FeatureFilterOperator;
    const quotedColumn = `__geo.${quoteIdentifier(column)}`;
    if (operator === "IS NULL" || operator === "IS NOT NULL") {
      if (filter.value !== undefined) throw new Error(`${operator} filters do not take a value.`);
      clauses.push(`${quotedColumn} ${operator}`);
      continue;
    }
    const value = filter.value;
    if (!validValue(value)) throw new Error(`Filter ${column} requires a finite non-null scalar value.`);
    if (operator === "LIKE" && typeof value !== "string") throw new Error("LIKE filters require a string value.");
    clauses.push(`${quotedColumn} ${operator} ?`);
    params.push(bindValue(value));
  }
  if (input.bbox && input.useSpatialIndex) {
    if (!input.rowIdColumn || !input.spatialIndexTable) throw new Error("The indexed layer has no usable rowid or RTree table.");
    clauses.push(`__geo.${quoteIdentifier(input.rowIdColumn)} IN (
      SELECT pkid FROM main.${quoteIdentifier(input.spatialIndexTable)}
      WHERE xmax >= ? AND xmin <= ? AND ymax >= ? AND ymin <= ?
    )`);
    params.push(input.bbox[0], input.bbox[2], input.bbox[1], input.bbox[3]);
  }
  const selections = properties.map((name, index) => {
    const alias = propertyAliases[index];
    if (alias === undefined) throw new Error("Failed to build a property column alias.");
    return `__geo.${quoteIdentifier(name)} AS ${quoteIdentifier(alias)}`;
  });
  selections.push(`__geo.${quoteIdentifier(geometryColumn)} AS ${quoteIdentifier(geometryAlias)}`);
  if (rowIdAlias && input.rowIdColumn) selections.push(`__geo.${quoteIdentifier(input.rowIdColumn)} AS ${quoteIdentifier(rowIdAlias)}`);
  let sql = `SELECT ${selections.join(", ")} FROM main.${quoteIdentifier(input.table)} AS __geo`;
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  // Bounding box post-filtering must happen before a limit so RTree false positives
  // and scan candidates cannot cause fewer than the requested number of features.
  if (input.limit !== undefined && !input.bbox) {
    sql += " LIMIT ?";
    params.push(input.limit);
  }
  return {
    sql, params, propertyColumns: properties, propertyAliases, geometryAlias, rowIdAlias,
    bbox: input.bbox, usesSpatialIndex: Boolean(input.bbox && input.useSpatialIndex),
  };
}

export function validSpatialIndexObject(type: unknown, sql: unknown): boolean {
  return type === "table" && typeof sql === "string" &&
    /CREATE\s+VIRTUAL\s+TABLE[\s\S]*?\bUSING\s+rtree\b/i.test(sql) &&
    !/\bUSING\s+rtree_i32\b/i.test(sql);
}

export function geometryEnvelopeIntersects(bounds: SourceBoundingBox | null, bbox: SourceBoundingBox): boolean {
  return bounds !== null && bounds[2] >= bbox[0] && bounds[0] <= bbox[2] && bounds[3] >= bbox[1] && bounds[1] <= bbox[3];
}

export function geometryEnvelope(geometry: Geometry): SourceBoundingBox | null {
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      const x = value[0], y = value[1];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
      }
      return;
    }
    value.forEach(visit);
  };
  if (geometry.type === "GeometryCollection") geometry.geometries.forEach((item) => {
    const envelope = geometryEnvelope(item);
    if (envelope) {
      bounds[0] = Math.min(bounds[0], envelope[0]); bounds[1] = Math.min(bounds[1], envelope[1]);
      bounds[2] = Math.max(bounds[2], envelope[2]); bounds[3] = Math.max(bounds[3], envelope[3]);
    }
  });
  else visit(geometry.coordinates);
  return bounds[0] === Infinity ? null : bounds;
}
