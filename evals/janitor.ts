// Janitor check (Feature 4). The wall upserts every scored event and never
// deletes it, so a long-open wall grows fraud_demo without bound. On each stream
// connection the SSE route fires deleteStaleScored, which removes scored events
// older than 24h. The `must_not is_empty(score)` guard must spare the seeded
// baseline points, which carry no `score` field.
//
// This seeds four points into a THROWAWAY collection: an old scored point, a
// recent scored point, an old baseline point (no score), a recent baseline
// point. After the janitor runs, ONLY the old scored point must be gone.
//
// qdrant.ts captures COLLECTION at import, so it is imported DYNAMICALLY below,
// after QDRANT_COLLECTION is set. A static import hoists above the assignment
// and would run against the live fraud_demo collection.
//
// Run: npx tsx --env-file=.env evals/janitor.ts
// Exits non-zero on any failure.

process.env.QDRANT_COLLECTION = "fraud_demo_eval_janitor";

import { FEATURE_DIM } from "../src/lib/features";

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed UUID ids so the eval's points never collide with real event ids.
const OLD_SCORED = "00000000-0000-4000-8000-000000000001";
const NEW_SCORED = "00000000-0000-4000-8000-000000000002";
const OLD_BASELINE = "00000000-0000-4000-8000-000000000003";
const NEW_BASELINE = "00000000-0000-4000-8000-000000000004";

function vec(): number[] {
  return new Array(FEATURE_DIM).fill(0.5);
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const { COLLECTION, deleteStaleScored, ensureCollection, FEATURE_VECTOR, qdrant } =
    await import("../src/lib/qdrant");
  if (COLLECTION !== "fraud_demo_eval_janitor") {
    throw new Error(`refusing to run against "${COLLECTION}"; expected the throwaway collection`);
  }

  // Start clean: an earlier run may have left this collection behind.
  try {
    await qdrant.deleteCollection(COLLECTION);
  } catch {
    // already gone
  }
  await ensureCollection();

  const old = new Date(Date.now() - 2 * DAY_MS).toISOString(); // 2 days old
  const recent = new Date().toISOString();

  await qdrant.upsert(COLLECTION, {
    wait: true,
    points: [
      { id: OLD_SCORED, vector: { [FEATURE_VECTOR]: vec() }, payload: { tenant_id: "t1", ts: old, score: 3.1 } },
      { id: NEW_SCORED, vector: { [FEATURE_VECTOR]: vec() }, payload: { tenant_id: "t1", ts: recent, score: 3.1 } },
      { id: OLD_BASELINE, vector: { [FEATURE_VECTOR]: vec() }, payload: { tenant_id: "t1", ts: old } },
      { id: NEW_BASELINE, vector: { [FEATURE_VECTOR]: vec() }, payload: { tenant_id: "t1", ts: recent } },
    ],
  });

  await deleteStaleScored(DAY_MS);

  const got = await qdrant.retrieve(COLLECTION, {
    ids: [OLD_SCORED, NEW_SCORED, OLD_BASELINE, NEW_BASELINE],
  });
  const alive = new Set(got.map((p) => String(p.id)));

  check("old scored point deleted", !alive.has(OLD_SCORED));
  check("recent scored point kept", alive.has(NEW_SCORED));
  check(
    "old baseline (no score) kept",
    alive.has(OLD_BASELINE),
    "must_not is_empty(score) protects the seeded baseline",
  );
  check("recent baseline (no score) kept", alive.has(NEW_BASELINE));

  await qdrant.deleteCollection(COLLECTION);

  console.log(
    failures === 0
      ? "\nAll janitor checks passed."
      : `\n${failures} janitor check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
