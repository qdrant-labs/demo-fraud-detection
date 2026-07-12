// Qdrant client + collection shape for the fraud demo.
//
// Qdrant is a vector search engine; here it is the ONLY backend. One collection
// holds every tenant's baseline and every scored live event, isolated per
// tenant by a tenant-keyed payload index (multitenancy).

import { QdrantClient } from "@qdrant/js-client-rest";
import type { RecentHistory } from "./features";
import { FEATURE_DIM } from "./features";
import type { Transaction } from "./world";

// The live demo scores against "fraud_demo"; evals override this to score
// against throwaway collections so eval traffic never pollutes the live one.
export const COLLECTION = process.env.QDRANT_COLLECTION ?? "fraud_demo";

// The single named vector. Named (not default) so the collection can grow other
// vectors later without a migration, and to make the `using` argument explicit.
export const FEATURE_VECTOR = "features";

// Recent context read per scored event: the tenant's most recent 30 points.
// This is also the learning-window size (first 30 tx per tenant never alert),
// so seed and score must use the SAME window or their vectors live in different
// spaces (dim 29 amount-ratio-median shifts with the window). See seed.ts.
export const CONTEXT_LIMIT = 30;

// QDRANT_URL / QDRANT_API_KEY come from .env (loaded via `tsx --env-file=.env`)
// or the Vercel environment. Construction is deferred to the first method call:
// the production build imports this module while collecting page data, and must
// not build a live client (nor require the URL) at build time. A Proxy keeps the
// `qdrant.method()` call sites unchanged while creating the client lazily.
let client: QdrantClient | undefined;
function makeClient(): QdrantClient {
  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  if (!url) throw new Error("QDRANT_URL is not set");
  return new QdrantClient({ url, apiKey });
}

export const qdrant = new Proxy({} as QdrantClient, {
  get(_t, prop) {
    client ??= makeClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

// Create the collection if absent, then ensure every payload index exists.
// Idempotent on both counts: an existing collection is left alone, and creating
// an index that already exists returns `status: completed` with no error
// (verified live against the 1.18 cluster), so this is safe on every cold start
// and also repairs an older collection that predates an index.
// Memoized per serverless instance: the SSE route calls this on every
// connection open, and 6 round trips per reconnect for state that cannot
// change mid-deploy is wasted work.
let ensured: Promise<void> | undefined;
export function ensureCollection(): Promise<void> {
  return (ensured ??= ensureCollectionNow());
}

// Clear the memo so the next ensureCollection re-runs. The memo assumes the
// collection never disappears mid-process; the determinism eval breaks that
// assumption by dropping and re-seeding the same collection twice in one
// process, so its dropCollection calls this to force a recreate.
export function resetEnsuredCollection(): void {
  ensured = undefined;
}

async function ensureCollectionNow(): Promise<void> {
  const { exists } = await qdrant.collectionExists(COLLECTION);
  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: {
        [FEATURE_VECTOR]: { size: FEATURE_DIM, distance: "Euclid" },
      },
    });
  }

  // Indexes are created unconditionally, not only on first creation: the
  // collection may already exist from an earlier build that lacked one of them.
  // tenant_id: keyword index with is_tenant so Qdrant co-locates each tenant's
  // vectors on disk (v1.11+). This is the multitenancy story the demo shows.
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "tenant_id",
    field_schema: { type: "keyword", is_tenant: true },
    wait: true,
  });

  // ts: datetime index. Required both for order_by on the context scroll and
  // for datetime_key inside the recency formula (verified: formula errors
  // without it).
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "ts",
    field_schema: "datetime",
    wait: true,
  });

  // channel_src: keyword index. The wall's SSE loop scrolls this each tick to
  // pick up browser-launched attack events (channel_src = browser_attack) that
  // were scored on a different serverless instance; an index keeps that scroll
  // cheap as the collection grows.
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "channel_src",
    field_schema: "keyword",
    wait: true,
  });

  // alerted: bool index. Qdrant 1.18 rejects a filter on a bool field that has
  // no index, and "show me the alerts" is the natural query over this collection
  // (the eval and the Phase 3 gate both scroll alerted = true), so the field is
  // indexed rather than scanned.
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "alerted",
    field_schema: "bool",
    wait: true,
  });

  // score: float index. The janitor (deleteStaleScored) spares seeded baseline
  // points with `must_not is_empty(score)`, and Qdrant 1.18 requires an index on
  // a field before it can appear in an is_empty filter (the same rule that forces
  // the alerted index above). Baseline points carry no score, so this index is
  // sparse over them, which is exactly what is_empty needs.
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "score",
    field_schema: "float",
    wait: true,
  });
}

