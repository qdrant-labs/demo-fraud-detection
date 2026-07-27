# Bank Assets Runbook

Two deliverables for a bank audience: a **scale benchmark** answering "cute at 200 customers, what about 80 million cardholders", and a **technical whitepaper** built only from measured numbers. A third workstream fixes how the demo's existing numbers are reported, and it gates what the whitepaper may claim.

Reviewed by Fable 5 and Codex; their corrections are already folded in. Where a tempting-but-wrong approach was rejected, the reason is written down so it does not get reintroduced.

Work the sections in order. Sections B and C need no cluster and no spend.

---

## 0. Facts verified against this code (2026-07-27)

Do not re-derive these; do re-verify before publishing any of them.

**`src/lib/world.ts`**
- `TENANT_COUNT = 200`, `WORLD_SEED = "fraud-watch-v1"`, `EPOCH = 2026-07-11T12:00Z`.
- `makeProfile(index, seed)` works for **any** index. It does not depend on `TENANT_COUNT`.
- `profile.txCount = 300 + floor(r() * 500)` (line 175), i.e. 300-800 per tenant.
- `baselineTransactions` spreads exactly `txCount` transactions over a **hardcoded 90-day** span (`Math.floor(r() * 90)`, line 303).
- `genTransaction` is module-private. `liveEvents` loops `makeProfile` over every tenant per 2-second bucket, so it is unusable at 20k tenants.

**`src/lib/qdrant.ts`**
- `COLLECTION` is read from `process.env.QDRANT_COLLECTION` **at import time** (line 14). This is the trap that wiped the live collection once already.
- One named vector `features`, 31-d, Euclid. `ensureCollection()` passes **no `hnsw_config`** (line 71), so the live collection runs a default global HNSW graph. Fixed in A0.
- **Exactly one vector search exists in the repo**: `qdrant.query` at `src/lib/score.ts:217`, tenant-filtered. Everything else is a scroll, count, retrieve or delete. This is what makes the A0 config change free of downside.
- Payload indexes: `tenant_id` keyword with `is_tenant: true`, `ts` datetime, `channel_src` keyword, `alerted` bool, `score` float.

**`src/lib/score.ts`** — three round trips per event:
1. filtered scroll: tenant + `ts < event.ts`, `order_by ts desc`, limit 30 (line 179)
2. `query` with filtered prefetch limit 100 + formula rerank (`-$score` + 0.15 × `exp_decay` on `ts`), limit 10, `with_vector: true` (line 217)
3. upsert `wait: true` (line 314)

- `StageTimings { scroll, knn, upsert, total }`. `t1` is taken after the scroll and `t2` after the kNN, so **`knn` includes the local `recentHistory` + `encode` CPU work** (lines 196-253). It is not a pure network stage. Name it accordingly.
- `persist = alerted || (opts?.persist ?? true)` (line 311). **Alerted events upsert even with `persist: false`**, and `timings.upsert` stays 0 when nothing is written (`t3 = t2`).

**`evals/harness.ts`** — `seedTenants(indices, seed)` already seeds an arbitrary set of tenant indices into the current `COLLECTION`. No new seeding code is needed for the tenant axis.

**`src/app/page.tsx`** — `LATENCY_CAP = 300` (line 90). The rolling buffer holds `timings.total` (line 331). `p95 Latency` renders at line 778. `timings` arrive only on generator events, not on attack pickups.

**`evals/TUNING.md`** current numbers, both seeds:

| | default seed | holdout `fraud-watch-holdout-v1` |
|---|---|---|
| fraud-labeled events | 150 alerted / 110 not = **260** | 153 / 107 = **260** |
| `motif=none` events | 28 alerted / 4,673 not = **4,701** | 24 / 4,679 = **4,703** |
| sequence recall | 48/60 = **0.800** | 49/60 = **0.817** |
| per-motif | card_testing 1.00, geo_hop 1.00, ladder **0.40** | 1.00, 1.00, ladder 0.45 |
| event precision | 150/178 = **0.843** | 153/177 = **0.864** |

Any note quoting holdout **0.950 / 0.833 is stale** (pre-interleaving). Re-run both seeds and quote fresh output before publishing.

Live latency today: median ~85 ms total (scroll 33 / knn 56), Vercel `pdx1`, cluster us-west-2.

---

