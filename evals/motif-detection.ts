// Motif detection (PLAN eval 2). A seeded run of ~5k events against a throwaway
// collection, containing exactly 60 labeled fraud sequences (20 per motif). We
// score everything through the real scoring path, then compute the confusion
// table at the shipped ALERT_THRESHOLD.
//
// A fraud sequence is DETECTED when at least one of its events alerts. A false
// positive is an alerted event whose ground-truth motif is "none". The scorer
// never reads `motif`; this eval reads it as ground truth.
//
// Gate: recall >= 0.8 (of 60 sequences), precision >= 0.6 (alerted events that
// are fraud-labeled). If the gate fails we still print the full table and the
// per-motif breakdown, then exit non-zero. Weights/threshold are NOT tuned here.
//
// Each motif's start time is placed uniformly inside the background span so
// fraud interleaves with the tenant's own background traffic. A world-seed
// override (argv[2] or MOTIF_WORLD_SEED) runs the same eval on a held-out world.
//
// Run: npx tsx --env-file=.env evals/motif-detection.ts [world_seed]

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

// Held-out seed override (fix 6b): argv[2] or MOTIF_WORLD_SEED, else the shipped
// world seed. Everything below derives from SEED: tenants, background, and motif
// placements. score.ts reads FRAUD_WORLD_SEED so its per-event profile lookup
// uses the same world, and the collection name is namespaced so a held-out run
// never collides with the default-seed run's throwaway collection.
const SEED = process.argv[2] || process.env.MOTIF_WORLD_SEED || WORLD_SEED;
process.env.FRAUD_WORLD_SEED = SEED;
process.env.QDRANT_COLLECTION =
  SEED === WORLD_SEED ? "fraud_demo_eval_motif" : "fraud_demo_eval_motif_holdout";

