<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/qdrant-fraud-detection-lockup-dark.png">
    <img src="public/qdrant-fraud-detection-lockup.png" alt="Fraud Detection by Qdrant" width="440">
  </picture>
</p>

A live fraud wall for a fictional card network. Synthetic transactions ping on a dark world map at their real coordinates, fraud ignites red within about a second, and every alert opens a panel that shows how it was caught in vector space and how many milliseconds it took.

The problem it demonstrates: "normal" is different for every customer, and per-customer baselines are expensive to run elsewhere (per-namespace pricing, table partitioning, or a separate index per customer). This demo keeps 200 customer baselines (109,446 points) in one [Qdrant](https://qdrant.tech) collection, isolates each customer with a tenant-keyed payload index, and scores every new event against that customer's own history the moment it lands. Qdrant is a vector search engine, and here it is the only backend: no queue, no cache, no relational store.

## The Wall

Open `/` and traffic follows daylight around the globe. Alerts collect in a queue; click one and the camera zooms to the customer, a geo-hop draws a distance-labeled arc between the two cities, and the panel walks through the catch: the transaction becomes a 31-dimensional vector, Qdrant finds its 10 nearest neighbors in this customer's own history, and the distance ratio past 2.0 decides. An animated scatter (2-D PCA of the customer's baseline) plays the same arithmetic visually, and a timing breakdown shows the milliseconds per Qdrant call.

Booth flow: toggle Auto Play for a self-running wall, or share the URL to a phone. Launch An Attack opens a drawer with three attack cards (Geo-Hop, Card Testing Burst, Amount Ladder); the flare lands on the map within a second or two, and See The Evidence pins the story, down to the 10 pinned neighbors and the line proving the stored score reproduces from them.

## How Qdrant Is Used

Everything lives in one collection with a 31-dimensional named vector (Euclid). The features are engineered by a pure function, no learned model, which is what lets the evidence panel explain every score exactly. Scoring is three Qdrant round trips per event:

1. **Context scroll.** The customer's 30 most recent points, `order_by` a datetime-indexed `ts`, feeding recent-history features and the cold-start check (a customer's first 30 events score but never alert).
2. **kNN formula query.** The 10 nearest neighbors inside the customer's [tenant](https://qdrant.tech/documentation/manage-data/multitenancy/), reordered by recency with an `exp_decay` term. The prefetch filter excludes the last hour, so a fraud burst cannot become its own nearest-neighbor cluster and mask itself:

```json
{
  "prefetch": {
    "query": "<event_vector>",
    "using": "features",
    "filter": {
      "must": [
        { "key": "tenant_id", "match": { "value": "<tenant_id>" } },
        { "key": "ts", "range": { "lt": "<event_ts_minus_1h>" } }
      ]
    },
    "limit": 100
  },
  "query": {
    "formula": {
      "sum": [
        { "mult": [-1.0, "$score"] },
        { "mult": [0.15, { "exp_decay": {
          "x": { "datetime_key": "ts" },
          "target": { "datetime": "<event_ts>" },
          "scale": 2592000,
          "midpoint": 0.5
        } } ] }
      ]
    }
  },
  "with_vector": true,
  "limit": 10
}
```

   The Euclid prefetch score sorts closest first while formula queries sort larger scores first, so the distance term is negated before it mixes with `exp_decay`; see the [search relevance docs](https://qdrant.tech/documentation/search/search-relevance/).

3. **Upsert with `wait: true`.** The scored event is searchable immediately, so the next event in a burst scores against it, with no refresh cycle.

The score is a self-normalizing kNN ratio in the style of a local outlier factor: `d_event / d_local`, where `d_event` is the mean distance from the event to its 10 neighbors and `d_local` is the mean distance from those neighbors to their own centroid. It alerts past 2.0. The neighbor IDs, distances, and score are pinned on the point's payload at scoring time, so the evidence panel reproduces the exact arithmetic later even after newer points land.

Two more Qdrant patterns carry the rest of the app:

- **Multitenancy.** The `tenant_id` keyword index is created with `is_tenant: true`, so Qdrant co-locates each customer's vectors and the per-customer kNN stays fast as the collection grows.
- **Qdrant as the message bus.** A phone-launched attack may score on a different serverless instance than the wall's stream, so the wall picks it up with a timestamp-filtered scroll on an indexed `channel_src` field. No queue needed.
- **Bounded growth.** Each stream connection fires a janitor that deletes scored events older than 24 hours with a `must_not is_empty(score)` filter; seeded baseline points carry no `score` field, so they survive ([`evals/janitor.ts`](evals/janitor.ts) checks this).

Feature layout and weights live in the header of [`src/lib/features.ts`](src/lib/features.ts); the tuning record is in [`evals/TUNING.md`](evals/TUNING.md).

## Measured Results

Every number is measured by scripts in [`evals/`](evals); run them with `npm run evals`.

| Eval | Result |
|---|---|
| Motif detection | Sequence recall 0.833, precision 0.754 at threshold 2.0 on the default seed; 0.950 and 0.833 on a held-out seed |
| Latency | Per-event scoring p95 475 ms measured one region away (~100 ms RTT, three round trips per event); launch-to-wall flare 0.9-2.1 s |
| Cold start | Pass: zero alerts inside a fresh customer's 30-event learning window |
| Tenant isolation | Pass: scoring against the wrong customer's baseline shifts the score by 56.5% |
| Determinism | Pass: two runs at the same world seed produce identical alert sets |
| API contract | 5/5 pass, asserting on computed values, not status codes |

Latency is dominated by round-trip time, so deploy the compute next to the Qdrant cluster: cross-region RTT alone eats the sub-second flare budget.

## Run It

Requires a Qdrant Cloud cluster (1-2 GB is plenty) and Node 20 or newer.

```bash
npm install
cp .env.example .env          # fill in QDRANT_URL and QDRANT_API_KEY
npx tsx --env-file=.env scripts/seed.ts   # ~100k baseline points across 200 customers
npm run dev                   # http://localhost:3000
npm run evals                 # runs the suite against throwaway collections
```

## Scope

This demonstrates the retrieval mechanics of per-customer anomaly scoring on synthetic data. It is not a production fraud model: the synthetic world separates fraud from normal traffic more cleanly than real payments, the threshold and features were tuned on this generator (validated on a held-out seed), and the one-hour neighbor exclusion is sized to this demo's motif durations.

---

Licensed under Apache-2.0. See [LICENSE](LICENSE).
