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

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CITIES, haversineKm } from "@/lib/geo";
import {
  fitCamera,
  lerpCamera,
  project,
  worldCamera,
  type Camera,
} from "@/lib/mapview";
import landDots from "@/lib/land-dots.json";
import QdrantPanel, { type PanelSubject } from "./qdrant-panel";

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
  timings: { total: number } | null;
  // Alerted events only.
  vector?: number[];
  neighbor_ids?: (string | number)[];
  d_event?: number;
  d_local?: number;
}

interface Alert {
  id: string | number;
  merchant: string;
  city: string;
  score: number;
  explanation: string;
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
const QUEUE_CAP = 3; // pending stories; oldest unplayed is dropped past this
const HOLD_MS = 7000; // how long a story holds before easing back to world
const CAM_MS = 800; // camera transition duration

// Mirrors score.ts ALERT_THRESHOLD; display-only, the server sends each verdict.
const THRESHOLD = 2.0;

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

export default function Wall() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pingsRef = useRef<Ping[]>([]);
  const seenRef = useRef<Set<string | number>>(new Set());
  const eventTimesRef = useRef<number[]>([]);
  const latencyRef = useRef<number[]>([]);

  // Camera + its in-flight transition.
  const camRef = useRef<Camera>({ lon: 0, lat: 8, s: 4 });
  const camFromRef = useRef<Camera>(camRef.current);
  const camToRef = useRef<Camera>(camRef.current);
  const camStartRef = useRef<number>(0);

  // Story orchestration. Refs are the source of truth (read by the rAF loop);
  // `force` re-renders the card/panel when the displayed story changes.
  const queueRef = useRef<Story[]>([]);
  const playingRef = useRef<Story | null>(null);
  const phaseRef = useRef<"attract" | "playing">("attract");
  const playStartRef = useRef<number>(0);
  const [, force] = useReducer((x: number) => x + 1, 0);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [conn, setConn] = useState<Conn>("connecting");
  const [points, setPoints] = useState<number | null>(null);
  const [eps, setEps] = useState(0);
  const [p95, setP95] = useState(0);

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
      if (ev.timings) latencyRef.current.push(ev.timings.total);
      if (latencyRef.current.length > LATENCY_CAP) latencyRef.current.shift();

