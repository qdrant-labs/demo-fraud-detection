// Runnable self-check for the synthetic world and feature encoder.
// Run: npx tsx scripts/check-world.ts
// Plain asserts, no test framework. Exits non-zero on the first failure.

import assert from "node:assert/strict";
import {
  WORLD_SEED,
  TENANT_COUNT,
  EPOCH,
  liveEvents,
  profiles,
  makeProfile,
  motifSequence,
  baselineTransactions,
} from "../src/lib/world";
import { encode, recentHistory, FEATURE_DIM } from "../src/lib/features";

// 1. Same seed -> byte-identical events (IDs and amounts) across two calls.
{
  const a = liveEvents(1234, WORLD_SEED);
  const b = liveEvents(1234, WORLD_SEED);
  assert.deepEqual(a, b, "same seed+bucket must produce identical events");
  assert.ok(a.length > 0, "a bucket must produce events");
}

// 2. Different buckets -> different events.
{
  const a = liveEvents(1234, WORLD_SEED);
  const b = liveEvents(1235, WORLD_SEED);
  assert.notDeepEqual(a, b, "different buckets must differ");
}

// 3. 200 profiles, deterministic.
{
  const p1 = profiles(WORLD_SEED);
  const p2 = profiles(WORLD_SEED);
  assert.equal(p1.length, TENANT_COUNT, "must be 200 profiles");
  assert.deepEqual(p1, p2, "profiles must be deterministic");
  for (const p of p1) {
    assert.ok(p.categories.length >= 2 && p.categories.length <= 4, "2-4 categories");
    assert.ok(p.txCount >= 300 && p.txCount <= 800, "300-800 baseline txns");
  }
}

// 4. Feature vector: exactly 31 dims, every dim finite.
{
  const profile = makeProfile(7);
  const base = baselineTransactions(profile);
  const tx = base[base.length - 1];
  const rh = recentHistory(tx, base.slice(0, -1));
  const vec = encode(tx, rh, {
    homeCurrency: profile.homeCity.currency,
    isNewMerchant: false,
  });
  assert.equal(vec.length, FEATURE_DIM, "vector must have 31 dims");
  for (const x of vec) assert.ok(Number.isFinite(x), "every dim must be finite");
}

// 5. A motif sequence differs measurably from baseline.
{
  const profile = makeProfile(42);
  const seq = motifSequence("card_testing", profile, EPOCH, "check");
  assert.ok(seq.length >= 3, "card_testing is a burst");

  const merchants = new Set(seq.map((e) => e.merchant));
  assert.equal(merchants.size, 1, "card_testing hits one merchant");

  for (const e of seq) {
    assert.equal(e.channel, "online", "card_testing is online");
    assert.ok(e.amount <= 5, "card_testing charges are small");
    assert.equal(e.motif, "card_testing", "carries ground-truth motif");
  }

  // Seconds apart, not the minutes/hours of baseline daily life.
  const gaps = seq
    .slice(1)
    .map((e, i) => Date.parse(e.ts) - Date.parse(seq[i].ts));
  for (const g of gaps) assert.ok(g > 0 && g < 60_000, "consecutive charges seconds apart");

  // Baseline of this tenant is not five small same-merchant online charges seconds apart.
  const base = baselineTransactions(profile);
  const baseMerchants = new Set(base.map((e) => e.merchant));
  assert.ok(baseMerchants.size > 1, "baseline spans multiple merchants");

  // geo_hop produces impossible travel between two cities.
  const hop = motifSequence("geo_hop", profile, EPOCH, "check");
  assert.equal(hop.length, 2, "geo_hop is two events");
  assert.notEqual(hop[0].city, hop[1].city, "geo_hop crosses cities");
}

console.log("check-world: all assertions passed");
