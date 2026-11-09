import "./geolibre/plugin.css";

import type { GeoLibreAppAPI, GeoLibrePlugin } from "./geolibre/host-api.js";
import {
  SpatialiteController,
  MENU_ID,
  PANEL_ID,
} from "./geolibre/spatialite-controller.js";
import { getSpatialiteService, registerGlobalSpatialiteService } from "./api/service.js";

import { PLUGIN_VERSION } from "./version.js";
export { PLUGIN_VERSION } from "./version.js";

export const PLUGIN_ID = "geolibre-spatialite";
export const PLUGIN_NAME = "SpatiaLite Spatial SQL Engine";

let controller: SpatialiteController | null = null;
let disposePanel: (() => void) | null = null;
let disposeMenu: (() => void) | null = null;
let disposeService: (() => void) | null = null;
let activeApp: GeoLibreAppAPI | null = null;
let previousService: Window["geolibreSpatialite"];

export const plugin: GeoLibrePlugin & { deactivate?: (app: GeoLibreAppAPI) => void } = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  activate(app: GeoLibreAppAPI) {
    if (controller) return true;
    if (!app.registerRightPanel || !app.registerToolbarMenu) return false;
    activeApp = app;
    previousService = window.geolibreSpatialite;

    // Register global inter-plugin service
    const service = registerGlobalSpatialiteService();
    if (app.registerService) {
      const cleanup = app.registerService("spatialite", service);
      disposeService = typeof cleanup === "function" ? cleanup : null;
    }

    controller = new SpatialiteController(app);

    {
      disposePanel = app.registerRightPanel({
        id: PANEL_ID,
        title: "SpatiaLite",
        dock: "right-of-layers",
        defaultWidth: 380,
        render: (container) => controller?.render(container),
      });
    }

    {
      disposeMenu = app.registerToolbarMenu({
        id: MENU_ID,
        label: "SpatiaLite",
        items: [
          {
            id: "open-db",
            label: "Open database…",
            onSelect: () => {
              void controller?.promptOpenDatabase();
            },
          },
          {
            id: "show-panel",
            label: "SpatiaLite panel",
            onSelect: () => {
              app.openRightPanel?.(PANEL_ID);
            },
          },
        ],
      });
    }

    return true;
  },
  deactivate(app: GeoLibreAppAPI) {
    if (app !== activeApp) return;
    controller?.dispose();
    disposeMenu?.();
    disposeMenu = null;
    app.closeRightPanel?.(PANEL_ID);
    disposePanel?.();
    disposePanel = null;
    controller = null;
    disposeService?.();
    if (!disposeService) app.unregisterService?.("spatialite");
    disposeService = null;
    if (window.geolibreSpatialite === getSpatialiteService()) {
      if (previousService) window.geolibreSpatialite = previousService;
      else delete window.geolibreSpatialite;
    }
    activeApp = null;
  },
};

export default plugin;
