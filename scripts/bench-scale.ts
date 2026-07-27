// Scale benchmark: how does decision latency move as the collection grows?
//
// One invocation runs ONE cell — seed N tenants with a given per-tenant history,
// wait for the index to settle, then score events one at a time and record the
// per-stage timings. The cell appends a single JSON line to
// evals/results/scale.jsonl and deletes its own collection.
//
// DECISION LATENCY = scroll + knn. The upsert is excluded: a card authorization
// has a hard end-to-end budget and no issuer puts a synchronous write in front
// of an approve/decline. `knn` includes the local feature encoding between the
// two round trips, so it is not a pure network stage.
//
// Runs against a LOCAL Qdrant. Two guards below refuse anything else, because
// pointing this at the shared cloud cluster once already wiped the live
// collection. QDRANT_COLLECTION must be set in the environment BEFORE the
// process starts — src/lib/qdrant.ts captures it at import, so an assignment in
// here would be too late. Never pass --env-file=.env: that file points at the
// cloud cluster.
//
//   QDRANT_URL=http://localhost:6333 QDRANT_COLLECTION=bench_t200_d90 \
//     npx tsx scripts/bench-scale.ts --tenants 200 --days 90 --tx-scale 1
//
// Flags: --tenants N  --days D  --tx-scale S  [--samples 1000] [--warmup 100]
//        [--default-hnsw]   run the control cell with Qdrant's default global graph

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { seedTenants } from "../evals/harness";
import { FEATURE_DIM } from "../src/lib/features";
import { COLLECTION, ensureCollection, FEATURE_VECTOR, qdrant } from "../src/lib/qdrant";
import { scoreEvent, type StageTimings } from "../src/lib/score";
import {
  baselineTransactions,
  makeProfile,
  WORLD_SEED,
  type Transaction,
} from "../src/lib/world";

// --- Guards. Nothing destructive runs above this block. ----------------------
// Two of them, because either alone still permits a run that creates millions of
// points on the shared cloud cluster: a throwaway name pointed at the wrong host,
// or the live collection name pointed at the right one.
const QDRANT_URL = process.env.QDRANT_URL ?? "";
function refuse(why: string): never {
  console.error(`bench-scale refused to run: ${why}`);
  process.exit(1);
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(QDRANT_URL)) {
  refuse(`QDRANT_URL must be a local Qdrant, got ${QDRANT_URL || "(unset)"}`);
}
if (!/^bench_[a-z0-9_]+$/.test(COLLECTION)) {
  refuse(`QDRANT_COLLECTION must match /^bench_[a-z0-9_]+$/, got ${COLLECTION}`);
}

// --- Arguments ---------------------------------------------------------------
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
const DEFAULT_HNSW = argv.includes("--default-hnsw");
// Override the indexing_threshold restored after the bulk load, in KB. Qdrant
// only builds a vector graph for a segment once it passes this, and at 31-d
// float32 a small collection never gets there on the default 10000, so it runs
// an exact filtered scan instead. Comparing a small unindexed cell against a
// large indexed one compares two retrieval mechanisms, not two sizes. Pass a
// low value to force the graph and hold the mechanism constant across cells.
// 0 means "use whatever this Qdrant build defaults to".
const INDEXING_THRESHOLD = num("--indexing-threshold", 0);
// Leave the collection in place instead of tearing it down. Used to build the
// standing local collection the wall demos against, so the booth runs on
// millions of points rather than the 200-cardholder cloud collection. A kept
// collection has to be deleted by hand before the same name is loaded again.
const KEEP = argv.includes("--keep");
if (TENANTS < 1) refuse("--tenants is required");

const RESULTS = "evals/results/scale.jsonl";

// Nearest-rank percentile. With 1,000 samples p99 is the tenth-worst
// observation; the sample size is written into the row so a reader can see that.
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return Number(sorted[rank - 1].toFixed(2));
}

function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return { p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), n: s.length };
}

