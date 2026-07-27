"use client";

// "How Qdrant Sees It": the teaching layer that runs beside a playing story. It
// shows the same alerted event in the customer's vector space and animates the
// scoring, in four beats:
//   a. the customer's baseline scatter fades in (x = anomaly direction, y = PCA),
//   b. the event drops in red,
//   c. its 10 pinned neighbors light amber with connecting lines,
//   d. the score arithmetic counts up: d_event, d_local, then the ratio vs 2.0.
//
// The projection is the pca.ts anomalyProjector.
// Baseline vectors come from GET /api/baseline/[tenant]; if they have not
// arrived by panel time, the arithmetic still plays without the cloud rather
// than blocking the story. d_event / d_local are the values computed at scoring
// time, carried on the alerted wire event.

import { useEffect, useRef, useState } from "react";
import { anomalyProjector } from "@/lib/pca";

// Mirrors score.ts ALERT_THRESHOLD. Hardcoded because score.ts pulls world.ts
// (node:crypto) and cannot cross into the client bundle; the server already
// sends each event's alert verdict, so this constant is display-only.
// ponytail: one number in one client file; if the threshold ever moves, update
// score.ts and this together.
const THRESHOLD = 2.0;

// Beat timings (ms from panel start).
const T_BASELINE = 1100; // baseline fully faded in by here
const T_EVENT = 2000; // event dropped in by here
const T_NEIGHBORS = 3300; // all neighbors lit by here
const T_D_EVENT = 4100;
const T_D_LOCAL = 4700;
const T_RATIO = 5400;

export interface PanelSubject {
  tenant_id: string;
  vector: number[];
  neighbor_ids: string[];
  d_event: number;
  d_local: number;
}

interface BaselinePoint {
  id: string | number;
  vector: number[];
}

function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
}

function fmt(n: number, d: number): string {
  return n.toFixed(d);
}

