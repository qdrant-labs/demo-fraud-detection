"use client";

// The wall: a dark, full-screen world map of the live payment flow. Every event
// pings at its real lat/lon; anomalies ignite red and enter a story queue. A
// story zooms the camera to fit the customer's home and the event locations,
// shows a booth-legible card, draws a glowing arc for a geo-hop, and runs the
// "How Qdrant Sees It" panel that teaches the per-customer kNN score. Between
// stories the map is the attract loop: full world view, live pings.
//
// This file is the wiring: the SSE consumer, the story queue's React state, the
// camera, the pointer handling, the rAF loop, and the layout. The pieces it
// drives live next door:
//
//   lib/wall-story.ts   the wire event shape, the Story type, and the pure
//                       enqueue/expire queue rules (with a self-check)
//   lib/wall-draw.ts    every canvas layer: land, the story arc and markers,
//                       the live pings
//   lib/mapview.ts      the camera and the lon/lat -> pixel projection
//   alert-panel.tsx     the pinned story's right-side panel
//   qdrant-panel.tsx    the "How Qdrant Sees It" teaching animation inside it
//
// The SSE stream is deterministic, so a reconnect resumes without gaps: we dedupe
// by event ID and only surface a "Reconnecting" hint in the ticker.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fitCamera,
  LAT_MAX,
  LAT_MIN,
  lerpCamera,
  project,
  worldCamera,
  type Camera,
} from "@/lib/mapview";
import { drawPings, drawStory, jitter, renderLand, type Ping } from "@/lib/wall-draw";
import {
  enqueue,
  expire,
  STORY_FADE_MS,
  STORY_TTL_MS,
  topEvent,
  type Story,
  type WallEvent,
} from "@/lib/wall-story";
import type { PersonaSummary } from "@/lib/world";
import AlertPanel, { LG_MIN, PANEL_PX, ScoreMeter } from "./alert-panel";
import { type PanelSubject } from "./qdrant-panel";
import AttackPanel from "./attack-panel";

type Conn = "connecting" | "live" | "reconnecting";

const SEEN_CAP = 8000;
const LATENCY_CAP = 300;
const EPS_WINDOW_MS = 2000;

const HOLD_MS = 7000; // auto mode: how long a story holds before easing back to world
const CAM_MS = 800; // camera transition duration
const AUTO_KEY = "wall-auto-play"; // localStorage flag for the pacing toggle
const DRAG_SLOP = 5; // a pointer release under this much travel is a click, not a pan

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
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
  // Decision latency: the two reads that must finish before an approve/decline,
  // with the upsert left out (a card authorization has a hard end-to-end budget
  // and the write is post-decision persistence). p50 and p95, not p99: the
  // rolling buffer holds LATENCY_CAP observations, so p99 here would be the
  // third-worst sample. The controlled p99 lives in the scale benchmark.
  const [p50, setP50] = useState(0);
  const [p95, setP95] = useState(0);
  // Ticker-driven clock for the queue's age-based fade (render-safe time source).
  const [tick, setTick] = useState(0);

  // Pointer-drag panning. `down` tracks the active drag; `moved` is the total
  // pixel travel, so an under-threshold release stays a click (ping hit-test).
  const dragRef = useRef<{ x: number; y: number; moved: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  // The inline attack launcher drawer. Persona is fetched from /api/persona when
  // the drawer opens (and re-fetched by "New Customer").
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
      // scroll + knn, not total: the buffer feeds the decision-latency metric.
      if (ev.timings) latencyRef.current.push(ev.timings.scroll + ev.timings.knn);
      if (latencyRef.current.length > LATENCY_CAP) latencyRef.current.shift();

      if (ev.alerted) {
        const now = performance.now();
        setStories((prev) => enqueue(prev, ev, now, playingIdRef.current));
      }
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
      setP50(pct(sorted, 50));
      setP95(pct(sorted, 95));

      const now = performance.now();
      setTick(now);
      setStories((prev) => expire(prev, now, playingIdRef.current));
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
        renderLand(lctx, cam, w, h);
        landKey = key;
      }

      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(land, 0, 0, w, h);

      const story = playingStoryRef.current;
      if (story) drawStory(ctx, story, cam, w, h, now, playStartRef.current);
      pingsRef.current = drawPings(ctx, pingsRef.current, cam, w, h, now);

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
  // The same worst-charge event the header badge shows (topEvent), not
  // events[0] — otherwise the panel explains a different, usually milder,
  // charge than the ratio in the header, and the two numbers drift apart.
  const subjectEvent = story ? topEvent(story) : undefined;
  // Wall re-renders every 500ms (ticker); memoized so a fresh subject object
  // each render doesn't restart the panel's animation effect mid-play. Only
  // changes identity when a new worse charge actually arrives.
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
              Each Charge Scored Against That Customer&apos;s Own History
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
          <Metric label="Charges / Sec" value={eps.toFixed(1)} />
          <Metric
            label="Typical / Slow Decision"
            value={`${Math.round(p50)} / ${Math.round(p95)} ms`}
          />
          <Metric
            label="Stored Charges"
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
          const top = topEvent(s);
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
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5">
                  <ScoreMeter score={top.score} />
                  <span className="font-mono text-base font-semibold text-red-400">
                    {top.score.toFixed(1)}
                  </span>
                </span>
                <span className="truncate text-sm text-slate-300">
                  {top.merchant}, {top.city}
                </span>
              </div>
              <p className="mt-0.5 truncate text-sm leading-snug text-slate-100">
                {top.explanation}
              </p>
            </button>
          );
        })}
      </div>
    </main>
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
          <p className="mt-0.5 text-sm text-slate-400">Pick a fraud pattern and watch the wall react.</p>
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
          <p className="text-sm text-slate-400">Loading a customer…</p>
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