## 1. Qdrant guidance (pulled live from skills.qdrant.tech, 2026-07-27)

Re-pull with the `qdrant-advisor` skill before publishing; this guidance changes.

1. **`ensureCollection()` is missing the prescribed multitenant HNSW config.** For a shared-collection multitenant setup:
   ```json
   { "hnsw_config": { "m": 0, "payload_m": 16 } }
   ```
   `m: 0` disables the global graph so Qdrant builds a separate index per tenant group. A global HNSW over a multitenant collection is named as an anti-pattern. https://qdrant.tech/documentation/manage-data/multitenancy/

   **What the docs actually claim is indexing speed, not search latency:** "Qdrant will index vectors for each user independently, significantly accelerating the process." Do not write a query-latency claim into the one-pager on the strength of this config. The direction and size of any search-latency effect is what cell 5 measures. If it turns out to be flat, the publishable result is faster index build and lower memory, which is still worth stating.

   **The documented downside does not apply here.** The docs warn that queries without the tenant filter must scan every group. This repo contains exactly one vector search — `qdrant.query` at `src/lib/score.ts:217` — and it filters on `tenant_id`. Verified with `grep -rn "qdrant\.query\|qdrant\.search" src evals scripts`: one hit. Every other Qdrant call is a scroll, a count, a retrieve or a delete, none of which touch the vector graph. Re-run that grep before trusting this; if a second vector search ever appears unfiltered, this tradeoff changes.
2. `is_tenant: true` co-locates a tenant's vectors for sequential reads (v1.11+). Already set here; omitting it "kills sequential read performance."
3. Payload filtering scales to roughly **10k tenants**. Past that, custom sharding by tenant-ID hash, or queries broadcast to every shard. Promote a tenant to a dedicated shard around 20k points; ~1000 dedicated shards max per cluster.
4. Never one collection per tenant (1000-collection limit). Separate collections are the compliance-only exception.
5. Benchmark validity: check `optimizer_status` and compare `indexed_vectors_count` to `points_count` before measuring. If `indexed_only=true` is much faster, indexing is still running.
6. Memory: payload indexes, the HNSW graph and quantized vectors are resident; raw vectors sit in page cache. Resident above 80% of RAM is a problem signal.

Item 1 is the most valuable thing in this document and the whitepaper's best chart.

---

## 2. Workstream B — reporting fixes (do first, no cluster needed)

### B1. Prevalence honesty

The eval's per-event fraud prevalence is 260 / 4,961 = **5.2%**. Real card fraud runs near **0.1%** of authorizations, so the published 0.843 precision does not survive the move to production prevalence. Measured rates from the default seed:

- synthetic-background false-positive rate: 28 / 4,701 = **0.596% per normal event**
- per-event recall: 150 / 260 = **0.577**
- per-sequence recall: 48 / 60 = **0.800**
- mean sequence length: 260 / 60 = **4.33 events**

Projection to 1M authorizations at 0.1% event-level prevalence (1,000 fraud events, 999,000 normal):

- false alerts ≈ 999,000 × 0.00596 = **5,950**
- event view: true alerts ≈ 1,000 × 0.577 = **577**, per-event precision **577 / 6,527 = 8.8%**
- case view: 1,000 fraud events / 4.33 = **231 fraud cases**, of which 80% are caught = **185 cases detected** against those 5,950 false alerts

Report **both**, each with its denominator stated. Codex flagged the real hazard here: mixing per-sequence recall with a per-event false-positive rate produces two different precision numbers from the same data. The fix is the explicit sequence-prevalence derivation above (event prevalence ÷ mean sequence length), not dropping either metric.

Call the 0.596% a **synthetic-background false-positive rate** every time it appears. It was measured on `liveEvents` traffic, not bank authorization traffic, and projecting it onto 999,000 real transactions is a conditional estimate. Say so in the same sentence as the number.

Task: add a reported block to `evals/motif-detection.ts` printing the four measured rates, then alerts-per-million, per-event precision, and cases-detected at a prevalence constant (default 0.001). Arithmetic on numbers the eval already computes; no new experiment. Do not add a pass/fail gate on it — it is a reporting change.

Why this is first: it decides the pitch. The honest pair (185 cases caught, 5,950 false alerts per million) points at a fraud-triage signal feeding an analyst queue, not a decisioning engine. Publishing 0.843 and letting a bank discover the prevalence gap is the failure case.

