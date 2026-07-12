// Generates src/lib/land-dots.json: a 1deg x 1deg grid of dot centers that
// fall on land, for the dark canvas halftone world map.
// Run: npx tsx scripts/gen-land-dots.ts
//
// Land polygons: Natural Earth 110m land, GeoJSON mirror.
// Source: https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const SOURCE_URL =
  "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json";

const STEP = 1;
const LAT_MIN = -58;
const LAT_MAX = 74;

type Ring = [number, number][];
type Geometry =
  | { type: "Polygon"; coordinates: Ring[] }
  | { type: "MultiPolygon"; coordinates: Ring[][] };

// Ray-casting point-in-polygon over a single ring (even-odd rule).
function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// A polygon's first ring is the outer boundary, remaining rings are holes.
function inPolygon(lon: number, lat: number, rings: Ring[]): boolean {
  if (!inRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (inRing(lon, lat, rings[i])) return false; // inside a hole
  }
  return true;
}

function isLand(lon: number, lat: number, polygons: Ring[][]): boolean {
  for (const rings of polygons) {
    if (inPolygon(lon, lat, rings)) return true;
  }
  return false;
}

async function main() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${SOURCE_URL}`);
  const geojson = (await res.json()) as {
    features: { geometry: Geometry }[];
  };

  // Flatten Polygon and MultiPolygon features into a flat list of ring-sets.
  const polygons: Ring[][] = [];
  for (const f of geojson.features) {
    const g = f.geometry;
    if (g.type === "Polygon") {
      polygons.push(g.coordinates);
    } else {
      for (const rings of g.coordinates) polygons.push(rings);
    }
  }

  // Sanity checks against known land/ocean points before trusting the data.
  assert.ok(!isLand(0, 0, polygons), "(0,0) Gulf of Guinea should be ocean");
  assert.ok(isLand(2.35, 48.86, polygons), "Paris should be land");
  assert.ok(!isLand(-30, 40, polygons), "mid-Atlantic should be ocean");
  assert.ok(isLand(151.21, -33.87, polygons), "Sydney should be land");

  const points: [number, number][] = [];
  for (let lat = LAT_MIN + STEP / 2; lat < LAT_MAX; lat += STEP) {
    for (let lon = -180 + STEP / 2; lon < 180; lon += STEP) {
      if (isLand(lon, lat, polygons)) {
        points.push([Math.round(lon * 10) / 10, Math.round(lat * 10) / 10]);
      }
    }
  }

  assert.ok(
    points.length >= 6000 && points.length <= 25000,
    `point count ${points.length} out of expected [6000, 25000] range`,
  );

  writeFileSync(
    "src/lib/land-dots.json",
    JSON.stringify({ step: STEP, points }),
  );
  console.log(`gen-land-dots: wrote ${points.length} points`);
}

main();
