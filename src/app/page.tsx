"use client";

// The wall: a dark, full-screen world map of the live payment flow. Every event
// pings at its real lat/lon; anomalies ignite red and enter a story queue. A
// story zooms the camera to fit the customer's home and the event locations,
// shows a booth-legible card, draws a glowing arc for a geo-hop, and runs the
// "How Qdrant Sees It" panel that teaches the per-customer kNN score. Between
// stories the map is the attract loop: full world view, live pings.
//
// The SSE stream is deterministic, so a reconnect resumes without gaps: we dedupe
// by event ID and only surface a "Reconnecting" hint in the ticker. All of that
// dedupe/ticker/reconnect machinery is unchanged from the hash-dot wall; only the
// rendering and the story choreography are new.

import { useEffect, useMemo, useRef, useState } from "react";
import { CITIES, haversineKm } from "@/lib/geo";
import {
  fitCamera,
  LAT_MAX,
  LAT_MIN,
  lerpCamera,
  project,
  worldCamera,
  type Camera,
} from "@/lib/mapview";
import landDots from "@/lib/land-dots.json";
import type { PersonaSummary } from "@/lib/world";
import QdrantPanel, { type PanelSubject } from "./qdrant-panel";
import AttackPanel from "./attack-panel";

interface WallEvent {
  id: string | number;
  tenant_id: string;
  amount: number;
  currency: string;
  merchant: string;
  city: string;
  lat: number;
  lon: number;
  home_city: string;
  home_lat: number;
  home_lon: number;
  score: number;
  alerted: boolean;
  learning: boolean;
  explanation: string;
  // Generator events carry the full per-stage timings; browser-attack pickups
  // are replayed from payload, not rescored, so theirs is null.
  timings: { scroll: number; knn: number; upsert: number; total: number } | null;
  // Alerted events only.
  vector?: number[];
  neighbor_ids?: (string | number)[];
  d_event?: number;
  d_local?: number;
}

// A live map ping, positioned in geographic coordinates and faded by age.
interface Ping {
  lon: number;
  lat: number;
  born: number; // performance.now()
  alerted: boolean;
  id: string | number;
}

// One coalesced attack. A burst of alerts from the same customer within
// COALESCE_MS is one story, not six.
interface Story {
  id: string; // first event's id
  tenant_id: string;
  events: WallEvent[]; // all alerted, newest appended
  home: { city: string; lat: number; lon: number };
  lastAt: number; // performance.now() of the last appended event
  played: boolean;
}

type Conn = "connecting" | "live" | "reconnecting";

const NORMAL_LIFE_MS = 3000;
const ALERT_LIFE_MS = 9000;
const SEEN_CAP = 8000;
const LATENCY_CAP = 300;
const EPS_WINDOW_MS = 2000;

const COALESCE_MS = 20_000; // same-customer alerts within this window = one story
const STORY_CAP = 10; // stories kept in the rail, newest first; oldest is dropped
const STORY_TTL_MS = 60_000; // unpinned queue entries fade out and drop after this
const STORY_FADE_MS = 5_000; // fade duration at the end of the TTL
const HOLD_MS = 7000; // auto mode: how long a story holds before easing back to world
const CAM_MS = 800; // camera transition duration
const AUTO_KEY = "wall-auto-play"; // localStorage flag for the pacing toggle

// The alert panel's desktop width. The Tailwind class (lg:w-[30rem]) and the
// story-fit math both read this, so they cannot drift.
// ponytail: 30rem in px assumes the 16px root font; move the class and this together.
const PANEL_REM = 30;
const PANEL_PX = PANEL_REM * 16;
const LG_MIN = 1024; // Tailwind lg breakpoint; the panel is fixed-right at/above this

const LAND = landDots.points as [number, number][];

