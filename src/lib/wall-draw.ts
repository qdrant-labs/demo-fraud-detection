// Everything the wall paints on its canvas, as plain functions over a 2D context
// and a camera. No React here: the frame loop in page.tsx advances the camera and
// calls these in layer order (land, story overlay, live pings).
//
// Every layer goes through mapview's project(), so a lon/lat lands in the same
// pixel in all of them.

import { CITIES, haversineKm } from "@/lib/geo";
import { project, type Camera } from "@/lib/mapview";
import landDots from "@/lib/land-dots.json";
import type { Story, WallEvent } from "@/lib/wall-story";

const LAND = landDots.points as [number, number][];

// How long a ping stays on the map. Alerts linger so a viewer can find and click
// one; ordinary charges are a brief sparkle.
const NORMAL_LIFE_MS = 3000;
const ALERT_LIFE_MS = 9000;

// A live map ping, positioned in geographic coordinates and faded by age.
export interface Ping {
  lon: number;
  lat: number;
  born: number; // performance.now()
  alerted: boolean;
  id: string | number;
}

// Deterministic sub-degree jitter from the event id, so stacked events at one
// city fan out instead of overprinting, and a re-emitted duplicate lands in the
// same spot.
export function jitter(id: string | number): [number, number] {
  let h = 2166136261 >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h & 0xffff) / 0xffff - 0.5) * 1.2;
  const b = (((h >>> 16) & 0xffff) / 0xffff - 0.5) * 1.2;
  return [a, b];
}

function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
}

// The event in a story that sits away from the customer's home city, if any
// (the geo-hop's second leg). Drives the arc.
function awayEvent(story: Story): WallEvent | null {
  for (const e of story.events) {
    if (Math.abs(e.lat - story.home.lat) > 0.5 || Math.abs(e.lon - story.home.lon) > 0.5) {
      return e;
    }
  }
  return null;
}

// Halftone landmasses plus city markers and labels. Static for a given camera,
// so the caller renders this into an offscreen canvas and blits it.
export function renderLand(
  lctx: CanvasRenderingContext2D,
  cam: Camera,
  w: number,
  h: number,
): void {
  lctx.clearRect(0, 0, w, h);
  const d = Math.max(1.6, Math.min(2.8, cam.s * 0.36));
  lctx.fillStyle = "rgba(71, 85, 105, 0.8)"; // slate-600, readable on a projector
  for (const [lon, lat] of LAND) {
    const [px, py] = project(lon, lat, cam, w, h);
    if (px < -4 || px > w + 4 || py < -4 || py > h + 4) continue;
    lctx.fillRect(px - d / 2, py - d / 2, d, d);
  }
  for (const c of CITIES) {
    const [px, py] = project(c.lon, c.lat, cam, w, h);
    if (px < 0 || px > w || py < 0 || py > h) continue;
    lctx.beginPath();
    lctx.arc(px, py, 2, 0, Math.PI * 2);
    lctx.fillStyle = "rgba(148, 163, 184, 0.5)"; // slate-400
    lctx.fill();
    lctx.fillStyle = "rgba(148, 163, 184, 0.7)";
    lctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    lctx.fillText(c.name, px + 5, py + 3);
  }
}

// A glowing quadratic arc from home to the away city, drawn progressively, with
// the great-circle distance labeled at its apex. `playStart` is when the story
// pinned (performance.now), which drives the draw progress.
function drawArc(
  ctx: CanvasRenderingContext2D,
  story: Story,
  away: WallEvent,
  cam: Camera,
  w: number,
  h: number,
  now: number,
  playStart: number,
): void {
  const [hx, hy] = project(story.home.lon, story.home.lat, cam, w, h);
  const [ex, ey] = project(away.lon, away.lat, cam, w, h);
  const cx = (hx + ex) / 2;
  const cy = (hy + ey) / 2 - Math.min(200, Math.hypot(ex - hx, ey - hy) * 0.4 + 40);

  const p = ease((now - playStart) / 1200);
  ctx.strokeStyle = "rgba(239, 68, 68, 0.85)";
  ctx.lineWidth = 2;
  ctx.shadowColor = "rgba(239, 68, 68, 0.7)";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  const steps = 40;
  let headX = hx;
  let headY = hy;
  for (let i = 1; i <= steps; i++) {
    const u = (i / steps) * p;
    const x = (1 - u) * (1 - u) * hx + 2 * (1 - u) * u * cx + u * u * ex;
    const y = (1 - u) * (1 - u) * hy + 2 * (1 - u) * u * cy + u * u * ey;
    ctx.lineTo(x, y);
    headX = x;
    headY = y;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // A bright head that travels the arc as it draws.
  ctx.beginPath();
  ctx.arc(headX, headY, 4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(254, 202, 202, 1)";
  ctx.fill();

  // Distance label at the apex.
  const km = haversineKm(story.home.lat, story.home.lon, away.lat, away.lon);
  ctx.fillStyle = "rgba(248, 250, 252, 0.9)";
  ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round(km).toLocaleString("en-US")} km`, cx, cy - 8);
  ctx.textAlign = "start";
}

// The pinned story's layer: the geo-hop arc, a ring on the customer's home, and
// a pulsing marker per charge. These markers live as long as the pin because live
// pings expire in seconds, so a story pinned from the queue later would
// otherwise zoom to an empty city.
export function drawStory(
  ctx: CanvasRenderingContext2D,
  story: Story,
  cam: Camera,
  w: number,
  h: number,
  now: number,
  playStart: number,
): void {
  const away = awayEvent(story);
  if (away) drawArc(ctx, story, away, cam, w, h, now, playStart);

  const [hx, hy] = project(story.home.lon, story.home.lat, cam, w, h);
  ctx.beginPath();
  ctx.arc(hx, hy, 7, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(148, 163, 184, 0.9)";
  ctx.stroke();

  const pulse = 1 + 0.15 * Math.sin(now / 300);
  ctx.fillStyle = "rgba(239, 68, 68, 0.95)";
  ctx.shadowColor = "rgba(239, 68, 68, 0.9)";
  for (const e of story.events) {
    const [px, py] = project(e.lon, e.lat, cam, w, h);
    ctx.beginPath();
    ctx.arc(px, py, 6 * pulse, 0, Math.PI * 2);
    ctx.shadowBlur = 18;
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

// Live pings on top, faded by age. Returns the pings still within their life, so
// the caller can swap its buffer: drawing and expiry walk the same list once.
// An off-screen ping is kept but not drawn — the camera may pan back to it.
export function drawPings(
  ctx: CanvasRenderingContext2D,
  pings: Ping[],
  cam: Camera,
  w: number,
  h: number,
  now: number,
): Ping[] {
  const kept: Ping[] = [];
  for (const p of pings) {
    const life = p.alerted ? ALERT_LIFE_MS : NORMAL_LIFE_MS;
    const age = now - p.born;
    if (age > life) continue;
    kept.push(p);
    const [px, py] = project(p.lon, p.lat, cam, w, h);
    if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
    const t = age / life;
    const alpha = 1 - t * t;
    if (p.alerted) {
      const r = 5 + 7 * (1 - Math.min(1, t * 3));
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(239, 68, 68, ${alpha})`;
      ctx.shadowColor = "rgba(239, 68, 68, 0.9)";
      ctx.shadowBlur = 20;
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(148, 163, 184, ${alpha * 0.7})`;
      ctx.fill();
    }
  }
  return kept;
}
