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
- **Scored events are alert evidence, not established history — the scorer excludes them (the crowding fix, shipped 2026-07-28).** Before the fix, persisted motif injections crowded a persona's newest-30 context window and its kNN pool until fresh attacks stopped alerting (booth incident: attacks on `t0011` at 1.18-1.27 crowded vs 5.49 after clearing). Two filter changes in `score.ts` close both channels: the context scroll admits a scored point only inside its burst window (`CONTEXT_SCORED_WINDOW_MS`, 20 min; baselines always qualify via `is_empty(score)` in `should`), and the kNN prefetch takes baseline points only (`is_empty(score)` in `must`). The scroll clause alone does NOT fix it — day-old fraud is past `NEIGHBOR_EXCLUDE_MS` and the recency term returns it as the next attack's neighbor cluster. `evals/crowding.ts` replays the incident and gates regressions; TUNING.md records the round (motif tables byte-identical, cold-start semantics deliberately changed: a tenant with no seeded baseline stays `learning` until `scripts/seed.ts` gives it one).
  - The clearing delete (`must_not is_empty(score)`, count lands on exactly **10,971,318**) is no longer needed for alerting — accumulated debris is invisible to the scorer — but remains the way to reclaim space beyond the janitor's 24 h sweep.
- `evals/TUNING.md` is authoritative for detection numbers, and it was measured against the cloud cluster. The same eval on local Docker reads **motif-detection 0.833/0.754** where TUNING records 0.800/0.843 — verified same-code on both trees 2026-07-28, so it is the backing store, not a regression. Compare like vantages before reading a regression into a number. Anything recorded there before 2026-07-27 is **not reproducible from the committed code**: the generated stream itself differs, so those runs came from a world that was never committed. Re-measure rather than quote old notes.

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

- Read-only is **enforced** by `scripts/read-only-fetch.ts`, which replaces global fetch and lets only `/points/scroll` and `/points/query` out of the process. `persist: false` is not enough on its own (an alerted event upserts anyway), and `ensureCollection()` is never called because it issues five index writes. `npx tsx scripts/read-only-fetch.test.ts` proves it against a stub server; run it if you touch either file, or `score.ts`.
- It reports two numbers per stage. `srv` is Qdrant's own `time` field, so it has no network in it and is the number to publish. `wall` is what the measuring machine saw, including its round trip to us-west-2 — from a laptop that is ~80 ms per trip and dominates everything, so never quote it.
- A sample that alerts dies at its blocked upsert and is counted as `alerted_blocked`. One in 1,000 does, matching the local cell's alert rate.

### The wall reports ~100 ms per decision and the cause is the cloud REST edge

**Attributed 2026-07-28. Do not re-investigate the client side.** Response HEADERS reach the function in ~6 ms; the BODY arrives ~44 ms later, per call, on warm keep-alive connections. Two calls per decision is the ~100 ms. Ruled out by deployed experiment: the official JS client, HTTP/1.1 vs h2, response size, Next's patched global fetch, the event loop (a 1 ms timer fires in 1.15 ms), distance (~4 ms round trip), viewer contamination. Local Docker reads bodies in under 1 ms. Commits `b95242d`, `b4ab7d5`, `fc123e5`, `dc82400` are those experiments; their code was reverted because none of it changed a number.

**The cloud team owns it** (answered 2026-07-28): shared Traefik 3.6.5 behind an NLB, REST via ForwardAuth to `:6333`, gRPC a separate `h2c` route, no response shaper in config. Their hypothesis is Linux TCP delayed ACK (~40 ms) rather than Traefik's 100 ms `flushInterval`, expected fleet-wide on Traefik-fronted clusters in the region. Their next steps: packet capture, a `flushInterval: -1` canary, a gRPC A/B. Nothing to do here unless they report that gRPC dodges it — that is when the shelved gRPC port gets reconsidered (`@qdrant/js-client-grpc`, protobuf-es v2 shapes: `create()` inits, `conditionOneOf` cases, `Formula`/`expDecay`, `DatetimeRange` takes `Timestamp`s not ISO strings; ~1-2 h with evals; expected wall number ~15 ms).

**The scaffolding is gone** (2026-07-28): `restCall` and its h2 dispatcher, `fetch-timing.ts`, the `*_fetch`/`*_body` wire fields, the `timer_ms` probe, the `undici` dependency. The scoring path is back on `@qdrant/js-client-rest`, which is what a reference demo should show. Verified result-neutral: seven evals pass, determinism to 1e-9, motif-detection identical before and after.

**What the investigation left that is worth keeping:** the context scroll uses a payload `include` list (6 fields) and the kNN another (4), cutting bodies ~3x. **A new payload field the scorer reads MUST be added to the include list in `score.ts` or it comes back undefined, silently.** The trap most likely to eat a day.