### B2. Define decision latency

Card authorization has a hard end-to-end budget (roughly 100-300 ms for the whole round trip, of which the risk model gets a slice). The demo's `total` includes an upsert with `wait: true`, which no bank puts in front of an approve/decline.

**Decision latency = `scroll + knn`** = everything except the write, including the local feature encoding (see §0). Use that definition in the bench, on the wall, and in the whitepaper, and describe the write as post-decision persistence.

Do **not** reorder `scoreEvent`'s awaits. The synchronous `wait: true` upsert is load-bearing for burst pickup in the demo and is documented as such in `score.ts`.

Whitepaper note only, no code: in a real deployment the recent-history scroll comes from the bank's existing feature store or cache, leaving one filtered kNN on the decision path.

### B3. Wall latency counter

`src/app/page.tsx` pushes `timings.total` into `latencyRef` (line 331) and shows `p95 Latency` (line 778). Change it to push `timings.scroll + timings.knn` and label it **Decision p50 / p95**.

This is not a label-only change — the buffer contents must change too, or the number stays wall-clock-including-write.

Show p50 and p95, not p99: `LATENCY_CAP = 300` makes p99 the third-worst observation, which is not a percentile worth putting on a wall. p99 belongs in the bench table where the sample size is controlled.

Both review passes wanted this cut as booth polish rather than a bank asset. Keeping it because Dylan asked for a visible latency counter specifically, and it is a handful of lines. Neither the benchmark nor the whitepaper depends on it, so ship it last.

### B4. Ladder recall — do not retune

Publish 0.40 with the explanation already written at `evals/TUNING.md:40` (interleaved same-merchant background traffic crowds the escalation chain out of the 30-point window before the ladder finishes). A retuning branch was considered and cut: it is a separate investigation, and an explained 0.40 is publishable while an unexplained one is not.

### B5. Isolation wording

Defensible, use verbatim:

> Every query carries a tenant filter, and `tenant_id` is indexed with `is_tenant: true` so each tenant's vectors are co-located. `evals/tenant-isolation.ts` asserts that no neighbour returned on any of the demo's query paths belongs to another tenant.

Never write "isolation guarantees" or "tenant data cannot leak." The filter is applied by application code in the query path. A bank's security reviewer makes that distinction, and a PDF that already made the stronger claim loses the room on page 2.

If a hard boundary is the requirement, name the docs' own exception: separate collections with per-tenant encryption, under the 1000-collection limit.

---

## 3. Workstream A — scale benchmark

Runs **locally against Qdrant in Docker**. See A4 and A5 for why that is a better analogue than a cloud cluster, and for what it cannot measure.

### A0. Fix the HNSW config, then re-verify the tuned numbers

`ensureCollectionNow()` at `src/lib/qdrant.ts:71` creates collections with no `hnsw_config`. Add it:

```ts
await qdrant.createCollection(COLLECTION, {
  vectors: {
    [FEATURE_VECTOR]: { size: FEATURE_DIM, distance: "Euclid" },
  },
  // Multitenant HNSW: `m: 0` disables the global graph and `payload_m` builds
  // one subgraph per tenant_id group instead. Every vector search here is
  // tenant-filtered (there is exactly one, the score.ts kNN), so a global graph
  // is maintained for a traversal that never happens. The documented downside —
  // unfiltered searches must scan every group — costs nothing for that reason.
  hnsw_config: { m: 0, payload_m: 16 },
});
```

**This only affects collections created from here on.** `createCollection` runs inside `if (!exists)`, so the live cloud `fraud_demo` collection keeps the default global graph it was created with. Changing that one is a separate action (see §7) and running the benchmark locally does not touch it.

**Then re-verify, before any number goes near the PDF.** Eval throwaway collections are created through this same function, so they now get per-tenant subgraphs while every number in `evals/TUNING.md` was measured under the default global graph. If the subgraph returns even slightly different neighbours, scores shift and the published recall and precision move.

```bash
npx tsx --env-file=.env evals/motif-detection.ts
npx tsx --env-file=.env evals/motif-detection.ts fraud-watch-holdout-v1
npm run evals
```

Expected: unchanged. At ~550 points per tenant the prefetch probably resolves exactly regardless of graph config, so the numbers should hold — but "probably" is not publishable. If they do shift, the shifted numbers become the published ones, because they were measured under the config being advocated. Record whichever outcome happens in `TUNING.md` with the config noted.

