// The scoring path: one function the SSE route and the attack launcher both
// call. Exactly three Qdrant round trips per event — context scroll, kNN
// formula query, upsert — so cross-region RTT stays inside the flare budget.
//
// The score is a stateless, self-normalizing kNN ratio (LOF-style): d_event /
// d_local, computed from the neighbor VECTORS the kNN query returns, not from
// the recency-adjusted formula scores. The formula only reorders which
// neighbors come back (recent behavior counts more); the arithmetic that
// produces the number is recomputed client-side so the evidence panel can show
// it exactly.

import { encode, recentHistory, type PriorTx, type RecentHistory } from "./features";
import { explainAlert, type Contrast } from "./explain";
import { lastBodyMs, lastFetchMs } from "./fetch-timing";
import {
  CONTEXT_LIMIT,
  FEATURE_VECTOR,
  pointFor,
  restCall,
  type RestPoint,
} from "./qdrant";
import { makeProfile, WORLD_SEED, type Transaction } from "./world";

// The world seed the scorer's per-event profile lookup uses. Production leaves
// it unset and scores the shipped world; the motif-detection eval sets
// FRAUD_WORLD_SEED so a held-out world's profiles (home currency, merchant set)
// match the baseline that world seeded. Read once at import, like COLLECTION.
const ACTIVE_WORLD_SEED = process.env.FRAUD_WORLD_SEED ?? WORLD_SEED;

// The pure LOF-style arithmetic, factored out so the scorer and the evidence
// panel share ONE implementation. The panel re-runs this on the pinned neighbor
// vectors and must land on the identical score (the Phase 4 gate); any drift
// would mean two copies of the math.
export interface ScoreMath {
  d_event: number; // mean event-to-neighbor distance
  d_local: number; // mean neighbor-to-centroid distance (clamped)
  score: number; // d_event / d_local
  distances: number[]; // event-to-each-neighbor, in neighbor order
  centroid: number[]; // neighbor centroid, needed by the explanation
}

export function scoreFromVectors(
  eventVector: number[],
  neighborVectors: number[][],
): ScoreMath {
  const distances = neighborVectors.map((v) => euclid(eventVector, v));
  const d_event =
    distances.length > 0
      ? distances.reduce((s, d) => s + d, 0) / distances.length
      : 0;

  const dim = eventVector.length;
  const centroid = new Array(dim).fill(0);
  for (const v of neighborVectors) for (let i = 0; i < dim; i++) centroid[i] += v[i];
  if (neighborVectors.length) for (let i = 0; i < dim; i++) centroid[i] /= neighborVectors.length;

  const dLocalRaw =
    neighborVectors.length > 0
      ? neighborVectors.reduce((s, v) => s + euclid(v, centroid), 0) / neighborVectors.length
      : 0;
  const d_local = Math.max(dLocalRaw, D_LOCAL_EPSILON);
  const score = d_local > 0 ? d_event / d_local : 0;

  return { d_event, d_local, score, distances, centroid };
}

// Alert when the ratio exceeds this. Tuned via the motif-detection eval's
// threshold sweep; evals/TUNING.md is the authoritative record of the measured
// recall/precision at this value. A named constant so the eval and the wall
// share one source of truth.
export const ALERT_THRESHOLD = 2.0;

const NEIGHBOR_K = 10;
// Prefetch enough candidates that recency reordering has room to work without
// silently dropping neighbors. Tenants with fewer points return fewer; that is
// handled (cold start covers alerting).
const PREFETCH_LIMIT = 100;

// The anomaly score compares an event against the tenant's ESTABLISHED
// baseline, not against the last hour of its own activity. Neighbors must be
// older than the event by this margin, or a fraud burst becomes its own nearest-
// neighbor cluster and masks itself: streaming-LOF self-masking. scoreEvent
// upserts each event before the next in a burst scores (the recent-history
// features and the wall's attack pickup both read those fresh upserts, so
// immediate searchability stays load-bearing), which means without this bound a
// later burst event's k nearest neighbors are the earlier burst events, their
// vectors nearly identical, and d_event collapses. Excluding the recent hour
// keeps the kNN pointed at the baseline while the upsert stays immediately
// searchable for everything else. Datetime range filters on `ts` are verified
// working (evals/api-contract.ts testScroll).
// Exported so the tenant-isolation eval mirrors this exclusion byte-for-byte
// instead of running a differently-shaped kNN.
export const NEIGHBOR_EXCLUDE_MS = 3_600_000; // 1 hour

