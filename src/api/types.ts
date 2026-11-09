import type { SpatialiteDatabase, SqlValue, SqlRow } from "../spatialite/database.js";
export type { GeoJsonReadOptions } from "../spatialite/database.js";
export type DatabaseScalar = SqlValue;
export type DatabaseRow = SqlRow;
export type ISpatialiteConnection = Pick<SpatialiteDatabase,
  "exec" | "query" | "transaction" | "getTableNames" | "getGeometryColumns" |
  "getTableGeoJson" | "getTableGeoJsonAsync" | "export" | "close"
>;

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
  openDatabase(data?: Uint8Array | ArrayBuffer): Promise<ISpatialiteConnection>;
  createDatabase(): Promise<ISpatialiteConnection>;
}

declare global {
  interface Window {
    geolibreSpatialite?: GeoLibreSpatialiteService;
  }
}