Do not run two eval processes concurrently — they share throwaway collection names.

### A1. Code changes (smallest correct diff)

No env vars in `world.ts`. `seedTenants(range(0, 20000))` already covers the tenant axis with zero changes to the shipped world, and the live demo's code path stays untouched.

Only the history axis needs a change — two optional parameters on `baselineTransactions` (`src/lib/world.ts:295`), defaults equal to today's behaviour:

```ts
export function baselineTransactions(
  profile: TenantProfile,
  seed: string = WORLD_SEED,
  opts?: { days?: number; txScale?: number },
): Transaction[]
```

`days` (default 90) replaces the hardcoded 90 in the day-index draw. `txScale` (default 1) multiplies `profile.txCount`.

**Both must move together.** Scaling the span alone keeps `txCount` fixed and thins per-day density by 5×, which shifts `rh_mins` and `rh_same10m` and therefore changes the vectors — the opposite of a controlled experiment. `days: 450, txScale: 5` gives ~2,735 points per tenant at unchanged per-day behaviour, modelling 15 months of history.

Thread the same options through `seedTenants` in `evals/harness.ts` to its `baselineTransactions` call.

### A2. `scripts/bench-scale.ts`

**Collection safety — non-negotiable, this is how the live collection got wiped:**

- `QDRANT_COLLECTION` is set in the **environment of the invocation**, before the process starts. Do **not** pass `--env-file=.env`: that file points at the live cloud cluster, and the bench must never reach it. Set both variables explicitly:

  ```bash
  QDRANT_URL=http://localhost:6333 QDRANT_COLLECTION=bench_t2000_d90 \
    npx tsx scripts/bench-scale.ts --tenants 2000 --days 90 --tx-scale 1
  ```

- Assert `QDRANT_URL` contains `localhost` or `127.0.0.1` alongside the collection-name check below. Two guards, because either one alone still permits a run that creates 11M points on the shared cloud cluster.
- The script must **never** assign `process.env.QDRANT_COLLECTION` itself. `src/lib/qdrant.ts:14` captures it at import, so an internal assignment is guaranteed too late.
- First statement after imports: assert `/^bench_[a-z0-9_]+$/.test(COLLECTION)` and exit non-zero otherwise. Nothing destructive runs before that assert.
- Teardown lives in a `finally` block and deletes **only the exact generated name**.

Per cell:

1. Create the collection directly (not via `ensureCollection`, which passes no `hnsw_config`) with the same vector config plus `hnsw_config: { m: 0, payload_m: 16 }`. The control cell omits `hnsw_config`. Then call `ensureCollection()` to add the five payload indexes — it no-ops on an existing collection.
2. Bulk load with `indexing_threshold: 0` and `wait: false`, batch 2000. Then restore the default `indexing_threshold` and wait for `status: green`, `optimizer_status: ok`, and `indexed_vectors_count` within 1% of `points_count`.
3. **Assert `points_count` is within 2% of expected** before measuring. This catches a mis-threaded `txScale` silently producing the wrong axis.
4. Warm up 100 events and discard. "Warm" means the connection is open and the index is resident, not that the measured tenant's segment is cached.
5. Measure 1,000 events across **1,000 distinct tenants** where the cell has that many. The 200-tenant cell uses 200 distinct plus repeats; record the repeat fraction. A real issuer's next authorization comes from a random cardholder, so the cold first touch of a tenant segment is the production case. Report first-touch and repeat-touch rows separately.
6. Sequential, one event at a time.
7. Record `scroll`, `knn` (includes feature encoding), and `decision = scroll + knn`. Report p50/p95/p99 **with the sample size beside each**. p99 from 1,000 samples is the tenth-worst observation; say so.
8. Append one JSON line per cell to `evals/results/scale.jsonl` (`fs.appendFileSync`, never overwrite). Record the **alerted-event count** in the row. Delete the cell collection in `finally` once the row is written.

Cut from an earlier draft: a network-floor sample (`collectionExists` × 50) and separate first-touch / repeat-touch rows. The bench runs over loopback, so the floor is noise — record the environment instead (A5). And with 1,000 distinct tenants, every sample already is a first touch; only the 200-tenant cell repeats, so note its repeat count and move on.

