import { SpatialiteDatabase } from "../spatialite/database.js";
import type { GeoLibreSpatialiteService, ISpatialiteConnection } from "./types.js";
import { PLUGIN_VERSION } from "../version.js";

class SpatialiteServiceImpl implements GeoLibreSpatialiteService {
  readonly version = PLUGIN_VERSION;

  isReady(): boolean {
    return true;
  }

  async openDatabase(data?: Uint8Array | ArrayBuffer): Promise<ISpatialiteConnection> {
    return SpatialiteDatabase.open(data);
  }

  async createDatabase(): Promise<ISpatialiteConnection> {
    return SpatialiteDatabase.open();
  }
}

let serviceInstance: GeoLibreSpatialiteService | null = null;

export function getSpatialiteService(): GeoLibreSpatialiteService {
  serviceInstance ??= new SpatialiteServiceImpl();
  return serviceInstance;
}

export function registerGlobalSpatialiteService(): GeoLibreSpatialiteService {
  const service = getSpatialiteService();
  if (typeof window !== "undefined") {
    window.geolibreSpatialite = service;
    window.dispatchEvent(new CustomEvent("geolibre:spatialite:ready", { detail: service }));
  }
  return service;
}
