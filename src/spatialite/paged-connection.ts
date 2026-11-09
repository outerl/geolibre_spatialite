// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import type { Feature, FeatureCollection, Geometry } from "geojson";
import proj4 from "proj4";
import PagedDatabaseWorker from "./paged-database.worker.ts?worker&inline";

import { decodeSpatialiteGeometry } from "./blob-codec.js";
import type { GeometryColumnInfo, GeoJsonReadOptions, SqlRow, SqlValue } from "./database.js";
import {
  buildFeatureReadPlan,
  geometryEnvelope,
  geometryEnvelopeIntersects,
  normalizeFeatureOptions,
  validSpatialIndexObject,
} from "./feature-read-plan.js";
import { quoteIdentifier } from "./spatial-index.js";
import type { PagedCursorBatch, PagedFileStats } from "./readonly-worker-database.js";

export interface PagedOpenOptions {
  /** SQLite page cache in MiB. Defaults to 32 and is limited to 1–512 MiB. */
  cacheMiB?: number;
  signal?: AbortSignal;
}

export interface PagedQueryOptions {
  /** Maximum rows to return in this materialized result. Defaults to 10,000. */
  maxRows?: number;
  /** Maximum serialized row payload. Defaults to 4 MiB and is limited to 1–16 MiB. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface PagedStreamOptions {
  batchSize?: number;
  /** Optional hard per-stream row bound. Omit to stream until exhausted. */
  maxRows?: number;
  /** Maximum serialized row payload per pull batch. Defaults to 4 MiB. */
  maxBytes?: number;
  signal?: AbortSignal;
}

interface PagedWorkerRequest {
  id: number;
  type: string;
  [key: string]: unknown;
}
interface WorkerCommand { type: string; [key: string]: unknown }

