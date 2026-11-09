// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

export * from "./spatialite/blob-codec.js";
export * from "./spatialite/geodesic.js";
export * from "./spatialite/spatial-functions.js";
export * from "./spatialite/spatial-index.js";
export * from "./spatialite/sqlite-engine.js";
export * from "./spatialite/database.js";
export * from "./api/types.js";
export * from "./api/service.js";
export { plugin as default, plugin, PLUGIN_ID, PLUGIN_NAME, PLUGIN_VERSION } from "./geolibre.js";
