// API-contract suite (PLAN eval 1). Verifies the recent Qdrant features this
// demo leans on, against a throwaway collection with ~105 synthetic points.
// Every assertion compares a COMPUTED value, never a 200-OK, because the server
// silently accepts unknown fields (the canary proves this is live).
//
// Run: npx tsx --env-file=.env evals/api-contract.ts
// Exits non-zero on any failure.

import { QdrantClient } from "@qdrant/js-client-rest";
import { FEATURE_DIM } from "../src/lib/features";

const URL = process.env.QDRANT_URL!;
const API_KEY = process.env.QDRANT_API_KEY;
const COLL = `fraud_demo_eval_${Date.now()}`;
const client = new QdrantClient({ url: URL, apiKey: API_KEY });

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

// --- Synthetic world: three tenants, deterministic vectors + timestamps. ---

const DIM = FEATURE_DIM;
const EVENT_TS = "2026-06-01T00:00:00Z";
const DAY_MS = 86_400_000;

function base(): number[] {
  return new Array(DIM).fill(0.5);
}
function bump(dim: number, delta: number): number[] {
  const v = base();
  v[dim] += delta;
  return v;
}
function tsMinusDays(days: number): string {
  return new Date(Date.parse(EVENT_TS) - days * DAY_MS).toISOString();
}

const Q = base(); // query vector

// tenant-c: 5 points at known distances (dim0) and varied ages, for the
// formula test. distance from Q = 0.1*(k+1); ages vary so recency reorders.
const cAges = [40, 5, 25, 10, 60];
const cPoints = cAges.map((age, k) => ({
  id: 1 + k,
  vector: { features: bump(0, 0.1 * (k + 1)) },
  payload: { tenant_id: "c", ts: tsMinusDays(age), amount: 10 + k },
}));

// tenant-b: 50 points VERY close to Q (closest globally), for isolation.
const bPoints = Array.from({ length: 50 }, (_, k) => ({
  id: 200 + k,
  vector: { features: bump(1, 0.02 * (k + 1)) },
  payload: { tenant_id: "b", ts: tsMinusDays(k), amount: 100 + k },
}));

// tenant-a: 50 points farther from Q (dim2), for isolation + idempotency.
const aPoints = Array.from({ length: 50 }, (_, k) => ({
  id: 100 + k,
  vector: { features: bump(2, 0.5 + 0.05 * k) },
  payload: { tenant_id: "a", ts: tsMinusDays(k), amount: 500 + k },
}));

const ALL = [...cPoints, ...bPoints, ...aPoints];

function euclid(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}
// Same recency-adjusted score the server should compute.
function expectedFormula(vec: number[], ts: string): number {
  const dist = euclid(Q, vec);
  const deltaSec = Math.abs(Date.parse(ts) - Date.parse(EVENT_TS)) / 1000;
  const decay = 0.5 ** (deltaSec / 2592000); // scale 30 days, midpoint 0.5
  return -1.0 * dist + 0.15 * decay;
}

async function setup() {
  await client.createCollection(COLL, {
    vectors: { features: { size: DIM, distance: "Euclid" } },
  });
  await client.createPayloadIndex(COLL, {
    field_name: "tenant_id",
    field_schema: { type: "keyword", is_tenant: true },
    wait: true,
  });
  await client.createPayloadIndex(COLL, {
    field_name: "ts",
    field_schema: "datetime",
    wait: true,
  });
  await client.upsert(COLL, { wait: true, points: ALL });
}

// 1. is_tenant index accepted AND tenant filter isolates: a plain nearest query
// filtered to tenant-a returns only tenant-a, even though tenant-b sits closer
// to Q. The unfiltered query proves tenant-b is genuinely nearer.
async function testIsolation() {
  const filtered = await client.query(COLL, {
    query: Q,
    using: "features",
    filter: { must: [{ key: "tenant_id", match: { value: "a" } }] },
    with_payload: true,
    limit: 10,
  });
  const allA = filtered.points.every((p) => (p.payload as { tenant_id: string }).tenant_id === "a");

  const unfiltered = await client.query(COLL, {
    query: Q,
    using: "features",
    with_payload: true,
    limit: 1,
  });
  const nearestTenant = (unfiltered.points[0].payload as { tenant_id: string }).tenant_id;

  check(
    "is_tenant filter isolates tenant",
    allA && nearestTenant === "b" && filtered.points.length > 0,
    `filtered→a-only=${allA}, global-nearest=${nearestTenant}`,
  );
}