export default function QdrantPanel({ subject }: { subject: PanelSubject }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The baseline lands in a ref, not state: the animation effect below must not
  // re-run (and reset its timeline) when the fetch resolves mid-play. The frame
  // loop picks the cloud up on whatever beat it arrives.
  const baselineRef = useRef<BaselinePoint[] | null>(null);
  const [nums, setNums] = useState({ dEvent: 0, dLocal: 0, ratio: 0, ratioDone: false });

  // Fetch the baseline cloud once per subject. A failure leaves it null and the
  // panel plays the arithmetic alone.
  useEffect(() => {
    baselineRef.current = null;
    let cancelled = false;
    fetch(`/api/baseline/${subject.tenant_id}`)
      .then((r) => r.json())
      .then((d: { points: BaselinePoint[] }) => {
        if (!cancelled) baselineRef.current = d.points;
      })
      .catch(() => {
        if (!cancelled) baselineRef.current = [];
      });
    return () => {
      cancelled = true;
    };
  }, [subject.tenant_id]);

  // One rAF timeline drives both the canvas and the counting numbers.
  useEffect(() => {
    const start = performance.now();
    let raf = 0;

    // Project once baseline is present; null until then.
    let projected: { xy: [number, number]; isNeighbor: boolean }[] | null = null;
    let eventXY: [number, number] | null = null;
    let neighborXY: [number, number][] = [];
    let bounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };

    function setup() {
      const baseline = baselineRef.current;
      if (!baseline || baseline.length === 0) return;
      const nbSet = new Set(subject.neighbor_ids);
      // x-axis = neighbors' centroid -> event (the direction the score measures),
      // y-axis = the history's main spread. See anomalyProjector for why plain
      // PCA put the red event visually on top of its amber neighbors.
      const project = anomalyProjector(
        baseline.map((p) => p.vector),
        subject.vector,
        baseline.filter((p) => nbSet.has(String(p.id))).map((p) => p.vector),
      );
      projected = baseline.map((p) => ({
        xy: project(p.vector),
        isNeighbor: nbSet.has(String(p.id)),
      }));
      eventXY = project(subject.vector);
      neighborXY = projected.filter((p) => p.isNeighbor).map((p) => p.xy);
      const all = [...projected.map((p) => p.xy), eventXY];
      const xs = all.map((p) => p[0]);
      const ys = all.map((p) => p[1]);
      bounds = {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
      };
    }
    setup();

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    const W = 640;
    const H = 380;
    const pad = 26;
    if (canvas && ctx) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = "100%";
      canvas.style.aspectRatio = `${W} / ${H}`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const sx = (x: number) =>
      pad + ((x - bounds.minX) / (bounds.maxX - bounds.minX || 1)) * (W - 2 * pad);
    const sy = (y: number) =>
      H - pad - ((y - bounds.minY) / (bounds.maxY - bounds.minY || 1)) * (H - 2 * pad);

    function frame(now: number) {
      const t = now - start;
      if (!projected) setup(); // cloud data may arrive mid-play

      if (ctx) {
        ctx.clearRect(0, 0, W, H);
        if (projected && eventXY) {
          // a. baseline cloud fades in.
          const baseA = ease(t / T_BASELINE) * 0.5;
          if (baseA > 0) {
            ctx.fillStyle = `rgba(100, 116, 139, ${baseA})`;
            for (const p of projected) {
              if (p.isNeighbor) continue;
              ctx.beginPath();
              ctx.arc(sx(p.xy[0]), sy(p.xy[1]), 2.2, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          // c. neighbors light amber with connecting lines, staggered.
          if (t > T_EVENT) {
            const ex = sx(eventXY[0]);
            const ey = sy(eventXY[1]);
            neighborXY.forEach((xy, i) => {
              const appear = T_EVENT + (i / Math.max(1, neighborXY.length)) * (T_NEIGHBORS - T_EVENT);
              const a = ease((t - appear) / 400);
              if (a <= 0) return;
              const nx = sx(xy[0]);
              const ny = sy(xy[1]);
              ctx.strokeStyle = `rgba(245, 158, 11, ${a * 0.35})`;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(ex, ey);
              ctx.lineTo(nx, ny);
              ctx.stroke();
              ctx.fillStyle = `rgba(245, 158, 11, ${a * 0.95})`;
              ctx.beginPath();
              ctx.arc(nx, ny, 4.5, 0, Math.PI * 2);
              ctx.fill();
            });
          }

          // b. the event drops in red (from above, easing to place).
          const evA = ease((t - T_BASELINE * 0.6) / 700);
          if (evA > 0) {
            const drop = (1 - ease((t - T_BASELINE * 0.6) / 700)) * 30;
            ctx.fillStyle = `rgba(239, 68, 68, ${evA})`;
            ctx.shadowColor = "rgba(239, 68, 68, 0.8)";
            ctx.shadowBlur = 14;
            ctx.beginPath();
            ctx.arc(sx(eventXY[0]), sy(eventXY[1]) - drop, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        }
      }

      // d. arithmetic counts up.
      const dEvent = ease((t - T_NEIGHBORS) / (T_D_EVENT - T_NEIGHBORS)) * subject.d_event;
      const dLocal = ease((t - T_D_EVENT) / (T_D_LOCAL - T_D_EVENT)) * subject.d_local;
      const ratioP = ease((t - T_D_LOCAL) / (T_RATIO - T_D_LOCAL));
      const ratio = ratioP * (subject.d_local > 0 ? subject.d_event / subject.d_local : 0);
      setNums({ dEvent, dLocal, ratio, ratioDone: ratioP >= 1 });

      // Keep animating through the beats, and past them while the baseline
      // fetch is still in flight (it settles to [] on failure, ending the loop).
      if (t < T_RATIO || baselineRef.current === null) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [subject]);

  const finalRatio = subject.d_local > 0 ? subject.d_event / subject.d_local : 0;
  const alert = finalRatio > THRESHOLD;

  return (
    <section className="flex flex-col gap-4">
      <h3 className="text-lg font-semibold text-slate-100">How This Alert Was Caught</h3>

      <Step
        n={1}
        title="Every Charge Becomes a Vector"
        body="Amount, time, place, and merchant type combine into one vector. Similar charges land close together."
      />

      <Step
        n={2}
        title="Qdrant Finds 10 Similar Charges"
        body="In this customer's history only. Gray is their past, red this charge, amber the 10 similar charges."
      />

      <canvas
        ref={canvasRef}
        className="w-full rounded-lg border border-slate-700/60 bg-slate-900/50"
      />
      <p className="-mt-2 text-sm text-slate-500">
        Further right = further from this customer&apos;s usual behavior
      </p>

      <div className="grid grid-cols-3 gap-2">
        <Cell
          label="This Charge"
          hint="how far this charge sits from 10 similar charges"
          value={fmt(nums.dEvent, 3)}
        />
        <Cell
          label="Usual Range"
          hint="how far apart 10 similar charges normally sit"
          value={fmt(nums.dLocal, 3)}
        />
        <Cell
          label="How Unusual"
          hint="distance ÷ usual range, alerts above 2×"
          value={`${fmt(nums.ratio, 2)}×`}
          highlight={nums.ratioDone && alert}
        />
      </div>

    </section>
  );
}

// One numbered teaching step. Body text is text-base/slate-300 (the panel's
// legibility floor, sized for booth distance) so nothing here reads as fine print.
function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-600/70 text-sm font-semibold text-slate-200">
        {n}
      </span>
      <div>
        <p className="text-base font-semibold text-slate-100">{title}</p>
        <p className="mt-1 text-base leading-snug text-slate-300">{body}</p>
      </div>
    </div>
  );
}

function Cell({
  label,
  hint,
  value,
  highlight,
}: {
  label: string;
  hint?: string; // one-line plain-language explainer, the one sub-label allowed below the floor
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 px-3 py-2">
      <div className="text-sm leading-tight text-slate-300">{label}</div>
      {hint ? <div className="mt-0.5 text-xs leading-snug text-slate-500">{hint}</div> : null}
      <div
        className={
          "mt-1 font-mono text-2xl tabular-nums " + (highlight ? "text-red-400" : "text-slate-100")
        }
      >
        {value}
      </div>
    </div>
  );
}
