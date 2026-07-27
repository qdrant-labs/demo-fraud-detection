// Shared helpers for the throwaway-collection evals (motif, cold-start,
// determinism). Each of those scripts sets QDRANT_COLLECTION to its own eval
// collection BEFORE dynamically importing this module, so `qdrant.ts` reads the
// right name (the COLLECTION const is captured at import time).
//
// This module must never be imported by the tenant-isolation eval: that one
// reads the LIVE fraud_demo collection and must never seed or drop anything.

import { encode, recentHistory } from "../src/lib/features";
import {
  COLLECTION,
  CONTEXT_LIMIT,
  ensureCollection,
  pointFor,
  qdrant,
  resetEnsuredCollection,
} from "../src/lib/qdrant";
import { scoreEvent, type ScoredEvent } from "../src/lib/score";
import { baselineTransactions, makeProfile, WORLD_SEED, type Transaction } from "../src/lib/world";

// Seed baseline points for the given tenant indices into the current COLLECTION.
// Same per-tenant logic as scripts/seed.ts (in-memory recent-history window, no
// Qdrant reads), scoped to a subset so an eval seeds only what it scores against.
// Called with [] it just creates the empty collection + indexes (cold start).
// `seed` picks the world: a held-out motif run seeds baselines from the same seed
// its scored events derive from, so profiles and baselines stay coherent.
// `days` / `txScale` are forwarded to baselineTransactions; the scale benchmark
// uses them to seed a longer per-tenant history. `wait` defaults to true so an
// eval's next read sees everything it just wrote; the benchmark sets it false to
// load millions of points without a round trip per batch, and waits for green
// once at the end instead. Omit opts and every caller gets today's world.
export async function seedTenants(
  indices: number[],
  seed: string = WORLD_SEED,
  opts?: { days?: number; txScale?: number; wait?: boolean },
): Promise<void> {
  await ensureCollection();
  const BATCH = 2000;
  const wait = opts?.wait ?? true;
  let batch: ReturnType<typeof pointFor>[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await qdrant.upsert(COLLECTION, { wait, points: batch });
    batch = [];
  };

  for (const idx of indices) {
    const profile = makeProfile(idx, seed);
    const baseline = baselineTransactions(profile, seed, opts); // oldest-first
    for (let i = 0; i < baseline.length; i++) {
      const tx = baseline[i];
      const window = baseline.slice(Math.max(0, i - CONTEXT_LIMIT), i);
      const recent = recentHistory(tx, window);
      const isNewMerchant = !profile.merchants.some((m) => m.name === tx.merchant);
      const vector = encode(tx, recent, {
        homeCurrency: profile.homeCity.currency,
        isNewMerchant,
      });
      batch.push(pointFor(tx, vector, recent));
      if (batch.length >= BATCH) await flush();
    }
  }
  await flush();
}

// Score a stream the way the wall does (src/app/api/stream processBucket):
// events of different tenants run in parallel, one tenant's events strictly in
// ts order so a burst's event N is upserted before N+1 is scored. Concurrency
// caps tenant groups in flight to stay polite to the shared cluster. Returns
// results keyed by tx.id; the caller re-orders by its own input if it needs to.
export async function scoreStream(
  txs: Transaction[],
  concurrency = 16,
): Promise<Map<string | number, ScoredEvent>> {
  const byTenant = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const list = byTenant.get(tx.tenant_id) ?? [];
    list.push(tx);
    byTenant.set(tx.tenant_id, list);
  }
  const groups = [...byTenant.values()];
  for (const g of groups) g.sort((a, b) => a.ts.localeCompare(b.ts));

  const results = new Map<string | number, ScoredEvent>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < groups.length) {
      const group = groups[next++];
      for (const tx of group) {
        results.set(tx.id, await scoreEvent(tx));
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, groups.length) }, worker),
  );
  return results;
}

// Delete the current COLLECTION (an eval collection). Safe to call when absent.
export async function dropCollection(): Promise<void> {
  try {
    await qdrant.deleteCollection(COLLECTION);
  } catch {
    // already gone
  }
  // The collection is gone; clear the ensureCollection memo so a following
  // seedTenants recreates it (determinism drops and re-seeds in one process).
  resetEnsuredCollection();
}
