// Decision latency against the LIVE cloud collection, read-only.
//
// scripts/bench-scale.ts cannot do this job: it creates and deletes a
// collection, and its two guards (localhost URL, ^bench_ name) exist to keep it
// away from the cloud cluster. Those guards stay. This script is the opposite
// shape - it never creates, never deletes, never writes, and refuses to run
// against a collection that does not already exist.
//
// It samples exactly like bench-scale so the rows compare: SAMPLES distinct
// cardholders spread across the collection, each event a clone of that
// cardholder's last baseline transaction placed 1 ms before it, scored
// sequentially, after a warmup on cardholders outside the measured set.
//
// TWO NUMBERS PER STAGE, because this runs over a WAN link and the demo does
// not:
//   srv   what Qdrant reports it spent handling the request (the `time` field
//         every REST response carries). No network in it. This is the number
//         that compares to the loopback rows in evals/results/scale.jsonl, and
//         what a same-region caller pays on top of its own round trip.
//   wall  what this process observed, so it carries this machine's round trip to
//         the cluster region. Honest, and NOT the demo's latency.
// A round-trip floor (GET / over the same connection pool) is measured before
// and after the run, so the gap between srv and wall can be attributed.
//
// READ-ONLY IS ENFORCED, NOT INTENDED, by scripts/read-only-fetch.ts: every
// request that is not the context scroll or the kNN query throws before it
// leaves the process. `persist: false` alone would not do it, because an alerted
// event upserts anyway (src/lib/score.ts, the `persist = alerted || ...` line).
// A sample that alerts dies at its upsert and is counted and dropped rather than
// written. ensureCollection() is deliberately NOT called: it issues five
// createPayloadIndex writes. The lock has its own test
// (scripts/read-only-fetch.test.ts).
//
//   QDRANT_URL=... QDRANT_API_KEY=... QDRANT_COLLECTION=fraud_demo \
//     npx tsx scripts/bench-cloud.ts --tenants 20000 --days 90 --tx-scale 1
//
// Flags: --tenants N (the collection's cardholder count) --days D --tx-scale S
//        [--samples 1000] [--warmup 100] [--label name]

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { COLLECTION, qdrant } from "../src/lib/qdrant";
import { scoreEvent, type StageTimings } from "../src/lib/score";
import {
  baselineTransactions,
  makeProfile,
  WORLD_SEED,
  type Transaction,
} from "../src/lib/world";
import { guard, installReadOnlyFetch, srvTime, WriteBlocked } from "./read-only-fetch";

installReadOnlyFetch();