// How long a persisted scored event stays visible to the context scroll. The
// scroll needs scored points only while their burst is still forming (event N
// feeds N+1's recent-history features); after that they are fraud debris that
// crowds the tenant's newest-30 window and blinds the scorer (the 2026-07-28
// booth incident; evals/crowding.ts). Baselines carry no `score` field and
// always qualify. Longest motif spans ~12 min, so 20 min covers a full burst.
export const CONTEXT_SCORED_WINDOW_MS = 20 * 60_000;

// Floor for d_local when a tenant's neighbors are near-identical (d_local -> 0
// would blow the ratio up). Below this the local spread is meaningless, so we
// clamp rather than divide by ~0.
// shortcut: a fixed epsilon; revisit if a tenant legitimately has near-zero
// spread and still needs a calibrated score.
const D_LOCAL_EPSILON = 1e-3;

export interface Neighbor {
  id: string | number;
  distance: number; // Euclidean distance from the event to this neighbor
  ts: string;
  merchant: string;
  amount: number;
  city: string;
}

export interface ScoredEvent {
  tx: Transaction;
  score: number;
  alerted: boolean;
  learning: boolean; // inside the tenant's 30-event cold-start window
  d_event: number;
  d_local: number;
  neighbors: Neighbor[];
  recent: RecentHistory;
  explanation: string;
  // "This charge vs this customer's normal", up to three rows for the alert card.
  contrasts: Contrast[];
  // The 31-d event vector, already computed above. Carried out so the wall can
  // ship it to the "How Qdrant Sees It" panel without a second encode. Additive:
  // the score is unchanged.
  vector: number[];
}

// Optional per-stage wall-clock timing (ms), filled in when a caller passes an
// object. Used by the latency eval and the wall's p95 ticker. The *_fetch
// fields are each stage's inner fetch round trip (headers received), present
// only when the stream route has installed fetch-timing.ts; the gap between a
// stage and its fetch is the client's body read + parse + validation.
export interface StageTimings {
  scroll: number;
  knn: number;
  upsert: number;
  total: number;
  scroll_fetch?: number;
  knn_fetch?: number;
  upsert_fetch?: number;
  // Body read + JSON parse per stage, the slice after headers arrive.
  scroll_body?: number;
  knn_body?: number;
}