**The measured events.** Transaction content is irrelevant to a latency benchmark — only query shape and filter cardinality matter. Clone the tenant's last baseline transaction with a fresh id and a `ts` just after `EPOCH`:

```ts
{ ...tx, id: randomUUID(), ts: new Date(EPOCH + n * 60_000).toISOString() }
```

No new exports needed from `world.ts`.

**Contamination disclosure.** `persist: false` still upserts alerted events (`score.ts:311`). Cloned baseline transactions are normal behaviour so alerts should be rare; log the count, and if it exceeds 2% of samples, stop and find out why before publishing the cell. The write is excluded from the decision metric regardless.

**Write latency is not in the table.** With `persist: false`, `timings.upsert` is 0 for everything that doesn't alert, so no clean write percentile exists on this path. B2 takes the write off the decision path anyway. State that the write is asynchronous in a real deployment, and that the demo's own on-screen figure previously included a synchronous `wait: true` upsert.

### A3. Sweep grid — 5 cells, one 11M load

**Primary axis: total collection scale at fixed per-tenant history.** This is deliberately *not* labelled a tenant-count sweep. Tenant count and total points grow together here, so a single cell pair cannot separate the two causes — and growing together is how a bank actually grows (more cardholders, same retention window).

| tenants | days / txScale | ≈ points | role |
|---|---|---|---|
| 200 | 90 / 1 | 0.11M | today's demo, control point |
| 2,000 | 90 / 1 | 1.1M | |
| 20,000 | 90 / 1 | 11M | 100× the demo, just past the ~10k payload-filtering ceiling |

**Matched-total cell** — the one that makes the claim causal:

| tenants | days / txScale | ≈ points |
|---|---|---|
| 200 | 900 / 10 | 1.1M |

Same 1.1M total as the 2,000-tenant cell, reached with 10× the history on 10× fewer tenants. If decision latency matches the 2,000-tenant cell, total collection size is what costs, not tenant cardinality. If it doesn't, per-tenant history is what costs. Either result is publishable, and both beat a single-axis sweep. Matched at 1.1M rather than 11M because it is cheap to load and answers the same question.

This cell replaces a separate history axis (2,000 tenants × 450 days = 5.5M) that an earlier draft had. It was redundant: this cell already varies per-tenant history 10×, so the extra 5.5M load bought nothing.

**Architecture control:**

| tenants | config | ≈ points |
|---|---|---|
| 2,000 | **default HNSW** (no `hnsw_config`) | 1.1M |

Compare against the 2,000-tenant primary cell. Run it at 1.1M, not 11M — the delta should be visible at 1.1M and the load is 10× cheaper. Only re-run at 11M if the delta is interesting enough to headline, and say which size it was measured at.

Report this as **default HNSW vs the prescribed multitenant config**, not as a `payload_m` measurement: `m: 0` changes index architecture, memory profile and build time all at once, so the delta cannot be attributed to `payload_m` alone. A purist `{m: 0, payload_m: 0}` control was considered and cut — nobody would deploy it, so it answers a question no reader has.

**Out of scope by default:** the 100k-tenant / 55M-point cell. Decide before provisioning, never mid-run. 200 → 20,000 tenants is a 100× sweep that demonstrates the mechanism, and past the documented 10k ceiling the answer is custom sharding — a config change, not a redesign. Add the 55M cell only if Dylan explicitly wants the bigger headline and accepts roughly a day of load time.

**Never extrapolate the curve past the last measured cell.**

Total loaded across the run ≈ 14.4M points, of which one cell is 11M. Cells are deleted as they complete, so peak retained is 11M.

**Not measured:** sustained throughput under concurrent load. A 16-way concurrency run was considered and cut — a partial load test invites "that isn't a load test." Put one sentence in the whitepaper saying per-query latency was measured and sustained throughput was not.

### A4. Where it runs: local Docker

**Local, not a cloud cluster.** This is a deliberate upgrade to the methodology, not a cost saving. A bank runs fraud scoring co-located with the authorization path inside its own datacenter, so a loopback connection is a closer analogue than a managed cluster reached over the public internet. It also removes cross-region RTT, which was the weakest part of the earlier plan — a reviewer can no longer discount the table for network overhead.

The shared hive-mind cluster is not involved at all, which also removes the risk that made the earlier plan nervous: it hosts the live booth demo and an errant eval already wiped it once.

