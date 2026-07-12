"use client";

// A 2-D PCA scatter of the tenant's baseline, drawn on a canvas. The two
// principal components are found by power iteration over the covariance of the
// baseline vectors (deflate for the second), which is ~30 lines and needs no
// dependency for 800 points in 31 dimensions. The event and its neighbors are
// projected onto the same basis so they line up with the baseline cloud.

import { useEffect, useRef, useState } from "react";
import { pcaProjector } from "@/lib/pca";

interface BaselinePoint {
  id: string | number;
  vector: number[];
}

export default function Scatter({
  tenantId,
  eventVector,
  neighborIds,
}: {
  tenantId: string;
  eventVector: number[];
  neighborIds: string[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [baseline, setBaseline] = useState<BaselinePoint[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/baseline/${tenantId}`)
      .then((r) => r.json())
      .then((d: { points: BaselinePoint[] }) => {
        if (!cancelled) setBaseline(d.points);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  useEffect(() => {
    if (!baseline || baseline.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    const vectors = baseline.map((p) => p.vector);
    const project = pcaProjector(vectors);

    const neighborSet = new Set(neighborIds);
    const projected = baseline.map((p) => ({
      xy: project(p.vector),
      isNeighbor: neighborSet.has(String(p.id)),
    }));
    const eventXY = project(eventVector);

    // Fit all points (baseline + event) into the canvas.
    const allXY = [...projected.map((p) => p.xy), eventXY];
    const xs = allXY.map((p) => p[0]);
    const ys = allXY.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const W = 900;
    const H = 420;
    const pad = 24;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = "100%";
    canvas.style.aspectRatio = `${W} / ${H}`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sx = (x: number) =>
      pad + ((x - minX) / (maxX - minX || 1)) * (W - 2 * pad);
    const sy = (y: number) =>
      H - pad - ((y - minY) / (maxY - minY || 1)) * (H - 2 * pad);

    ctx.clearRect(0, 0, W, H);

    // Baseline (dim), then neighbors (amber) on top.
    for (const p of projected) {
      if (p.isNeighbor) continue;
      ctx.beginPath();
      ctx.arc(sx(p.xy[0]), sy(p.xy[1]), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(100, 116, 139, 0.5)";
      ctx.fill();
    }
    for (const p of projected) {
      if (!p.isNeighbor) continue;
      ctx.beginPath();
      ctx.arc(sx(p.xy[0]), sy(p.xy[1]), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
      ctx.fill();
    }
    // The event (red), on top of everything.
    ctx.beginPath();
    ctx.arc(sx(eventXY[0]), sy(eventXY[1]), 7, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(239, 68, 68, 1)";
    ctx.shadowColor = "rgba(239, 68, 68, 0.8)";
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.shadowBlur = 0;
  }, [baseline, eventVector, neighborIds]);

  if (error) {
    return (
      <p className="text-sm text-slate-500">Could not load the baseline scatter.</p>
    );
  }
  if (!baseline) {
    return <p className="text-sm text-slate-500">Loading baseline scatter&hellip;</p>;
  }
  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-lg border border-slate-700/60 bg-slate-900/40"
    />
  );
}