function euclid(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// A query/scroll point's vector arrives as { features: [...] } for a named
// vector. Pull the array out regardless of shape.
function vectorOf(point: { vector?: unknown }): number[] {
  const v = point.vector;
  if (Array.isArray(v)) return v as number[];
  if (v && typeof v === "object") {
    const named = (v as Record<string, unknown>)[FEATURE_VECTOR];
    if (Array.isArray(named)) return named as number[];
  }
  throw new Error("point returned without its vector");
}

function priorFromPayload(payload: Record<string, unknown> | null | undefined): PriorTx {
  const p = payload ?? {};
  return {
    ts: String(p.ts),
    amount: Number(p.amount),
    merchant: String(p.merchant),
    lat: Number(p.lat),
    lon: Number(p.lon),
    city: String(p.city),
  };
}

export async function scoreEvent(
  tx: Transaction,
  timings?: Partial<StageTimings>,
  opts?: { persist?: boolean },
): Promise<ScoredEvent> {
  const tenantIndex = Number(tx.tenant_id.slice(1));
  const profile = makeProfile(tenantIndex, ACTIVE_WORLD_SEED);
  const t0 = performance.now();

  // (1) CONTEXT SCROLL: the tenant's most recent CONTEXT_LIMIT points, newest
  // first. Feeds recent-history features and the cold-start check.
  const context = await restCall<{ points: RestPoint[] }>("POST", "/points/scroll", {
    filter: {
      must: [
        { key: "tenant_id", match: { value: tx.tenant_id } },
        // Only points strictly before this event feed the 30 newest-first slots.
        // Injected motifs (and browser attacks) carry timestamps up to ~12 min
        // ahead of the event being scored; without this bound those future
        // points would take the newest slots and inflate the learning count.
        // recentHistory() also drops ts >= now as defense in depth.
        { key: "ts", range: { lt: tx.ts } },
      ],
      // must AND (baseline OR inside the burst window): scored points enter the
      // context only while their burst is forming; baselines always qualify.
      // This is the scroll's counterpart to the kNN's NEIGHBOR_EXCLUDE_MS —
      // without it, persisted fraud crowds the newest-30 window (see
      // CONTEXT_SCORED_WINDOW_MS above).
      should: [
        { is_empty: { key: "score" } },
        {
          key: "ts",
          range: {
            gte: new Date(Date.parse(tx.ts) - CONTEXT_SCORED_WINDOW_MS).toISOString(),
          },
        },
      ],
    },
    order_by: { key: "ts", direction: "desc" },
    limit: CONTEXT_LIMIT,
    // Only the fields recentHistory reads; the full payload is ~3x the bytes.
    with_payload: { include: ["ts", "amount", "merchant", "lat", "lon", "city"] },
    with_vector: false,
  });
  const t1 = performance.now();
  const scrollFetch = lastFetchMs();
  const scrollBody = lastBodyMs();
  const priors = context.points.map((p) => priorFromPayload(p.payload as Record<string, unknown>));
  // Cold-start rule: the first CONTEXT_LIMIT points per tenant are scored but
  // never alerted. OR'd below with the zero-eligible-neighbor case once the kNN
  // has run.
  let learning = context.points.length < CONTEXT_LIMIT;

  const recent = recentHistory(tx, priors);
  const isNewMerchant = !profile.merchants.some((m) => m.name === tx.merchant);
  const eventVector = encode(tx, recent, {
    homeCurrency: profile.homeCity.currency,
    isNewMerchant,
  });

  // (2) kNN: nearest neighbors within the tenant, reordered by recency. The
  // Euclid prefetch $score is a raw distance, so negate it before mixing with
  // exp_decay (formula sorts descending; verified against the cluster).
  // The ts upper bound restricts neighbors to the tenant's established baseline
  // (older than NEIGHBOR_EXCLUDE_MS), so a burst cannot become its own neighbor
  // cluster; see the constant's comment.
  const neighborCutoff = new Date(Date.parse(tx.ts) - NEIGHBOR_EXCLUDE_MS).toISOString();
  const knn = await restCall<{ points: RestPoint[] }>("POST", "/points/query", {
    prefetch: {
      query: eventVector,
      using: FEATURE_VECTOR,
      filter: {
        must: [
          { key: "tenant_id", match: { value: tx.tenant_id } },
          { key: "ts", range: { lt: neighborCutoff } },
          // Neighbors come from the tenant's baseline only. Scored events are
          // alert evidence, not established history: a day-old fraud burst is
          // past NEIGHBOR_EXCLUDE_MS and sits exactly where the next attack
          // lands, so with the recency boost it becomes the attack's nearest-
          // neighbor cluster and masks it (evals/crowding.ts reproduces this;
          // the 2026-07-28 booth incident measured it live).
          { is_empty: { key: "score" } },
        ],
      },
      limit: PREFETCH_LIMIT,
    },
    query: {
      formula: {
        sum: [
          { mult: [-1.0, "$score"] },
          {
            mult: [
              0.15,
              {
                exp_decay: {
                  x: { datetime_key: "ts" },
                  target: { datetime: tx.ts },
                  scale: 2592000, // 30 days, in seconds
                  midpoint: 0.5,
                },
              },
            ],
          },
        ],
      },
    },
    with_vector: true,
    // Only the fields the neighbor cards show.
    with_payload: { include: ["ts", "merchant", "amount", "city"] },
    limit: NEIGHBOR_K,
  });
  const t2 = performance.now();
  const knnFetch = lastFetchMs();
  const knnBody = lastBodyMs();

  const neighborVectors = knn.points.map(vectorOf);
  const neighborIds = knn.points.map((p) => p.id);

  // Zero-eligible-neighbor guard: NEIGHBOR_EXCLUDE_MS can leave a tenant with no
  // points old enough to score against (a fresh tenant whose whole history is
  // inside the last hour, e.g. cold-start's 35-events-in-an-hour scenario). With
  // no neighbors, d_event is 0 and the ratio would read as a confident "normal";
  // instead the event comes back learning:true, score 0, and unalerted.
  const noEligibleNeighbors = neighborVectors.length === 0;
  learning = learning || noEligibleNeighbors;

  // Self-normalizing ratio from the neighbor vectors (shared with the panel).
  const { d_event, d_local, score, distances, centroid } = scoreFromVectors(
    eventVector,
    neighborVectors,
  );

  const neighbors: Neighbor[] = knn.points.map((p, i) => {
    const pl = (p.payload ?? {}) as Record<string, unknown>;
    return {
      id: p.id,
      distance: distances[i],
      ts: String(pl.ts),
      merchant: String(pl.merchant),
      amount: Number(pl.amount),
      city: String(pl.city),
    };
  });

  const alerted = score > ALERT_THRESHOLD && !learning;

  const explained = noEligibleNeighbors
    ? { explanation: "Not enough established history to score", contrasts: [] as Contrast[] }
    : explainAlert({
        tx,
        eventVector,
        centroid,
        context: priors,
        profile,
      });
  const { explanation, contrasts } = explained;

  // (3) UPSERT the scored event so it is immediately searchable — no refresh
  // cycle. wait:true so a burst's next event sees this one when it scores. The
  // full scoring result (neighbor_ids pinned, d_event, d_local, alerted,
  // explanation) rides along so the wall and the evidence panel can replay this
  // event on any instance without a second kNN.
  //
  // Persist only what belongs in the tenant's history: anything alerted (so its
  // evidence stays retrievable), plus events a caller marks with persist:true —
  // the launched/injected fraud sequences whose bursts must build up as they
  // score. Ambient background traffic is scored and shown but NOT stored: every
  // live event is timestamped "now", so it would take the newest recent-history
  // slots ahead of the pre-seeded (pre-EPOCH) baseline and drift every tenant
  // into marginal alerts. This is a persistence policy, not scoring — the score
  // above never reads it. Default true so evals and the attack route are
  // unchanged; only the wall's background generator opts out.
  const persist = alerted || (opts?.persist ?? true);
  let t3 = t2;
  if (persist) {
    await restCall("PUT", "/points?wait=true", {
      points: [
        pointFor(tx, eventVector, recent, {
          score,
          alerted,
          explanation,
          // Alerts only: replayed by the story card; non-alert payloads stay lean.
          ...(alerted ? { contrasts } : {}),
          neighbor_ids: neighborIds,
          d_event,
          d_local,
        }),
      ],
    });
    t3 = performance.now();
  }

  if (timings) {
    timings.scroll = t1 - t0;
    timings.knn = t2 - t1;
    timings.upsert = t3 - t2;
    timings.total = t3 - t0;
    // Scoped per event via withFetchTiming (stream route), so concurrent
    // viewers on one instance don't contaminate each other's numbers.
    if (scrollFetch !== null) timings.scroll_fetch = scrollFetch;
    if (knnFetch !== null) timings.knn_fetch = knnFetch;
    if (scrollBody !== null) timings.scroll_body = scrollBody;
    if (knnBody !== null) timings.knn_body = knnBody;
    if (persist) {
      const upsertFetch = lastFetchMs();
      if (upsertFetch !== null) timings.upsert_fetch = upsertFetch;
    }
  }

  return {
    tx,
    score,
    alerted,
    learning,
    d_event,
    d_local,
    neighbors,
    recent,
    explanation,
    contrasts,
    vector: eventVector,
  };
}
