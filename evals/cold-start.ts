// Cold start (PLAN eval 3). A fresh, unseeded tenant streams 50
// profile-conforming events at an empty throwaway collection. A tenant with no
// seeded baseline must never alert: scored events are alert evidence, not
// established history (the crowding fix, see CONTEXT_SCORED_WINDOW_MS in
// score.ts), so history enters the baseline through the profile pipeline
// (scripts/seed.ts), never through the scoring path. Until that happens the
// tenant stays in the learning state.
//
// The 200 seeded tenants never exercise this rule (they start with 300+ points),
// so this is the only eval that proves the cold-start guard.
//
// Scenario 1 asserts: zero alerts across all 50 events; the `learning` flag
// stays true for all 50 (scored-only history never graduates a tenant); all 50
// scores are finite.
//
// Scenario 2 streams 35 events one minute apart, all inside one hour, at a second
// fresh tenant. It asserts no crash, zero alerts, and that every event past the
// 30-context threshold still reports learning:true, because the 1-hour neighbor
// exclusion leaves no eligible neighbors (the zero-eligible-neighbor guard).
//
// Run: npx tsx --env-file=.env evals/cold-start.ts

process.env.QDRANT_COLLECTION = "fraud_demo_eval_coldstart";

import { baselineTransactions, EPOCH, makeProfile } from "../src/lib/world";

const FRESH_TENANT_INDEX = 4711; // beyond the seeded 200; still deterministic
const N = 50;
const WINDOW = 30; // CONTEXT_LIMIT / learning-window size

async function main() {
  const { seedTenants, scoreStream, dropCollection } = await import("./harness");

  await dropCollection();
  let exitCode = 1;
  try {
    await seedTenants([]); // create the empty collection + indexes, seed nothing

    // 50 profile-conforming events for the fresh tenant, oldest-first. These are
    // the world's own baseline transactions (motif "none"), the same generator
    // path the seeded tenants use.
    const profile = makeProfile(FRESH_TENANT_INDEX);
    const events = baselineTransactions(profile).slice(0, N);
    if (events.length < N) throw new Error(`only generated ${events.length} events`);

    const results = await scoreStream(events); // single tenant -> strictly sequential
    const ordered = events.map((ev) => results.get(ev.id)!);

    let failures = 0;
    const check = (name: string, ok: boolean, detail = "") => {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
      if (!ok) failures++;
    };

    const alerts = ordered.filter((s) => s.alerted).length;
    check("zero alerts across all 50 events", alerts === 0, `${alerts} alerts`);

    const stillLearning = ordered.every((s) => s.learning === true);
    check(
      "learning stays true for all 50 (scored-only history never graduates)",
      stillLearning,
    );

    const allFinite = ordered.every((s) => Number.isFinite(s.score));
    check("all 50 scores are finite", allFinite);

    console.log(
      `\nScores range [${Math.min(...ordered.map((s) => s.score)).toFixed(2)}, ` +
        `${Math.max(...ordered.map((s) => s.score)).toFixed(2)}] (all learning, none alerted).`,
    );

    // Scenario 2: a fresh tenant receiving 35 events 1 minute apart, all inside
    // one hour. Every event past the 30-context threshold still reports
    // learning:true, because the 1-hour neighbor exclusion leaves no eligible
    // neighbors to score against (exercises the zero-eligible-neighbor guard).
    console.log("\n--- Scenario 2: 35 events one minute apart, all within one hour ---");
    const FRESH_TENANT_2 = 4712; // a different fresh tenant, still deterministic
    const M = 35;
    const profile2 = makeProfile(FRESH_TENANT_2);
    // Profile-conforming transactions, but with timestamps forced to one minute
    // apart from EPOCH so the whole run fits inside a single hour.
    const events2 = baselineTransactions(profile2)
      .slice(0, M)
      .map((tx, i) => ({ ...tx, ts: new Date(EPOCH + i * 60_000).toISOString() }));
    if (events2.length < M) throw new Error(`only generated ${events2.length} events`);

    const results2 = await scoreStream(events2);
    const ordered2 = events2.map((ev) => results2.get(ev.id)!);

    const alerts2 = ordered2.filter((s) => s.alerted).length;
    check("scenario 2: zero alerts across the 35 in-hour events", alerts2 === 0, `${alerts2} alerts`);

    const finite2 = ordered2.every((s) => Number.isFinite(s.score));
    check("scenario 2: all 35 scores are finite (no crash, no NaN)", finite2);

    const pastThreshold = ordered2.slice(WINDOW); // events 31-35
    const allLearning = pastThreshold.every((s) => s.learning === true);
    check(
      "scenario 2: events past the 30-context threshold still report learning:true",
      allLearning,
      `events 31-35 learning=${pastThreshold.map((s) => s.learning).join(",")}`,
    );

    console.log(
      `Scenario 2 scores range [${Math.min(...ordered2.map((s) => s.score)).toFixed(2)}, ` +
        `${Math.max(...ordered2.map((s) => s.score)).toFixed(2)}] (all learning, none alerted).`,
    );

    console.log(failures === 0 ? "\nCold-start PASS." : `\nCold-start FAIL (${failures}).`);
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
