// SPDX-License-Identifier: LGPL-2.1-or-later
import { describe, expect, it } from "vitest";

import { PagedSpatialiteConnection } from "../src/spatialite/paged-connection.js";
import { encodeSpatialitePoint } from "../src/spatialite/blob-codec.js";
import type { SqlRow } from "../src/spatialite/database.js";

interface WorkerResponse { id: number; ok: boolean; value?: unknown; error?: string }

class ProtocolWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly requests: string[] = [];
  terminated = false;
  failedOpen = false;
  queryHandler?: (sql: string, params: unknown[]) => { columns: string[]; rows: SqlRow[]; truncated?: boolean } | null;
  cursorHandler?: (sql: string, params: unknown[]) => { columns: string[]; rows: SqlRow[] } | null;
  private nextCursor = 1;
  private cursors = new Map<number, { columns: string[]; rows: SqlRow[]; offset: number }>();

  postMessage(message: { id: number; type: string; [key: string]: unknown }): void {
    this.requests.push(message.type);
    queueMicrotask(() => {
      if (message.type === "open" && this.failedOpen) {
        this.emit({ id: message.id, ok: false, error: "synthetic open failure" });
        return;
      }
      let value: unknown;
      switch (message.type) {
        case "open": value = { stats: {} }; break;
        case "query": {
          const sql = String(message.sql);
          const params = Array.isArray(message.params) ? message.params : [];
          const handled = this.queryHandler?.(sql, params);
          value = handled ?? { columns: ["id"], rows: [{ id: 1 }], truncated: false };
          break;
        }
        case "cursor-start": {
          const sql = String(message.sql);
          const params = Array.isArray(message.params) ? message.params : [];
          const cursorId = this.nextCursor++;
          const handled = this.cursorHandler?.(sql, params);
          if (handled) {
            this.cursors.set(cursorId, { columns: handled.columns, rows: handled.rows, offset: 0 });
            value = { cursorId, columns: handled.columns };
          } else {
            const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
            this.cursors.set(cursorId, { columns: ["id"], rows, offset: 0 });
            value = { cursorId, columns: ["id"] };
          }
          break;
        }
        case "cursor-next": {
          const cursorId = message.cursorId as number;
          const cursor = this.cursors.get(cursorId);
          if (!cursor) {
            value = { columns: ["id"], rows: [], bytes: 0, done: true };
            break;
          }
          const batchSize = message.batchSize as number;
          const rows = cursor.rows.slice(cursor.offset, cursor.offset + batchSize);
          cursor.offset += rows.length;
          const done = cursor.offset >= cursor.rows.length;
          value = { columns: cursor.columns, rows, bytes: rows.length * 8, done };
          break;
        }
        case "cursor-more": {
          const cursor = this.cursors.get(message.cursorId as number);
          value = cursor ? cursor.offset < cursor.rows.length : false;
          break;
        }
        case "cursor-close": this.cursors.delete(message.cursorId as number); break;
        case "stats": value = { fileSize: 1000, sliceBytesRequested: 128, sliceRequestCount: 2, cacheBytes: 1024 }; break;
        case "close": this.cursors.clear(); break;
      }
      this.emit({ id: message.id, ok: true, value });
    });
  }

  private emit(response: WorkerResponse): void {
    this.onmessage?.(new MessageEvent<WorkerResponse>("message", { data: response }));
  }

  terminate(): void { this.terminated = true; }
}

