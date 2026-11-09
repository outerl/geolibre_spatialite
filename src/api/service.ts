// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import { SpatialiteDatabase } from "../spatialite/database.js";
import { PagedSpatialiteConnection } from "../spatialite/paged-connection.js";
import { getActiveEngineType, getLoadedSpatialiteVersion, registerNativeSpatialiteFactory as registerFactory } from "../spatialite/sqlite-engine.js";
import type { GeoLibreSpatialiteService, ISpatialiteConnection, PagedOpenOptions, IPagedSpatialiteConnection, SpatialiteEngineType } from "./types.js";
import type { SpatialiteWasmModule } from "../spatialite/c-wasm-adapter.js";
import { PLUGIN_VERSION } from "../version.js";

class SpatialiteServiceImpl implements GeoLibreSpatialiteService {
  readonly version = PLUGIN_VERSION;

  isReady(): boolean {
    return true;
  }

  getEngineType(): SpatialiteEngineType {
    return getActiveEngineType();
  }

  getSpatialiteVersion(): string {
    return getActiveEngineType() === "native-c-wasm" ? getLoadedSpatialiteVersion() : `${PLUGIN_VERSION} (inlined)`;
  }

  registerNativeSpatialiteFactory(factory: (() => Promise<SpatialiteWasmModule>) | null): void {
    registerFactory(factory);
  }

  async openDatabase(data?: Uint8Array | ArrayBuffer): Promise<ISpatialiteConnection> {
    return SpatialiteDatabase.open(data);
  }

  async openFile(blob: Blob, options?: PagedOpenOptions): Promise<IPagedSpatialiteConnection> {
    return PagedSpatialiteConnection.open(blob, options);
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
