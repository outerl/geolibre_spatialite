// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import type { SpatialiteDatabase, SqlValue, SqlRow } from "../spatialite/database.js";
import type { SpatialiteWasmModule } from "../spatialite/c-wasm-adapter.js";
export type { GeoJsonReadOptions } from "../spatialite/database.js";
export type DatabaseScalar = SqlValue;
export type DatabaseRow = SqlRow;
export type ISpatialiteConnection = Pick<SpatialiteDatabase,
  "exec" | "query" | "transaction" | "getTableNames" | "getGeometryColumns" |
  "getTableGeoJson" | "getTableGeoJsonAsync" | "export" | "close" | "isNativeC" |
  "getSpatialiteVersion" | "hasGeos" | "hasProj"
>;

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
  createDatabase(): Promise<ISpatialiteConnection>;
  registerNativeSpatialiteFactory?(factory: (() => Promise<SpatialiteWasmModule>) | null): void;
}

declare global {
  interface Window {
    geolibreSpatialite?: GeoLibreSpatialiteService;
  }
}