```bash
docker run -p 6333:6333 -p 6334:6334 -v "$(pwd)/.qdrant-bench:/qdrant/storage" qdrant/qdrant
```

Point the bench at it with `QDRANT_URL=http://localhost:6333` and no API key. Keep the storage volume out of git.

Setup checks before the first big load:

1. **Docker Desktop memory allocation.** The default is often 8 GB, which is the binding constraint here, not the machine's 24 GB. Raise it before the 11M cell.
2. **Qdrant version.** Record it (`GET /`) — `payload_m` and `is_tenant` both need ≥1.11, and the version belongs next to the published numbers.
3. **Preflight.** Run the 0.11M cell end to end first. Time it, multiply by 100, and write the expected 11M load time here so a later executor can tell a slow load from a hang. If it extrapolates past a few hours, raise `BATCH` and keep `wait: false` rather than waiting it out.
4. **Delete the storage volume** when the sweep is done.

Sizing on this machine (Apple M5 Pro, 15 cores, 24 GB RAM, ~570 GB free): 31-d float32 = 124 B per vector, so 11M vectors ≈ 1.4 GB raw. Per-tenant HNSW graphs at `payload_m: 16` add roughly 11M × 16 × 4 B ≈ 0.7 GB. Payload (~15 fields, 300-500 B per point) is the bulk at 3-6 GB and can sit on disk. 11M should fit comfortably; watch RSS as the cells ascend, and if 11M does not fit, publish through 1.1M and say so rather than forcing it.

### A5. What local measurement can and cannot support

**Report the environment next to every number**, in this form: Apple M5 Pro, 15 cores, 24 GB RAM, Qdrant `<version>` in Docker, single node, loopback connection. A bank engineer calibrates from that line, and without it the table is unreadable.

Three honest limits, all of which belong in the one-pager rather than being discovered by a reader:

- **Docker on macOS virtualizes disk I/O**, so a disk-bound result is slower than the same workload on native storage. If the numbers look disk-bound at 11M, say so. The fallback is the native Qdrant binary instead of Docker.
- **Single node.** Nothing about the sharding conversation past 10k tenants can be measured here — no shard broadcast, no replication. State that the sharding recommendation comes from the docs, not from measurement.
- **Laptop hardware is not server hardware.** An M5 Pro with fast local NVMe may beat a modest cloud node on single-query latency and lose to a large one. The number is an honest measurement of a specific machine, not a capacity promise, and should be worded that way.

The network floor sampling from an earlier draft is gone: on loopback it is noise. Record where the bench ran instead.

---

## 4. Workstream C — whitepaper

Draft as an Artifact (load the `artifact-design` skill first), then browser print-to-PDF. No export pipeline.

**Two pages.** Dylan's original ask was an architecture one-pager; an earlier draft had grown to four pages plus an appendix. Write the two pages, and add the numbers appendix only if the measured results need more room than the body gives them. It must stand alone — a bank circulates the PDF, not the demo URL.

1. **The gap.** Supervised fraud models need chargeback labels that arrive weeks later, so a genuinely new pattern runs until it is labelled. Per-customer behavioural baselines need no labels.
2. **The pattern.** One vector per transaction from 31 engineered features. Score = mean distance from the event to its 10 nearest neighbours *inside that customer's own history*, divided by the mean spread of those neighbours. Self-normalizing, so a customer who always spends 40 EUR and one who always spends 4,000 EUR need no per-customer thresholds. This is the intellectual content — lead with it.
3. **The architecture.** One collection, tenant-partitioned HNSW (`m: 0`, `payload_m: 16`), tenant-filtered kNN with a recency-weighted rerank, two reads on the decision path. Evidence written onto the point (pinned neighbour ids, `d_event`, `d_local`, explanation) so an analyst reproduces the score after the fact. For a bank, that audit story carries as much weight as the latency.
4. **The numbers.** Measured only, from `evals/results/scale.jsonl` and a fresh two-seed eval run. Per-motif recall, alerts per million with prevalence stated, the latency sweep, the architecture delta, sample size beside every percentile.
5. **What this is not.** Not a replacement for a rules engine or a supervised model; one signal in an ensemble aimed at the unlabelled tail. No consortium data, no device fingerprinting, no supervised training. Synthetic data, said plainly.

Gates before it leaves: **`/qdrant-messaging`** (mandatory for customer-facing work) and **`/andrey-review`**. Qdrant is a vector search engine, never a vector database.

