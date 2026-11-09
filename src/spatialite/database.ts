// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import type { Feature, FeatureCollection, Geometry } from "geojson";
import proj4 from "proj4";

import { decodeSpatialiteGeometry } from "./blob-codec.js";
import { ensureSpatialIndexView } from "./spatial-index.js";
import { createSpatialiteDatabase } from "./sqlite-engine.js";
import type { IDatabaseBackend, IStatementBackend } from "./c-wasm-adapter.js";
import {
  buildFeatureReadPlan,
  geometryEnvelope,
  geometryEnvelopeIntersects,
  normalizeFeatureOptions,
  validSpatialIndexObject,
  type FeatureReadOptions,
} from "./feature-read-plan.js";
export type { AttributeFilter, FeatureFilterOperator, FeatureFilterValue, SourceBoundingBox } from "./feature-read-plan.js";

export interface GeometryColumnInfo {
  tableName: string;
  columnName: string;
  type: string;
  coordDimension: number;
  srid: number;
  spatialIndexEnabled: boolean;
}
export type SqlValue = number | string | Uint8Array | null | bigint;
export type SqlRow = Record<string, SqlValue>;
export type GeoJsonReadOptions = FeatureReadOptions;

function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  // MessageChannel avoids timer clamping (especially costly on Windows).
  if (typeof MessageChannel !== "undefined") return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class SpatialiteDatabase {
  private db: IDatabaseBackend | null;
  private schemaVersion = -1;
  private tableNames: string[] | null = null;
  private geometryColumns: GeometryColumnInfo[] | null = null;
  private transactionDepth = 0;
  private activeReaders = 0;
  private readonly projections = new Map<number, proj4.Converter>();

  constructor(db: IDatabaseBackend) { this.db = db; }

  static async open(data?: Uint8Array | ArrayBuffer): Promise<SpatialiteDatabase> {
    return new SpatialiteDatabase(await createSpatialiteDatabase(data));
  }

  get rawDb(): IDatabaseBackend {
    if (!this.db) throw new Error("Database is closed.");
    return this.db;
  }

  get isNativeC(): boolean {
    return this.rawDb.isNativeC;
  }

  getSpatialiteVersion(): string {
    return this.rawDb.getSpatialiteVersion ? this.rawDb.getSpatialiteVersion() : "unknown";
  }

  hasGeos(): boolean {
    return this.rawDb.hasGeos ? this.rawDb.hasGeos() : false;
  }

  hasProj(): boolean {
    return this.rawDb.hasProj ? this.rawDb.hasProj() : false;
  }

  private assertIdle(): void {
    if (this.activeReaders) throw new Error("A layer is loading. Cancel it before modifying or exporting the database.");
  }

  private checkSchema(): void {
    const version = Number(this.rawDb.exec("PRAGMA main.schema_version")[0]?.values[0]?.[0]);
    if (version !== this.schemaVersion) {
      this.schemaVersion = version;
      this.tableNames = null;
      this.geometryColumns = null;
      this.projections.clear();
    }
  }

  private invalidateMetadata(sql: string): void {
    if (/\b(geometry_columns|spatial_ref_sys)\b/i.test(sql) && /\b(insert|update|delete|replace|create|drop|alter)\b/i.test(sql)) {
      this.geometryColumns = null;
      this.projections.clear();
    }
  }

  exec(sql: string, params: SqlValue[] = []): void {
    this.assertIdle();
    // A multi-statement call can change metadata before a later statement fails.
    try { this.rawDb.run(sql, params.length ? params : undefined); }
    finally { this.invalidateMetadata(sql); }
  }

  query<T = SqlRow>(sql: string, params: SqlValue[] = [], maxRows?: number): T[] {
    this.assertIdle();
    if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 0)) throw new Error("Invalid row limit.");
    let stmt: IStatementBackend | null = null;
    try {
      stmt = this.rawDb.prepare(sql);
      if (params.length) stmt.bind(params);
      const cols = stmt.getColumnNames();
      const rows: T[] = [];
      while ((maxRows === undefined || rows.length < maxRows) && stmt.step()) {
        const vals = stmt.get();
        const row: SqlRow = {};
        for (let i = 0; i < cols.length; i += 1) {
          const col = cols[i];
          if (col !== undefined) Object.defineProperty(row, col, { value: vals[i] ?? null, enumerable: true, configurable: true });
        }
        rows.push(row as T);
      }
      return rows;
    } finally { stmt?.free(); this.invalidateMetadata(sql); }
  }

  /** Execute console statements in order, retaining only a bounded result preview. */
  executePreview(sql: string, maxRows = 101): SqlRow[] | null {
    this.assertIdle();
    if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error("Invalid preview limit.");
    let result: SqlRow[] | null = null;
    try {
    for (const stmt of this.rawDb.iterateStatements(sql)) {
      try {
        const columns = stmt.getColumnNames();
        result = columns.length ? [] : null;
        let count = 0;
        while (stmt.step()) {
          if (result) {
            const values = stmt.get();
            result.push(Object.fromEntries(columns.map((key, i) => [key, values[i] ?? null])));
          }
          if (++count >= maxRows && result) break;
        }
      } finally { stmt.free(); }
    }
    return result;
    } finally { this.invalidateMetadata(sql); }
  }

  transaction<T>(fn: () => T): T {
    this.assertIdle();
    const savepoint = `spatialite_${this.transactionDepth}`;
    this.rawDb.run(`SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = fn();
      if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
        throw new Error("Transaction callbacks must be synchronous.");
      }
      this.rawDb.run(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.rawDb.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.rawDb.run(`RELEASE SAVEPOINT ${savepoint}`);
      this.geometryColumns = null;
      throw error;
    } finally { this.transactionDepth -= 1; }
  }

  getTableNames(): string[] {
    this.checkSchema();
    this.tableNames ??= this.query<{ name: string }>(
      "SELECT name FROM main.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((r) => r.name);
    return [...this.tableNames];
  }

  getGeometryColumns(): GeometryColumnInfo[] {
    this.checkSchema();
    if (!this.geometryColumns) {
      const columns: GeometryColumnInfo[] = [];
      if (this.getTableNames().some((name) => name.toLowerCase() === "geometry_columns")) {
        const info = this.query<{ name: string }>("PRAGMA table_info(geometry_columns)");
        const typeColumn = info.some((col) => col.name === "geometry_type") ? "geometry_type" : "type";
        const rows = this.query<{
          f_table_name: string; f_geometry_column: string; geometry_type: number | string;
          coord_dimension: number | string; srid: number; spatial_index_enabled: number;
        }>(`SELECT f_table_name, f_geometry_column, ${typeColumn} AS geometry_type, coord_dimension, srid, spatial_index_enabled FROM geometry_columns`);
        for (const row of rows) columns.push({
          tableName: row.f_table_name, columnName: row.f_geometry_column, type: String(row.geometry_type),
          coordDimension: typeof row.coord_dimension === "number" ? row.coord_dimension : row.coord_dimension.length,
          srid: row.srid, spatialIndexEnabled: Boolean(row.spatial_index_enabled),
        });
      } else {
        // One schema query for plain SQLite; registered SpatiaLite layers need no per-table PRAGMAs.
        const rows = this.query<{ table_name: string; column_name: string; type: string }>(`
          SELECT m.name AS table_name, p.name AS column_name, p.type
          FROM main.sqlite_master AS m JOIN pragma_table_info(m.name) AS p
          WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'
            AND m.sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND lower(p.name) = 'geometry'
        `);
        for (const row of rows) columns.push({
          tableName: row.table_name, columnName: row.column_name, type: row.type || "GEOMETRY",
          coordDimension: 2, srid: 0, spatialIndexEnabled: false,
        });
      }
      this.geometryColumns = columns;
    }
    return this.geometryColumns.map((col) => ({ ...col }));
  }

  private projectGeometry(geometry: Geometry, srid: number): Geometry {
    if (srid === 4326) return geometry;
    let converter = this.projections.get(srid);
    if (!converter) {
      let definition: string | undefined;
      if (this.getTableNames().includes("spatial_ref_sys")) {
        definition = this.query<{ proj4text: string }>("SELECT proj4text FROM spatial_ref_sys WHERE srid = ?", [srid])[0]?.proj4text;
      }
      const known: unknown = proj4.defs(`EPSG:${srid}`);
      if (!definition && !known) throw new Error(`Unknown SRID ${srid}; define its projection in spatial_ref_sys before adding the layer.`);
      converter = proj4(definition || `EPSG:${srid}`, "EPSG:4326");
      this.projections.set(srid, converter);
    }
    const project = (coords: unknown[]): void => {
      if (typeof coords[0] === "number" && typeof coords[1] === "number") {
        const result = converter.forward([coords[0], coords[1]]);
        if (!Number.isFinite(result[0]) || !Number.isFinite(result[1])) throw new Error(`Cannot transform SRID ${srid}.`);
        coords[0] = result[0]; coords[1] = result[1];
      } else for (const part of coords) if (Array.isArray(part)) project(part);
    };
    const visit = (geom: Geometry): void => {
      if (geom.type === "GeometryCollection") geom.geometries.forEach(visit);
      else project(geom.coordinates);
    };
    visit(geometry);
    return geometry;
  }

  private *readFeatures(table: string, column: string, limit: number | undefined, options: GeoJsonReadOptions): Generator<Feature<Geometry | null>> {
    this.assertIdle();
    options.signal?.throwIfAborted();
    const normalized = normalizeFeatureOptions(options);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("Invalid feature limit.");
    const tableName = this.getTableNames().find((name) => name.toLowerCase() === table.toLowerCase());
    if (!tableName) throw new Error(`Table ${table} does not exist.`);
    const schema = this.query<{ name: string }>("SELECT name FROM pragma_table_xinfo(?) WHERE hidden != 1 ORDER BY cid", [tableName]).map((row) => row.name);
    const tableInfo = this.query<{ type: string; sql: string | null }>(
      "SELECT type, sql FROM main.sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 1", [tableName],
    )[0];
    const rowIdColumn = tableInfo?.type === "table" && !/\bWITHOUT\s+ROWID\b/i.test(tableInfo.sql ?? "")
      ? ["_rowid_", "rowid", "oid"].find((candidate) => !schema.some((name) => name.toLowerCase() === candidate)) ?? null
      : null;
    const metadata = this.getGeometryColumns().find((col) => col.tableName.toLowerCase() === tableName.toLowerCase() && col.columnName.toLowerCase() === column.toLowerCase());
    const geometryColumn = schema.find((name) => name.toLowerCase() === column.toLowerCase());
    if (!geometryColumn) throw new Error(`Geometry column ${column} does not exist in ${table}.`);
    const srid = metadata?.srid ?? 0;
    let spatialIndexTable: string | null = null;
    let useSpatialIndex = false;
    if (normalized.bbox && metadata?.spatialIndexEnabled && rowIdColumn && srid > 0) {
      const indexName = `idx_${tableName}_${geometryColumn}`;
      const object = this.query<{ type: string; sql: string | null }>(
        "SELECT type, sql FROM main.sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 1", [indexName],
      )[0];
      if (validSpatialIndexObject(object?.type, object?.sql)) {
        try {
          const indexColumns = this.query<{ name: string }>("SELECT name FROM pragma_table_info(?)", [indexName]).map((row) => row.name.toLowerCase());
          useSpatialIndex = ["pkid", "xmin", "xmax", "ymin", "ymax"].every((name) => indexColumns.includes(name));
          if (useSpatialIndex) spatialIndexTable = indexName;
        } catch { useSpatialIndex = false; }
      }
    }
    if (options.requireSpatialIndex && !useSpatialIndex) {
      throw new Error(`A valid SpatiaLite spatial index is required for ${tableName}.${geometryColumn}.`);
    }
    if (limit === 0) return;
    const plan = buildFeatureReadPlan({
      table: tableName, geometryColumn, schemaColumns: schema,
      ...(options.propertyColumns === undefined ? {} : { propertyColumns: options.propertyColumns }),
      ...(options.filters === undefined ? {} : { filters: options.filters }),
      bbox: normalized.bbox, srid, useSpatialIndex, rowIdColumn, spatialIndexTable,
      ...(limit === undefined ? {} : { limit }),
    });
    if (srid > 0 && srid !== 4326) this.projectGeometry({ type: "GeometryCollection", geometries: [] }, srid);
    let stmt: IStatementBackend | null = null;
    let active = false;
    let yielded = 0;
    try {
      stmt = this.rawDb.prepare(plan.sql);
      if (plan.params.length) stmt.bind(plan.params);
      const cols = stmt.getColumnNames();
      const geomIndex = cols.findIndex((name) => name === plan.geometryAlias);
      const propIndices = plan.propertyAliases.map((alias) => cols.findIndex((name) => name === alias));
      if (geomIndex < 0 || propIndices.some((index) => index < 0)) throw new Error("SQLite returned an unexpected feature result shape.");
      const propertyTemplate: Record<string, unknown> = Object.fromEntries(plan.propertyColumns.map((key) => [key, null]));
      this.activeReaders += 1;
      active = true;
      while (stmt.step()) {
        options.signal?.throwIfAborted();
        const values = stmt.get();
        const blob = values[geomIndex];
        let geometry: Geometry | null = null;
        if (blob !== null) {
          if (!(blob instanceof Uint8Array)) throw new Error(`Geometry column ${geometryColumn} contains a non-BLOB value.`);
          const decoded = decodeSpatialiteGeometry(blob);
          if (normalized.bbox && !geometryEnvelopeIntersects(geometryEnvelope(decoded.geometry), normalized.bbox)) continue;
          // Plain SQLite can contain projected BLOBs without geometry_columns.
          if (decoded.srid !== 4326 && !this.projections.has(decoded.srid)) {
            this.activeReaders -= 1;
            try { this.projectGeometry({ type: "GeometryCollection", geometries: [] }, decoded.srid); }
            finally { this.activeReaders += 1; }
          }
          geometry = this.projectGeometry(decoded.geometry, decoded.srid);
        } else if (normalized.bbox) continue;
        const properties: Record<string, unknown> = { ...propertyTemplate };
        plan.propertyColumns.forEach((key, index) => {
          const propertyIndex = propIndices[index];
          if (propertyIndex === undefined) throw new Error("SQLite returned an unexpected feature property shape.");
          const val = values[propertyIndex];
          const value = val instanceof Uint8Array ? `[BLOB ${val.length} bytes]` : typeof val === "bigint" ? val.toString() : val;
          properties[key] = value ?? null;
        });
        yield { type: "Feature", geometry, properties };
        yielded += 1;
        if (limit !== undefined && yielded >= limit) return;
      }
    } finally { stmt?.free(); if (active) this.activeReaders -= 1; }
  }

  getTableGeoJson(table: string, column = "geometry", limit?: number, options: GeoJsonReadOptions = {}): FeatureCollection<Geometry | null> {
    return { type: "FeatureCollection", features: [...this.readFeatures(table, column, limit, options)] };
  }

  async *streamTableGeoJson(
    table: string, column = "geometry", limit?: number, options: GeoJsonReadOptions = {},
  ): AsyncIterableIterator<Feature<Geometry | null>[]> {
    const { batchSize } = normalizeFeatureOptions(options);
    let batch: Feature<Geometry | null>[] = [];
    let deadline = performance.now() + 16;
    for (const feature of this.readFeatures(table, column, limit, options)) {
      batch.push(feature);
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
        if (performance.now() >= deadline) {
          await yieldToBrowser();
          options.signal?.throwIfAborted();
          deadline = performance.now() + 16;
        }
      }
    }
    if (batch.length) yield batch;
  }

  async getTableGeoJsonAsync(table: string, column = "geometry", limit?: number, options: GeoJsonReadOptions = {}): Promise<FeatureCollection<Geometry | null>> {
    const features: Feature<Geometry | null>[] = [];
    let lastProgress = -1;
    for await (const batch of this.streamTableGeoJson(table, column, limit, options)) {
      features.push(...batch);
      options.onProgress?.(features.length);
      lastProgress = features.length;
    }
    options.signal?.throwIfAborted();
    if (lastProgress !== features.length) options.onProgress?.(features.length);
    return { type: "FeatureCollection", features };
  }

  export(): Uint8Array {
    this.assertIdle();
    if (this.transactionDepth) throw new Error("Cannot export during a transaction.");
    return this.rawDb.export();
  }

  refreshSpatialIndex(): void {
    this.assertIdle();
    this.geometryColumns = null;
    this.projections.clear();
    ensureSpatialIndexView(this.rawDb);
  }

  close(): void {
    this.assertIdle();
    if (this.db) { this.db.close(); this.db = null; }
  }
}
