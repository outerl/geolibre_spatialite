import { describe, expect, it } from "vitest";

import {
  haversineDistance,
  lineStringGeodesicLength,
  vincentyDistance,
} from "../src/spatialite/geodesic.js";

describe("Geodesic Calculations", () => {
  it("calculates distance between Brisbane and Sydney accurately", () => {
    // Brisbane: [153.0251, -27.4698]
    // Sydney: [151.2093, -33.8688]
    const brisbane: [number, number] = [153.0251, -27.4698];
    const sydney: [number, number] = [151.2093, -33.8688];

    const distVincenty = vincentyDistance(brisbane, sydney);
    const distHaversine = haversineDistance(brisbane, sydney);

    // Approximate straight-line distance is ~732 km
    expect(distVincenty).toBeGreaterThan(730000);
    expect(distVincenty).toBeLessThan(735000);

    // Haversine and Vincenty should be within 0.5% of each other
    expect(Math.abs(distVincenty - distHaversine) / distVincenty).toBeLessThan(0.005);
  });

  it("handles identical points with zero distance", () => {
    const pt: [number, number] = [10.0, 20.0];
    expect(vincentyDistance(pt, pt)).toBe(0);
    expect(haversineDistance(pt, pt)).toBe(0);
  });

  it("calculates total linestring length correctly", () => {
    const coords: [number, number][] = [
      [0, 0],
      [0, 1], // ~111 km along meridian
      [1, 1], // ~111 km along parallel
    ];
    const total = lineStringGeodesicLength(coords);
    expect(total).toBeGreaterThan(220000);
    expect(total).toBeLessThan(223000);
  });
});