// Deterministic sub-degree jitter from the event id, so stacked events at one
// city fan out instead of overprinting, and a re-emitted duplicate lands in the
// same spot.
function jitter(id: string | number): [number, number] {
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

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
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

export default function Wall() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pingsRef = useRef<Ping[]>([]);
  const seenRef = useRef<Set<string | number>>(new Set());
  const eventTimesRef = useRef<number[]>([]);
  const latencyRef = useRef<number[]>([]);

  // Camera + its in-flight transition. All three start at the same view; the
  // frame loop replaces them with fresh objects, so sharing the initial literal
  // is safe (and keeps refs out of the render path).
  const initialCam: Camera = { lon: 0, lat: 8, s: 4 };
  const camRef = useRef<Camera>(initialCam);
  const camFromRef = useRef<Camera>(initialCam);
  const camToRef = useRef<Camera>(initialCam);
  const camStartRef = useRef<number>(0);

  // Story orchestration. `stories` is the visible rail (newest first); `playingId`
  // is the pinned story shown on the wall, or null for the world view. Manual is
  // the default: stories pile up and the viewer clicks one to pin it. Auto plays
  // the newest unplayed story on a timer. The rAF loop and the auto-play timer
  // run outside React's render, so they read these through the mirror refs below.
  const [stories, setStories] = useState<Story[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const playStartRef = useRef<number>(0);
  const storiesRef = useRef<Story[]>(stories);
  const playingIdRef = useRef<string | null>(playingId);
  const autoRef = useRef<boolean>(auto);
  const playingStoryRef = useRef<Story | null>(null);

  const [conn, setConn] = useState<Conn>("connecting");
  const [points, setPoints] = useState<number | null>(null);
  const [eps, setEps] = useState(0);
  const [p95, setP95] = useState(0);
  // Ticker-driven clock for the queue's age-based fade (render-safe time source).
  const [tick, setTick] = useState(0);

  // Pointer-drag panning. `down` tracks the active drag; `moved` is the total
  // pixel travel, so an under-threshold release stays a click (ping hit-test).
  const dragRef = useRef<{ x: number; y: number; moved: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  // The inline attack launcher drawer. Persona is fetched from /api/persona when
  // the drawer opens (and re-fetched by "New Persona").
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [persona, setPersona] = useState<{ tenantId: string; persona: PersonaSummary } | null>(null);

  async function loadPersona(): Promise<void> {
    setPersona(null);
    const r = await fetch("/api/persona");
    setPersona(await r.json());
  }

  function openLauncher(): void {
    setLauncherOpen(true);
    if (!persona) void loadPersona();
  }

  function setCamTarget(cam: Camera): void {
    camFromRef.current = camRef.current;
    camToRef.current = cam;
    camStartRef.current = performance.now();
  }

  // Coalesce an alerted event into an existing same-customer story within
  // COALESCE_MS (whether or not it is displayed), else start a new story at the
  // front of the rail. Appends keep events[0] stable, which the panel memo needs.
  function enqueueStory(ev: WallEvent): void {
    const now = performance.now();
    setStories((prev) => {
      const idx = prev.findIndex(
        (s) => s.tenant_id === ev.tenant_id && now - s.lastAt < COALESCE_MS,
      );
      if (idx !== -1) {
        const s = prev[idx];
        const updated: Story = { ...s, events: [...s.events, ev], lastAt: now };
        const next = [...prev];
        next[idx] = updated;
        return next;
      }
      const story: Story = {
        id: String(ev.id),
        tenant_id: ev.tenant_id,
        events: [ev],
        home: { city: ev.home_city, lat: ev.home_lat, lon: ev.home_lon },
        lastAt: now,
        played: false,
      };
      // Newest first; drop the oldest past the cap.
      return [story, ...prev].slice(0, STORY_CAP);
    });
  }

  // --- SSE stream ---------------------------------------------------------
  useEffect(() => {
    const es = new EventSource("/api/stream");

    es.addEventListener("open", () => setConn("live"));
    es.onerror = () => setConn("reconnecting"); // EventSource auto-reconnects

    es.addEventListener("tx", (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as WallEvent;
      const seen = seenRef.current;
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      if (seen.size > SEEN_CAP) {
        for (const k of [...seen].slice(0, SEEN_CAP / 2)) seen.delete(k);
      }
      setConn("live");

      const [dlon, dlat] = jitter(ev.id);
      pingsRef.current.push({
        lon: ev.lon + dlon,
        lat: ev.lat + dlat,
        born: performance.now(),
        alerted: ev.alerted,
        id: ev.id,
      });

      eventTimesRef.current.push(Date.now());
      if (ev.timings) latencyRef.current.push(ev.timings.total);
      if (latencyRef.current.length > LATENCY_CAP) latencyRef.current.shift();

      if (ev.alerted) enqueueStory(ev);
    });

    es.addEventListener("stats", (e) => {
      const s = JSON.parse((e as MessageEvent).data) as { points: number };
      setPoints(s.points);
    });

    return () => es.close();
  }, []);

  // Fit a story into the map area the panel does not cover. On desktop the panel
  // owns the right PANEL_PX, so we fit into the remaining width and shift the
  // camera east: with project x = dlon*s + w/2, centering the story at the
  // visible middle (x = w_vis/2) needs cam.lon = storyCenterLon + panelPx/(2*s).
  function fitCameraForStory(story: Story): Camera {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pts: [number, number][] = [
      [story.home.lon, story.home.lat],
      ...story.events.map((e) => [e.lon, e.lat] as [number, number]),
    ];
    const panelPx = w >= LG_MIN ? PANEL_PX : 0;
    const cam = fitCamera(pts, w - panelPx, h);
    if (panelPx > 0) cam.lon += panelPx / (2 * cam.s);
    return cam;
  }

  // Pin a story on the wall (manual click). Taking the wheel switches to manual
  // so a booth person's click is predictable, and marks the story played so a
  // later switch to auto does not replay it.
  function pinStory(id: string): void {
    setAutoPersist(false);
    setPlayingId(id);
    setStories((prev) => prev.map((s) => (s.id === id ? { ...s, played: true } : s)));
  }

  // The × on the story card: back to the world view.
  function closeStory(): void {
    setPlayingId(null);
  }

  // Persist the pacing toggle so a booth setup survives reloads. Called only from
  // client event handlers, where localStorage is defined (SSR-safe).
  function setAutoPersist(next: boolean): void {
    setAuto(next);
    localStorage.setItem(AUTO_KEY, String(next));
  }

  // Load the persisted pacing toggle once on mount. Deferred to an effect (not a
  // useState initializer) so the server and first client render agree on `false`
  // and hydration stays stable; the stored value applies right after mount.
  useEffect(() => {
    const saved = localStorage.getItem(AUTO_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved !== null) setAuto(saved === "true");
  }, []);

  // --- Auto-play (attract loop, off the render path) ----------------------
  // Manual mode leaves this idle: stories accumulate and the viewer clicks
  // through. Auto plays the newest unplayed story, holds HOLD_MS, then eases back
  // to the world before the next.
  useEffect(() => {
    const t = setInterval(() => {
      if (!autoRef.current) return;
      const now = performance.now();
      if (playingIdRef.current === null) {
        const next = storiesRef.current.find((s) => !s.played);
        if (next) {
          setStories((prev) => prev.map((s) => (s.id === next.id ? { ...s, played: true } : s)));
          setPlayingId(next.id);
          playingIdRef.current = next.id; // sync now so the next tick sees it before the render commits
          playStartRef.current = now;
        }
      } else if (now - playStartRef.current >= HOLD_MS) {
        setPlayingId(null);
      }
    }, 150);
    return () => clearInterval(t);
  }, []);

  // The pinned story object, recomputed from state each render. Its identity and
  // events[0] stay stable across coalescing appends, which the panel memo relies on.
  const playingStory = playingId
    ? stories.find((s) => s.id === playingId) ?? null
    : null;
  const playingEventCount = playingStory?.events.length ?? 0;

  // Mirror state into refs so the rAF loop and the auto-play timer, which run
  // outside render, read current values. Synced in an effect (not during render)
  // to keep the ref a render-free channel.
  useEffect(() => {
    storiesRef.current = stories;
    playingIdRef.current = playingId;
    autoRef.current = auto;
    playingStoryRef.current = playingStory;
  });

  // Drive the camera: fit a pinned story (and widen as its burst grows), or ease
  // back to the world view when nothing is pinned.
  useEffect(() => {
    if (playingStory) setCamTarget(fitCameraForStory(playingStory));
    else setCamTarget(worldCamera(window.innerWidth, window.innerHeight));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingId, playingEventCount]);

  // Reset the arc/hold timer when a story pins (manual clicks land here; the
  // auto-play timer sets its own start when it begins a story).
  useEffect(() => {
    if (playingId !== null) playStartRef.current = performance.now();
  }, [playingId]);

  // --- Ticker metrics (recomputed ~2 Hz, off the render path) -------------
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - EPS_WINDOW_MS;
      eventTimesRef.current = eventTimesRef.current.filter((ts) => ts >= cutoff);
      setEps(eventTimesRef.current.length / (EPS_WINDOW_MS / 1000));
      const sorted = [...latencyRef.current].sort((a, b) => a - b);
      setP95(pct(sorted, 95));

      // Expire old queue entries. The pinned story is exempt so a viewer who is
      // studying one never has it yanked away; it expires after unpinning.
      const now = performance.now();
      setTick(now);
      setStories((prev) => {
        const next = prev.filter(
          (s) => s.id === playingIdRef.current || now - s.lastAt < STORY_TTL_MS,
        );
        return next.length === prev.length ? prev : next;
      });
    }, 500);
    return () => clearInterval(t);
  }, []);

  // --- Canvas animation ---------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    // The land + city layer is static for a given camera, so it is rendered to an
    // offscreen canvas and blitted. During a camera transition the camera changes
    // every frame and the offscreen is rebuilt (same cost as drawing direct); on
    // held/attract frames it is a single drawImage.
    // ponytail: rebuild-on-change caching; if profiling shows the transition
    // frames drop, pre-render a few fixed zoom levels instead.
    const land = document.createElement("canvas");
    const lctx = land.getContext("2d")!;
    let landKey = "";

    function size() {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      land.width = w * dpr;
      land.height = h * dpr;
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      landKey = ""; // force a land rebuild
      // Recenter the world when the viewport changes and no story is playing.
      if (playingStoryRef.current === null) {
        const world = worldCamera(w, h);
        camRef.current = world;
        camFromRef.current = world;
        camToRef.current = world;
      }
    }
    size();
    window.addEventListener("resize", size);

    function renderLand(cam: Camera, w: number, h: number) {
      lctx.clearRect(0, 0, w, h);
      // Halftone landmasses.
      const d = Math.max(1.6, Math.min(2.8, cam.s * 0.36));
      lctx.fillStyle = "rgba(71, 85, 105, 0.8)"; // slate-600, readable on a projector
      for (const [lon, lat] of LAND) {
        const [px, py] = project(lon, lat, cam, w, h);
        if (px < -4 || px > w + 4 || py < -4 || py > h + 4) continue;
        lctx.fillRect(px - d / 2, py - d / 2, d, d);
      }
      // City markers + labels.
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

    function frame() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const now = performance.now();

      // Advance the camera transition.
      const tt = (now - camStartRef.current) / CAM_MS;
      camRef.current =
        tt >= 1 ? camToRef.current : lerpCamera(camFromRef.current, camToRef.current, tt);
      const cam = camRef.current;

      // Rebuild the land layer only when the camera (or size) actually changed.
      const key = `${cam.lon.toFixed(2)},${cam.lat.toFixed(2)},${cam.s.toFixed(3)},${w}x${h}`;
      if (key !== landKey) {
        renderLand(cam, w, h);
        landKey = key;
      }

      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(land, 0, 0, w, h);

      // Geo-hop arc + persistent story markers, while a story is playing. Live
      // pings expire in seconds, so a story pinned from the queue later would
      // otherwise zoom to an empty city; these markers live as long as the pin.
      const story = playingStoryRef.current;
      if (story) {
        const away = awayEvent(story);
        if (away) drawArc(ctx, story, away, cam, w, h, now, playStartRef.current);

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

      // Live pings on top.
      const pings = pingsRef.current;
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
      pingsRef.current = kept;
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
  }, []);

  // Pin the story whose events include this event id, retrying briefly. A
  // browser attack's events reach the wall through the stream pickup a beat
  // after the launch, so the story may not exist yet when the drawer asks; give
  // up silently after ~5 s. Used by the drawer's "See The Evidence" action and
  // by clicking an alerted ping.
  function pinStoryForEvent(eventId: string): void {
    const deadline = performance.now() + 5000;
    const attempt = () => {
      const story = storiesRef.current.find((s) =>
        s.events.some((e) => String(e.id) === eventId),
      );
      if (story) {
        pinStory(story.id);
        return;
      }
      if (performance.now() < deadline) setTimeout(attempt, 200);
    };
    attempt();
  }

  // Hit-test a click against live alert pings; pin the nearest one's story. A
  // ping whose story has not arrived yet is ignored.
  function hitTest(mx: number, my: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cam = camRef.current;
    let best: Ping | null = null;
    let bestD = 20 * 20;
    for (const p of pingsRef.current) {
      if (!p.alerted) continue;
      const [px, py] = project(p.lon, p.lat, cam, w, h);
      const dx = px - mx;
      const dy = py - my;
      const dist = dx * dx + dy * dy;
      if (dist < bestD) {
        bestD = dist;
        best = p;
      }
    }
    if (best) pinStoryForEvent(String(best.id));
  }

  // Pointer-drag pans the camera; a release with under ~5px of travel is a click.
  const DRAG_SLOP = 5;

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, moved: 0 };
    setGrabbing(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved += Math.hypot(dx, dy);

    // Convert pixel delta to degrees and pan the camera center. A user pan wins:
    // collapse the in-flight transition onto the dragged camera so nothing eases
    // back until the next pin/close or auto-play retarget.
    const cam = camRef.current;
    const lat = Math.max(LAT_MIN, Math.min(LAT_MAX, cam.lat + dy / cam.s));
    const next: Camera = { lon: cam.lon - dx / cam.s, lat, s: cam.s };
    camRef.current = next;
    camFromRef.current = next;
    camToRef.current = next;
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    setGrabbing(false);
    if (d && d.moved < DRAG_SLOP) hitTest(e.clientX, e.clientY);
  }

  const connLabel =
    conn === "live" ? "Live" : conn === "reconnecting" ? "Reconnecting" : "Connecting";
  const connColor = conn === "live" ? "#22c55e" : "#f59e0b";

  const story = playingStory;
  const subjectEvent = story?.events[0];
  // Memoized on the story's first event, whose identity never changes for the
  // story's life. Wall re-renders every 500ms (ticker); a fresh subject object
  // each render would restart the panel's animation effect mid-play.
  const panelSubject = useMemo<PanelSubject | null>(
    () =>
      subjectEvent && subjectEvent.vector && subjectEvent.neighbor_ids
        ? {
            tenant_id: subjectEvent.tenant_id,
            vector: subjectEvent.vector,
            neighbor_ids: subjectEvent.neighbor_ids.map(String),
            d_event: subjectEvent.d_event ?? 0,
            d_local: subjectEvent.d_local ?? 0,
          }
        : null,
    [subjectEvent],
  );

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#07090d] text-slate-100">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={
          "absolute inset-0 h-full w-full touch-none " +
          (grabbing ? "cursor-grabbing" : "cursor-grab")
        }
      />

      {/* Ticker. Shifts left of the teaching panel while a story plays, so the
          metrics stay visible instead of sliding under it. */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-6 py-4 transition-[padding] duration-300 ${
          story && panelSubject ? "lg:pr-[calc(30rem+1.5rem)]" : ""
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- static 2KB SVG, no optimizer needed */}
          <img
            src="/qdrant-fraud-detection-mark.svg"
            alt="Fraud Detection by Qdrant"
            className="h-11 w-11 shrink-0"
          />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Fraud Detection</h1>
            <p className="truncate text-sm text-slate-400">
              One Qdrant Collection, 200 Customer Baselines, Scored As Events Land
            </p>
          </div>
          <button
            onClick={openLauncher}
            className="pointer-events-auto ml-2 shrink-0 whitespace-nowrap rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/20"
          >
            Launch An Attack
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-4 font-mono text-base text-slate-300">
          <button
            onClick={() => setAutoPersist(!auto)}
            aria-pressed={auto}
            className={
              "pointer-events-auto whitespace-nowrap rounded-lg border px-4 py-2 text-sm font-semibold transition-colors " +
              (auto
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                : "border-slate-600/60 bg-slate-800/40 text-slate-300 hover:bg-slate-700/50")
            }
          >
            Auto Play {auto ? "On" : "Off"}
          </button>
          <Metric label="Events / Sec" value={eps.toFixed(1)} />
          <Metric label="p95 Latency" value={`${Math.round(p95)} ms`} />
          <Metric
            label="Total Points"
            value={points === null ? "-" : points.toLocaleString("en-US")}
          />
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: connColor }}
            />
            <span style={{ color: connColor }}>{connLabel}</span>
          </div>
        </div>
      </div>

      {/* One unified alert panel: score header, one-liner, charge trail, the
          teaching section with the animated scatter, the timings, and the
          evidence link. Fixed-right on desktop, bottom sheet on small screens.
          Keyed on story.id so the scatter animation runs once per story. */}
      {story && panelSubject ? (
        <AlertPanel key={story.id} story={story} subject={panelSubject} onClose={closeStory} />
      ) : null}

      {/* Inline attack launcher drawer (left side / full modal on small screens).
          The wall stays live behind it, so a launched attack flares here. */}
      {launcherOpen ? (
        <LauncherDrawer
          persona={persona}
          onNewPersona={loadPersona}
          onClose={() => setLauncherOpen(false)}
          onSeeEvidence={pinStoryForEvent}
        />
      ) : null}

      {/* Story queue, newest on top. Click an entry to pin its story on the wall
          and browse at your own pace. Scrolls so it never climbs into the card. */}
      {/* Hidden while the launcher drawer covers the same corner. */}
      <div
        className={`absolute bottom-6 left-6 z-10 flex max-h-[calc(100vh-15rem)] w-[26rem] max-w-[80vw] flex-col gap-2 overflow-y-auto ${
          launcherOpen ? "hidden" : ""
        }`}
      >
        {stories.map((s) => {
          const lead = s.events[0];
          const top = s.events.reduce((m, e) => (e.score > m.score ? e : m), s.events[0]);
          const active = s.id === playingId;
          // Age-based fade over the last STORY_FADE_MS of the TTL. The 500ms
          // ticker re-render steps the value; the CSS opacity transition smooths
          // between steps, so the card fades continuously across the window.
          const fadeAge = tick - s.lastAt - (STORY_TTL_MS - STORY_FADE_MS);
          const opacity = active ? 1 : Math.max(0, Math.min(1, 1 - fadeAge / STORY_FADE_MS));
          return (
            <button
              key={s.id}
              onClick={() => pinStory(s.id)}
              aria-pressed={active}
              style={{ opacity, transition: "opacity 500ms linear, background-color 150ms" }}
              className={
                "shrink-0 rounded-lg border px-3 py-2 text-left backdrop-blur " +
                (active
                  ? "border-red-500/70 bg-red-950/95 ring-1 ring-red-500/60"
                  : "border-red-500/40 bg-red-950/85 hover:bg-red-900/80")
              }
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-base font-semibold text-red-400">
                  {top.score.toFixed(1)}x
                </span>
                <span className="truncate text-sm text-slate-300">
                  {top.merchant}, {top.city}
                </span>
              </div>
              <p className="mt-0.5 truncate text-sm leading-snug text-slate-100">
                {lead.explanation}
              </p>
            </button>
          );
        })}
      </div>
    </main>
  );
}