interface PagedWorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface WorkerLike {
  onmessage: ((event: MessageEvent<PagedWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
  postMessage(message: PagedWorkerRequest): void;
  terminate(): void;
}

interface CursorStart { cursorId: number; columns: string[] }
interface QueryPage { columns: string[]; rows: SqlRow[]; truncated: boolean }

const MAX_QUERY_ROWS = 10_000;
const MAX_STREAM_ROWS = 10_000_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;

function asAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The paged database operation was aborted; reopen the file to continue.", "AbortError");
}

function validateBound(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${label}.`);
  return value;
}

function createBundledWorker(): WorkerLike {
  if (typeof Worker === "undefined") throw new Error("Paged reads require Web Worker support.");
  return new PagedDatabaseWorker();
}

/** Asynchronous read-only API over one dedicated native WORKERFS worker. */
export class PagedSpatialiteConnection {
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();
  private state: "opening" | "open" | "closed" = "opening";
  private terminationError: Error | null = null;
  private openElapsedMs = 0;
  private readonly projections = new Map<number, proj4.Converter>();

  private constructor(private readonly worker: WorkerLike) {
    this.worker.onmessage = (event): void => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error ?? "Paged worker request failed."));
    };
    this.worker.onerror = (event): void => {
      this.terminate(new Error(event.message || "Paged worker failed."));
    };
    this.worker.onmessageerror = (): void => {
      this.terminate(new Error("Paged worker returned an unreadable response."));
    };
  }

  static async open(blob: Blob, options: PagedOpenOptions = {}, workerFactory: () => Promise<WorkerLike> | WorkerLike = createBundledWorker): Promise<PagedSpatialiteConnection> {
    if (!(blob instanceof Blob)) throw new TypeError("openFile expects a Blob or File.");
    const cacheMiB = validateBound(options.cacheMiB ?? 32, "SQLite cache size", 1, 512);
    if (options.signal?.aborted) throw asAbortError(options.signal);
    const started = performance.now();
    const worker = await workerFactory();
    if (options.signal?.aborted) {
      worker.terminate();
      throw asAbortError(options.signal);
    }
    const connection = new PagedSpatialiteConnection(worker);
    const abort = (): void => { connection.terminate(asAbortError(options.signal as AbortSignal)); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await connection.request({ type: "open", blob, cacheMiB });
      if (options.signal?.aborted) throw asAbortError(options.signal);
      if (connection.state === "closed") throw connection.terminationError ?? new Error("Paged database opening was cancelled.");
      connection.openElapsedMs = performance.now() - started;
      connection.state = "open";
      return connection;
    } catch (cause) {
      connection.terminate(cause instanceof Error ? cause : new Error(String(cause)));
      throw cause;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private assertOpen(): void {
    if (this.state !== "open") throw this.terminationError ?? new Error("Paged database is not open.");
  }

  private request<T>(message: WorkerCommand): Promise<T> {
    if (this.terminationError) return Promise.reject(this.terminationError);
    if (this.state === "closed") return Promise.reject(new Error("Paged database is closed."));
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try { this.worker.postMessage({ ...message, id }); }
      catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  private terminate(cause: Error): void {
    if (this.state === "closed") return;
    this.terminationError = cause;
    this.state = "closed";
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(cause);
    this.pending.clear();
  }

  /** A bounded, materialized read. Use streamQuery for larger result sets. */
  async query<T extends SqlRow = SqlRow>(sql: string, params: SqlValue[] = [], options: PagedQueryOptions = {}): Promise<T[]> {
    this.assertOpen();
    const maxRows = validateBound(options.maxRows ?? MAX_QUERY_ROWS, "query row limit", 1, MAX_QUERY_ROWS);
    const maxBytes = validateBound(options.maxBytes ?? DEFAULT_MAX_BYTES, "query byte limit", 1, MAX_BYTES);
    if (options.signal?.aborted) throw asAbortError(options.signal);
    const abort = (): void => { this.terminate(asAbortError(options.signal as AbortSignal)); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const page = await this.request<QueryPage>({ type: "query", sql, params, maxRows, maxBytes });
      if (page.truncated) throw new Error("The query result exceeded its row or byte bound; use streamQuery() to pull batches.");
      return page.rows as T[];
    } finally { options.signal?.removeEventListener("abort", abort); }
  }

  /** Pull one bounded row batch at a time. Early iterator return finalizes its SQLite statement. */
  async *streamQuery<T extends SqlRow = SqlRow>(sql: string, params: SqlValue[] = [], options: PagedStreamOptions = {}): AsyncIterableIterator<T[]> {
    this.assertOpen();
    const batchSize = validateBound(options.batchSize ?? 256, "query batch size", 1, 10_000);
    const maxRows = options.maxRows === undefined ? undefined : validateBound(options.maxRows, "stream row limit", 1, MAX_STREAM_ROWS);
    const maxBytes = validateBound(options.maxBytes ?? DEFAULT_MAX_BYTES, "stream byte limit", 1, MAX_BYTES);
    if (options.signal?.aborted) throw asAbortError(options.signal);
    const abort = (): void => { this.terminate(asAbortError(options.signal as AbortSignal)); };
    options.signal?.addEventListener("abort", abort, { once: true });
    let cursorId: number | null = null;
    try {
      const cursor = await this.request<CursorStart>({ type: "cursor-start", sql, params });
      cursorId = cursor.cursorId;
      let total = 0;
      for (;;) {
        if (options.signal?.aborted) throw asAbortError(options.signal);
        if (maxRows !== undefined && total >= maxRows) {
          const more = await this.request<boolean>({ type: "cursor-more", cursorId });
          if (more) throw new Error("The stream exceeded its configured row limit.");
          cursorId = null;
          return;
        }
        const boundedBatch = maxRows === undefined ? batchSize : Math.min(batchSize, maxRows - total);
        const batch = await this.request<PagedCursorBatch>({ type: "cursor-next", cursorId, batchSize: boundedBatch, maxBytes });
        total += batch.rows.length;
        if (maxRows !== undefined && total > maxRows) throw new Error("The stream exceeded its configured row limit.");
        if (batch.rows.length) yield batch.rows as T[];
        if (batch.done) { cursorId = null; return; }
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (cursorId !== null && this.state === "open") {
        try { await this.request({ type: "cursor-close", cursorId }); } catch { /* Connection may have closed concurrently. */ }
      }
    }
  }

  async getTableNames(): Promise<string[]> {
    return (await this.query<{ name: string }>(
      "SELECT name FROM main.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )).map((row) => row.name);
  }

  async getGeometryColumns(): Promise<GeometryColumnInfo[]> {
    const tableNames = await this.getTableNames();
    if (tableNames.some((name) => name.toLowerCase() === "geometry_columns")) {
      const columns = await this.query<{ name: string }>("PRAGMA table_info(geometry_columns)");
      const typeColumn = columns.some((column) => column.name === "geometry_type") ? "geometry_type" : "type";
      const rows = await this.query<{
        f_table_name: string; f_geometry_column: string; geometry_type: number | string;
        coord_dimension: number | string; srid: number; spatial_index_enabled: number;
      }>(`SELECT f_table_name, f_geometry_column, ${quoteIdentifier(typeColumn)} AS geometry_type, coord_dimension, srid, spatial_index_enabled FROM geometry_columns`);
      return rows.map((row) => ({
        tableName: row.f_table_name, columnName: row.f_geometry_column, type: String(row.geometry_type),
        coordDimension: typeof row.coord_dimension === "number"
          ? row.coord_dimension
          : (Number.isFinite(Number(row.coord_dimension)) ? Number(row.coord_dimension) : row.coord_dimension.length),
        srid: row.srid, spatialIndexEnabled: Boolean(row.spatial_index_enabled),
      }));
    }
    const rows = await this.query<{ table_name: string; column_name: string; type: string }>(`
      SELECT m.name AS table_name, p.name AS column_name, p.type
      FROM main.sqlite_master AS m JOIN pragma_table_info(m.name) AS p
      WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'
        AND m.sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND lower(p.name) = 'geometry'
    `);
    return rows.map((row) => ({
      tableName: row.table_name, columnName: row.column_name, type: row.type || "GEOMETRY",
      coordDimension: 2, srid: 0, spatialIndexEnabled: false,
    }));
  }

  async getStats(): Promise<PagedFileStats> {
    this.assertOpen();
    const stats = await this.request<PagedFileStats>({ type: "stats" });
    return { ...stats, openElapsedMs: this.openElapsedMs };
  }

  async getTableGeoJsonAsync(table: string, column = "geometry", limit?: number, options: GeoJsonReadOptions = {}): Promise<FeatureCollection<Geometry | null>> {
    const features: Feature<Geometry | null>[] = [];
    for await (const batch of this.streamTableGeoJson(table, column, limit, options)) {
      features.push(...batch);
    }
    options.signal?.throwIfAborted();
    return { type: "FeatureCollection", features };
  }

  async *streamTableGeoJson(
    table: string,
    column = "geometry",
    limit?: number,
    options: GeoJsonReadOptions = {},
  ): AsyncIterableIterator<Feature<Geometry | null>[]> {
    const { bbox, batchSize } = normalizeFeatureOptions(options);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("Invalid feature limit.");
    if (options.signal?.aborted) throw asAbortError(options.signal);
    if (limit === 0) { options.onProgress?.(0); return; }
    const tableNames = await this.getTableNames();
    const tableName = tableNames.find((name) => name.toLowerCase() === table.toLowerCase());
    if (!tableName) throw new Error(`Table ${table} does not exist.`);
    const schema = (await this.query<{ name: string }>("SELECT name FROM pragma_table_xinfo(?) WHERE hidden != 1 ORDER BY cid", [tableName])).map((row) => row.name);
    const tableInfo = (await this.query<{ type: string; sql: string | null }>(
      "SELECT type, sql FROM main.sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 1", [tableName],
    ))[0];
    const rowIdColumn = tableInfo?.type === "table" && !/\bWITHOUT\s+ROWID\b/i.test(tableInfo.sql ?? "")
      ? ["_rowid_", "rowid", "oid"].find((candidate) => !schema.some((name) => name.toLowerCase() === candidate)) ?? null
      : null;
    const geometryColumn = schema.find((name) => name.toLowerCase() === column.toLowerCase());
    if (!geometryColumn) throw new Error(`Geometry column ${column} does not exist in ${table}.`);
    const metadata = (await this.getGeometryColumns()).find((item) =>
      item.tableName.toLowerCase() === tableName.toLowerCase() && item.columnName.toLowerCase() === geometryColumn.toLowerCase());
    let spatialIndexTable: string | null = null;
    let useSpatialIndex = false;
    if (bbox && metadata?.spatialIndexEnabled && rowIdColumn && metadata.srid > 0) {
      const indexName = `idx_${tableName}_${geometryColumn}`;
      const object = (await this.query<{ type: string; sql: string | null }>(
        "SELECT type, sql FROM main.sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 1", [indexName],
      ))[0];
      if (validSpatialIndexObject(object?.type, object?.sql)) {
        try {
          const indexColumns = (await this.query<{ name: string }>("SELECT name FROM pragma_table_info(?)", [indexName])).map((row) => row.name.toLowerCase());
          if (!["pkid", "xmin", "xmax", "ymin", "ymax"].every((name) => indexColumns.includes(name))) throw new Error("RTree schema is incomplete.");
          useSpatialIndex = true;
          spatialIndexTable = indexName;
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
      bbox, srid: metadata?.srid ?? 0, useSpatialIndex, rowIdColumn, spatialIndexTable,
      ...(limit === undefined ? {} : { limit }),
    });
    const indexes = await this.getProjectionIndexes(metadata?.srid ?? 0);
    const features: Feature<Geometry | null>[] = [];
    const propertyTemplate: Record<string, unknown> = Object.fromEntries(plan.propertyColumns.map((key) => [key, null]));
    let count = 0;
    let lastProgress = -1;
    for await (const rows of this.streamQuery(plan.sql, plan.params, {
      batchSize, maxBytes: MAX_BYTES, ...(options.signal ? { signal: options.signal } : {}),
    })) {
      for (const row of rows) {
        options.signal?.throwIfAborted();
        const blob = row[plan.geometryAlias];
        let geometry: Geometry | null = null;
        if (blob !== null) {
          if (!(blob instanceof Uint8Array)) throw new Error(`Geometry column ${geometryColumn} contains a non-BLOB value.`);
          const decoded = decodeSpatialiteGeometry(blob);
          if (bbox && !geometryEnvelopeIntersects(geometryEnvelope(decoded.geometry), bbox)) continue;
          if (decoded.srid !== 4326 && !indexes.has(decoded.srid)) await this.loadProjection(decoded.srid, indexes);
          geometry = this.projectGeometry(decoded.geometry, decoded.srid, indexes);
        } else if (bbox) continue;
        const properties: Record<string, unknown> = { ...propertyTemplate };
        plan.propertyColumns.forEach((property, index) => {
          const alias = plan.propertyAliases[index];
          if (alias === undefined) throw new Error("SQLite returned an unexpected feature property shape.");
          const value = row[alias];
          properties[property] = value instanceof Uint8Array ? `[BLOB ${value.length} bytes]` : typeof value === "bigint" ? value.toString() : value ?? null;
        });
        features.push({ type: "Feature", geometry, properties });
        count += 1;
        if (features.length >= batchSize) yield features.splice(0, batchSize);
        if (limit !== undefined && count >= limit) break;
      }
      options.onProgress?.(count);
      lastProgress = count;
      if (limit !== undefined && count >= limit) {
        if (features.length) yield features;
        return;
      }
    }
    if (features.length) yield features;
    options.signal?.throwIfAborted();
    if (lastProgress !== count) options.onProgress?.(count);
  }

  private async getProjectionIndexes(srid: number): Promise<Map<number, proj4.Converter>> {
    const indexes = this.projections;
    if (srid > 0 && srid !== 4326 && !indexes.has(srid)) await this.loadProjection(srid, indexes);
    return indexes;
  }

  private async loadProjection(srid: number, indexes: Map<number, proj4.Converter>): Promise<void> {
    let definition: string | undefined;
    const tableNames = await this.getTableNames();
    if (tableNames.some((name) => name.toLowerCase() === "spatial_ref_sys")) {
      definition = (await this.query<{ proj4text: string }>("SELECT proj4text FROM spatial_ref_sys WHERE srid = ?", [srid]))[0]?.proj4text;
    }
    const known: unknown = proj4.defs(`EPSG:${srid}`);
    if (!definition && !known) throw new Error(`Unknown SRID ${srid}; define its projection in spatial_ref_sys before adding the layer.`);
    indexes.set(srid, proj4(definition || `EPSG:${srid}`, "EPSG:4326"));
  }

  private projectGeometry(geometry: Geometry, srid: number, indexes: Map<number, proj4.Converter>): Geometry {
    if (srid === 4326) return geometry;
    let converter = indexes.get(srid);
    if (!converter) {
      const known: unknown = proj4.defs(`EPSG:${srid}`);
      if (!known) throw new Error(`Unknown SRID ${srid}; define its projection in spatial_ref_sys before adding the layer.`);
      converter = proj4(`EPSG:${srid}`, "EPSG:4326");
      indexes.set(srid, converter);
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

  async close(): Promise<void> {
    if (this.state === "closed") return;
    let closed: Promise<unknown>;
    try { closed = this.request({ type: "close" }); }
    catch (cause) { this.terminate(cause instanceof Error ? cause : new Error(String(cause))); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); });
    await Promise.race([closed, timeout]).catch(() => undefined);
    if (timer !== undefined) clearTimeout(timer);
    this.state = "closed";
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Paged database is closed."));
    this.pending.clear();
  }
}

export type { PagedFileStats };