// 2. Formula rescoring over a Euclid prefetch: server scores and order must
// match the client-side recency-adjusted computation for all 5 known points.
async function testFormula() {
  const res = await client.query(COLL, {
    prefetch: {
      query: Q,
      using: "features",
      filter: { must: [{ key: "tenant_id", match: { value: "c" } }] },
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
                  target: { datetime: EVENT_TS },
                  scale: 2592000,
                  midpoint: 0.5,
                },
              },
            ],
          },
        ],
      },
    },
    with_payload: true,
    limit: 5,
  });

  const expected = cPoints
    .map((p) => ({ id: p.id, score: expectedFormula(p.vector.features, p.payload.ts) }))
    .sort((x, y) => y.score - x.score);

  const orderOk = res.points.every((p, i) => p.id === expected[i].id);
  const scoresOk = res.points.every((p, i) => Math.abs((p.score ?? 0) - expected[i].score) < 1e-4);

  check(
    "formula rescoring matches client-side (score + order)",
    orderOk && scoresOk && res.points.length === 5,
    `order=${orderOk}, scores=${scoresOk}, n=${res.points.length}`,
  );
}

// 3. Timestamp-filtered scroll returns exactly the expected IDs.
async function testScroll() {
  const cutoff = tsMinusDays(30);
  const res = await client.scroll(COLL, {
    filter: {
      must: [
        { key: "tenant_id", match: { value: "c" } },
        { key: "ts", range: { gte: cutoff } },
      ],
    },
    order_by: { key: "ts", direction: "desc" },
    limit: 100,
    with_payload: true,
  });
  const got = res.points.map((p) => p.id).sort((a, b) => Number(a) - Number(b));
  const want = cPoints
    .filter((p) => Date.parse(p.payload.ts) >= Date.parse(cutoff))
    .map((p) => p.id)
    .sort((a, b) => a - b);

  check(
    "timestamp-filtered scroll returns expected IDs",
    JSON.stringify(got) === JSON.stringify(want),
    `got=${JSON.stringify(got)}, want=${JSON.stringify(want)}`,
  );
}

// 4. Idempotent upsert by deterministic ID: same ID twice with different
// payload leaves the count unchanged and keeps the latest payload.
async function testIdempotent() {
  const id = 999;
  await client.upsert(COLL, {
    wait: true,
    points: [{ id, vector: { features: base() }, payload: { tenant_id: "z", amount: 10 } }],
  });
  const c1 = (await client.count(COLL, { exact: true })).count;

  await client.upsert(COLL, {
    wait: true,
    points: [{ id, vector: { features: base() }, payload: { tenant_id: "z", amount: 20 } }],
  });
  const c2 = (await client.count(COLL, { exact: true })).count;

  const got = await client.retrieve(COLL, { ids: [id], with_payload: true });
  const amount = (got[0].payload as { amount: number }).amount;

  check(
    "idempotent upsert (count stable, latest payload wins)",
    c1 === c2 && amount === 20,
    `count ${c1}→${c2}, amount=${amount}`,
  );
}

// 5. CANARY: the typed client can't construct a misspelled parameter, so this
// uses one raw fetch. Known live behavior: a misspelled field inside `prefetch`
// (`limitt`) is silently accepted and ignored, so the prefetch falls back to a
// default limit instead of 1. We prove it by VALUE: the misspelled request
// returns more points than the correctly-spelled `limit: 1` request. If it ever
// starts rejecting the typo, this fails loudly and we can relax the
// value-assertions elsewhere.
async function testCanary() {
  async function rawQuery(prefetch: Record<string, unknown>): Promise<number> {
    const resp = await fetch(`${URL}/collections/${COLL}/points/query`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(API_KEY ? { "api-key": API_KEY } : {}) },
      body: JSON.stringify({ prefetch, query: { nearest: Q }, using: "features", limit: 10 }),
    });
    if (!resp.ok) throw new Error(`raw query HTTP ${resp.status}`);
    const json = (await resp.json()) as { result: { points: unknown[] } };
    return json.result.points.length;
  }

  const filter = { must: [{ key: "tenant_id", match: { value: "a" } }] };
  const honored = await rawQuery({ query: Q, using: "features", filter, limit: 1 });
  const misspelled = await rawQuery({ query: Q, using: "features", filter, limitt: 1 });

  // The typo is ignored, so its prefetch falls back to a larger default and
  // returns more points than the correctly-spelled small limit.
  const silentlyAccepted = misspelled > honored;
  check(
    "canary: misspelled prefetch field is silently accepted",
    silentlyAccepted,
    `limit:1→${honored} points, limitt:1→${misspelled} points`,
  );
  if (silentlyAccepted) {
    console.log(
      "  ⚠️  LIVE FAILURE MODE: Qdrant silently ignores unknown request fields.\n" +
        "     Every eval must assert on computed VALUES, never on 200-OK.",
    );
  }
}

async function main() {
  await setup();
  try {
    await testIsolation();
    await testFormula();
    await testScroll();
    await testIdempotent();
    await testCanary();
  } finally {
    await client.deleteCollection(COLL);
  }
  console.log(failures === 0 ? "\nAll contract tests passed." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
