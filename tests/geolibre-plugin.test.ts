import { describe, expect, it, vi } from "vitest";

import { plugin, PLUGIN_ID, PLUGIN_NAME } from "../src/geolibre.js";
import type { GeoLibreAppAPI, GeoLibreRightPanelRegistration, GeoLibreToolbarMenu } from "../src/geolibre/host-api.js";
import { getSpatialiteService } from "../src/api/service.js";
import { SpatialiteController } from "../src/geolibre/spatialite-controller.js";
import { addSpatialiteLayerToMap, computeGeoJsonBounds } from "../src/geolibre/layer-manager.js";
import { encodeSpatialitePoint } from "../src/spatialite/blob-codec.js";

describe("GeoLibre SpatiaLite Plugin Lifecycle & UI", () => {
  it("registers right panel, toolbar menu, and global service on activation", () => {
    const captures: {
      panel?: GeoLibreRightPanelRegistration;
      menu?: GeoLibreToolbarMenu;
      service?: unknown;
    } = {};

    const mockApp: GeoLibreAppAPI = {
      addGeoJsonLayer: vi.fn().mockReturnValue("layer-1"),
      fitBounds: vi.fn(),
      registerRightPanel: vi.fn((panel: GeoLibreRightPanelRegistration) => {
        captures.panel = panel;
        return () => {};
      }),
      registerToolbarMenu: vi.fn((menu: GeoLibreToolbarMenu) => {
        captures.menu = menu;
        return () => {};
      }),
      registerService: vi.fn((name: string, service: unknown) => {
        if (name === "spatialite") captures.service = service;
      }),
    };

    expect(plugin.id).toBe(PLUGIN_ID);
    expect(plugin.name).toBe(PLUGIN_NAME);

    const activated = plugin.activate(mockApp);
    expect(activated).toBe(true);

    expect(captures.panel?.id).toBe("spatialite-explorer");
    expect(captures.menu?.id).toBe("spatialite-menu");
    expect(captures.service).toBeDefined();
    expect(window.geolibreSpatialite).toBeDefined();
    expect(window.geolibreSpatialite?.isReady()).toBe(true);
    plugin.deactivate(mockApp);
  });

  it("exposes functional openDatabase on global service", async () => {
    const service = getSpatialiteService();
    const conn = await service.createDatabase();
    conn.exec("CREATE TABLE test (val INT);");
    conn.exec("INSERT INTO test VALUES (42);");
    const rows = conn.query<{ val: number }>("SELECT val FROM test;");
    expect(rows[0]?.val).toBe(42);
    conn.close();
  });

  it("renders SpatialiteController and executes queries through UI", async () => {
    const mockApp: GeoLibreAppAPI = {
      addGeoJsonLayer: vi.fn().mockReturnValue("layer-1"),
      fitBounds: vi.fn(),
    };

    const controller = new SpatialiteController(mockApp);
    const container = document.createElement("div");
    document.body.appendChild(container);

    const cleanup = controller.render(container);
    expect(container.querySelector(".spatialite-title")?.textContent).toBe("SpatiaLite");

    // Open an in-memory database
    await controller.openDatabaseFromBuffer(new Uint8Array(), "test.db");
    const db = controller.getDatabase();
    expect(db).toBeDefined();
    if (!db) return;

    db.exec("CREATE TABLE cities (name TEXT, geometry BLOB);");
    const pt = encodeSpatialitePoint(153.0, -27.5);
    db.rawDb.run("INSERT INTO cities VALUES ('Brisbane', ?);", [pt]);

    // Re-render UI with active database
    controller.render(container);
    expect(container.textContent).toContain("Connected: test.db");
    expect(container.textContent).toContain("cities");

    // Execute query via textarea and button
    const textarea = container.querySelector(".spatialite-sql-editor") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    textarea.value = "SELECT name FROM cities;";

    const runBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Run SQL");
    expect(runBtn).not.toBeNull();
    runBtn?.click();

    expect(container.textContent).toContain("Brisbane");

    // Click "Add to Map"
    const addBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Add to Map");
    expect(addBtn).not.toBeNull();
    addBtn?.click();
    await vi.waitFor(() => { expect(mockApp.addGeoJsonLayer).toHaveBeenCalled(); });

    expect(mockApp.addGeoJsonLayer).toHaveBeenCalled();

    cleanup();
    controller.dispose();
    document.body.removeChild(container);
  });

  it("computes bounds and adds layer to map in layer-manager", () => {
    const mockApp: GeoLibreAppAPI = {
      addGeoJsonLayer: vi.fn().mockReturnValue("layer-100"),
      fitBounds: vi.fn(),
    };

    const fc = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [10, 20],
          },
          properties: {},
        },
        {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [30, 40],
          },
          properties: {},
        },
      ],
    };

    const bounds = computeGeoJsonBounds(fc);
    expect(bounds).toEqual([10, 20, 30, 40]);

    const id = addSpatialiteLayerToMap(mockApp, "my-layer", fc);
    expect(id).toBe("layer-100");
    expect(mockApp.fitBounds).toHaveBeenCalledWith([10, 20, 30, 40]);
  });
});

