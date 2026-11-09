import type { FeatureCollection, Geometry } from "geojson";
import type { GeoLibreAppAPI } from "./host-api.js";

export function computeGeoJsonBounds(fc: FeatureCollection<Geometry | null>): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function processCoords(coords: unknown): void {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number" && Number.isFinite(coords[0]) && Number.isFinite(coords[1])) {
      const x = coords[0];
      const y = coords[1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const item of coords) {
      processCoords(item);
    }
  }

  function processGeometry(geometry: Geometry | null): void {
    if (!geometry) return;
    if (geometry.type === "GeometryCollection") geometry.geometries.forEach(processGeometry);
    else processCoords(geometry.coordinates);
  }
  for (const feature of fc.features) processGeometry(feature.geometry);

  if (minX === Infinity || minY === Infinity || maxX === -Infinity || maxY === -Infinity) {
    return null;
  }

  return [minX, minY, maxX, maxY];
}

export function addSpatialiteLayerToMap(
  app: GeoLibreAppAPI,
  layerName: string,
  data: FeatureCollection<Geometry | null>,
): string {
  const layerId = app.addGeoJsonLayer(layerName, data as FeatureCollection);

  const bounds = computeGeoJsonBounds(data);
  if (bounds && app.fitBounds) {
    app.fitBounds(bounds);
  }

  return layerId;
}