      if (ev.alerted) {
        // One rail entry per attack, not one per burst event: skip when the
        // newest entry is already this merchant's alert in this city. The story
        // card carries the burst's full trail. Capped at 5 so the rail never
        // climbs into the story card.
        setAlerts((prev) =>
          prev[0] && prev[0].merchant === ev.merchant && prev[0].city === ev.city
            ? prev
            : [
                {
                  id: ev.id,
                  merchant: ev.merchant,
                  city: ev.city,
                  score: ev.score,
                  explanation: ev.explanation,
                },
                ...prev,
              ].slice(0, 5),
        );
        enqueueStory(ev);
      }
    });

    es.addEventListener("stats", (e) => {
      const s = JSON.parse((e as MessageEvent).data) as { points: number };
      setPoints(s.points);
    });

    return () => es.close();
    // enqueueStory closes only over refs/setters, stable for the connection's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coalesce an alerted event into the playing story or the queue, else start a
  // new story. Same customer within COALESCE_MS is one attack.
  function enqueueStory(ev: WallEvent): void {
    const now = performance.now();
    const playing = playingRef.current;
    if (playing && playing.tenant_id === ev.tenant_id && now - playing.lastAt < COALESCE_MS) {
      playing.events.push(ev);
      playing.lastAt = now;
      // Widen the camera to keep the new location in frame.
      setCamTarget(fitCameraForStory(playing));
      force();
      return;
    }
    const queued = queueRef.current.find(
      (s) => s.tenant_id === ev.tenant_id && now - s.lastAt < COALESCE_MS,
    );
    if (queued) {
      queued.events.push(ev);
      queued.lastAt = now;
      return;
    }
    const story: Story = {
      id: String(ev.id),
      tenant_id: ev.tenant_id,
      events: [ev],
      home: { city: ev.home_city, lat: ev.home_lat, lon: ev.home_lon },
      lastAt: now,
      played: false,
    };
    queueRef.current.push(story);
    // Drop the oldest unplayed story past the cap.
    if (queueRef.current.length > QUEUE_CAP) queueRef.current.shift();
  }

  function fitCameraForStory(story: Story): Camera {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pts: [number, number][] = [
      [story.home.lon, story.home.lat],
      ...story.events.map((e) => [e.lon, e.lat] as [number, number]),
    ];
    return fitCamera(pts, w, h);
  }

  // --- Story player (phase timers, off the render path) -------------------
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now();
      if (phaseRef.current === "attract") {
        const next = queueRef.current.shift();
        if (next) {
          next.played = true;
          playingRef.current = next;
          phaseRef.current = "playing";
          playStartRef.current = now;
          setCamTarget(fitCameraForStory(next));
          force();
        }
      } else if (now - playStartRef.current >= HOLD_MS) {
        phaseRef.current = "attract";
        playingRef.current = null;
        setCamTarget(worldCamera(window.innerWidth, window.innerHeight));
        force();
      }
    }, 150);
    return () => clearInterval(t);
  }, []);

  // --- Ticker metrics (recomputed ~2 Hz, off the render path) -------------
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - EPS_WINDOW_MS;
      eventTimesRef.current = eventTimesRef.current.filter((ts) => ts >= cutoff);
      setEps(eventTimesRef.current.length / (EPS_WINDOW_MS / 1000));
      const sorted = [...latencyRef.current].sort((a, b) => a - b);
      setP95(pct(sorted, 95));
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
      if (phaseRef.current === "attract") {
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
        lctx.font = "11px ui-sans-serif, system-ui, sans-serif";
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

      // Geo-hop arc, while a story with an away-leg is playing.
      const story = playingRef.current;
      if (story) {
        const away = awayEvent(story);
        if (away) drawArc(ctx, story, away, cam, w, h, now);
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

  // A glowing quadratic arc from home to the away city, drawn progressively, with
  // the great-circle distance labeled at its apex.
  function drawArc(
    ctx: CanvasRenderingContext2D,
    story: Story,
    away: WallEvent,
    cam: Camera,
    w: number,
    h: number,
    now: number,
  ): void {
    const [hx, hy] = project(story.home.lon, story.home.lat, cam, w, h);
    const [ex, ey] = project(away.lon, away.lat, cam, w, h);
    const cx = (hx + ex) / 2;
    const cy = (hy + ey) / 2 - Math.min(200, Math.hypot(ex - hx, ey - hy) * 0.4 + 40);

    const p = ease((now - playStartRef.current) / 1200);
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
    ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(km).toLocaleString("en-US")} km`, cx, cy - 8);
    ctx.textAlign = "start";
  }

  // Click a live alert ping to open its evidence panel.
  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cam = camRef.current;
    const mx = e.clientX;
    const my = e.clientY;
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
    if (best) router.push(`/alert/${best.id}`);
  }

  const connLabel =
    conn === "live" ? "Live" : conn === "reconnecting" ? "Reconnecting" : "Connecting";
  const connColor = conn === "live" ? "#22c55e" : "#f59e0b";

  const story = playingRef.current;
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
        onClick={onCanvasClick}
        className="absolute inset-0 h-full w-full"
      />

      {/* Ticker. Shifts left of the teaching panel while a story plays, so the
          metrics stay visible instead of sliding under it. */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-6 py-4 transition-[padding] duration-300 ${
          story && panelSubject ? "lg:pr-[calc(32%+1.5rem)]" : ""
        }`}
      >
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- static 2KB SVG, no optimizer needed */}
          <img
            src="/qdrant-fraud-detection-mark.svg"
            alt="Fraud Detection by Qdrant"
            className="h-11 w-11"
          />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Fraud Detection</h1>
            <p className="text-xs text-slate-400">
              One Qdrant Collection, 200 Customer Baselines, Scored As Events Land
            </p>
          </div>
        </div>
        <div className="flex items-center gap-6 font-mono text-sm text-slate-300">
          <Metric label="Events / Sec" value={eps.toFixed(1)} />
          <Metric label="p95 Score" value={`${Math.round(p95)} ms`} />
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

      {/* Story card */}
      {story ? <StoryCard story={story} /> : null}

      {/* Teaching panel, right third on desktop / bottom sheet on small screens */}
      {story && panelSubject ? (
        <aside
          className="pointer-events-auto fixed z-20 overflow-y-auto border-slate-700/60 bg-[#0a0d12]/95 backdrop-blur
            inset-x-0 bottom-0 max-h-[58vh] border-t p-4
            lg:inset-y-0 lg:right-0 lg:left-auto lg:h-full lg:max-h-none lg:w-[32%] lg:border-l lg:border-t-0 lg:p-6"
        >
          <QdrantPanel key={story.id} subject={panelSubject} />
        </aside>
      ) : null}

      {/* Recent alerts, newest on top */}
      <div className="absolute bottom-6 left-6 z-10 flex w-[26rem] max-w-[80vw] flex-col gap-2">
        {alerts.map((a) => (
          <button
            key={String(a.id)}
            onClick={() => router.push(`/alert/${a.id}`)}
            className="group rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-left transition-colors hover:bg-red-500/20"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-sm font-semibold text-red-400">
                {a.score.toFixed(1)}x
              </span>
              <span className="truncate text-xs text-slate-400">
                {a.merchant}, {a.city}
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-snug text-slate-200">{a.explanation}</p>
          </button>
        ))}
      </div>
    </main>
  );
}

// The booth-legible story card: the one-liner, who and where, the amount trail,
// and the score against the threshold.
function StoryCard({ story }: { story: Story }) {
  const lead = story.events[0];
  const top = story.events.reduce((m, e) => (e.score > m.score ? e : m), story.events[0]);
  const multi = story.events.length > 1;
  return (
    <div className="pointer-events-none absolute left-6 top-24 z-10 w-[30rem] max-w-[calc(100vw-3rem)] rounded-2xl border border-red-500/30 bg-[#0a0d12]/85 p-5 backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-red-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-400">
          Alert
        </span>
        <span className="font-mono text-2xl font-semibold text-red-400">
          {top.score.toFixed(1)}x
        </span>
      </div>

      <p className="mt-3 text-xl font-semibold leading-snug text-slate-50">
        {lead.explanation}
      </p>

      <p className="mt-3 text-sm text-slate-400">
        Customer {story.tenant_id}, home {story.home.city}
      </p>

      {multi ? (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {story.events.length} Charges At {lead.merchant}
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-sm text-slate-300">
            {story.events.slice(0, 6).map((e) => (
              <li key={String(e.id)} className="flex justify-between gap-4">
                <span>
                  {e.currency} {e.amount.toLocaleString("en-US")}, {e.city}
                </span>
                <span className={e.alerted ? "text-red-400" : "text-slate-500"}>
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

      <p className="mt-3 font-mono text-xs text-slate-500">
        Score {top.score.toFixed(2)}x, threshold {THRESHOLD.toFixed(1)}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="text-[0.65rem] uppercase tracking-wide text-slate-500">{label}</span>
      <span className="tabular-nums text-slate-100">{value}</span>
    </div>
  );
}
