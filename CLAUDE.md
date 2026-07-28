# Working notes for this repo

The README explains what the demo is. This file is the things that are not visible from the code, and the rules that have already cost a day when broken.

## Hard rules

- **Any script that overrides `QDRANT_COLLECTION` sets it in the process environment BEFORE the process starts, or imports `qdrant.ts` dynamically after assigning it.** `src/lib/qdrant.ts` captures `COLLECTION` at import time, so a static import hoists above an in-file assignment. That exact mistake wiped the live collection once. `evals/janitor.ts` shows the dynamic-import pattern; `scripts/bench-scale.ts` shows the environment-first pattern plus a name assert.
- **Never run two eval processes at once.** They share throwaway collection names and determinism breaks.
- **Commits are fine to make as you go. Pushes always need an explicit ask.**

## Scoring facts that surprise people

- `persist: false` still upserts an **alerted** event (`src/lib/score.ts`, the `persist = alerted || ...` line). Anything that scores against a collection it must not modify has to account for alerts, not just set the flag.
- Decision latency is **`scroll + knn`**, not `total`. The upsert is post-decision persistence, and no card authorization path waits on a synchronous write. The wall's counter and the benchmark both use the two-stage definition. `knn` includes the local feature encoding between the two round trips, so it is not a pure network stage.
- The encoder weights sin/cos hour-of-day at 1.0 and day-of-week at 0.5, and each cardholder only transacts inside its own active window. Moving a synthetic event's timestamp across hours makes it a genuine anomaly. This is the single easiest way to accidentally manufacture alerts.
- `evals/TUNING.md` is authoritative for detection numbers. Anything recorded there before 2026-07-27 is **not reproducible from the committed code**: the generated stream itself differs, so those runs came from a world that was never committed. Re-measure rather than quote old notes.

## Local benchmark and the 11M demo collection

Everything below runs against Qdrant in Docker on localhost. It never touches the cloud cluster.

- Container `qdrant-bench`, storage bind-mounted at `.qdrant-bench/` (gitignored), `restart unless-stopped`. Start it with `docker start qdrant-bench`.
- **Docker Desktop is set to 16 GB** (was 4 GB; backup at `~/Library/Group Containers/group.com.docker/settings-store.json.bak-prebench`). An 11M-point collection OOM-kills the container at 4 GB and peaks near 7 GB while indexing. Leave the 16 GB setting alone while the big demo collection exists.
- `bench_demo_11m` is the standing 20,000-cardholder, 11M-point collection the wall can demo against:
  ```
  QDRANT_URL=http://localhost:6333 QDRANT_COLLECTION=bench_demo_11m npm run dev
  ```
  The wall generates live traffic only for cardholders 0-199 (`TENANT_COUNT` in `world.ts`) and `makeProfile` is deterministic per index, so those 200 have identical baselines to the cloud collection. The rest is depth behind the `Stored Charges` counter. The janitor spares every baseline because baselines carry no `score` field.

### `scripts/bench-scale.ts`

One cell per invocation. Two guards refuse to run otherwise: `QDRANT_URL` must be localhost, and `QDRANT_COLLECTION` must match `^bench_[a-z0-9_]+$`. Never pass `--env-file=.env`; that file points at the cloud cluster.

```
QDRANT_URL=http://localhost:6333 QDRANT_COLLECTION=bench_t2000_d90 \
  npx tsx scripts/bench-scale.ts --tenants 2000 --days 90 --tx-scale 1
```

Flags: `--tenants --days --tx-scale --samples --warmup --default-hnsw --indexing-threshold --keep`. `--indexing-threshold 1` (KB) forces a graph build on cells that would otherwise settle under the default threshold and run an exact scan; the mechanism-matched 0.11M cells were run with it. `--keep` skips teardown, which is how `bench_demo_11m` was built; a kept collection must be deleted by hand before that name reloads. Results append one JSON row per cell to `evals/results/scale.jsonl`, which is committed as the provenance behind any published number.

`--days` and `--tx-scale` must move together. Stretching the span alone thins per-day density and shifts the recent-history features, which changes the vectors and stops it being a controlled comparison.

### Three traps already hit in this harness

1. **Restoring `indexing_threshold` to a hardcoded value.** Qdrant 1.18's default is 10000 (KB), not 20000. A hardcoded 20000 ran every cell at twice the real threshold and silently suppressed index building at 1.1M. The script now reads the default off the server after creating the collection.
2. **`indexed_vectors_count: 0` is a legitimate settled state**, not a stall. Qdrant only builds a vector graph once a segment passes `indexing_threshold`, and at 31-d float32 a 0.11M-point collection never gets there. Those cells run an exact scan of the filtered points. The row records the count so a reader can tell which mechanism a cell measured.
3. **Repeat fraction is a confound between cells.** A cell with fewer cardholders than samples repeats them, so it measures warm segments; a cell with 1,000+ cardholders measures cold first touches. Only compare cells with the same `repeat_fraction`. The 200-cardholder cells sit at 0.80 and the 2,000- and 20,000-cardholder cells at 0.

## What the sweep found

Read `evals/results/scale.jsonl` for the numbers. The conclusions worth keeping:

