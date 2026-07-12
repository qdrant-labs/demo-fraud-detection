// Seed the fraud_demo collection with 200 tenants' baselines (~100k points).
// Run: npx tsx --env-file=.env scripts/seed.ts
//
// Everything is a pure function of the world seed, and point IDs are
// deterministic, so re-running overwrites the same points instead of
// duplicating them. No Qdrant reads during seeding: each transaction's
// recent-history features are computed in memory from the tenant's prior
// baseline transactions.

import { encode, recentHistory } from "../src/lib/features";
import {
  COLLECTION,
  CONTEXT_LIMIT,
  ensureCollection,
  pointFor,
  qdrant,
} from "../src/lib/qdrant";
import { baselineTransactions, profiles } from "../src/lib/world";

const BATCH_SIZE = 2000;
const LOG_EVERY = 10_000;

async function main() {
  await ensureCollection();

  const all = profiles();
  let batch: ReturnType<typeof pointFor>[] = [];
  let total = 0;
  const started = Date.now();

  async function flush() {
    if (batch.length === 0) return;
    await qdrant.upsert(COLLECTION, { wait: true, points: batch });
    batch = [];
  }

  for (const profile of all) {
    const baseline = baselineTransactions(profile); // oldest-first

    for (let i = 0; i < baseline.length; i++) {
      const tx = baseline[i];

      // Same trailing window the scorer reads at runtime (CONTEXT_LIMIT), so
      // baseline vectors and live-event vectors share one feature space.
      const window = baseline.slice(Math.max(0, i - CONTEXT_LIMIT), i);
      const recent = recentHistory(tx, window);

      // Baseline merchants come from the tenant's own list, so this is always
      // false here; computed properly to match the scorer's rule.
      const isNewMerchant = !profile.merchants.some((m) => m.name === tx.merchant);

      const vector = encode(tx, recent, {
        homeCurrency: profile.homeCity.currency,
        isNewMerchant,
      });

      // Baseline points carry no score (they were never scored).
      batch.push(pointFor(tx, vector, recent));
      total++;

      if (batch.length >= BATCH_SIZE) await flush();
      if (total % LOG_EVERY === 0) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  ${total} points upserted (${secs}s)`);
      }
    }
  }

  await flush();

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const count = await qdrant.count(COLLECTION, { exact: true });
  console.log(`Done: ${total} points seeded in ${secs}s. Collection count: ${count.count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
