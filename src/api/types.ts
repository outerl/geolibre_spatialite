// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import type { SpatialiteDatabase, SqlValue, SqlRow } from "../spatialite/database.js";
import type { SpatialiteWasmModule } from "../spatialite/c-wasm-adapter.js";
import type { PagedOpenOptions, PagedQueryOptions, PagedSpatialiteConnection, PagedStreamOptions, PagedFileStats } from "../spatialite/paged-connection.js";
export type { GeoJsonReadOptions } from "../spatialite/database.js";
export type DatabaseScalar = SqlValue;
export type DatabaseRow = SqlRow;
export type ISpatialiteConnection = Pick<SpatialiteDatabase,
  "exec" | "query" | "transaction" | "getTableNames" | "getGeometryColumns" |
  "getTableGeoJson" | "getTableGeoJsonAsync" | "streamTableGeoJson" | "export" | "close" | "isNativeC" |
  "getSpatialiteVersion" | "hasGeos" | "hasProj"
>;
export type IPagedSpatialiteConnection = Pick<PagedSpatialiteConnection,
  "query" | "streamQuery" | "getTableNames" | "getGeometryColumns" | "getTableGeoJsonAsync" |
  "streamTableGeoJson" | "getStats" | "close"
>;
export type { PagedOpenOptions, PagedQueryOptions, PagedStreamOptions, PagedFileStats };

export type SpatialiteEngineType = "native-c-wasm" | "inlined-sqlite-wasm";

export interface GeometryColumnMetadata {
  tableName: string;
  columnName: string;
  type: string;
  coordDimension: number;
  srid: number;
  spatialIndexEnabled: boolean;
}

export interface GeoLibreSpatialiteService {
  readonly version: string;
  isReady(): boolean;
  getEngineType(): SpatialiteEngineType;
  getSpatialiteVersion(): string;
  openDatabase(data?: Uint8Array | ArrayBuffer): Promise<ISpatialiteConnection>;
  /** Open a consistent SQLite Blob through a dedicated native, read-only WORKERFS worker. */
  openFile(blob: Blob, options?: PagedOpenOptions): Promise<IPagedSpatialiteConnection>;
  createDatabase(): Promise<ISpatialiteConnection>;
  registerNativeSpatialiteFactory?(factory: (() => Promise<SpatialiteWasmModule>) | null): void;
}

declare global {
  interface Window {
    geolibreSpatialite?: GeoLibreSpatialiteService;
  }
}
