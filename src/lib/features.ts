// The feature encoder: a pure function from a transaction to a 31-d vector.
// No learned model. Deterministic and human-readable, which is what lets the
// evidence panel explain a score honestly.
//
// Dim layout (block — dims — weight):
//
//   [0]      log10(1+amount)/5              ×2.0   (1)
//   [1,2]    sin/cos hour-of-day            ×1.0   (2)
//   [3,4]    sin/cos day-of-week            ×0.5   (2)
//   [5,6,7]  geo -> unit-sphere xyz         ×1.5   (3)
//   [8..19]  merchant category one-hot      ×1.0   (12)
//   [20,21,22] channel one-hot pos/online/atm ×1.0 (3)
//   [23]     card_present flag              ×1.0   (1)
//   [24]     currency-is-home flag          ×1.0   (1)
//   [25]     new-merchant-for-tenant flag   ×2.5   (1)
//   [26]     minutes-since-last-tx          ×0.5   (1)
//   [27]     same-merchant-10m count        ×0.5   (1)
//   [28]     impossible-travel kmh          ×1.0   (1)
//   [29]     amount / recent median         ×2.0   (1)
//   [30]     consecutive escalation count   ×2.0   (1)
//
// Total: 31. Weights balance the blocks' scales; tune only via the eval suite
// (evals/motif-detection.ts prints the threshold sweep). Dim 25 and dims 29/30
// carry extra weight: background traffic never hits a new merchant, and the
// amount-ratio dims share one distribution between the seeded baseline and live
// traffic, so they lift fraud scores without raising the false-positive floor.
// Dims 26/27 are damped for the opposite reason: live traffic is denser in time
// than the 90-day seeded baseline, so at full weight every normal live event
// deviates from its baseline neighbors on them. Record: evals/TUNING.md.

import { CATEGORIES, haversineKm, type Transaction } from "./world";

export const FEATURE_DIM = 31;

const CHANNELS = ["pos", "online", "atm"] as const;

// The five recent-history features, already scaled to ~[0,1] for the vector.
// These are the exact dims 26..30; the scorer writes them back to the payload
// so the wall and evidence panel can replay the arithmetic.
export interface RecentHistory {
  minutesSinceLast: number; // clip 0-1440, log-scaled
  sameMerchant10m: number; // clip 0-10, /10
  impossibleTravelKmh: number; // haversine kmh, clip 0-2000, /2000
  amountRatioMedian: number; // clip 0-10, log-scaled
  // Consecutive same-merchant escalations (each step >= 1.5x) ending at this
  // event, clip 4, /4. Redefines the PLAN's literal ladder_step_ratio
  // (executive-judgment clause): three measured tuning rounds showed a single
  // step ratio cannot separate laddering from a log-normal baseline — the
  // chain of escalations is the signal. Record: evals/TUNING.md.
  ladderRises: number;
}

// The payload fields recentHistory needs from each prior transaction.
export type PriorTx = Pick<
  Transaction,
  "ts" | "amount" | "merchant" | "lat" | "lon"
>;

// Everything the encoder needs beyond the transaction itself. The scorer
// derives these from the tenant profile and its retrieved history:
//   homeCurrency   -> profile.homeCity.currency
//   isNewMerchant  -> merchant absent from the tenant's baseline
export interface EncodeContext {
  homeCurrency: string;
  isNewMerchant: boolean;
}

function log10Scaled(value: number, clipMax: number): number {
  const v = Math.min(Math.max(value, 0), clipMax);
  return Math.log10(1 + v) / Math.log10(1 + clipMax);
}

