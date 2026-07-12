// Evidence panel for one scored event. Deep-linkable (/alert/<uuid> with no
// other state) because the browser attack flow links straight here.
//
// Exactly two round trips happen server-side: retrieve the event point (vector +
// payload), then retrieve its PINNED neighbors by the IDs stored at scoring
// time. The score is recomputed from those neighbor vectors with the same
// helper the scorer used; it must equal the stored score (the Phase 4 gate).
// The pinned neighbor set is why: a fresh kNN would drift once more of the
// tenant's events exist, and the panel is meant to reproduce the original math.

import Link from "next/link";
import { notFound } from "next/navigation";
import { COLLECTION, FEATURE_VECTOR, qdrant } from "@/lib/qdrant";
import { ALERT_THRESHOLD, scoreFromVectors } from "@/lib/score";
import Scatter from "./scatter";

export const dynamic = "force-dynamic";

function vectorOf(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (v && typeof v === "object") {
    const named = (v as Record<string, unknown>)[FEATURE_VECTOR];
    if (Array.isArray(named)) return named as number[];
  }
  return [];
}

function fmt(n: number, d = 4): string {
  return n.toFixed(d);
}

export default async function AlertPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // A malformed ID (not a valid UUID/uint) makes Qdrant reject the retrieve;
  // treat that the same as "not found" so a bad deep link renders the friendly
  // 404 instead of a 500.
  let got: Awaited<ReturnType<typeof qdrant.retrieve>> = [];
  try {
    got = await qdrant.retrieve(COLLECTION, {
      ids: [id],
      with_vector: true,
      with_payload: true,
    });
  } catch {
    notFound();
  }
  if (got.length === 0) notFound();

  const point = got[0];
  const eventVector = vectorOf(point.vector);
  const pl = (point.payload ?? {}) as Record<string, unknown>;

  const storedScore = pl.score === undefined ? null : Number(pl.score);
  const alerted = Boolean(pl.alerted);
  const explanation = String(pl.explanation ?? "");
  const neighborIds = Array.isArray(pl.neighbor_ids)
    ? (pl.neighbor_ids as (string | number)[])
    : [];

  const meta = {
    merchant: String(pl.merchant ?? ""),
    city: String(pl.city ?? ""),
    amount: Number(pl.amount ?? 0),
    currency: String(pl.currency ?? ""),
    ts: String(pl.ts ?? ""),
    tenant_id: String(pl.tenant_id ?? ""),
    channel_src: String(pl.channel_src ?? ""),
  };

  // A baseline (never-scored) point has no pinned neighbors: show it labeled
  // normal, with no arithmetic to reproduce.
  const isScored = storedScore !== null && neighborIds.length > 0;

  let recompute: ReturnType<typeof scoreFromVectors> | null = null;
  let neighbors: {
    id: string | number;
    merchant: string;
    amount: number;
    currency: string;
    city: string;
    ts: string;
    distance: number;
  }[] = [];

  if (isScored) {
    const retrieved = await qdrant.retrieve(COLLECTION, {
      ids: neighborIds,
      with_vector: true,
      with_payload: true,
    });
    // retrieve does not guarantee it returns points in request order, but the
    // neighbor list and distances must render in the stored ranked order. Rebuild
    // by neighbor_ids so row i is the i-th ranked neighbor.
    const byId = new Map(retrieved.map((p) => [String(p.id), p]));
    const nbPoints = neighborIds
      .map((nid) => byId.get(String(nid)))
      .filter((p): p is (typeof retrieved)[number] => p !== undefined);
    const nbVectors = nbPoints.map((p) => vectorOf(p.vector));
    recompute = scoreFromVectors(eventVector, nbVectors);
    neighbors = nbPoints.map((p, i) => {
      const npl = (p.payload ?? {}) as Record<string, unknown>;
      return {
        id: p.id,
        merchant: String(npl.merchant ?? ""),
        amount: Number(npl.amount ?? 0),
        currency: String(npl.currency ?? ""),
        city: String(npl.city ?? ""),
        ts: String(npl.ts ?? ""),
        distance: recompute!.distances[i],
      };
    });
  }

  const storedDEvent = pl.d_event === undefined ? null : Number(pl.d_event);
  const storedDLocal = pl.d_local === undefined ? null : Number(pl.d_local);

  return (
    <main className="min-h-screen bg-[#07090d] px-6 py-8 text-slate-100">
      <div
        className="mx-auto max-w-5xl"
        // Machine-readable numbers so the Phase 4 gate can parse and compare
        // the recomputed score against the stored one without scraping prose.
        data-alert-id={String(point.id)}
        data-stored-score={storedScore === null ? "" : fmt(storedScore, 6)}
        data-recomputed-score={recompute ? fmt(recompute.score, 6) : ""}
        data-stored-d-event={storedDEvent === null ? "" : fmt(storedDEvent, 6)}
        data-recomputed-d-event={recompute ? fmt(recompute.d_event, 6) : ""}
        data-stored-d-local={storedDLocal === null ? "" : fmt(storedDLocal, 6)}
        data-recomputed-d-local={recompute ? fmt(recompute.d_local, 6) : ""}
      >
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">
            &larr; Back To The Wall
          </Link>
          <span
            className={
              alerted
                ? "rounded-full bg-red-500/15 px-3 py-1 text-xs font-medium text-red-400"
                : "rounded-full bg-slate-500/15 px-3 py-1 text-xs font-medium text-slate-400"
            }
          >
            {alerted ? "Alert" : "Normal"}
          </span>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight">
          {meta.currency} {meta.amount.toLocaleString("en-US")} at {meta.merchant}
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Customer {meta.tenant_id}, {meta.city}, {meta.ts}
          {meta.channel_src === "browser_attack" ? ", Browser Launch" : ""}
        </p>

        {explanation ? (
          <p className="mt-4 rounded-lg border border-slate-700/60 bg-slate-800/40 px-4 py-3 text-slate-100">
            {explanation}
          </p>
        ) : null}

        {isScored && recompute ? (
          <>
            {/* Score arithmetic */}
            <section className="mt-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                Score Arithmetic
              </h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat
                  label="d_event"
                  hint="Mean Distance To 10 Neighbors"
                  value={fmt(recompute.d_event)}
                />
                <Stat
                  label="d_local"
                  hint="Mean Neighbor-To-Centroid Distance"
                  value={fmt(recompute.d_local)}
                />
                <Stat
                  label="Score"
                  hint={`d_event / d_local, Threshold ${ALERT_THRESHOLD}`}
                  value={fmt(recompute.score, 3)}
                  highlight={recompute.score > ALERT_THRESHOLD}
                />
              </div>
              <p className="mt-3 font-mono text-sm text-slate-300">
                {fmt(recompute.d_event)} / {fmt(recompute.d_local)} ={" "}
                {fmt(recompute.score, 3)}{" "}
                {recompute.score > ALERT_THRESHOLD ? ">" : "<="} {ALERT_THRESHOLD}{" "}
                {recompute.score > ALERT_THRESHOLD ? "(Alert)" : "(Normal)"}
              </p>
              {storedScore !== null ? (
                <p className="mt-2 text-xs text-slate-500">
                  Stored score {fmt(storedScore, 3)}; recomputed from the pinned
                  neighbors {fmt(recompute.score, 3)}. These match by construction:
                  the neighbor set is fixed at scoring time.
                </p>
              ) : null}
            </section>

            {/* Neighbor list */}
            <section className="mt-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                Nearest Neighbors In This Customer&apos;s Baseline
              </h2>
              <div className="overflow-x-auto rounded-lg border border-slate-700/60">
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
                    {neighbors.map((n) => (
                      <tr key={String(n.id)} className="border-t border-slate-800">
                        <td className="px-3 py-2">{n.merchant}</td>
                        <td className="px-3 py-2 tabular-nums">
                          {n.currency} {n.amount.toLocaleString("en-US")}
                        </td>
                        <td className="px-3 py-2">{n.city}</td>
                        <td className="px-3 py-2 text-slate-400">{n.ts}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">
                          {fmt(n.distance, 3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Baseline scatter */}
            <section className="mt-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                Customer Baseline, Projected To 2-D
              </h2>
              <Scatter
                tenantId={meta.tenant_id}
                eventVector={eventVector}
                neighborIds={neighborIds.map(String)}
              />
              <p className="mt-2 text-xs text-slate-500">
                Baseline points dim, the 10 neighbors amber, this event red. PCA
                computed in the browser over the tenant&apos;s 31-d vectors.
              </p>
            </section>
          </>
        ) : (
          <p className="mt-8 text-sm text-slate-400">
            This point is a baseline transaction. It was never scored, so there is
            no neighbor set or arithmetic to reproduce.
          </p>
        )}
      </div>
    </main>
  );
}

function Stat({
  label,
  hint,
  value,
  highlight,
}: {
  label: string;
  hint: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 px-4 py-3">
      <div className="font-mono text-xs text-slate-400">{label}</div>
      <div
        className={
          "mt-1 font-mono text-2xl tabular-nums " +
          (highlight ? "text-red-400" : "text-slate-100")
        }
      >
        {value}
      </div>
      <div className="mt-1 text-[0.7rem] text-slate-500">{hint}</div>
    </div>
  );
}