// Small seeded PRNG (FNV-1a + mulberry32, the recipe world.ts uses) kept local so
// motif placement is a pure function of the world seed without exporting world's
// internals.
function placementRng(key: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Event-level fraud prevalence to project the measured rates onto. This eval's
// own stream runs near 5%, which is two orders of magnitude above real card
// fraud, so the precision it measures does not survive the move to production
// traffic. 0.1% is the rate the projection below assumes; override to run a
// sensitivity.
const PREVALENCE = Number(process.env.FRAUD_PREVALENCE ?? 0.001);

const TENANT_COUNT = 60; // one distinct tenant per fraud sequence
const PER_MOTIF = 20;
const MOTIFS: Exclude<Motif, "none">[] = ["card_testing", "geo_hop", "ladder"];
const TOTAL_EVENTS = 5000;

// Build the deterministic event stream: profile-conforming background for the
// seeded tenants, plus one fraud sequence per tenant (20 per motif). Background
// comes from liveEvents (filtered to seeded tenants, motif "none" only); each
// fraud sequence's start time is placed uniformly inside the background span so
// the burst interleaves with the tenant's own background traffic.
function buildStream(seed: string): { background: Transaction[]; sequences: Transaction[][]; maxBucket: number } {
  const background: Transaction[] = [];
  let bucket = 0;
  while (background.length < TOTAL_EVENTS - PER_MOTIF * MOTIFS.length * 5) {
    for (const ev of liveEvents(bucket, seed)) {
      const idx = Number(ev.tenant_id.slice(1));
      if (idx < TENANT_COUNT && ev.motif === "none") background.push(ev);
    }
    bucket++;
    if (bucket > 500_000) break; // safety
  }
  const maxBucket = bucket;

  // INTERLEAVING (fix 6a): place each motif's start time uniformly inside the
  // background stream's time span, so a tenant's fraud burst interleaves with its
  // own background rather than trailing all of it. Seeded PRNG -> deterministic
  // per world seed. The upper bound leaves room for the longest motif (the
  // ladder: 5 events 3 min apart) to finish inside the span. The harness still
  // scores each tenant's events in ts order.
  const MAX_MOTIF_MS = 12 * 60_000;
  const spanMs = Math.max(maxBucket * BUCKET_MS - MAX_MOTIF_MS, 0);
  const place = placementRng(`${seed}:motif-placement`);
  const sequences: Transaction[][] = [];
  for (let m = 0; m < MOTIFS.length; m++) {
    for (let j = 0; j < PER_MOTIF; j++) {
      const seqIndex = m * PER_MOTIF + j;
      const tenantIdx = seqIndex; // 0..59, all seeded, one sequence each
      const startTs = EPOCH + Math.floor(place() * spanMs);
      sequences.push(
        motifSequence(
          MOTIFS[m],
          makeProfile(tenantIdx, seed),
          startTs,
          `${seed}:evalseq:${seqIndex}`,
          "generator",
        ),
      );
    }
  }
  return { background, sequences, maxBucket };
}

async function main() {
  const { seedTenants, scoreStream, dropCollection } = await import("./harness");

  await dropCollection(); // clean slate if a prior run left the collection
  let exitCode = 1;
  try {
    const tenants = Array.from({ length: TENANT_COUNT }, (_, i) => i);
    console.log(`World seed: ${SEED}  (collection ${process.env.QDRANT_COLLECTION})`);
    console.log(`Seeding ${TENANT_COUNT} tenants' baselines...`);
    const seedStart = Date.now();
    await seedTenants(tenants, SEED);
    console.log(`  seeded in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`);

    const { background, sequences } = buildStream(SEED);
    const fraudEvents = sequences.flat();
    const all = [...background, ...fraudEvents];
    console.log(
      `Scoring ${all.length} events (${background.length} background, ${fraudEvents.length} fraud across ${sequences.length} sequences)...`,
    );

    const scoreStart = Date.now();
    const results = await scoreStream(all);
    const scoreSecs = (Date.now() - scoreStart) / 1000;
    console.log(`  scored in ${scoreSecs.toFixed(1)}s`);

    // Ground-truth motif per event id, for the event-level confusion table.
    const motifOf = new Map<string | number, Motif>();
    for (const ev of all) motifOf.set(ev.id, ev.motif);

    // Event-level confusion at ALERT_THRESHOLD (encoded in scored.alerted).
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const ev of all) {
      const scored = results.get(ev.id);
      const alerted = scored?.alerted ?? false;
      const isFraud = ev.motif !== "none";
      if (alerted && isFraud) tp++;
      else if (alerted && !isFraud) fp++;
      else if (!alerted && isFraud) fn++;
      else tn++;
    }

    // Sequence-level detection + per-motif recall.
    const perMotif: Record<string, { detected: number; total: number }> = {};
    for (const mo of MOTIFS) perMotif[mo] = { detected: 0, total: 0 };
    let detected = 0;
    for (const seq of sequences) {
      const mo = seq[0].motif;
      perMotif[mo].total++;
      const seqDetected = seq.some((ev) => results.get(ev.id)?.alerted ?? false);
      if (seqDetected) {
        detected++;
        perMotif[mo].detected++;
      }
    }

    const recall = detected / sequences.length;
    const totalAlerted = tp + fp;
    const precision = totalAlerted > 0 ? tp / totalAlerted : 0;

    // --- Report -------------------------------------------------------------
    console.log("\n=== Motif detection ===");
    console.log(`Runtime (scoring): ${scoreSecs.toFixed(1)}s`);
    console.log("\nEvent-level confusion (alert = score > threshold, cold start excluded):");
    console.log("                 alerted   not alerted");
    console.log(`  fraud-labeled  ${String(tp).padStart(7)}   ${String(fn).padStart(11)}`);
    console.log(`  motif=none     ${String(fp).padStart(7)}   ${String(tn).padStart(11)}`);
    console.log(`\n  TP=${tp}  FP=${fp}  FN=${fn}  TN=${tn}`);

    console.log("\nPer-motif sequence recall:");
    for (const mo of MOTIFS) {
      const { detected: d, total } = perMotif[mo];
      console.log(`  ${mo.padEnd(13)} ${d}/${total} = ${(d / total).toFixed(2)}`);
    }

    console.log(
      `\nRecall (sequences detected): ${detected}/${sequences.length} = ${recall.toFixed(3)}  (gate >= 0.80)`,
    );
    console.log(
      `Precision (alerted events fraud-labeled): ${tp}/${totalAlerted} = ${precision.toFixed(3)}  (gate >= 0.60)`,
    );

    // --- Rates and projection to production prevalence ----------------------
    // The precision above is measured on a stream where ~5% of events are fraud.
    // Real card fraud runs near 0.1% of authorizations, and precision moves with
    // prevalence while the two rates below do not. So report the rates, then
    // project them onto a million authorizations at PREVALENCE.
    //
    // Two precision views come out of the same data, and they differ because
    // their denominators differ: one alert per fraud EVENT, versus one case per
    // fraud SEQUENCE. Both are printed, each next to its denominator. The
    // sequence view needs sequence prevalence, which is event prevalence divided
    // by the mean sequence length.
    const bgFpRate = fp + tn > 0 ? fp / (fp + tn) : 0;
    const eventRecall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const meanSeqLen = fraudEvents.length / sequences.length;

    const N = 1_000_000;
    const fraudPerM = N * PREVALENCE;
    const falseAlertsPerM = N * (1 - PREVALENCE) * bgFpRate;
    const trueAlertsPerM = fraudPerM * eventRecall;
    const projectedPrecision =
      trueAlertsPerM + falseAlertsPerM > 0
        ? trueAlertsPerM / (trueAlertsPerM + falseAlertsPerM)
        : 0;
    const casesPerM = fraudPerM / meanSeqLen;
    const casesDetectedPerM = casesPerM * recall;

    console.log("\nMeasured rates (this run):");
    console.log(`  synthetic-background false-positive rate  ${fp}/${fp + tn} = ${(bgFpRate * 100).toFixed(3)}% per normal event`);
    console.log(`  per-event recall                          ${tp}/${tp + fn} = ${eventRecall.toFixed(3)}`);
    console.log(`  per-sequence recall                       ${detected}/${sequences.length} = ${recall.toFixed(3)}`);
    console.log(`  mean sequence length                      ${fraudEvents.length}/${sequences.length} = ${meanSeqLen.toFixed(2)} events`);
    console.log(`  this run's event prevalence               ${tp + fn}/${all.length} = ${((tp + fn) / all.length * 100).toFixed(1)}%`);

    console.log(`\nProjected to 1M authorizations at ${(PREVALENCE * 100).toFixed(2)}% event prevalence:`);
    console.log(`  false alerts        ${Math.round(falseAlertsPerM).toLocaleString("en-US")}  (${N - fraudPerM} normal events at the rate above)`);
    console.log(`  true alerts         ${Math.round(trueAlertsPerM).toLocaleString("en-US")}  (${fraudPerM} fraud events at per-event recall)`);
    console.log(`  per-event precision ${projectedPrecision.toFixed(3)}`);
    console.log(`  case view           ${Math.round(casesDetectedPerM)} of ${Math.round(casesPerM)} fraud cases detected, against those false alerts`);
    console.log("  The false-positive rate is measured on synthetic background traffic, not");
    console.log("  bank authorizations, so this projection is an estimate conditional on that rate.");

    // --- Threshold sweep ----------------------------------------------------
    // Recompute the metrics at a range of thresholds from the already-scored
    // data (each event's raw score + learning flag), so the shipped constant can
    // be chosen with the full recall/precision curve in view. `alerted` on the
    // stored results is fixed at the shipped ALERT_THRESHOLD; the sweep ignores
    // it and re-derives the alert decision at each candidate threshold.
    function metricsAt(threshold: number) {
      const alertAt = (id: string | number): boolean => {
        const s = results.get(id);
        return s ? s.score > threshold && !s.learning : false;
      };
      let stp = 0, sfp = 0;
      for (const ev of all) {
        if (!alertAt(ev.id)) continue;
        if (ev.motif !== "none") stp++;
        else sfp++;
      }
      const prec = stp + sfp > 0 ? stp / (stp + sfp) : 0;
      const per: Record<string, { d: number; t: number }> = {};
      for (const mo of MOTIFS) per[mo] = { d: 0, t: 0 };
      let det = 0;
      for (const seq of sequences) {
        const mo = seq[0].motif;
        per[mo].t++;
        if (seq.some((ev) => alertAt(ev.id))) {
          det++;
          per[mo].d++;
        }
      }
      return { recall: det / sequences.length, precision: prec, per };
    }

    console.log("\nThreshold sweep (from scored data; per-motif recall + precision):");
    console.log("  thr    seqRecall  card_testing  geo_hop  ladder   precision");
    for (let thr = 1.5; thr <= 4.0 + 1e-9; thr += 0.25) {
      const m = metricsAt(thr);
      const pm = (mo: string) => (m.per[mo].d / m.per[mo].t).toFixed(2);
      console.log(
        `  ${thr.toFixed(2)}   ${m.recall.toFixed(3).padStart(8)}   ` +
          `${pm("card_testing").padStart(10)}  ${pm("geo_hop").padStart(6)}  ` +
          `${pm("ladder").padStart(6)}   ${m.precision.toFixed(3).padStart(8)}`,
      );
    }

    const pass = recall >= 0.8 && precision >= 0.6;
    console.log(`\n${pass ? "PASS" : "FAIL"}: recall=${recall.toFixed(3)}, precision=${precision.toFixed(3)}`);
    if (!pass) {
      console.log(
        "Gate not met. Numbers reported as measured; threshold/weights are tuned by the orchestrator via this eval, not here.",
      );
    }
    exitCode = pass ? 0 : 1;
  } finally {
    await dropCollection();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
