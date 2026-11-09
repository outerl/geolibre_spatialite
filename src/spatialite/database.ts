import type { Database, Statement } from "sql.js";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import proj4 from "proj4";

import { decodeSpatialiteGeometry } from "./blob-codec.js";
import { ensureSpatialIndexView, quoteIdentifier } from "./spatial-index.js";
import { createSpatialiteDatabase } from "./sqlite-engine.js";

export interface GeometryColumnInfo {
  tableName: string;
  columnName: string;
  type: string;
  coordDimension: number;
  srid: number;
  spatialIndexEnabled: boolean;
}
export type SqlValue = number | string | Uint8Array | null;
export type SqlRow = Record<string, SqlValue>;
export interface GeoJsonReadOptions {
  /** Omit for all attributes; [] loads geometry only. */
  propertyColumns?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (features: number) => void;
}

export class SpatialiteDatabase {
  private db: Database | null;
  private schemaVersion = -1;
  private tableNames: string[] | null = null;
  private geometryColumns: GeometryColumnInfo[] | null = null;
  private transactionDepth = 0;
  private activeReaders = 0;
  private readonly projections = new Map<number, proj4.Converter>();

  constructor(db: Database) { this.db = db; }

  static async open(data?: Uint8Array | ArrayBuffer): Promise<SpatialiteDatabase> {
    return new SpatialiteDatabase(await createSpatialiteDatabase(data));
  }

  get rawDb(): Database {
    if (!this.db) throw new Error("Database is closed.");
    return this.db;
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

  exec(sql: string, params: SqlValue[] = []): void {
    this.assertIdle();
    this.rawDb.run(sql, params.length ? params : undefined);
    // Metadata DML does not change schema_version. Ordinary data edits need no scan.
    if (/\b(geometry_columns|spatial_ref_sys)\b/i.test(sql)) {
      this.geometryColumns = null;
      this.projections.clear();
    }
  }

  query<T = SqlRow>(sql: string, params: SqlValue[] = [], maxRows?: number): T[] {
    this.assertIdle();
    if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 0)) throw new Error("Invalid row limit.");
    let stmt: Statement | null = null;
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
    } finally { stmt?.free(); }
  }

  /** Execute console statements in order, retaining only a bounded result preview. */
  executePreview(sql: string, maxRows = 101): SqlRow[] | null {
    this.assertIdle();
    let result: SqlRow[] | null = null;
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
    this.geometryColumns = null;
    return result;
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
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("Invalid feature limit.");
    // Resolve/cache projections before starting the cursor (query() rejects concurrent SQL).
    const metadata = this.getGeometryColumns().find((col) => col.tableName.toLowerCase() === table.toLowerCase() && col.columnName.toLowerCase() === column.toLowerCase());
    if (metadata && metadata.srid !== 4326 && metadata.srid > 0) this.projectGeometry({ type: "GeometryCollection", geometries: [] }, metadata.srid);
    const selection = options.propertyColumns === undefined ? "*" : [...new Set([column, ...options.propertyColumns])].map(quoteIdentifier).join(", ");
    const stmt = this.rawDb.prepare(`SELECT ${selection} FROM ${quoteIdentifier(table)}${limit === undefined ? "" : " LIMIT ?"}`);
    if (limit !== undefined) stmt.bind([limit]);
    const cols = stmt.getColumnNames();
    const geomIndex = cols.findIndex((name) => name.toLowerCase() === column.toLowerCase());
    // Give every row the same compact object shape, even for wide tables.
    const propertyTemplate: Record<string, unknown> = Object.fromEntries(cols.filter((_, i) => i !== geomIndex).map((key) => [key, null]));
    this.activeReaders += 1;
    try {
      if (geomIndex < 0) throw new Error(`Geometry column ${column} does not exist in ${table}.`);
      while (stmt.step()) {
        options.signal?.throwIfAborted();
        const values = stmt.get();
        const blob = values[geomIndex];
        let geometry: Geometry | null = null;
        if (blob !== null) {
          if (!(blob instanceof Uint8Array)) throw new Error(`Geometry column ${column} contains a non-BLOB value.`);
          const decoded = decodeSpatialiteGeometry(blob);
          // Plain SQLite can contain projected BLOBs without geometry_columns.
          if (decoded.srid !== 4326 && !this.projections.has(decoded.srid)) {
            this.activeReaders -= 1;
            try { this.projectGeometry({ type: "GeometryCollection", geometries: [] }, decoded.srid); }
            finally { this.activeReaders += 1; }
          }
          geometry = this.projectGeometry(decoded.geometry, decoded.srid);
        }
        const properties: Record<string, unknown> = { ...propertyTemplate };
        for (let i = 0; i < cols.length; i += 1) {
          const key = cols[i];
          if (i === geomIndex || key === undefined) continue;
          const val = values[i];
          const value = val instanceof Uint8Array ? `[BLOB ${val.length} bytes]` : val;
          properties[key] = value;
        }
        yield { type: "Feature", geometry, properties };
      }
    } finally { stmt.free(); this.activeReaders -= 1; }
  }

  getTableGeoJson(table: string, column = "geometry", limit?: number, options: GeoJsonReadOptions = {}): FeatureCollection<Geometry | null> {
    return { type: "FeatureCollection", features: [...this.readFeatures(table, column, limit, options)] };
  }

  async getTableGeoJsonAsync(table: string, column = "geometry", limit?: number, options: GeoJsonReadOptions = {}): Promise<FeatureCollection<Geometry | null>> {
    const features: Feature<Geometry | null>[] = [];
    let deadline = performance.now() + 16;
    for (const feature of this.readFeatures(table, column, limit, options)) {
      features.push(feature);
      if (features.length % 256 === 0 && performance.now() >= deadline) {
        options.onProgress?.(features.length);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        options.signal?.throwIfAborted();
        deadline = performance.now() + 16;
      }
    }
    options.signal?.throwIfAborted();
    options.onProgress?.(features.length);
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
