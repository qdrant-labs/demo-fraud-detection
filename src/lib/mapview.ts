// Equirectangular map projection with a camera, shared by everything the wall
// draws: land dots, city markers, event pings, the geo-hop arc, and hit-testing.
// One project() function so a lon/lat lands in the same pixel for every layer.
//
// The camera is (center lon, center lat, scale) where scale is pixels-per-degree.
// project() wraps longitude to the nearest copy of the center, so a point across
// the dateline (Tokyo vs San Francisco) draws on the short side without special
// cases at the call sites.

export interface Camera {
  lon: number; // center longitude, degrees
  lat: number; // center latitude, degrees
  s: number; // pixels per degree (zoom)
}

// Clamp band matches land-dots.json (lat -58..74). Antarctica and the far Arctic
// carry no demo cities, so cropping them keeps the map dense and legible.
export const LAT_MIN = -58;
export const LAT_MAX = 74;

export function project(
  lon: number,
  lat: number,
  cam: Camera,
  w: number,
  h: number,
): [number, number] {
  let dlon = lon - cam.lon;
  while (dlon > 180) dlon -= 360;
  while (dlon < -180) dlon += 360;
  return [dlon * cam.s + w / 2, (cam.lat - lat) * cam.s + h / 2];
}

// The whole clamped world, centered and fit to the canvas.
export function worldCamera(w: number, h: number): Camera {
  const s = Math.min(w / 360, h / (LAT_MAX - LAT_MIN));
  return { lon: 0, lat: (LAT_MAX + LAT_MIN) / 2, s };
}

// Fit a bounding box around `pts` (lon/lat) with padding, so a story shows all
// its event cities plus the customer's home. Longitudes are unwrapped around the
// first point so a dateline-spanning pair (e.g. home in Tokyo, hop to New York)
// centers on the short side. Never zooms out past the world view.
export function fitCamera(
  pts: [number, number][],
  w: number,
  h: number,
  padFrac = 0.4,
  maxS = 9,
): Camera {
  const ref = pts[0][0];
  const lons = pts.map(([lon]) => {
    let d = lon - ref;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return ref + d;
  });
  const lats = pts.map((p) => p[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  // Floor the span so a single-city story (all events in one place) still zooms
  // to a sensible neighborhood instead of dividing by ~0.
  const spanLon = Math.max(maxLon - minLon, 12);
  const spanLat = Math.max(maxLat - minLat, 12);
  const pad = 1 + padFrac * 2;
  const world = worldCamera(w, h);
  const s = Math.max(
    Math.min(w / (spanLon * pad), h / (spanLat * pad), maxS),
    world.s,
  );

  let lon = (minLon + maxLon) / 2;
  while (lon >= 180) lon -= 360;
  while (lon < -180) lon += 360;
  return { lon, lat: (minLat + maxLat) / 2, s };
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Eased interpolation between two cameras. Longitude takes the short way around
// so a pan across the dateline does not spin the globe the long way.
export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  const e = easeInOut(Math.max(0, Math.min(1, t)));
  let dlon = b.lon - a.lon;
  while (dlon > 180) dlon -= 360;
  while (dlon < -180) dlon += 360;
  return {
    lon: a.lon + dlon * e,
    lat: a.lat + (b.lat - a.lat) * e,
    s: a.s + (b.s - a.s) * e,
  };
}

// Self-check (run: npx tsx src/lib/mapview.ts). Guarded so the browser bundle
// never touches process.
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("mapview.ts")) {
  const w = 1600;
  const h = 900;
  const assert = (ok: boolean, msg: string) => {
    if (!ok) throw new Error("mapview self-check failed: " + msg);
  };
  // Center of the camera lands at canvas center.
  const cam = worldCamera(w, h);
  const [cx, cy] = project(cam.lon, cam.lat, cam, w, h);
  assert(Math.abs(cx - w / 2) < 1e-6 && Math.abs(cy - h / 2) < 1e-6, "center");
  // Dateline wrap: 170E and 170W (=-190 relative) sit 20 deg apart, not 340.
  const a = project(170, 0, { lon: 180, lat: 0, s: 1 }, w, h);
  const b = project(-170, 0, { lon: 180, lat: 0, s: 1 }, w, h);
  assert(Math.abs(a[0] - b[0]) === 20, "dateline wrap");
  // fitCamera on two cities centers between them (short way over the Pacific).
  const fit = fitCamera([[139.65, 35.67], [-122.42, 37.77]], w, h); // Tokyo, SF
  assert(fit.lon > 90 || fit.lon < -90, "fit centers across Pacific, not Atlantic");
  // A single-point story still fits inside the canvas.
  const one = fitCamera([[0, 0]], w, h);
  const [px, py] = project(0, 0, one, w, h);
  assert(px > 0 && px < w && py > 0 && py < h, "single point on screen");
  console.log("mapview self-check ok");
}
