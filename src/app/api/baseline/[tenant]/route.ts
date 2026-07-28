// The tenant's points (vectors only) for the evidence-panel scatter. One scroll
// filtered to the tenant, up to ~800 points; the client projects them with PCA.
// This is the third and last round trip the panel makes (retrieve point,
// retrieve neighbors, scroll baseline); it never re-runs the kNN.

import { COLLECTION, qdrant, vectorOf } from "@/lib/qdrant";
import { tenantIndex } from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tenant: string }> },
): Promise<Response> {
  const { tenant } = await params;
  // Public route: only the 200 seeded demo personas are servable. Anything else
  // (including the other 19,800 cardholders backing the Stored Charges counter)
  // is rejected before any Qdrant work.
  if (tenantIndex(tenant) === null) {
    return Response.json({ error: "unknown tenant" }, { status: 404 });
  }
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
