// Latency harness (PLAN gate: p95 event->score < 300 ms server-side budget).
// Scores 50 sequential live events for one seeded tenant and reports p50/p95
// per Qdrant round trip plus total.
//
// These numbers include local RTT from this machine to the cluster's region,
// so they are an upper bound on the server-side budget, not the budget itself.
// Reported as measured; not adjusted.
//
// Run: npx tsx --env-file=.env evals/latency.ts

import { scoreEvent, type StageTimings } from "../src/lib/score";
import { ensureCollection } from "../src/lib/qdrant";
import { liveEvents, WORLD_SEED } from "../src/lib/world";

const N = 50;
const TENANT = "t0000"; // a seeded tenant (index 0)

// Collect N live events that belong to the target tenant by scanning buckets.
// liveEvents produces profile-conforming events for the seeded tenants.
function eventsForTenant(): ReturnType<typeof liveEvents> {
  const out: ReturnType<typeof liveEvents> = [];
  for (let bucket = 0; out.length < N && bucket < 200_000; bucket++) {
    for (const ev of liveEvents(bucket, WORLD_SEED)) {
      if (ev.tenant_id === TENANT && ev.motif === "none") {
        out.push(ev);
        if (out.length >= N) break;
      }
    }
  }
  return out;
}

function pct(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  await ensureCollection();
  const events = eventsForTenant();
  if (events.length < N) throw new Error(`only found ${events.length} events for ${TENANT}`);

  const stages = ["scroll", "knn", "upsert", "total"] as const;
  const samples: Record<(typeof stages)[number], number[]> = { scroll: [], knn: [], upsert: [], total: [] };

  for (const ev of events) {
    const t: Partial<StageTimings> = {};
    await scoreEvent(ev, t);
    for (const s of stages) samples[s].push(t[s]!);
  }

  console.log(`Scored ${N} sequential events for ${TENANT}. Timings in ms (incl. local RTT):\n`);
  console.log("stage    p50     p95");
  for (const s of stages) {
    const sorted = [...samples[s]].sort((a, b) => a - b);
    console.log(`${s.padEnd(7)} ${pct(sorted, 50).toFixed(1).padStart(6)}  ${pct(sorted, 95).toFixed(1).padStart(6)}`);
  }

  const totalSorted = [...samples.total].sort((a, b) => a - b);
  const p95 = pct(totalSorted, 95);
  console.log(`\nTotal p95: ${p95.toFixed(1)} ms (server-side budget 300 ms; this includes local RTT).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
