// Tenant isolation (PLAN eval 6). Proves the tenant_id filter, not luck, is what
// keeps each customer's anomaly score local. We build ONE event vector for
// tenant A, then run the exact kNN formula query the scorer uses twice against
// the LIVE fraud_demo collection: once filtered to A, once to B. We recompute
// d_event/d_local client-side from each neighbor set and assert the two scores
// differ meaningfully, and that every returned neighbor belongs to the filtered
// tenant.
//
// Read-only: no upserts, no collection changes. Uses its own client pinned to
// "fraud_demo" so no eval env var can redirect it.
//
// Run: npx tsx --env-file=.env evals/tenant-isolation.ts

import { QdrantClient } from "@qdrant/js-client-rest";
import { encode, recentHistory } from "../src/lib/features";
import { scoreFromVectors, ALERT_THRESHOLD, NEIGHBOR_EXCLUDE_MS } from "../src/lib/score";
import { baselineTransactions, makeProfile } from "../src/lib/world";

const COLL = "fraud_demo"; // the LIVE collection, read-only
const FEATURE_VECTOR = "features";
const TENANT_A = "t0000";
const TENANT_B = "t0001";

const client = new QdrantClient({
  url: process.env.QDRANT_URL!,
  apiKey: process.env.QDRANT_API_KEY,
});

// The same recency-adjusted kNN query scoreEvent runs, against one tenant. Same
// shape byte-for-byte, including the ts < (event - NEIGHBOR_EXCLUDE_MS) clause
// that keeps the kNN on the tenant's established baseline; the constant is
// imported from score.ts so the two cannot drift.
async function knn(vector: number[], tenantId: string, eventTs: string) {
  const neighborCutoff = new Date(Date.parse(eventTs) - NEIGHBOR_EXCLUDE_MS).toISOString();
  return client.query(COLL, {
    prefetch: {
      query: vector,
      using: FEATURE_VECTOR,
      filter: {
        must: [
          { key: "tenant_id", match: { value: tenantId } },
          { key: "ts", range: { lt: neighborCutoff } },
        ],
      },
      limit: 100,
    },
    query: {
      formula: {
        sum: [
          { mult: [-1.0, "$score"] },
          {
            mult: [
              0.15,
              {
                exp_decay: {
                  x: { datetime_key: "ts" },
                  target: { datetime: eventTs },
                  scale: 2592000,
                  midpoint: 0.5,
                },
              },
            ],
          },
        ],
      },
    },
    with_vector: true,
    with_payload: true,
    limit: 10,
  });
}

function vectorOf(point: { vector?: unknown }): number[] {
  const v = point.vector;
  if (Array.isArray(v)) return v as number[];
  if (v && typeof v === "object") {
    const named = (v as Record<string, unknown>)[FEATURE_VECTOR];
    if (Array.isArray(named)) return named as number[];
  }
  throw new Error("neighbor returned without its vector");
}

async function main() {
  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  // One event vector built from tenant A's own profile: an A-conforming
  // transaction with a neutral (empty) recent-history context, so it is not an
  // exact copy of any stored point. It sits inside A's cluster and far from B's.
  const profileA = makeProfile(0);
  const tx = baselineTransactions(profileA)[100]; // a real A transaction
  const rh = recentHistory(tx, []);
  const isNewMerchant = !profileA.merchants.some((m) => m.name === tx.merchant);
  const vector = encode(tx, rh, {
    homeCurrency: profileA.homeCity.currency,
    isNewMerchant,
  });

  const resA = await knn(vector, TENANT_A, tx.ts);
  const resB = await knn(vector, TENANT_B, tx.ts);

  if (resA.points.length === 0 || resB.points.length === 0) {
    throw new Error(
      `empty neighbor set (A=${resA.points.length}, B=${resB.points.length}); is fraud_demo seeded?`,
    );
  }

  const mathA = scoreFromVectors(vector, resA.points.map(vectorOf));
  const mathB = scoreFromVectors(vector, resB.points.map(vectorOf));

  const tenantsA = resA.points.map((p) => (p.payload as { tenant_id: string }).tenant_id);
  const tenantsB = resB.points.map((p) => (p.payload as { tenant_id: string }).tenant_id);
  check(
    "every A-neighbor belongs to tenant A",
    tenantsA.every((t) => t === TENANT_A),
    `distinct=${[...new Set(tenantsA)].join(",")}`,
  );
  check(
    "every B-neighbor belongs to tenant B",
    tenantsB.every((t) => t === TENANT_B),
    `distinct=${[...new Set(tenantsB)].join(",")}`,
  );

  const relDiff = Math.abs(mathA.score - mathB.score) / Math.max(mathA.score, mathB.score);
  const alertA = mathA.score > ALERT_THRESHOLD;
  const alertB = mathB.score > ALERT_THRESHOLD;
  const differ = relDiff > 0.2 || alertA !== alertB;

  console.log(
    `\nSame A-event vector scored against each tenant's baseline:` +
      `\n  tenant A: score=${mathA.score.toFixed(3)} (d_event=${mathA.d_event.toFixed(3)}, d_local=${mathA.d_local.toFixed(3)}), alert=${alertA}` +
      `\n  tenant B: score=${mathB.score.toFixed(3)} (d_event=${mathB.d_event.toFixed(3)}, d_local=${mathB.d_local.toFixed(3)}), alert=${alertB}` +
      `\n  relative difference=${(relDiff * 100).toFixed(1)}%`,
  );
  check(
    "scores differ meaningfully (rel diff > 20% or different alert outcome)",
    differ,
    `relDiff=${(relDiff * 100).toFixed(1)}%, alerts ${alertA}/${alertB}`,
  );

  console.log(failures === 0 ? "\nTenant-isolation PASS." : `\nTenant-isolation FAIL (${failures}).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