// k tenant indices spread evenly across [0, total).
function spread(total: number, k: number): number[] {
  const n = Math.min(k, total);
  return Array.from({ length: n }, (_, i) => Math.floor((i * total) / n));
}

// The measured event. Transaction CONTENT is irrelevant to a latency benchmark —
// only the query shape and the filter cardinality matter — so each sample clones
// the tenant's most recent baseline transaction with a fresh id, placed
// `1 + n` milliseconds BEFORE it.
//
// Placing it just before the source, rather than just after, is what keeps the
// sample a normal transaction. The scroll takes the 30 most recent points with
// `ts < event.ts`, so an event placed just before its source reads exactly the
// window that produced the source's own seeded vector, and scores like it.
// Placed just after, the source itself becomes the newest prior at a gap of
// ~0 minutes, which is the signature of a burst.
//
// Both wrong versions were measured. Walking the timestamp forward an hour per
// sample alerted 9.1% of them, because the encoder weights sin/cos hour-of-day
// at 1.0 and a tenant only transacts inside its own active window. Placing it
// 1 ms after alerted 11.2% on the 15-month cell: the same zero-gap perturbation
// costs more there, because 5,470 points of history put the 10 nearest
// neighbours closer together, so a smaller d_local turns the same d_event into
// a larger ratio. An alerted event upserts even under `persist: false`
// (score.ts:311), so either version writes to the collection mid-measurement.
function sampleEvent(base: Transaction, n: number): Transaction {
  return { ...base, id: randomUUID(), ts: new Date(Date.parse(base.ts) - 1 - n).toISOString() };
}

function lastBaseline(idx: number): Transaction {
  const profile = makeProfile(idx, WORLD_SEED);
  const baseline = baselineTransactions(profile, WORLD_SEED, { days: DAYS, txScale: TX_SCALE });
  return baseline[baseline.length - 1];
}

