// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import "./geolibre/plugin.css";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "./geolibre/host-api.js";
import { SpatialiteController, MENU_ID, PANEL_ID } from "./geolibre/spatialite-controller.js";
import { getSpatialiteService, registerGlobalSpatialiteService } from "./api/service.js";
import { PLUGIN_VERSION } from "./version.js";
export { PLUGIN_VERSION } from "./version.js";
export const PLUGIN_ID = "geolibre-spatialite";
export const PLUGIN_NAME = "SpatiaLite Spatial SQL Engine";

let controller: SpatialiteController | null = null;
let activeApp: GeoLibreAppAPI | null = null;
let previousService: Window["geolibreSpatialite"];
let disposePanel: (() => void) | null = null;
let disposeMenu: (() => void) | null = null;
let disposeService: (() => void) | null = null;
let registeredService = false;

export const plugin: GeoLibrePlugin & { deactivate: (app?: GeoLibreAppAPI) => void } = {
  id: PLUGIN_ID, name: PLUGIN_NAME, version: PLUGIN_VERSION,
  activate(app) {
    if (controller) return activeApp === app;
    if (!app.registerRightPanel || !app.registerToolbarMenu) return false;
    activeApp = app;
    previousService = window.geolibreSpatialite;
    controller = new SpatialiteController(app);
    try {
      disposePanel = app.registerRightPanel({
        id: PANEL_ID, title: "SpatiaLite", dock: "right-of-layers", defaultWidth: 380,
        render: (container) => controller?.render(container),
      });
      disposeMenu = app.registerToolbarMenu({
        id: MENU_ID, label: "SpatiaLite", items: [
          { id: "open-db", label: "Open database…", onSelect: () => { void controller?.promptOpenDatabase(); } },
          { id: "show-panel", label: "SpatiaLite panel", onSelect: () => { app.openRightPanel?.(PANEL_ID); } },
        ],
      });
      if (app.registerService) {
        const cleanup = app.registerService("spatialite", getSpatialiteService());
        registeredService = true;
        disposeService = typeof cleanup === "function" ? cleanup : null;
      }
      registerGlobalSpatialiteService();
      return true;
    } catch (error) {
      plugin.deactivate(app);
      throw error;
    }
  },
  deactivate(app = activeApp ?? undefined) {
    if (!app || app !== activeApp) return;
    controller?.dispose();
    controller = null;
    disposeMenu?.(); disposeMenu = null;
    app.closeRightPanel?.(PANEL_ID);
    disposePanel?.(); disposePanel = null;
    disposeService?.();
    if (registeredService && !disposeService) app.unregisterService?.("spatialite");
    registeredService = false; disposeService = null;
    if (window.geolibreSpatialite === getSpatialiteService()) {
      if (previousService) window.geolibreSpatialite = previousService;
      else delete window.geolibreSpatialite;
    }
    activeApp = null;
  },
};
export default plugin;
