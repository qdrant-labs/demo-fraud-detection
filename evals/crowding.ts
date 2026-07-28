// Baseline crowding (the 2026-07-28 booth incident, as a regression gate).
//
// processBucket persists every injected motif, so a long booth session piles
// scored fraud events onto a persona. Once the newest 30 points by ts are all
// prior fraud, a fresh attack looks ordinary next to them (d_local inflates,
// the ratio falls under 2.0) and the wall shows nothing. Measured live: attacks
// on t0011 scored 1.18-1.27 crowded, 5.49 (geo_hop) and 3.09-3.23 (card_testing)
// after clearing.
//
// This eval replays that day against a throwaway collection: seed t0011's
// baseline, prove fresh attacks alert (control), persist a booth-day of
// injected bursts, then attack again. The gate is that the post-crowd attacks
// still alert.
//
// qdrant.ts captures COLLECTION at import, so harness/score are imported
// DYNAMICALLY below, after QDRANT_COLLECTION is set.
//
// Run: npx tsx --env-file=.env evals/crowding.ts   (or QDRANT_URL=http://localhost:6333)

process.env.QDRANT_COLLECTION = "fraud_demo_eval_crowding";

import { EPOCH, makeProfile, motifSequence, type Transaction } from "../src/lib/world";

const TENANT_INDEX = 11; // t0011, the incident's persona
const HOUR_MS = 3_600_000;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const { COLLECTION } = await import("../src/lib/qdrant");
  if (COLLECTION !== "fraud_demo_eval_crowding") {
    throw new Error(`refusing to run against "${COLLECTION}"; expected the throwaway collection`);
  }
  const { seedTenants, scoreStream, dropCollection } = await import("./harness");

  await dropCollection();
  let exitCode = 1;
  try {
    const profile = makeProfile(TENANT_INDEX);
    console.log(`Seeding ${profile.id}'s baseline (${profile.txCount} points)...`);
    await seedTenants([TENANT_INDEX]);

    // Reports the highest score in a sequence, whether any event alerted, and
    // every neighbor id the kNN returned across the sequence.
    const attack = async (motif: "geo_hop" | "card_testing", atMs: number, tag: string) => {
      const seq = motifSequence(motif, profile, atMs, `crowding:${tag}`);
      const results = await scoreStream(seq);
      const scored = seq.map((ev) => results.get(ev.id)!);
      const top = Math.max(...scored.map((s) => s.score));
      const neighborIds = new Set(scored.flatMap((s) => s.neighbors.map((n) => String(n.id))));
      return { alerted: scored.some((s) => s.alerted), top, neighborIds };
    };

    // Control: on a clean baseline, both attack motifs must alert.
    const c1 = await attack("geo_hop", EPOCH + 1 * HOUR_MS, "control-geo");
    const c2 = await attack("card_testing", EPOCH + 1.5 * HOUR_MS, "control-card");
    check("control geo_hop alerts on clean baseline", c1.alerted, `top score ${c1.top.toFixed(2)}`);
    check("control card_testing alerts on clean baseline", c2.alerted, `top score ${c2.top.toFixed(2)}`);

    // A booth day: 9 injected bursts persisted across hours 2-23, exactly what
    // processBucket does with `persist: tx.motif !== "none"`. 39 scored points,
    // enough to fill the 30-slot context window with prior fraud.
    const motifs = ["card_testing", "geo_hop", "ladder"] as const;
    const crowd: Transaction[] = [];
    for (let b = 0; b < 9; b++) {
      const at = EPOCH + (2 + b * 2.5) * HOUR_MS;
      crowd.push(...motifSequence(motifs[b % 3], profile, at, `crowding:crowd:${b}`, "generator"));
    }
    console.log(`Persisting ${crowd.length} injected fraud events across the day...`);
    await scoreStream(crowd);

    // The incident: a fresh attack 1h+ after the last burst (old enough that the
    // crowd is kNN-eligible) must still alert.
    const a1 = await attack("geo_hop", EPOCH + 25 * HOUR_MS, "probe-geo");
    const a2 = await attack("card_testing", EPOCH + 25.5 * HOUR_MS, "probe-card");
    check("geo_hop still alerts after a day of persisted bursts", a1.alerted, `top score ${a1.top.toFixed(2)}`);
    check("card_testing still alerts after a day of persisted bursts", a2.alerted, `top score ${a2.top.toFixed(2)}`);

    // The kNN-channel invariant, checked directly: no persisted fraud event
    // (crowd or control attack) may come back as a probe's neighbor. Neighbors
    // must be baseline points.
    const scoredIds = new Set([
      ...crowd.map((e) => String(e.id)),
      ...motifSequence("geo_hop", profile, EPOCH + 1 * HOUR_MS, "crowding:control-geo").map((e) => String(e.id)),
      ...motifSequence("card_testing", profile, EPOCH + 1.5 * HOUR_MS, "crowding:control-card").map((e) => String(e.id)),
    ]);
    const contaminated = [...a1.neighborIds, ...a2.neighborIds].filter((id) => scoredIds.has(id));
    check(
      "probe neighbors are baseline points only (no scored event re-enters the kNN)",
      contaminated.length === 0,
      contaminated.length ? `${contaminated.length} scored points among neighbors` : "",
    );

    console.log(failures === 0 ? "\nCrowding PASS." : `\nCrowding FAIL (${failures}).`);
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
