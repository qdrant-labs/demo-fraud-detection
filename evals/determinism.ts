// Determinism (PLAN eval 4). Two full scoring runs with the same world seed must
// produce identical alert sets and identical scores.
//
// KNOWN FACT: rescoring against a LIVE collection drifts, because kNN and the
// recent-history scroll read collection state that the run itself mutates. So
// determinism only holds against IDENTICAL FRESH collection states. Each run
// therefore starts from the same freshly seeded baseline: seed -> run -> record
// -> drop -> re-seed identically -> run -> compare.
//
// Asserts: the two alert ID SETS are identical, and every event's score matches
// across runs to 1e-9. Reports the set sizes.
//
// Run: npx tsx --env-file=.env evals/determinism.ts

process.env.QDRANT_COLLECTION = "fraud_demo_eval_determinism";

import {
  BUCKET_MS,
  EPOCH,
  liveEvents,
  makeProfile,
  motifSequence,
  WORLD_SEED,
  type Motif,
  type Transaction,
} from "../src/lib/world";

const TENANTS = 10;
const BACKGROUND_TARGET = 450;

// A modest, fully deterministic stream: background for tenants 0-9 plus a few
// injected motifs so the alert set is non-trivial.
function buildStream(): Transaction[] {
  const background: Transaction[] = [];
  let bucket = 0;
  while (background.length < BACKGROUND_TARGET) {
    for (const ev of liveEvents(bucket, WORLD_SEED)) {
      const idx = Number(ev.tenant_id.slice(1));
      if (idx < TENANTS && ev.motif === "none") background.push(ev);
    }
    bucket++;
    if (bucket > 500_000) break;
  }

  const fraudStart = EPOCH + (bucket + 100) * BUCKET_MS;
  const motifs: Exclude<Motif, "none">[] = ["card_testing", "geo_hop", "ladder"];
  const fraud: Transaction[] = [];
  for (let i = 0; i < 6; i++) {
    const motif = motifs[i % motifs.length];
    fraud.push(
      ...motifSequence(
        motif,
        makeProfile(i), // tenants 0-5
        fraudStart + i * 3_600_000,
        `${WORLD_SEED}:detseq:${i}`,
        "generator",
      ),
    );
  }
  return [...background, ...fraud];
}

async function main() {
  const { seedTenants, scoreStream, dropCollection } = await import("./harness");

  const tenants = Array.from({ length: TENANTS }, (_, i) => i);
  const stream = buildStream();

  let exitCode = 1;
  try {
    // Run 1: fresh state.
    await dropCollection();
    await seedTenants(tenants);
    const r1 = await scoreStream(stream);

    // Run 2: identical fresh state.
    await dropCollection();
    await seedTenants(tenants);
    const r2 = await scoreStream(stream);

    const alerts1 = new Set([...r1].filter(([, s]) => s.alerted).map(([id]) => id));
    const alerts2 = new Set([...r2].filter(([, s]) => s.alerted).map(([id]) => id));

    const sameSize = alerts1.size === alerts2.size;
    const sameSet = sameSize && [...alerts1].every((id) => alerts2.has(id));

    let maxScoreDelta = 0;
    for (const [id, s1] of r1) {
      const s2 = r2.get(id);
      if (!s2) {
        maxScoreDelta = Infinity;
        break;
      }
      maxScoreDelta = Math.max(maxScoreDelta, Math.abs(s1.score - s2.score));
    }
    const scoresMatch = maxScoreDelta < 1e-9;

    let failures = 0;
    const check = (name: string, ok: boolean, detail = "") => {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
      if (!ok) failures++;
    };

    console.log(`Scored ${stream.length} events per run across ${TENANTS} tenants.`);
    console.log(`Alert set sizes: run1=${alerts1.size}, run2=${alerts2.size}`);
    check("alert ID sets identical across runs", sameSet, `sizes ${alerts1.size} vs ${alerts2.size}`);
    check("all scores match to 1e-9 across runs", scoresMatch, `max delta=${maxScoreDelta.toExponential(2)}`);

    console.log(failures === 0 ? "\nDeterminism PASS." : `\nDeterminism FAIL (${failures}).`);
    exitCode = failures === 0 ? 0 : 1;
  } finally {
    await dropCollection();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
