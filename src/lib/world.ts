// The deterministic synthetic world for the fraud/anomaly demo.
//
// Everything here is a pure function of a world seed (plus a time bucket for
// live events). No Date.now(), no Math.random(): the same seed always produces
// byte-identical output, so a serverless reconnect regenerates the same stream
// and upserts stay idempotent.

import { createHash } from "node:crypto";
import { CITIES, haversineKm, type City } from "./geo";

// The city list and the great-circle helper live in the client-safe geo module
// (world.ts imports node:crypto and cannot be pulled client-side). Re-exported
// here so existing server imports from "./world" keep working, one source of truth.
export { CITIES, haversineKm, type City } from "./geo";

// --- Seeded PRNG ------------------------------------------------------------

// mulberry32: a small, fast 32-bit PRNG. Good enough for synthetic data.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit string hash, to turn a seed string into a PRNG seed number.
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// A named RNG stream. Pass a descriptive key so independent streams stay
// independent: rng(`${seed}:profile:${i}`) never correlates with rng(`${seed}:bucket:${b}`).
function rng(key: string): () => number {
  return mulberry32(hashStr(key));
}

function gaussian(rand: () => number): number {
  // Box-Muller. rand() can return 0, so floor u1 away from it.
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

// Deterministic UUID (version-5 shaped) from arbitrary parts, via sha1.
// Qdrant point IDs must be an unsigned int or a UUID; this gives a stable UUID
// with no `uuid` dependency.
function uuidFrom(...parts: (string | number)[]): string {
  const h = createHash("sha1").update(parts.join(":")).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// --- Geography --------------------------------------------------------------

function farthestCity(from: City): City {
  let best = CITIES[0];
  let bestD = -1;
  for (const c of CITIES) {
    const d = haversineKm(from.lat, from.lon, c.lat, c.lon);
    if (d > bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// --- Merchants --------------------------------------------------------------

// The fixed 12-category list. features.ts one-hots against this exact order.
export const CATEGORIES: readonly string[] = [
  "grocery",
  "restaurant",
  "fuel",
  "electronics",
  "travel",
  "entertainment",
  "clothing",
  "pharmacy",
  "utilities",
  "transport",
  "digital_goods",
  "home_improvement",
];

interface Merchant {
  name: string;
  cat: string;
}

function titleCase(cat: string): string {
  return cat
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// Deterministic display name for merchant k in a category, e.g. "Grocery A".
function merchantName(cat: string, k: number): string {
  return `${titleCase(cat)} ${"ABCDEF"[k % 6]}`;
}

// --- Tenant profiles --------------------------------------------------------

export interface TenantProfile {
  id: string; // "t0001"
  homeCity: City;
  categories: string[]; // 2-4 of CATEGORIES
  merchants: Merchant[]; // the merchants this tenant frequents
  amountLogMean: number; // natural-log mean of the log-normal amount
  amountLogStd: number;
  activeHourStart: number; // UTC hour, inclusive; may exceed activeHourEnd (wraps midnight)
  activeHourEnd: number; // UTC hour, inclusive
  onlineShare: number; // fraction of transactions that are online
  txCount: number; // number of baseline transactions (300-800)
}

export const WORLD_SEED = "fraud-watch-v1";
export const TENANT_COUNT = 200;

// The demo's time origin. Baselines fill the 90 days before this; live events
// start here and advance with the bucket index.
export const EPOCH = Date.UTC(2026, 6, 11, 12, 0, 0);
export const BUCKET_MS = 2000;
const DAY_MS = 86_400_000;

function tenantId(index: number): string {
  return `t${String(index).padStart(4, "0")}`;
}

export function makeProfile(index: number, seed: string = WORLD_SEED): TenantProfile {
  const r = rng(`${seed}:profile:${index}`);
  const homeCity = pick(r, CITIES);

  // 2-4 distinct categories.
  const shuffled = [...CATEGORIES].sort(() => r() - 0.5);
  const nCats = 2 + Math.floor(r() * 3);
  const categories = shuffled.slice(0, nCats);

  // 1-3 merchants per frequented category.
  const merchants: Merchant[] = [];
  for (const cat of categories) {
    const nMerch = 1 + Math.floor(r() * 3);
    for (let k = 0; k < nMerch; k++) {
      merchants.push({ name: merchantName(cat, k), cat });
    }
  }

  return {
    id: tenantId(index),
    homeCity,
    categories,
    merchants,
    amountLogMean: 2.0 + r() * 2.5, // median ~7 to ~90 in home currency
    amountLogStd: 0.4 + r() * 0.5,
    // Local waking hours mapped to UTC by the home city's longitude, so live
    // traffic follows daylight around the globe: any wall-clock hour has active
    // tenants, and no tenant transacts at an hour missing from its baseline.
    // The UTC window may wrap midnight (start > end).
    activeHourStart: toUtcHour(7 + Math.floor(r() * 3), homeCity), // 7-9 local
    activeHourEnd: toUtcHour(20 + Math.floor(r() * 4), homeCity), // 20-23 local
    onlineShare: 0.2 + r() * 0.4, // 0.2-0.6
    txCount: 300 + Math.floor(r() * 500), // 300-800
  };
}

// Whole-hour timezone offset from longitude (15 deg per hour), good enough for
// a synthetic world: no DST, no political timezone borders.
function toUtcHour(localHour: number, city: City): number {
  const offset = Math.round(city.lon / 15);
  return ((localHour - offset) % 24 + 24) % 24;
}

// Hours in the tenant's active window, inclusive, handling the midnight wrap.
export function activeWindowHours(profile: TenantProfile): number {
  return ((profile.activeHourEnd - profile.activeHourStart + 24) % 24) + 1;
}

export function inActiveWindow(hour: number, profile: TenantProfile): boolean {
  const { activeHourStart: s, activeHourEnd: e } = profile;
  return s <= e ? hour >= s && hour <= e : hour >= s || hour <= e;
}

export function profiles(seed: string = WORLD_SEED): TenantProfile[] {
  return Array.from({ length: TENANT_COUNT }, (_, i) => makeProfile(i, seed));
}

// Human-readable "normal life" summary for the /launch persona card.
export interface PersonaSummary {
  homeCity: string;
  favoriteCategories: string[];
  typicalAmountRange: [number, number]; // ~1 std band around the median
  medianAmount: number;
  currency: string;
}

export function personaSummary(profile: TenantProfile): PersonaSummary {
  const median = Math.exp(profile.amountLogMean);
  const low = Math.exp(profile.amountLogMean - profile.amountLogStd);
  const high = Math.exp(profile.amountLogMean + profile.amountLogStd);
  return {
    homeCity: profile.homeCity.name,
    favoriteCategories: profile.categories.map(titleCase),
    typicalAmountRange: [round2(low), round2(high)],
    medianAmount: round2(median),
    currency: profile.homeCity.currency,
  };
}

// --- Transactions -----------------------------------------------------------

export type Channel = "pos" | "online" | "atm";
export type Motif = "card_testing" | "geo_hop" | "ladder" | "none";
export type ChannelSrc = "generator" | "browser_attack";

export interface Transaction {
  id: string;
  tenant_id: string;
  ts: string; // ISO 8601
  amount: number;
  currency: string;
  merchant: string;
  merchant_cat: string;
  city: string;
  lat: number;
  lon: number;
  channel: Channel;
  card_present: boolean;
  motif: Motif; // ground truth; the scorer must never read this
  channel_src: ChannelSrc;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function logNormalAmount(profile: TenantProfile, r: () => number): number {
  const a = Math.exp(profile.amountLogMean + profile.amountLogStd * gaussian(r));
  return round2(Math.max(1, a));
}

function channelFor(
  profile: TenantProfile,
  r: () => number,
): { channel: Channel; cardPresent: boolean } {
  const roll = r();
  if (roll < profile.onlineShare) return { channel: "online", cardPresent: false };
  if (roll < profile.onlineShare + 0.08) return { channel: "atm", cardPresent: true };
  return { channel: "pos", cardPresent: true };
}

// One profile-conforming transaction at a given time, in the tenant's home
// city and currency. The shared builder for baseline and live generator events.
function genTransaction(
  profile: TenantProfile,
  r: () => number,
  tsMs: number,
  id: string,
): Transaction {
  const merchant = pick(r, profile.merchants);
  const { channel, cardPresent } = channelFor(profile, r);
  const home = profile.homeCity;
  return {
    id,
    tenant_id: profile.id,
    ts: new Date(tsMs).toISOString(),
    amount: logNormalAmount(profile, r),
    currency: home.currency,
    merchant: merchant.name,
    merchant_cat: merchant.cat,
    city: home.name,
    lat: home.lat,
    lon: home.lon,
    channel,
    card_present: cardPresent,
    motif: "none",
    channel_src: "generator",
  };
}

// The tenant's baseline: 300-800 transactions over the ~90 days before EPOCH,
// clustered inside its active hours. Returned sorted oldest-first.
export function baselineTransactions(
  profile: TenantProfile,
  seed: string = WORLD_SEED,
): Transaction[] {
  const out: Transaction[] = [];
  for (let i = 0; i < profile.txCount; i++) {
    const r = rng(`${seed}:tx:${profile.id}:${i}`);
    const dayIndex = Math.floor(r() * 90);
    const day = new Date(EPOCH - dayIndex * DAY_MS);
    day.setUTCHours(0, 0, 0, 0);
    const hour =
      (profile.activeHourStart + Math.floor(r() * activeWindowHours(profile))) % 24;
    const tsMs =
      day.getTime() + hour * 3_600_000 + Math.floor(r() * 3_600_000);
    out.push(genTransaction(profile, r, tsMs, uuidFrom(seed, profile.id, i)));
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

// --- Fraud motifs -----------------------------------------------------------

// Each motif is a deterministic sequence generator. Events carry the ground-
// truth `motif` label. Used by both the live generator (occasional injection)
// and the /launch attack cards; the caller sets `src` (browser_attack for
// launches, generator for injection).
export function motifSequence(
  motif: Exclude<Motif, "none">,
  profile: TenantProfile,
  startTs: number,
  seed: string,
  src: ChannelSrc = "browser_attack",
): Transaction[] {
  const r = rng(`${seed}:motif:${motif}:${profile.id}`);
  const home = profile.homeCity;
  const median = Math.exp(profile.amountLogMean);
  const base = (): Omit<Transaction, "ts" | "amount" | "id"> => ({
    tenant_id: profile.id,
    currency: home.currency,
    merchant: "",
    merchant_cat: "",
    city: home.name,
    lat: home.lat,
    lon: home.lon,
    channel: "pos",
    card_present: true,
    motif,
    channel_src: src,
  });

  if (motif === "card_testing") {
    // Burst of small same-merchant online charges seconds apart. Merchant index
    // 5 ("Digital Goods F"): profiles only ever use indexes 0-2, so this
    // merchant is new-for-tenant by construction (fires the new-merchant flag).
    const merchant = merchantName("digital_goods", 5);
    const count = 6;
    let t = startTs;
    return Array.from({ length: count }, (_, i) => {
      if (i > 0) t += 2000 + Math.floor(r() * 2001); // 2-4s apart
      return {
        ...base(),
        id: uuidFrom(seed, motif, profile.id, i),
        ts: new Date(t).toISOString(),
        amount: round2(1 + r() * 3), // $1-4, small
        merchant,
        merchant_cat: "digital_goods",
        channel: "online" as Channel,
        card_present: false,
      };
    });
  }

  if (motif === "geo_hop") {
    // Two card-present events in distant cities minutes apart: impossible travel.
    const far = farthestCity(home);
    const gapMs = (2 + Math.floor(r() * 4)) * 60_000; // 2-5 min
    const merchant = pick(r, profile.merchants);
    return [
      {
        ...base(),
        id: uuidFrom(seed, motif, profile.id, 0),
        ts: new Date(startTs).toISOString(),
        amount: round2(median),
        merchant: merchant.name,
        merchant_cat: merchant.cat,
      },
      {
        ...base(),
        id: uuidFrom(seed, motif, profile.id, 1),
        ts: new Date(startTs + gapMs).toISOString(),
        amount: round2(median),
        merchant: merchant.name,
        merchant_cat: merchant.cat,
        city: far.name,
        lat: far.lat,
        lon: far.lon,
        currency: far.currency, // foreign card-present charge
      },
    ];
  }

  // ladder: escalating amounts at the same merchant, minutes apart. A probe
  // charge at ~half the tenant's median, then a steep x2.5 escalation per step.
  const merchant = pick(r, profile.merchants);
  const count = 5;
  let amount = median * 0.5;
  return Array.from({ length: count }, (_, i) => {
    if (i > 0) amount *= 2.5; // steep escalation
    return {
      ...base(),
      id: uuidFrom(seed, motif, profile.id, i),
      ts: new Date(startTs + i * 180_000).toISOString(), // 3 min apart
      amount: round2(amount),
      merchant: merchant.name,
      merchant_cat: merchant.cat,
    };
  });
}

// --- Live event generation --------------------------------------------------

// ponytail: 10% of buckets inject one motif; tune with the motif-detection eval.
const INJECT_PROB = 0.1;

// The events for one 2-second bucket: ~10 profile-conforming transactions
// across random tenants, plus an occasional injected motif. Fully determined by
// (seed, bucket), with deterministic event IDs.
export function liveEvents(bucket: number, seed: string = WORLD_SEED): Transaction[] {
  const r = rng(`${seed}:bucket:${bucket}`);
  const bucketStart = EPOCH + bucket * BUCKET_MS;
  const n = 8 + Math.floor(r() * 5); // 8-12, ~10 per 2s bucket

  // Background traffic comes only from tenants inside their active window at
  // this hour. Scoring an event at an hour absent from the tenant's baseline
  // reads as an anomaly (it is one), so an unfiltered pick floods the wall with
  // marginal alerts whenever the wall clock drifts from the seeded hours.
  // Injected motifs below stay unfiltered: fraud at an odd hour is realistic.
  const hour = new Date(bucketStart).getUTCHours();
  const active: number[] = [];
  for (let i = 0; i < TENANT_COUNT; i++) {
    if (inActiveWindow(hour, makeProfile(i, seed))) active.push(i);
  }

  const events: Transaction[] = [];
  for (let i = 0; i < n; i++) {
    const tenantIndex = active.length
      ? active[Math.floor(r() * active.length)]
      : Math.floor(r() * TENANT_COUNT);
    const profile = makeProfile(tenantIndex, seed);
    const tsMs = bucketStart + Math.floor(r() * BUCKET_MS);
    events.push(
      genTransaction(profile, r, tsMs, uuidFrom(seed, bucket, i)),
    );
  }

  if (r() < INJECT_PROB) {
    const motifs: Exclude<Motif, "none">[] = ["card_testing", "geo_hop", "ladder"];
    const motif = pick(r, motifs);
    const profile = makeProfile(Math.floor(r() * TENANT_COUNT), seed);
    events.push(
      ...motifSequence(motif, profile, bucketStart, `${seed}:inject:${bucket}`, "generator"),
    );
  }

  return events;
}
