// WGS84 ellipsoid constants
const WGS84_A = 6378137.0; // semi-major axis in meters
const WGS84_B = 6356752.314245; // semi-minor axis in meters
const WGS84_F = 1 / 298.257223563; // flattening

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180.0;
}

/**
 * Great-circle distance using the Haversine formula (meters).
 */
export function haversineDistance(
  coord1: readonly [number, number],
  coord2: readonly [number, number],
): number {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return WGS84_A * c;
}

/**
 * Geodesic distance on the WGS84 ellipsoid using Vincenty's inverse formula (meters).
 * Falls back to Haversine if points are nearly antipodal or formula fails to converge.
 */
export function vincentyDistance(
  coord1: readonly [number, number],
  coord2: readonly [number, number],
): number {
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;

  if (Math.abs(lon1 - lon2) < 1e-11 && Math.abs(lat1 - lat2) < 1e-11) {
    return 0.0;
  }

  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(phi1));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(phi2));
  const L = toRadians(lon2 - lon1);

  let lambda = L;
  let lambdaPrev: number;
  let sinSigma: number;
  let cosSigma: number;
  let sigma: number;
  let sinAlpha: number;
  let cosSqAlpha: number;
  let cos2SigmaM: number;

  let iterations = 100;

  do {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);

    sinSigma = Math.sqrt(
      (Math.cos(U2) * sinLambda) ** 2 +
        (Math.cos(U1) * Math.sin(U2) - Math.sin(U1) * Math.cos(U2) * cosLambda) ** 2,
    );

    if (sinSigma === 0) return 0; // Coincident points

    cosSigma = Math.sin(U1) * Math.sin(U2) + Math.cos(U1) * Math.cos(U2) * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (Math.cos(U1) * Math.cos(U2) * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * Math.sin(U1) * Math.sin(U2)) / cosSqAlpha : 0;

    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));

    iterations -= 1;
  } while (Math.abs(lambda - lambdaPrev) > 1e-12 && iterations > 0);

  if (iterations === 0) {
    // Formula failed to converge (nearly antipodal points); fallback to Haversine
    return haversineDistance(coord1, coord2);
  }

  const uSq = (cosSqAlpha * (WGS84_A ** 2 - WGS84_B ** 2)) / WGS84_B ** 2;
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma ** 2) *
            (-3 + 4 * cos2SigmaM ** 2)));

  return WGS84_B * A * (sigma - deltaSigma);
}

/**
 * Calculates the total geodesic length of a linestring in meters.
 */
export function lineStringGeodesicLength(coordinates: readonly (readonly [number, number])[]): number {
  if (coordinates.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const p1 = coordinates[i];
    const p2 = coordinates[i + 1];
    if (p1 && p2) {
      total += vincentyDistance(p1, p2);
    }
  }
  return total;
}