---

## 5. How realistic is this for an actual bank?

The pattern is real; parts of the demo are demo-shaped. Prepare these answers — they are what gets asked in the room.

**Realistic**
- Per-customer behavioural baselines are standard practice in card fraud. Retrieving a customer's own history by vector similarity is a legitimate implementation of it.
- Unsupervised scoring genuinely addresses label latency. This is the strongest part of the pitch.
- Per-alert stored evidence maps onto analyst review and model governance (SR 11-7 style documentation, adverse-action explainability).
- Single-collection multitenancy with a tenant filter is how a bank would hold per-customer partitions, and `is_tenant` plus `payload_m` are real answers at scale.

**Demo-shaped, and a fraud team will spot it**
- 31 hand-weighted features tuned against a synthetic world. Production runs hundreds of features through gradient-boosted trees plus a rules engine plus consortium signals. A kNN outlier ratio is one signal among those. Say so first, before someone else does.
- Throughput: 5-6 events/sec here versus thousands of authorizations/sec at a real issuer. Per-query latency was measured; sustained write throughput under load was not.
- Volume: 80M cardholders × 15 months is billions of points. The realistic deployment is a rolling window with TTL, tiered multitenancy, and custom sharding past 10k tenants. The bench shows the shape of the curve and the mechanism, not production volume.
- Class imbalance (B1) — the most likely place the document loses the room.
- No feedback loop: no chargeback labels, no analyst dispositions. Real deployments retune on both.
- The synchronous upsert on the decision path (B2).

**Framing:** a fraud-triage signal for the unlabelled tail, feeding an analyst queue, with reproducible per-alert evidence. Not "we replace your fraud engine." The narrow claim is defensible; the broad one is not.

---

## 6. Order of work

1. **B1, B2, B5** — arithmetic and definitions. No infrastructure. They decide what the one-pager may claim.
2. **A0** — the `hnsw_config` fix, then the eval re-verification. Do this before the bench harness, so every measured cell already runs the config being advocated and no cell needs re-running later.
3. **A1**, then **A2** against the two cheap cells (200 and 2,000 tenants) locally, to prove the harness end to end and calibrate load time.
4. Run the five-cell sweep locally, then delete the storage volume.
5. **B3**, **B4**.
6. **C** from the JSONL plus the A0 eval output. Both gates. Print to PDF.

**Stop conditions.** If A's numbers are unimpressive, the whitepaper still ships with the honest curve and the sharding recommendation. If B1's projected precision is embarrassing, the pitch becomes the triage-queue framing, which is where it belonged anyway.

---

## 7. Decisions needed from Dylan

1. ~~**Cluster.**~~ **Resolved: local Docker.** See A4. Removes the provisioning step, the leave-it-billing risk, and the cross-region RTT in the numbers.
2. **The 55M cell.** Still out of scope by default. Locally it is bounded by 24 GB of RAM and load time rather than by spend, which makes it less attractive, not more. Include it only on an explicit ask.
3. **Live collection config.** The A0 fix only reaches collections created after it lands, so the live cloud `fraud_demo` keeps its default global graph. Bringing it in line needs `PATCH /collections/fraud_demo` with the new `hnsw_config` — no re-seed, vectors untouched, but it triggers a re-index, so it wants a window when the booth demo is not running. Deliberately off the critical path; neither asset depends on it. Worth doing after the bank meeting so the demo matches its own architecture diagram.
4. **`evals/results/` is a new directory.** Check whether `.gitignore` should cover it or whether the JSONL is committed as the one-pager's provenance. Committing it is the more defensible choice for a document a bank will scrutinise. Add the Docker storage volume (`.qdrant-bench/`) to `.gitignore` either way.

---

## 8. Standing rules for this repo (violating these has already cost a day)

- Any script overriding `QDRANT_COLLECTION` sets it in the process environment **before** the process starts, and asserts the resolved `COLLECTION` is a throwaway name before any destructive call. `evals/janitor.ts` shows the pattern.
- Never run two `npm run evals` concurrently — they share throwaway collection names and determinism breaks.
- Commits are approved as a standing practice for this project. **Pushes always need an explicit ask.**
- The memory file for this project quotes stale holdout numbers (0.950 / 0.833). `evals/TUNING.md` is authoritative; the current values are 0.817 / 0.864.