// Compute the five recent-history features from the current transaction and the
// tenant's recent transactions (any order; only those strictly before `tx`
// count). Pure: same inputs -> same output.
export function recentHistory(tx: Transaction, recent: PriorTx[]): RecentHistory {
  const nowMs = Date.parse(tx.ts);
  const prior = recent
    .filter((p) => Date.parse(p.ts) < nowMs)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  if (prior.length === 0) {
    // No history: a lone event looks maximally stale and otherwise neutral.
    return {
      minutesSinceLast: log10Scaled(1440, 1440),
      sameMerchant10m: 0,
      impossibleTravelKmh: 0,
      amountRatioMedian: log10Scaled(1, 10),
      ladderRises: 0,
    };
  }

  const last = prior[prior.length - 1];
  const lastMs = Date.parse(last.ts);

  const minutesGap = (nowMs - lastMs) / 60_000;

  const sameMerchantPrior = prior.filter((p) => p.merchant === tx.merchant);
  const sameMerchant10m = sameMerchantPrior.filter(
    (p) => nowMs - Date.parse(p.ts) <= 600_000,
  ).length;

  const hoursGap = (nowMs - lastMs) / 3_600_000;
  const kmh =
    hoursGap > 0
      ? haversineKm(last.lat, last.lon, tx.lat, tx.lon) / hoursGap
      : 0;

  const amounts = [...prior.map((p) => p.amount)].sort((a, b) => a - b);
  const median = amounts[Math.floor(amounts.length / 2)];
  const amountRatio = median > 0 ? tx.amount / median : 1;

  // Walk back through this merchant's prior amounts, counting consecutive
  // steps of >= 1.5x that lead up to the current amount. A ladder's later
  // events carry 2, 3, 4; normal life almost never chains large monotone
  // rises at one merchant.
  let rises = 0;
  let cur = tx.amount;
  for (let i = sameMerchantPrior.length - 1; i >= 0; i--) {
    const prev = sameMerchantPrior[i].amount;
    if (prev > 0 && cur >= prev * 1.5) {
      rises++;
      cur = prev;
    } else break;
  }

  return {
    minutesSinceLast: log10Scaled(minutesGap, 1440),
    sameMerchant10m: Math.min(sameMerchant10m, 10) / 10,
    impossibleTravelKmh: Math.min(kmh, 2000) / 2000,
    amountRatioMedian: log10Scaled(amountRatio, 10),
    ladderRises: Math.min(rises, 4) / 4,
  };
}

// Encode one transaction into the 31-d feature vector.
export function encode(
  tx: Transaction,
  recent: RecentHistory,
  ctx: EncodeContext,
): number[] {
  const v: number[] = [];
  const d = new Date(tx.ts);

  // amount (1)
  v.push((Math.log10(1 + tx.amount) / 5) * 2.0);

  // hour-of-day sin/cos (2)
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const hourAngle = (2 * Math.PI * hour) / 24;
  v.push(Math.sin(hourAngle) * 1.0, Math.cos(hourAngle) * 1.0);

  // day-of-week sin/cos (2)
  const dowAngle = (2 * Math.PI * d.getUTCDay()) / 7;
  v.push(Math.sin(dowAngle) * 0.5, Math.cos(dowAngle) * 0.5);

  // geo -> unit-sphere xyz (3)
  const latR = (tx.lat * Math.PI) / 180;
  const lonR = (tx.lon * Math.PI) / 180;
  v.push(
    Math.cos(latR) * Math.cos(lonR) * 1.5,
    Math.cos(latR) * Math.sin(lonR) * 1.5,
    Math.sin(latR) * 1.5,
  );

  // merchant category one-hot (12)
  for (const cat of CATEGORIES) v.push(tx.merchant_cat === cat ? 1.0 : 0.0);

  // channel one-hot pos/online/atm (3)
  for (const ch of CHANNELS) v.push(tx.channel === ch ? 1.0 : 0.0);

  // card_present flag (1)
  v.push(tx.card_present ? 1.0 : 0.0);

  // currency-is-home flag (1)
  v.push(tx.currency === ctx.homeCurrency ? 1.0 : 0.0);

  // new-merchant-for-tenant flag (1)
  v.push(ctx.isNewMerchant ? 2.5 : 0.0);

  // recent-history features (5), already scaled; fraud-only dims weighted up
  // (see the dim-layout comment above)
  v.push(
    recent.minutesSinceLast * 0.5,
    recent.sameMerchant10m * 0.5,
    recent.impossibleTravelKmh * 1.0,
    recent.amountRatioMedian * 2.0,
    recent.ladderRises * 2.0,
  );

  return v;
}