// The unified alert panel: everything about a pinned story in one right-side
// column. Top to bottom: score header, the one-liner and charge trail, the
// "How This Alert Was Caught" teaching section (animated scatter + arithmetic),
// the scoring timings, and the evidence link. Fixed-right on desktop, bottom
// sheet on small screens. Keyed by the caller on story.id, so it remounts (and
// the scatter animation replays) once per story.
// The GET /api/alert/[id] shape the evidence expander renders.
interface Evidence {
  stored: { score: number | null };
  recomputed: { score: number } | null;
  neighbors: {
    id: string | number;
    merchant: string;
    amount: number;
    currency: string;
    city: string;
    ts: string;
    distance: number;
  }[];
}

function AlertPanel({
  story,
  subject,
  onClose,
}: {
  story: Story;
  subject: PanelSubject;
  onClose: () => void;
}) {
  const lead = story.events[0];
  const top = story.events.reduce((m, e) => (e.score > m.score ? e : m), story.events[0]);
  const multi = story.events.length > 1;
  const timings = lead.timings;

  // "View Full Evidence" expands in place. The JSON is fetched once on first
  // expand (keyed by story via the remount), then collapse/expand only toggles.
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);

  async function toggleEvidence(): Promise<void> {
    if (evidenceOpen) {
      setEvidenceOpen(false);
      return;
    }
    setEvidenceOpen(true);
    if (evidence || evidenceLoading) return;
    setEvidenceLoading(true);
    try {
      const r = await fetch(`/api/alert/${top.id}`);
      if (r.ok) setEvidence((await r.json()) as Evidence);
    } finally {
      setEvidenceLoading(false);
    }
  }

  return (
    <aside
      className="pointer-events-auto fixed z-20 flex flex-col gap-5 overflow-y-auto border-slate-700/60 bg-[#0a0d12]/95 backdrop-blur
        inset-x-0 bottom-0 max-h-[58vh] border-t p-4
        lg:inset-y-0 lg:right-0 lg:left-auto lg:h-full lg:max-h-none lg:w-[30rem] lg:border-l lg:border-t-0 lg:p-6"
    >
      {/* a. Score header */}
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-red-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-400">
          Alert
        </span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-3xl font-semibold text-red-400">
            {top.score.toFixed(1)}x
          </span>
          <button
            onClick={onClose}
            aria-label="Close And Return To World View"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-600/60 text-slate-400 transition-colors hover:bg-slate-700/50 hover:text-slate-100"
          >
            &times;
          </button>
        </div>
      </div>

      {/* b. One-liner, who and where, charge trail */}
      <div>
        <p className="text-2xl font-semibold leading-snug text-slate-50">{lead.explanation}</p>
        <p className="mt-2 text-base text-slate-300">
          Customer {story.tenant_id}, home {story.home.city}
        </p>

        {multi ? (
          <div className="mt-3">
            <p className="text-base text-slate-300">
              {story.events.length} Charges At {lead.merchant}
            </p>
            <ul className="mt-1 space-y-0.5 font-mono text-base text-slate-300">
              {story.events.slice(0, 6).map((e) => (
                <li key={String(e.id)} className="flex justify-between gap-4">
                  <span>
                    {e.currency} {e.amount.toLocaleString("en-US")}, {e.city}
                  </span>
                  <span className={e.alerted ? "text-red-400" : "text-slate-400"}>
                    {e.score.toFixed(1)}x
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-3 font-mono text-base text-slate-200">
            {lead.currency} {lead.amount.toLocaleString("en-US")} at {lead.merchant}, {lead.city}
          </p>
        )}
      </div>

      {/* c. How This Alert Was Caught (steps + animated scatter + arithmetic) */}
      <QdrantPanel subject={subject} />

      {/* d. Scoring timings (generator events only; pickups carry no timings) */}
      {timings ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-lg font-semibold text-slate-100">
            Caught In {Math.round(timings.total)} ms
          </h3>
          <TimingRow label="History Lookup" ms={timings.scroll} />
          <TimingRow label="Similarity Search" ms={timings.knn} />
          <TimingRow label="Saving The Event" ms={timings.upsert} />
          <p className="mt-1 text-base leading-snug text-slate-300">
            Searchable immediately; the next charge scores against it.
          </p>
        </section>
      ) : null}

      {/* e. Full evidence, expanded in place: the pinned neighbor table and the
          line proving the stored score reproduces from that neighbor set. */}
      <section className="flex flex-col gap-3">
        <button
          onClick={toggleEvidence}
          aria-expanded={evidenceOpen}
          className="inline-block self-start rounded-lg bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/25"
        >
          View Full Evidence
        </button>

        {evidenceOpen ? (
          evidenceLoading && !evidence ? (
            <p className="text-sm text-slate-300">Loading evidence…</p>
          ) : evidence && evidence.recomputed ? (
            <>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-700/60">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-800/50 text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Merchant</th>
                      <th className="px-3 py-2">Amount</th>
                      <th className="px-3 py-2">City</th>
                      <th className="px-3 py-2">Time</th>
                      <th className="px-3 py-2 text-right">Distance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evidence.neighbors.map((n) => (
                      <tr key={String(n.id)} className="border-t border-slate-800 text-slate-300">
                        <td className="px-3 py-2">{n.merchant}</td>
                        <td className="px-3 py-2 font-mono tabular-nums">
                          {n.currency} {n.amount.toLocaleString("en-US")}
                        </td>
                        <td className="px-3 py-2">{n.city}</td>
                        <td className="px-3 py-2 text-slate-400">{n.ts}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">
                          {n.distance.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-base text-slate-300">
                Stored score {(evidence.stored.score ?? 0).toFixed(3)}; recomputed from those
                same neighbors {evidence.recomputed.score.toFixed(3)}.
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-300">Could not load the evidence.</p>
          )
        ) : null}
      </section>
    </aside>
  );
}

function TimingRow({ label, ms }: { label: string; ms: number }) {
  return (
    <div className="flex items-baseline justify-between border-b border-slate-800/70 pb-1 text-base">
      <span className="text-slate-300">{label}</span>
      <span className="font-mono tabular-nums text-slate-100">{Math.round(ms)} ms</span>
    </div>
  );
}

// The inline attack launcher: a left-side drawer on desktop, a full-height modal
// on small screens. The wall stays live behind it, so a launched attack flares
// on the map and enters the queue; its story pins via "See The Evidence".
function LauncherDrawer({
  persona,
  onNewPersona,
  onClose,
  onSeeEvidence,
}: {
  persona: { tenantId: string; persona: PersonaSummary } | null;
  onNewPersona: () => void;
  onClose: () => void;
  onSeeEvidence: (eventId: string) => void;
}) {
  return (
    <aside
      className="pointer-events-auto fixed z-30 flex flex-col overflow-y-auto border-slate-700/60 bg-[#0a0d12]/97 backdrop-blur
        inset-0 p-5
        sm:inset-y-0 sm:left-0 sm:right-auto sm:w-[26rem] sm:border-r sm:p-6"
    >
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Launch An Attack</h2>
          <p className="mt-0.5 text-sm text-slate-400">Pick an attack and watch it flare on the wall.</p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close The Launcher"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-600/60 text-slate-400 transition-colors hover:bg-slate-700/50 hover:text-slate-100"
        >
          &times;
        </button>
      </div>

      <div className="mt-6">
        {persona ? (
          <AttackPanel
            tenantId={persona.tenantId}
            persona={persona.persona}
            onNewPersona={onNewPersona}
            onSeeEvidence={onSeeEvidence}
          />
        ) : (
          <p className="text-sm text-slate-400">Assigning a persona…</p>
        )}
      </div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <span className="tabular-nums text-slate-100">{value}</span>
    </div>
  );
}
