// The tenant's points (vectors only) for the evidence-panel scatter. One scroll
// filtered to the tenant, up to ~800 points; the client projects them with PCA.
// This is the third and last round trip the panel makes (retrieve point,
// retrieve neighbors, scroll baseline); it never re-runs the kNN.

import { COLLECTION, FEATURE_VECTOR, qdrant } from "@/lib/qdrant";

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

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tenant: string }> },
): Promise<Response> {
  const { tenant } = await params;
  const res = await qdrant.scroll(COLLECTION, {
    filter: { must: [{ key: "tenant_id", match: { value: tenant } }] },
    limit: 800,
    with_vector: true,
    with_payload: false,
  });
  const points = res.points
    .map((p) => ({ id: p.id, vector: vectorOf(p.vector) }))
    .filter((p) => p.vector.length > 0);
  return Response.json({ points });
}
