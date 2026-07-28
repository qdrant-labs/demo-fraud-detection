// The wall's event bus: a Server-Sent Events stream that generates and scores
// the live payment flow, and relays browser-launched attacks scored on other
// instances. Qdrant is the only shared state; nothing here is persisted in
// process memory beyond one connection's dedupe bookkeeping.
//
// Determinism is the whole trick: the events for a bucket are a pure function
// of (world seed, bucket index), with deterministic IDs, so a reconnect (or a
// second instance) regenerates byte-identical events. Overlapping connections
// therefore emit the same IDs, and the client's Set-dedupe collapses them with
// no drift.

import type { Contrast } from "@/lib/explain";
import { withFetchTiming } from "@/lib/fetch-timing";
import { scoreEvent, type StageTimings } from "@/lib/score";
import { COLLECTION, deleteStaleScored, ensureCollection, qdrant, vectorOf } from "@/lib/qdrant";
import {
  BUCKET_MS,
  EPOCH,
  liveEvents,
  makeProfile,
  WORLD_SEED,
  type Transaction,
} from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel ends the function around here and the wall reconnects on its own.
// Vercel clamps this to the plan's ceiling; local dev ignores it and the stream
// runs until the browser disconnects.
export const maxDuration = 300;

// Poll every 500 ms so a browser-launched attack is picked up and flared well
// inside the < 1 s budget; the bucket work is guarded by `due > lastBucket`, so
// the only added cost over a slower cadence is one cheap attack scroll per tick.
// The busy guard makes a slow tick skip the next poll rather than overlap.
const POLL_MS = 500;
const STATS_EVERY_TICKS = 10; // ~5s at POLL_MS = 500ms
const ATTACK_WINDOW_MS = 15_000; // browser-attack scroll look-back
const JANITOR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // drop scored events older than this
const JANITOR_EVERY_MS = 60 * 60 * 1000; // at most one sweep an hour per instance
// Per instance, not global: instances recycle, so a fresh one sweeps on its first
// connection. That is the point - the sweep still happens often enough to bound
// growth, just not once per viewer.
let lastSweep = 0;

function currentBucket(): number {
  return Math.floor((Date.now() - EPOCH) / BUCKET_MS);
}

// The wire shape shared by generated and picked-up events. Generated events
// carry stage timings; picked-up attacks are replayed from payload, not
// rescored, so their timings are null.
//
// Every event carries its own lat/lon and the customer's home city so the map
// wall can ping it in the right place and draw the geo-hop arc. The heavy vector-
// space fields (vector, neighbor_ids, d_event, d_local) ride along ONLY on
// alerted events, which feed the "How Qdrant Sees It" panel; normal events stay
// lean.
interface WallEvent {
  id: string | number;
  tenant_id: string;
  ts: string;
  amount: number;
  currency: string;
  merchant: string;
  merchant_cat: string;
  city: string;
  lat: number;
  lon: number;
  home_city: string;
  home_lat: number;
  home_lon: number;
  channel: string;
  card_present: boolean;
  score: number;
  alerted: boolean;
  explanation: string;
  channel_src: string;
  bucket: number | null; // processing bucket for generator events; null for pickups
  timings: StageTimings | null;
  // Alerted events only; omitted on normal events to keep the wire lean.
  vector?: number[];
  neighbor_ids?: (string | number)[];
  d_event?: number;
  d_local?: number;
  contrasts?: Contrast[];
}

// The customer's home city, derived the same way the scorer's profile lookup is
// (makeProfile on the tenant index). Production scores the shipped world, so
// WORLD_SEED is correct here; the FRAUD_WORLD_SEED override only exists for the
// eval harness, which never runs this route.
function homeOf(tenantId: string): {
  home_city: string;
  home_lat: number;
  home_lon: number;
} {
  const profile = makeProfile(Number(tenantId.slice(1)), WORLD_SEED);
  return {
    home_city: profile.homeCity.name,
    home_lat: profile.homeCity.lat,
    home_lon: profile.homeCity.lon,
  };
}

