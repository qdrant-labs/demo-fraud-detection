// JSON evidence for one scored event. Everything the alert panel's "View Full
// Evidence" expander shows, computed server-side, and the surface the Phase 4
// gate asserts against.
//
// Exactly two Qdrant round trips: retrieve the event point (vector + payload),
// then retrieve its PINNED neighbors by the IDs stored at scoring time. The
// score is recomputed from those neighbor vectors with the same helper the
// scorer used; it must equal the stored score. The pinned neighbor set is why:
// a fresh kNN would drift once more of the tenant's events exist, and this must
// reproduce the original math.

import { COLLECTION, FEATURE_VECTOR, qdrant } from "@/lib/qdrant";
import { scoreFromVectors } from "@/lib/score";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function vectorOf(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (v && typeof v === "object") {
    const named = (v as Record<string, unknown>)[FEATURE_VECTOR];
    if (Array.isArray(named)) return named as number[];
  }
  return [];
}

function notFoundJson(): Response {
  return Response.json({ error: "not found" }, { status: 404 });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  // A malformed ID (not a valid UUID/uint) makes Qdrant reject the retrieve;
  // treat that the same as "not found" so a bad id returns 404 JSON, not a 500.
  let got: Awaited<ReturnType<typeof qdrant.retrieve>>;
  try {
    got = await qdrant.retrieve(COLLECTION, {
      ids: [id],
      with_vector: true,
      with_payload: true,
    });
  } catch {
    return notFoundJson();
  }
  if (got.length === 0) return notFoundJson();

  const point = got[0];
  const eventVector = vectorOf(point.vector);
  const pl = (point.payload ?? {}) as Record<string, unknown>;

  const storedScore = pl.score === undefined ? null : Number(pl.score);
  const storedDEvent = pl.d_event === undefined ? null : Number(pl.d_event);
  const storedDLocal = pl.d_local === undefined ? null : Number(pl.d_local);
  const neighborIds = Array.isArray(pl.neighbor_ids)
    ? (pl.neighbor_ids as (string | number)[])
    : [];

  const meta = {
    merchant: String(pl.merchant ?? ""),
    amount: Number(pl.amount ?? 0),
    currency: String(pl.currency ?? ""),
    city: String(pl.city ?? ""),
    ts: String(pl.ts ?? ""),
    tenant_id: String(pl.tenant_id ?? ""),
    channel_src: String(pl.channel_src ?? ""),
  };

  // A baseline (never-scored) point has no pinned neighbors: nothing to reproduce.
  const isScored = storedScore !== null && neighborIds.length > 0;

  let recomputed: { score: number; d_event: number; d_local: number } | null = null;
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
    // retrieve does not guarantee request order; rebuild by neighbor_ids so row
    // i is the i-th ranked neighbor and the distances line up.
    const byId = new Map(retrieved.map((p) => [String(p.id), p]));
    const nbPoints = neighborIds
      .map((nid) => byId.get(String(nid)))
      .filter((p): p is (typeof retrieved)[number] => p !== undefined);
    const nbVectors = nbPoints.map((p) => vectorOf(p.vector));
    const math = scoreFromVectors(eventVector, nbVectors);
    recomputed = { score: math.score, d_event: math.d_event, d_local: math.d_local };
    neighbors = nbPoints.map((p, i) => {
      const npl = (p.payload ?? {}) as Record<string, unknown>;
      return {
        id: p.id,
        merchant: String(npl.merchant ?? ""),
        amount: Number(npl.amount ?? 0),
        currency: String(npl.currency ?? ""),
        city: String(npl.city ?? ""),
        ts: String(npl.ts ?? ""),
        distance: math.distances[i],
      };
    });
  }

  return Response.json({
    id: point.id,
    meta,
    alerted: Boolean(pl.alerted),
    explanation: String(pl.explanation ?? ""),
    contrasts: Array.isArray(pl.contrasts) ? pl.contrasts : [],
    stored: { score: storedScore, d_event: storedDEvent, d_local: storedDLocal },
    recomputed,
    neighbor_ids: neighborIds.map(String),
    neighbors,
  });
}