**Quote the engine number, not the wall's counter.** 1.86 ms decision p50 is what Qdrant costs (`evals/results/cloud-latency.jsonl`); ~100 ms is the demo's serverless wrapper plus the REST edge stall.

## The 2026-07-31 outage: a cluster restart the app never recovered from

**Attributed 2026-08-03. The cluster was not the problem for most of the hour.** Qdrant restarted at **15:41:34 UTC** (`/telemetry` `app.startup`, raft term 38). The wall then read "Reconnecting" until a redeploy at **16:41:03 UTC** — the same commit, from the CLI, with no env change (`QDRANT_URL`/`QDRANT_API_KEY` untouched for 23 days). A redeploy of identical code fixing it is the tell: the broken state was in the serverless instance, not in the code or the cluster.

`ensureCollection()` memoized its own failure. `??=` does not replace a non-nullish value and a rejected promise is not nullish, so the one call that failed against the restarting cluster stuck to the warm instance forever. The SSE route awaits it on its first line, so every EventSource reconnect replayed the original error and only replacing the instances cleared it. Fixed: the memo now caches success only. `scripts/ensure-collection.test.ts` reproduces the outage against a stub server that is unavailable once, then healthy, and fails if the failure is cached again. No cluster or credentials needed.

The lesson generalizes past this one function: **any module-scope memo in a serverless instance turns a transient backend blip into downtime that outlives it.** A cache of a failure needs an eviction path or it is a permanent outage with extra steps.

### `fraud_demo` shares a cluster with twelve other collections

The OOM notification is a cluster fact, not a demo fact, and nothing here can attribute it. Estimated resident RAM at 2026-08-03, from each collection's vector config (every collection on this cluster has `hnsw_config.on_disk: false`, so all their graphs are resident):

| Collection | Points | Resident vectors | + graph | ≈ Total |
|---|---|---|---|---|
| `startups_3m` | 3.0M | 384-d float32, no quantization | 0.4 GB | **5.0 GB** |
| `products` | 5.8M | 384-d int8 `always_ram`, both vectors `on_disk` | 1.5 GB (2 graphs) | **3.7 GB** |
| `startups_hybrid` | 0.7M | 1024-d float32, no quantization | 0.1 GB | **3.1 GB** |
| `fraud_demo` | 11.0M | 31-d float32 | 1.4 GB | **2.8 GB** |
| others (9) | ~4.9M | mostly `on_disk` | — | ~1.0 GB |

So `fraud_demo` is roughly **18% of ~15.5 GB** — fourth largest, despite having the most points, because 31 dimensions is cheap. Ten million points is not what fills this cluster; 384- and 1024-dimensional collections held in RAM unquantized are.

**This reverses the 2026-07-28 finding, and that is the lead.** That round scaled the cluster 16 GB -> 32 GB and recorded `fraud_demo` as *the only* collection on it keeping vectors in RAM with `hnsw_config.on_disk: false` and no quantization, across **8** collections. There are now **13**, and three are RAM-resident unquantized. `startups_3m` (~5.0 GB) and `startups_hybrid` (~3.1 GB) therefore cannot have been among the eight, so roughly **8 GB of new resident RAM landed on this cluster between 2026-07-28 and 2026-08-03** — and the OOM sits inside that window, on 07-31. Loading a 3M-point 384-d collection also spikes well past its resting size while the optimizer builds the graph and holds a second copy of the merging segment, which is the exact mechanism that killed the node on 07-28. Check that before touching the demo; `fraud_demo` has not changed since the 07-27 merge.

The data-plane API reports the k8s **node's** RAM (`system.ram_size`, 62 GB), never the pod limit, so the cluster's real ceiling only comes from the Qdrant Cloud console. `collection_hardware_metric_cpu` in `/metrics` resets on restart and is the fastest way to see who is actually working the cluster: since the 07-31 restart `products` has burned **47x** `fraud_demo`'s CPU. That metric also listed `hybrid_probe` and `ci_probe_0`-`ci_probe_7`, none of which exist in `/collections` — CI creates and drops collections on this shared cluster, and collection builds are the classic memory spike.

**Do not re-investigate the ~100 ms wall counter after an outage.** Measured 2026-08-03 from the deployed function: `scroll` p50 49.8 ms, `knn` p50 50.1 ms, `total` p50 **100.3 ms** over 240 events, unchanged from the 07-28 attribution above. The first event on a cold instance reads ~1,270 ms (connection setup, not the engine); sample past it before reading a regression into one number.

### The public URL is the `eta` alias

`demo-fraud-detection-eta.vercel.app` serves 200. The `demo-fraud-detection-qdrant.vercel.app` alias sits behind Vercel SSO and 302s to `vercel.com/sso-api`, so it is useless for checking whether the demo is up — an SSO redirect is not an outage.