// Wait until the collection is done optimizing, so the cell measures a settled
// index rather than a background build.
//
// `indexed_vectors_count: 0` is a legitimate settled state, not a stall: Qdrant
// only builds a vector graph for a segment once the segment passes
// `indexing_threshold` (20 MB by default), and at 31-d float32 a small cell's
// segments never get there. Those cells run an exact scan over the tenant's
// filtered points, which IS what the shipped config does at that size. The row
// records indexed_vectors_count so a reader can tell which mechanism a cell
// measured. Settled is required twice in a row because restoring the threshold
// takes a moment to reach the optimizer, and it would otherwise read green
// before any work started.
async function waitForIndex(expected: number): Promise<number> {
  const started = Date.now();
  let stable = 0;
  for (;;) {
    const info = await qdrant.getCollection(COLLECTION);
    const points = info.points_count ?? 0;
    const indexed = info.indexed_vectors_count ?? 0;
    const settled =
      info.status === "green" &&
      info.optimizer_status === "ok" &&
      points >= expected * 0.98 &&
      (indexed === 0 || indexed >= points * 0.99);
    stable = settled ? stable + 1 : 0;
    const mins = ((Date.now() - started) / 60_000).toFixed(1);
    console.log(
      `  [${mins}m] status=${info.status} optimizer=${JSON.stringify(info.optimizer_status)} ` +
        `points=${points}/${expected} indexed=${indexed}`,
    );
    if (stable >= 2) return indexed;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function main() {
  const version = await fetch(QDRANT_URL)
    .then((r) => r.json())
    .then((j) => String(j.version ?? "unknown"))
    .catch(() => "unknown");

  const { exists } = await qdrant.collectionExists(COLLECTION);
  if (exists) refuse(`${COLLECTION} already exists; delete it or use a fresh name`);

  const tenantIdx = Array.from({ length: TENANTS }, (_, i) => i);
  let expected = 0;
  for (const i of tenantIdx) {
    expected += Math.round(makeProfile(i, WORLD_SEED).txCount * TX_SCALE);
  }

  console.log(
    `Cell: ${TENANTS} tenants x ${DAYS}d x${TX_SCALE} = ~${expected} points, ` +
      `${DEFAULT_HNSW ? "default HNSW" : "multitenant HNSW (m:0, payload_m:16)"}, ` +
      `collection ${COLLECTION}, Qdrant ${version}`,
  );

  let wroteRow = false;
  try {
    // (1) Create with the config under test. Not via ensureCollection() — that
    // one always applies the multitenant config, and this script also has to be
    // able to create the default-HNSW control. ensureCollection() runs right
    // after purely to add the five payload indexes; its create is skipped
    // because the collection now exists.
    await qdrant.createCollection(COLLECTION, {
      vectors: { [FEATURE_VECTOR]: { size: FEATURE_DIM, distance: "Euclid" } },
      ...(DEFAULT_HNSW ? {} : { hnsw_config: { m: 0, payload_m: 16 } }),
    });
    await ensureCollection();

    // The measured cell must run on the shipped default indexing_threshold, so
    // read what this Qdrant build actually defaults to rather than hardcoding a
    // number: it is 10000 (KB) on 1.18 and a hardcoded 20000 would have
    // measured every cell at twice the real threshold. Indexing is switched off
    // for the bulk load and this exact value is put back before measuring.
    const created = await qdrant.getCollection(COLLECTION);
    const defaultThreshold =
      INDEXING_THRESHOLD > 0
        ? INDEXING_THRESHOLD
        : created.config.optimizer_config.indexing_threshold ?? 10_000;

    // (2) Bulk load.
    const loadStart = Date.now();
    await qdrant.updateCollection(COLLECTION, {
      optimizers_config: { indexing_threshold: 0 },
    });
    await seedTenants(tenantIdx, WORLD_SEED, { days: DAYS, txScale: TX_SCALE, wait: false });
    await qdrant.updateCollection(COLLECTION, {
      optimizers_config: { indexing_threshold: defaultThreshold },
    });
    console.log("Loaded; waiting for the index to settle...");
    const indexedVectors = await waitForIndex(expected);
    const loadSecs = (Date.now() - loadStart) / 1000;
    console.log(`  load + index: ${(loadSecs / 60).toFixed(1)}m`);

    // (3) A mis-threaded txScale would silently benchmark the wrong axis.
    const info = await qdrant.getCollection(COLLECTION);
    const points = info.points_count ?? 0;
    const drift = Math.abs(points - expected) / expected;
    if (drift > 0.02) {
      throw new Error(`points_count ${points} is ${(drift * 100).toFixed(1)}% off expected ${expected}`);
    }

    // Measured tenants, spread across the cell. Where the cell has fewer than
    // SAMPLES tenants the run repeats them; the repeat fraction goes in the row.
    // A real issuer's next authorization comes from a random cardholder, so a
    // cold first touch of a tenant's segment is the production case.
    const measuredTenants = spread(TENANTS, SAMPLES);
    const measuredSet = new Set(measuredTenants);
    const events = measuredTenants.map(lastBaseline);

    // (4) Warm up on tenants OUTSIDE the measured set where the cell has spares,
    // so "warm" means an open connection and a resident index, not a cached
    // segment for the tenants about to be measured.
    const spares: number[] = [];
    for (let i = 0; i < TENANTS && spares.length < WARMUP; i++) {
      if (!measuredSet.has(i)) spares.push(i);
    }
    const warmTenants = spares.length > 0 ? spares : measuredTenants.slice(0, WARMUP);
    console.log(`Warming up (${WARMUP} events, ${spares.length > 0 ? "unmeasured" : "measured"} tenants)...`);
    for (let n = 0; n < WARMUP; n++) {
      const base = lastBaseline(warmTenants[n % warmTenants.length]);
      await scoreEvent(sampleEvent(base, n), undefined, { persist: false });
    }

    // (5-7) Measure. Sequential, one event at a time.
    console.log(`Measuring ${SAMPLES} events across ${measuredTenants.length} distinct tenants...`);
    const scroll: number[] = [];
    const knn: number[] = [];
    const decision: number[] = [];
    let alerted = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const t: Partial<StageTimings> = {};
      const ev = sampleEvent(events[i % events.length], WARMUP + i);
      const r = await scoreEvent(ev, t, { persist: false });
      if (r.alerted) alerted++;
      scroll.push(t.scroll ?? 0);
      knn.push(t.knn ?? 0);
      decision.push((t.scroll ?? 0) + (t.knn ?? 0));
      if ((i + 1) % 250 === 0) console.log(`  ${i + 1}/${SAMPLES}`);
    }

    // `persist: false` still upserts an ALERTED event (score.ts), so a cell that
    // alerts a lot has written points that later samples can read back as
    // context. Cloned baseline transactions are normal behaviour, so this should
    // be rare. Above 2% the cell is contaminated and should not be published.
    const alertRate = alerted / SAMPLES;
    const contaminated = alertRate > 0.02;

    const cpu = os.cpus();
    const row = {
      ts: new Date().toISOString(),
      collection: COLLECTION,
      tenants: TENANTS,
      days: DAYS,
      tx_scale: TX_SCALE,
      hnsw: DEFAULT_HNSW ? "default" : "m0_payload_m16",
      qdrant_version: version,
      points_count: points,
      expected_points: expected,
      // 0 means every segment stayed under indexing_threshold, so this cell
      // measured an exact scan of the filtered points, not a graph traversal.
      indexed_vectors_count: indexedVectors,
      indexing_threshold_kb: defaultThreshold,
      load_seconds: Number(loadSecs.toFixed(1)),
      samples: SAMPLES,
      distinct_tenants: measuredTenants.length,
      repeat_fraction: Number((1 - measuredTenants.length / SAMPLES).toFixed(3)),
      warmup: WARMUP,
      alerted,
      alert_rate: Number(alertRate.toFixed(4)),
      contaminated,
      scroll_ms: stats(scroll),
      knn_ms: stats(knn),
      decision_ms: stats(decision),
      env: {
        cpu: cpu[0]?.model ?? "unknown",
        cores: cpu.length,
        total_mem_gb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        platform: `${os.platform()} ${os.release()}`,
        node: process.version,
        transport: "loopback",
      },
    };

    mkdirSync("evals/results", { recursive: true });
    appendFileSync(RESULTS, `${JSON.stringify(row)}\n`);
    wroteRow = true;

    const line = (name: string, s: ReturnType<typeof stats>) =>
      console.log(`  ${name.padEnd(9)} p50 ${String(s.p50).padStart(7)}  p95 ${String(s.p95).padStart(7)}  p99 ${String(s.p99).padStart(7)}   (n=${s.n})`);
    console.log(`\n=== ${COLLECTION}: ${points} points, ${row.hnsw} ===`);
    line("scroll", row.scroll_ms);
    line("knn", row.knn_ms);
    line("decision", row.decision_ms);
    console.log(`  alerted ${alerted}/${SAMPLES} (${(alertRate * 100).toFixed(1)}%)`);
    console.log(`Appended to ${RESULTS}`);

    if (contaminated) {
      console.error(
        `\nCONTAMINATED: ${(alertRate * 100).toFixed(1)}% of samples alerted and therefore ` +
          `upserted despite persist:false. Find out why before publishing this cell.`,
      );
      process.exitCode = 2;
    }
  } finally {
    if (KEEP) {
      console.log(`Keeping ${COLLECTION} (--keep). Delete it by hand to reload this name.`);
    } else {
      // Only ever the exact generated name, and only after the row is safe.
      console.log(`Deleting ${COLLECTION}${wroteRow ? "" : " (no row written)"}...`);
      await qdrant.deleteCollection(COLLECTION).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