// Delete scored live events older than `maxAgeMs` from the current COLLECTION.
// The wall upserts every scored event and never removes them, so a long-open
// wall grows the collection without bound (~5-6 points/s). The `must_not
// is_empty(score)` guard is load-bearing: seeded baseline points carry no
// `score` payload field, so they never match this filter and survive. Verified
// the is_empty condition shape against the Qdrant filtering docs.
// ponytail: a scheduled sweep would be tidier, but PLAN forbids a cron/queue;
// the SSE route fires this per connection instead (a few times an hour).
export async function deleteStaleScored(maxAgeMs: number): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  await qdrant.delete(COLLECTION, {
    wait: true,
    filter: {
      must: [{ key: "ts", range: { lt: cutoff } }],
      must_not: [{ is_empty: { key: "score" } }],
    },
  });
}

// Compact payload keys for the five recent-history feature values. Written back
// so the wall and evidence panel can replay the exact arithmetic later.
export interface RecentHistoryPayload {
  rh_mins: number; // minutes since last tx (scaled)
  rh_same10m: number; // same-merchant count in 10m (scaled)
  rh_kmh: number; // impossible-travel speed (scaled)
  rh_amt: number; // amount / recent median (scaled)
  rh_ladder: number; // consecutive same-merchant escalation count (scaled)
}

export function recentHistoryPayload(rh: RecentHistory): RecentHistoryPayload {
  return {
    rh_mins: rh.minutesSinceLast,
    rh_same10m: rh.sameMerchant10m,
    rh_kmh: rh.impossibleTravelKmh,
    rh_amt: rh.amountRatioMedian,
    rh_ladder: rh.ladderRises,
  };
}

// The full scoring result persisted on a scored point's payload. Every field
// here exists so that another serverless instance (or the alert panel)
// can replay the event without rescoring: the wall picks up browser-launched
// attacks scored elsewhere, and the evidence panel must reproduce the exact
// arithmetic even after later points land. The neighbor set is pinned at
// scoring time (`neighbor_ids`) precisely because a fresh kNN would return a
// different set once more of the tenant's events exist, which would change the
// numbers the panel is supposed to reproduce.
export interface ScoredPayload {
  score: number;
  alerted: boolean;
  explanation: string;
  neighbor_ids: (string | number)[]; // the 10 neighbors used, in ranked order
  d_event: number; // mean event-to-neighbor distance
  d_local: number; // mean neighbor-to-centroid distance
}

// The Qdrant point for one transaction. `scored` is present only for scored
// live events; baseline points were never scored, so it is omitted for them.
//
// lat/lon are stored on top of the PLAN's payload list on purpose: computing a
// future event's recent-history (impossible-travel) needs the prior points'
// coordinates, and the context scroll reads them straight from payload.
export function pointFor(
  tx: Transaction,
  vector: number[],
  rh: RecentHistory,
  scored?: ScoredPayload,
) {
  return {
    id: tx.id,
    vector: { [FEATURE_VECTOR]: vector },
    payload: {
      tenant_id: tx.tenant_id,
      ts: tx.ts,
      amount: tx.amount,
      currency: tx.currency,
      merchant: tx.merchant,
      merchant_cat: tx.merchant_cat,
      city: tx.city,
      lat: tx.lat,
      lon: tx.lon,
      channel: tx.channel,
      card_present: tx.card_present,
      motif: tx.motif, // ground truth, evals only; the scorer never reads it
      channel_src: tx.channel_src,
      ...recentHistoryPayload(rh),
      ...(scored ?? {}),
    },
  };
}