// --- Arguments ---------------------------------------------------------------
function refuse(why: string): never {
  console.error(`bench-cloud refused to run: ${why}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
function num(flag: string, def: number): number {
  const i = argv.indexOf(flag);
  if (i === -1) return def;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v)) refuse(`${flag} needs a number`);
  return v;
}
const TENANTS = num("--tenants", 0);
const DAYS = num("--days", 90);
const TX_SCALE = num("--tx-scale", 1);
const SAMPLES = num("--samples", 1000);
const WARMUP = num("--warmup", 100);
const labelIdx = argv.indexOf("--label");
const LABEL = labelIdx === -1 ? "" : String(argv[labelIdx + 1]);
if (TENANTS < 1) refuse("--tenants is required (the collection's cardholder count)");

const QDRANT_URL = process.env.QDRANT_URL ?? "";
if (!QDRANT_URL) refuse("QDRANT_URL is not set");
const AUTH: Record<string, string> = process.env.QDRANT_API_KEY
  ? { "api-key": process.env.QDRANT_API_KEY }
  : {};
const RESULTS = "evals/results/cloud-latency.jsonl";

// --- Statistics. Same nearest-rank percentile bench-scale uses. --------------
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return Number(sorted[rank - 1].toFixed(2));
}
function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return {
    p50: pct(s, 0.5),
    p95: pct(s, 0.95),
    p99: pct(s, 0.99),
    min: s.length ? Number(s[0].toFixed(2)) : 0,
    n: s.length,
  };
}
// The two stages of the same sample, added per sample. Both series are in
// request order and one entry long per sample, so index i is one event.
function pairSum(a: number[], b: number[]): number[] {
  const n = Math.min(a.length, b.length);
  return Array.from({ length: n }, (_, i) => a[i] + b[i]);
}
function spread(total: number, k: number): number[] {
  const n = Math.min(k, total);
  return Array.from({ length: n }, (_, i) => Math.floor((i * total) / n));
}

// --- The measured event ------------------------------------------------------
// Same construction as bench-scale: clone the cardholder's newest baseline
// transaction and place it 1+n ms BEFORE it, so the scroll reads exactly the
// window that produced the source's own vector and the event scores as ordinary
// behaviour. Moving the timestamp any further (an hour forward, or after the
// source) manufactures alerts, which here means blocked upserts and dropped
// samples.
function sampleEvent(base: Transaction, n: number): Transaction {
  return { ...base, id: randomUUID(), ts: new Date(Date.parse(base.ts) - 1 - n).toISOString() };
}
function lastBaseline(idx: number): Transaction {
  const profile = makeProfile(idx, WORLD_SEED);
  const baseline = baselineTransactions(profile, WORLD_SEED, { days: DAYS, txScale: TX_SCALE });
  return baseline[baseline.length - 1];
}

// A request the cluster answers without touching a collection, over the same
// connection pool. The gap between this floor and a stage's wall time is what
// the stage spent on the cluster plus body transfer.
async function rttFloor(n: number) {
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    const res = await fetch(`${QDRANT_URL}/`, { headers: AUTH });
    await res.text();
    t.push(performance.now() - a);
  }
  return stats(t.slice(5)); // drop the pool warmup
}

async function main() {
  const { exists } = await qdrant.collectionExists(COLLECTION);
  if (!exists) refuse(`${COLLECTION} does not exist; this script never creates one`);

  const info = await qdrant.getCollection(COLLECTION);
  const points = info.points_count ?? 0;
  const indexed = info.indexed_vectors_count ?? 0;
  if (info.status !== "green") refuse(`${COLLECTION} status is ${info.status}, not green`);
  if (indexed < points * 0.99) {
    refuse(`indexed ${indexed} is under 99% of points ${points}; the graph is still building`);
  }

  const hnsw = info.config.hnsw_config?.m === 0 ? "m0_payload_m16" : "default";
  const shards = info.config.params.shard_number ?? 1;
  const version = await fetch(QDRANT_URL, { headers: AUTH })
    .then((r) => r.json())
    .then((j) => String(j.version ?? "unknown"))
    .catch(() => "unknown");

  console.log(
    `Cloud cell: ${COLLECTION} @ ${new URL(QDRANT_URL).host}\n` +
      `  ${points} points, ${indexed} indexed, ${hnsw}, ${shards} shard(s), Qdrant ${version}`,
  );

  const rttBefore = await rttFloor(25);
  console.log(`  round-trip floor before: p50 ${rttBefore.p50} ms (min ${rttBefore.min})`);

  const measuredTenants = spread(TENANTS, SAMPLES);
  const measuredSet = new Set(measuredTenants);
  const events = measuredTenants.map(lastBaseline);

  // Warm up on cardholders OUTSIDE the measured set, so "warm" means an open
  // connection pool and a resident index, not a cached segment for the
  // cardholders about to be measured.
  const spares: number[] = [];
  for (let i = 0; i < TENANTS && spares.length < WARMUP; i++) {
    if (!measuredSet.has(i)) spares.push(i);
  }
  const warmTenants = spares.length > 0 ? spares : measuredTenants.slice(0, WARMUP);
  console.log(`Warming up (${WARMUP} events, unmeasured cardholders)...`);
  let warmupBlocked = 0;
  for (let n = 0; n < WARMUP; n++) {
    try {
      await scoreEvent(sampleEvent(lastBaseline(warmTenants[n % warmTenants.length]), n), undefined, {
        persist: false,
      });
    } catch (err) {
      if (err instanceof WriteBlocked) warmupBlocked++;
      else throw err;
    }
  }

  console.log(`Measuring ${SAMPLES} events across ${measuredTenants.length} distinct cardholders...`);
  const wallScroll: number[] = [];
  const wallKnn: number[] = [];
  let alertedBlocked = 0;
  guard.tapping = true;
  for (let i = 0; i < SAMPLES; i++) {
    const t: Partial<StageTimings> = {};
    try {
      await scoreEvent(sampleEvent(events[i % events.length], WARMUP + i), t, { persist: false });
      wallScroll.push(t.scroll ?? 0);
      wallKnn.push(t.knn ?? 0);
    } catch (err) {
      // An alerted sample's upsert was refused. Both of its reads already
      // happened, so its srv times stay in the series; only the wall pair is
      // dropped, because score.ts fills the timings object after the upsert.
      if (err instanceof WriteBlocked) alertedBlocked++;
      else throw err;
    }
    if ((i + 1) % 250 === 0) console.log(`  ${i + 1}/${SAMPLES}`);
  }
  guard.tapping = false;

  const rttAfter = await rttFloor(25);
  console.log(`  round-trip floor after: p50 ${rttAfter.p50} ms (min ${rttAfter.min})`);

  const cpu = os.cpus();
  const row = {
    ts: new Date().toISOString(),
    ...(LABEL ? { label: LABEL } : {}),
    collection: COLLECTION,
    host: new URL(QDRANT_URL).host,
    // Where the measuring process ran. laptop_wan wall numbers carry this
    // machine's round trip to the cluster region and are not the demo's path.
    vantage: "laptop_wan",
    tenants: TENANTS,
    days: DAYS,
    tx_scale: TX_SCALE,
    hnsw,
    qdrant_version: version,
    points_count: points,
    indexed_vectors_count: indexed,
    shards,
    samples: SAMPLES,
    measured: wallScroll.length,
    distinct_tenants: measuredTenants.length,
    repeat_fraction: Number((1 - measuredTenants.length / SAMPLES).toFixed(3)),
    warmup: WARMUP,
    // Samples that alerted and therefore tried to upsert despite persist:false.
    // The guard threw, so nothing was written and the sample was dropped.
    alerted_blocked: alertedBlocked,
    warmup_blocked: warmupBlocked,
    blocked_total: guard.blocked,
    rtt_floor_ms: { before: rttBefore, after: rttAfter },
    srv_scroll_ms: stats(srvTime.scroll),
    srv_knn_ms: stats(srvTime.query),
    srv_decision_ms: stats(pairSum(srvTime.scroll, srvTime.query)),
    wall_scroll_ms: stats(wallScroll),
    wall_knn_ms: stats(wallKnn),
    wall_decision_ms: stats(pairSum(wallScroll, wallKnn)),
    env: {
      cpu: cpu[0]?.model ?? "unknown",
      cores: cpu.length,
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
      transport: "wan_rest",
    },
  };

  mkdirSync("evals/results", { recursive: true });
  appendFileSync(RESULTS, `${JSON.stringify(row)}\n`);

  const line = (name: string, s: ReturnType<typeof stats>) =>
    console.log(
      `  ${name.padEnd(9)} p50 ${String(s.p50).padStart(7)}  p95 ${String(s.p95).padStart(7)}  ` +
        `p99 ${String(s.p99).padStart(7)}  min ${String(s.min).padStart(7)}   (n=${s.n})`,
    );
  console.log(`\n=== ${COLLECTION}: ${points} points, ${hnsw}, ${shards} shard(s) ===`);
  console.log("engine-reported, no network:");
  line("scroll", row.srv_scroll_ms);
  line("knn", row.srv_knn_ms);
  line("decision", row.srv_decision_ms);
  console.log("observed from this machine, includes WAN round trips:");
  line("scroll", row.wall_scroll_ms);
  line("knn", row.wall_knn_ms);
  line("decision", row.wall_decision_ms);
  console.log(
    `  measured ${row.measured}/${SAMPLES}; ${alertedBlocked} dropped (alerted, upsert blocked); ` +
      `${guard.blocked} writes blocked in total`,
  );
  console.log(`Appended to ${RESULTS}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