describe("paged connection worker protocol", () => {
  it("pulls bounded batches, closes an early cursor, and keeps the read-only connection alive", async () => {
    const worker = new ProtocolWorker();
    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    const rows = connection.streamQuery<{ id: number }>("SELECT id FROM places", [], { batchSize: 1 });
    expect(worker.requests).toEqual(["open"]);
    expect((await rows.next()).value).toEqual([{ id: 1 }]);
    expect(worker.requests.filter((type) => type === "cursor-next")).toHaveLength(1);
    await rows.return?.();
    expect(worker.requests).toContain("cursor-close");
    expect(await connection.query("SELECT id FROM places")).toEqual([{ id: 1 }]);
    await connection.close();
    expect(worker.terminated).toBe(true);
  });

  it("hard-cancels the worker and rejects subsequent and pending requests", async () => {
    const worker = new ProtocolWorker();
    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    const controller = new AbortController();
    const iterator = connection.streamQuery("SELECT id FROM places", [], { batchSize: 1, signal: controller.signal });
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toThrow("aborted");
    expect(worker.terminated).toBe(true);
    await expect(connection.query("SELECT 1")).rejects.toThrow("aborted");
  });

  it("cleans up a worker when opening fails or is aborted during worker creation", async () => {
    const failedWorker = new ProtocolWorker();
    failedWorker.failedOpen = true;
    await expect(PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => failedWorker)).rejects.toThrow("synthetic open failure");
    expect(failedWorker.terminated).toBe(true);

    const controller = new AbortController();
    const abortedWorker = new ProtocolWorker();
    const opening = PagedSpatialiteConnection.open(new Blob(["database"]), { signal: controller.signal }, async () => {
      await Promise.resolve();
      return abortedWorker;
    });
    controller.abort();
    await expect(opening).rejects.toThrow("aborted");
    expect(abortedWorker.terminated).toBe(true);
  });

  it("retrieves table names, geometry columns, and connection stats", async () => {
    const worker = new ProtocolWorker();
    worker.queryHandler = (sql) => {
      if (/main\.sqlite_master/i.test(sql) && !/pragma_table_info/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "geometry_columns" }, { name: "places" }] };
      }
      if (/PRAGMA\s+table_info\(geometry_columns\)/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "geometry_type" }] };
      }
      if (/FROM\s+geometry_columns/i.test(sql)) {
        return {
          columns: ["f_table_name", "f_geometry_column", "geometry_type", "coord_dimension", "srid", "spatial_index_enabled"],
          rows: [
            { f_table_name: "places", f_geometry_column: "geometry", geometry_type: "POINT", coord_dimension: "XY", srid: 4326, spatial_index_enabled: 1 },
            { f_table_name: "places", f_geometry_column: "geom2", geometry_type: "LINESTRING", coord_dimension: "2", srid: 4326, spatial_index_enabled: 0 },
          ],
        };
      }
      return null;
    };
    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    expect(await connection.getTableNames()).toEqual(["geometry_columns", "places"]);
    const cols = await connection.getGeometryColumns();
    expect(cols).toEqual([
      { tableName: "places", columnName: "geometry", type: "POINT", coordDimension: 2, srid: 4326, spatialIndexEnabled: true },
      { tableName: "places", columnName: "geom2", type: "LINESTRING", coordDimension: 2, srid: 4326, spatialIndexEnabled: false },
    ]);
    const stats = await connection.getStats();
    expect(stats.fileSize).toBe(1000);
    expect(stats.cacheBytes).toBe(1024);
    expect(stats.openElapsedMs).toBeGreaterThanOrEqual(0);
    await connection.close();
  });

  it("retrieves geometry columns with sqlite_master fallback when geometry_columns is absent", async () => {
    const worker = new ProtocolWorker();
    worker.queryHandler = (sql) => {
      if (/main\.sqlite_master/i.test(sql) && !/pragma_table_info/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "tracks" }] };
      }
      if (/pragma_table_info\(m\.name\)/i.test(sql)) {
        return {
          columns: ["table_name", "column_name", "type"],
          rows: [{ table_name: "tracks", column_name: "geometry", type: "LINESTRING" }],
        };
      }
      return null;
    };
    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    const cols = await connection.getGeometryColumns();
    expect(cols).toEqual([
      { tableName: "tracks", columnName: "geometry", type: "LINESTRING", coordDimension: 2, srid: 0, spatialIndexEnabled: false },
    ]);
    await connection.close();
  });

  it("streams GeoJSON with attribute selection, bbox post-filtering, exact integers, and limit", async () => {
    const worker = new ProtocolWorker();
    worker.queryHandler = (sql, params) => {
      if (/main\.sqlite_master\s+WHERE\s+type/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "geometry_columns" }, { name: "places" }, { name: "idx_places_geometry" }] };
      }
      if (/pragma_table_xinfo/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "id" }, { name: "label" }, { name: "exact_id" }, { name: "blob_col" }, { name: "geometry" }] };
      }
      if (/main\.sqlite_master\s+WHERE\s+name\s*=/i.test(sql)) {
        const name = String(params[0]);
        if (name === "places") return { columns: ["type", "sql"], rows: [{ type: "table", sql: "CREATE TABLE places (id INT, label TEXT, exact_id INT, blob_col BLOB, geometry BLOB)" }] };
        if (name === "idx_places_geometry") return { columns: ["type", "sql"], rows: [{ type: "table", sql: "CREATE VIRTUAL TABLE idx_places_geometry USING rtree(pkid, xmin, xmax, ymin, ymax)" }] };
      }
      if (/PRAGMA\s+table_info\(geometry_columns\)/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "geometry_type" }] };
      }
      if (/FROM\s+geometry_columns/i.test(sql)) {
        return {
          columns: ["f_table_name", "f_geometry_column", "geometry_type", "coord_dimension", "srid", "spatial_index_enabled"],
          rows: [{ f_table_name: "places", f_geometry_column: "geometry", geometry_type: "POINT", coord_dimension: "XY", srid: 4326, spatial_index_enabled: 1 }],
        };
      }
      if (/pragma_table_info\(\?\)/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "pkid" }, { name: "xmin" }, { name: "xmax" }, { name: "ymin" }, { name: "ymax" }] };
      }
      return null;
    };
    worker.cursorHandler = () => {
      return {
        columns: ["__geolibre_property_0", "__geolibre_property_1", "__geolibre_property_2", "__geolibre_property_3", "__geolibre_internal_geometry", "__geolibre_internal_rowid"],
        rows: [
          {
            __geolibre_property_0: 1,
            __geolibre_property_1: "inside",
            __geolibre_property_2: 9007199254740993n,
            __geolibre_property_3: new Uint8Array([1, 2, 3]),
            __geolibre_internal_geometry: encodeSpatialitePoint(1, 1, 4326),
            __geolibre_internal_rowid: 1,
          },
          {
            __geolibre_property_0: 2,
            __geolibre_property_1: "outside-candidate",
            __geolibre_property_2: 100n,
            __geolibre_property_3: null,
            __geolibre_internal_geometry: encodeSpatialitePoint(8.0000001, 8.0000001, 4326),
            __geolibre_internal_rowid: 2,
          },
          {
            __geolibre_property_0: 3,
            __geolibre_property_1: "null-geom",
            __geolibre_property_2: 200n,
            __geolibre_property_3: null,
            __geolibre_internal_geometry: null,
            __geolibre_internal_rowid: 3,
          },
        ],
      };
    };

    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    const progressUpdates: number[] = [];
    const result = await connection.getTableGeoJsonAsync("places", "geometry", undefined, {
      propertyColumns: ["id", "label", "exact_id", "blob_col"],
      bbox: [0, 0, 2, 2],
      requireSpatialIndex: true,
      batchSize: 2,
      onProgress: (count) => progressUpdates.push(count),
    });

    expect(result.features).toHaveLength(1);
    const feature = result.features[0];
    expect(feature?.geometry).toEqual({ type: "Point", coordinates: [1, 1] });
    expect(feature?.properties?.id).toBe(1);
    expect(feature?.properties?.label).toBe("inside");
    expect(feature?.properties?.exact_id).toBe("9007199254740993");
    expect(feature?.properties?.blob_col).toBe("[BLOB 3 bytes]");
    expect(progressUpdates).toContain(1);

    // Limit 0 returns immediately
    const emptyResult = await connection.getTableGeoJsonAsync("places", "geometry", 0);
    expect(emptyResult.features).toEqual([]);

    await connection.close();
  });

  it("transforms projected coordinates to EPSG:4326 in streamTableGeoJson", async () => {
    const worker = new ProtocolWorker();
    worker.queryHandler = (sql, params) => {
      if (/main\.sqlite_master/i.test(sql) && !/pragma/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "geometry_columns" }, { name: "places" }, { name: "spatial_ref_sys" }] };
      }
      if (/pragma_table_xinfo/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "id" }, { name: "geometry" }] };
      }
      if (/main\.sqlite_master WHERE name = \? COLLATE NOCASE/i.test(sql)) {
        return { columns: ["type", "sql"], rows: [{ type: "table", sql: "CREATE TABLE places (id INT, geometry BLOB)" }] };
      }
      if (/PRAGMA\s+table_info\(geometry_columns\)/i.test(sql)) {
        return { columns: ["name"], rows: [{ name: "geometry_type" }] };
      }
      if (/FROM\s+geometry_columns/i.test(sql)) {
        return {
          columns: ["f_table_name", "f_geometry_column", "geometry_type", "coord_dimension", "srid", "spatial_index_enabled"],
          rows: [{ f_table_name: "places", f_geometry_column: "geometry", geometry_type: "POINT", coord_dimension: 2, srid: 3857, spatial_index_enabled: 0 }],
        };
      }
      if (/SELECT proj4text FROM spatial_ref_sys WHERE srid = \?/i.test(sql)) {
        const srid = Number(params[0]);
        if (srid === 3857) {
          return {
            columns: ["proj4text"],
            rows: [{ proj4text: "+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs" }],
          };
        }
      }
      return null;
    };
    worker.cursorHandler = () => {
      return {
        columns: ["__geolibre_property_0", "__geolibre_internal_geometry"],
        rows: [{ __geolibre_property_0: 1, __geolibre_internal_geometry: encodeSpatialitePoint(0, 0, 3857) }],
      };
    };

    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    const result = await connection.getTableGeoJsonAsync("places", "geometry");
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.geometry).toEqual({ type: "Point", coordinates: [0, 0] });
    await connection.close();
  });

  it("validates parameters and rejects invalid states or inputs", async () => {
    const worker = new ProtocolWorker();
    await expect(PagedSpatialiteConnection.open("not a blob" as never, {}, () => worker)).rejects.toThrow(TypeError);
    await expect(PagedSpatialiteConnection.open(new Blob(["database"]), { cacheMiB: 0 }, () => worker)).rejects.toThrow("SQLite cache size");
    await expect(PagedSpatialiteConnection.open(new Blob(["database"]), { cacheMiB: 1000 }, () => worker)).rejects.toThrow("SQLite cache size");

    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    await expect(connection.query("SELECT 1", [], { maxRows: 0 })).rejects.toThrow("query row limit");
    await expect(connection.query("SELECT 1", [], { maxBytes: 0 })).rejects.toThrow("query byte limit");

    worker.queryHandler = () => ({ columns: ["id"], rows: [{ id: 1 }], truncated: true });
    await expect(connection.query("SELECT 1")).rejects.toThrow("exceeded its row or byte bound");

    worker.queryHandler = (sql) => {
      if (/main\.sqlite_master/i.test(sql)) return { columns: ["name"], rows: [{ name: "places" }] };
      return null;
    };
    await expect(connection.getTableGeoJsonAsync("missing")).rejects.toThrow("Table missing does not exist");

    await connection.close();
  });

  it("terminates worker when onmessageerror is triggered", async () => {
    const worker = new ProtocolWorker();
    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    worker.onmessageerror?.(new MessageEvent("messageerror"));
    await expect(connection.query("SELECT 1")).rejects.toThrow("unreadable response");
  });
});