export async function GET(req: Request): Promise<Response> {
  await ensureCollection();

  // Bound the collection's growth. Fire-and-forget: a slow delete must not delay
  // the first tick, so it is not awaited on the hot path. Throttled because the
  // filtered delete costs the cluster about 1.1 s on this collection, and every
  // viewer opening the wall (and every reconnect, a few times an hour each) was
  // paying for it while the first buckets scored.
  if (Date.now() - lastSweep > JANITOR_EVERY_MS) {
    lastSweep = Date.now();
    deleteStaleScored(JANITOR_MAX_AGE_MS).catch((err) =>
      console.error("janitor delete failed", err),
    );
  }

  const encoder = new TextEncoder();
  const emittedIds = new Set<string | number>(); // this connection's dedupe

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // Start one bucket back so the first tick emits the just-completed bucket.
      let lastBucket = currentBucket() - 2;
      let ticks = 0;
      let busy = false;

      function send(event: string, data: unknown): void {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true; // controller already closed by teardown
        }
      }

      function heartbeat(): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }

      function emit(ev: WallEvent): void {
        if (emittedIds.has(ev.id)) return;
        emittedIds.add(ev.id);
        send("tx", ev);
      }

      // Score one bucket's events, ONE AT A TIME. A single tenant's events run
      // strictly in ts order, because a burst's event N must be upserted before
      // N+1 is scored or the recent-history features never see the burst forming.
      //
      // Tenants used to run in parallel, and that is what the wall's own latency
      // counter was reporting: with a bucket's ~10 events in flight together,
      // every event's stage window also covered the time this single-threaded
      // runtime spent on its peers. Measured against the 11M cloud collection,
      // decision latency climbed with an event's position in the bucket - 71.6 ms
      // for the first, 128.4 ms for the ninth, about 7 ms per event queued ahead -
      // while Qdrant reported 1.9 ms for the same two round trips. Sequential
      // costs nothing here: a bucket is 8-12 events per 2 s, so the whole bucket
      // finishes in well under its own window, and each event's reported latency
      // is its own.
      async function processBucket(bucket: number): Promise<void> {
        const byTenant = new Map<string, Transaction[]>();
        for (const ev of liveEvents(bucket)) {
          const list = byTenant.get(ev.tenant_id) ?? [];
          list.push(ev);
          byTenant.set(ev.tenant_id, list);
        }

        for (const txs of byTenant.values()) {
          txs.sort((a, b) => a.ts.localeCompare(b.ts));
          for (const tx of txs) {
            const timings: Partial<StageTimings> = {};
            // Persist only injected fraud sequences (their bursts must build up
            // as they score); ambient background traffic is shown but not stored,
            // so its "now" timestamp never crowds the baseline out of later
            // events' recent-history. Alerts still persist (see scoreEvent).
            // withFetchTiming attributes the deployed per-decision cost: each
            // stage's wall splits at the fetch boundary into *_fetch fields on
            // the wire (see fetch-timing.ts), scoped so viewers don't mix.
            const s = await withFetchTiming(() =>
              scoreEvent(tx, timings, { persist: tx.motif !== "none" }),
            );
            emit({
              id: tx.id,
              tenant_id: tx.tenant_id,
              ts: tx.ts,
              amount: tx.amount,
              currency: tx.currency,
              merchant: tx.merchant,
              merchant_cat: tx.merchant_cat,
              city: tx.city,
              lat: tx.lat,
              lon: tx.lon,
              ...homeOf(tx.tenant_id),
              channel: tx.channel,
              card_present: tx.card_present,
              score: s.score,
              alerted: s.alerted,
              explanation: s.explanation,
              channel_src: tx.channel_src,
              bucket,
              timings: timings as StageTimings,
              // Heavy fields on alerts only, for the vector-space panel.
              ...(s.alerted
                ? {
                    vector: s.vector,
                    neighbor_ids: s.neighbors.map((n) => n.id),
                    d_event: s.d_event,
                    d_local: s.d_local,
                    contrasts: s.contrasts,
                  }
                : {}),
            });
          }
        }
      }

      // Pick up browser-launched attacks scored on another instance. They land
      // in Qdrant with score/alerted/explanation already on the payload, so they
      // are replayed as-is, never rescored.
      async function pickupAttacks(): Promise<void> {
        const since = new Date(Date.now() - ATTACK_WINDOW_MS).toISOString();
        const res = await qdrant.scroll(COLLECTION, {
          filter: {
            must: [
              { key: "channel_src", match: { value: "browser_attack" } },
              { key: "ts", range: { gte: since } },
            ],
          },
          limit: 50,
          with_payload: true,
          // Vectors are needed so an alerted attack picked up here can feed the
          // vector-space panel; neighbor_ids/d_event/d_local are already on the
          // payload from scoring time.
          with_vector: true,
        });
        for (const p of res.points) {
          if (emittedIds.has(p.id)) continue;
          const pl = (p.payload ?? {}) as Record<string, unknown>;
          const tenant_id = String(pl.tenant_id);
          const alerted = Boolean(pl.alerted);
          emit({
            id: p.id,
            tenant_id,
            ts: String(pl.ts),
            amount: Number(pl.amount),
            currency: String(pl.currency),
            merchant: String(pl.merchant),
            merchant_cat: String(pl.merchant_cat),
            city: String(pl.city),
            lat: Number(pl.lat),
            lon: Number(pl.lon),
            ...homeOf(tenant_id),
            channel: String(pl.channel),
            card_present: Boolean(pl.card_present),
            score: Number(pl.score ?? 0),
            alerted,
            explanation: String(pl.explanation ?? ""),
            channel_src: "browser_attack",
            bucket: null,
            timings: null,
            ...(alerted
              ? {
                  vector: vectorOf(p.vector),
                  neighbor_ids: Array.isArray(pl.neighbor_ids)
                    ? (pl.neighbor_ids as (string | number)[])
                    : [],
                  d_event: Number(pl.d_event ?? 0),
                  d_local: Number(pl.d_local ?? 0),
                  contrasts: Array.isArray(pl.contrasts) ? (pl.contrasts as Contrast[]) : [],
                }
              : {}),
          });
        }
      }

      async function tick(): Promise<void> {
        if (busy || closed) return;
        busy = true;
        try {
          // Process only the latest completed bucket; if a slow tick fell
          // behind, skip the gap rather than backlog. The client dedupes and a
          // reconnect regenerates identical events, so nothing is lost.
          const due = currentBucket() - 1;
          if (due > lastBucket) {
            lastBucket = due;
            await processBucket(due);
          }
          await pickupAttacks();
          ticks++;
          if (ticks % STATS_EVERY_TICKS === 0) {
            // Approximate: an exact count scans every point, which the cluster
            // reports averaging 740 ms on this 11M-point collection, once every
            // five seconds per viewer. The estimate comes off segment metadata
            // and the counter reads the same on a wall.
            const { count } = await qdrant.count(COLLECTION, { exact: false });
            send("stats", { points: count });
          }
          heartbeat();
        } catch (err) {
          console.error("stream tick error", err);
        } finally {
          busy = false;
        }
      }

      const interval = setInterval(tick, POLL_MS);
      void tick(); // emit immediately, don't wait a full poll

      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable proxy buffering
    },
  });
}