- **Cost tracks cardholder count, not point count.** Ten times the points at a fixed 200 cardholders is free (holds with both cells graph-indexed: 8.95/8.65 at 0.11M vs 7.96/8.54/8.40 at 1.09M). Ten times the points via ten times the cardholders costs about 5 ms at the median. Most of the increase lands in the payload-filtered scroll, not the vector search.
- **The multitenant HNSW config (`m: 0, payload_m: 16`) is neither a result change nor a latency win here.** Two eval runs, one per configuration, produced byte-identical confusion tables. Three benchmark runs per configuration at 1.1M interleave, and two per configuration at 11M interleave as well: the only outlier (default, p99 34.52) ran on the storage volume that repeated 11M load/delete cycles had degraded, and its fresh-volume repeat was the fastest of the four runs. The 2026-07-27 draft claim that the config "starts paying at 11M" was that volume artifact. It is still the right config to ship, per the multitenancy docs, but no published number depends on it. Note that `ensureCollection()` only applies it to collections created from that point on; the live cloud `fraud_demo` still has the default global graph and would need a `PATCH` plus a re-index to match. **Decision 2026-07-27: leave `fraud_demo` on the default graph.** The sweep shows no measurable difference at either scale and the PATCH needs a re-index window. Do not apply it without Dylan asking.
- **The cloud collection is not slower than local at 11M.** Measured 2026-07-28 against `fraud_demo` (10.98M points, 20,000 cardholders, default graph, 2 shards, us-west-2): Qdrant's own processing time is **scroll p50 0.75 ms, knn p50 1.12 ms, decision p50 1.86 ms** (p95 2.25, p99 4.67), over 1,000 sequential samples across 1,000 distinct cardholders. Row in `evals/results/cloud-latency.jsonl`. The local 13.5 ms p50 in `scale.jsonl` is client-observed wall-clock over loopback, so it is a different measurement point, not a slower cluster. Quote the engine number plus a same-region round trip (~4 ms, measured off the deployed function), so roughly **6-10 ms per decision on the demo's path**.
- **Per-cardholder history depth changes the alert rate.** At 15 months of history (5,472 points per cardholder) roughly 2.5% of ordinary transactions clear the threshold tuned against 3 months, reproducibly across runs. `ALERT_THRESHOLD` is calibrated to history depth, which matters for any retention-window decision.

## Measuring against the live cloud collection

`scripts/bench-cloud.ts` is the read-only counterpart to `bench-scale.ts`. It never creates, deletes or writes, and refuses a collection that does not already exist. Do not point `bench-scale.ts` at the cloud instead; its localhost and `^bench_` guards are why the live collection is still there.

```
QDRANT_URL=<cloud> QDRANT_API_KEY=<key> QDRANT_COLLECTION=fraud_demo \
  npx tsx scripts/bench-cloud.ts --tenants 20000 --days 90 --tx-scale 1
```

- Read-only is **enforced** by `scripts/read-only-fetch.ts`, which replaces global fetch and lets only `/points/scroll` and `/points/query` out of the process. `persist: false` is not enough on its own (an alerted event upserts anyway), and `ensureCollection()` is never called because it issues five index writes. `npx tsx scripts/read-only-fetch.test.ts` proves it against a stub server; run it if you touch either file.
- It reports two numbers per stage. `srv` is Qdrant's own `time` field, so it has no network in it and is the number to publish. `wall` is what the measuring machine saw, including its round trip to us-west-2 — from a laptop that is ~80 ms per trip and dominates everything, so never quote it.
- A sample that alerts dies at its blocked upsert and is counted as `alerted_blocked`. One in 1,000 does, matching the local cell's alert rate.

### The wall reports ~100 ms per decision and Qdrant is not the reason

Measured on the deployment, before and after the 2026-07-28 fix, 5 minutes of `curl -sN <prod>/api/stream` each (~1,540 samples; the route already reports per-stage times, so this needs no instrumentation):

| | p50 | p95 | p99 | min | by position in bucket |
| --- | --- | --- | --- | --- | --- |
| `Promise.all` | 104.1 | 172.4 | 215.8 | 23.0 | 72 → 128, rising |
| sequential | 100.0 | 119.8 | 130.0 | 53.9 | 61, then flat ~100 |

**Scoring a bucket sequentially fixed the tail, not the median.** It was worth doing: p95 fell 30%, p99 fell 40%, and an event's latency no longer depends on where it sits in its bucket, so the counter now reports each event's own cost. But the rising 72 → 128 curve was mostly overlapping measurement windows under `Promise.all`, not the cause of the cost. Every event was already paying ~100 ms.

**That ~100 ms is a fixed per-event cost inside the Next.js function and it is still unattributed.** Ruled out by measurement, so do not re-litigate these: distance (cluster and function are both us-west-2, `x-vercel-id` shows `pdx1`, and one function-to-cluster round trip measures ~4 ms via the `/api/persona` vs `/api/alert/<unused uuid>` difference), the engine (1.9 ms for both round trips), the scorer's own arithmetic (0.04 ms per event), and the Stored Charges count (events right after a `stats` push were *faster* than elsewhere). A second and third viewer add 30%, because every SSE connection re-scores the same buckets. Attributing the rest needs timing instrumentation inside the function; nothing else will settle it.

Also fixed 2026-07-28 in `src/app/api/stream/route.ts`, both on the cluster's behalf rather than for this latency: the Stored Charges counter uses `exact: false` (an exact count scans all 11M points, which the cluster reports averaging 740 ms, fired every 5 s per viewer), and the janitor sweep is throttled to once an hour per instance instead of once per connection (its filtered delete costs the cluster ~1.1 s).

**Quote the engine number, not this one.** The 100 ms is what this demo's wall costs end to end in a serverless function; 1.86 ms is what Qdrant costs, and a same-region service pays that plus its own round trip.
