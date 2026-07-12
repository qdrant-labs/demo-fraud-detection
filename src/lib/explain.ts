// Deterministic one-liner for an alert, grounded in the actual neighbors and
// context: no invented numbers. It picks a template from which feature BLOCK
// deviates most between the event vector and its neighbor centroid, then fills
// the sentence with facts recomputed from the tenant's real recent history.
//
// shortcut: a four-template library keyed on the top deviating block
// (geo/impossible-travel, burst, amount/ladder, generic fallback). Extend the
// library if new motifs need finer wording; the block-deviation ranking already
// generalizes, only the sentences are fixed.

import type { PriorTx } from "./features";
import { haversineKm, type TenantProfile, type Transaction } from "./world";

// Dim-block layout, matching the comment in features.ts. [start, end).
const BLOCKS = {
  amount: [0, 1],
  timeOfDay: [1, 3],
  dayOfWeek: [3, 5],
  geo: [5, 8],
  category: [8, 20],
  channel: [20, 23],
  cardPresent: [23, 24],
  currency: [24, 25],
  newMerchant: [25, 26],
  recent: [26, 31],
} as const;

// Within the recent-history block, each dim maps to a distinct motif signal.
const RECENT_DIMS = {
  minutesSince: 26,
  burstCount: 27,
  impossibleTravel: 28,
  amountRatio: 29,
  ladder: 30,
} as const;

function blockDeviation(event: number[], centroid: number[], range: readonly [number, number]): number {
  let s = 0;
  for (let i = range[0]; i < range[1]; i++) {
    const d = event[i] - centroid[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Facts pulled straight from the tenant's real recent history. This mirrors the
// arithmetic in features.recentHistory but keeps RAW human numbers (that helper
// returns only the scaled vector values), so the sentence shows "5 charges",
// not "0.7". Small, deliberate duplication for display.
function facts(tx: Transaction, context: PriorTx[]) {
  const nowMs = Date.parse(tx.ts);
  const prior = context
    .filter((p) => Date.parse(p.ts) < nowMs)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const sameMerchant = prior.filter((p) => p.merchant === tx.merchant);
  const burstWindow = sameMerchant.filter((p) => nowMs - Date.parse(p.ts) <= 600_000);
  const burstCount = burstWindow.length + 1; // include the current charge
  const burstMinutes = burstWindow.length
    ? Math.max(1, Math.round((nowMs - Date.parse(burstWindow[0].ts)) / 60_000))
    : 0;

  const last = prior[prior.length - 1];
  let kmh = 0;
  if (last) {
    const hours = (nowMs - Date.parse(last.ts)) / 3_600_000;
    if (hours > 0) kmh = haversineKm(last.lat, last.lon, tx.lat, tx.lon) / hours;
  }

  const amounts = prior.map((p) => p.amount).sort((a, b) => a - b);
  const median = amounts.length ? amounts[Math.floor(amounts.length / 2)] : tx.amount;
  const amountRatio = median > 0 ? tx.amount / median : 1;

  const prevSame = [...sameMerchant].reverse()[0];
  const ladderRatio = prevSame && prevSame.amount > 0 ? tx.amount / prevSame.amount : 1;

  // How many consecutive rises at this merchant, ending with the current charge.
  let rises = 0;
  let cur = tx.amount;
  for (let i = sameMerchant.length - 1; i >= 0; i--) {
    if (sameMerchant[i].amount < cur) {
      rises++;
      cur = sameMerchant[i].amount;
    } else break;
  }

  return { prior, burstCount, burstMinutes, kmh, amountRatio, ladderRatio, rises };
}

export function explain(args: {
  tx: Transaction;
  eventVector: number[];
  centroid: number[];
  context: PriorTx[];
  profile: TenantProfile;
  score: number;
}): string {
  const { tx, eventVector, centroid, context, profile, score } = args;
  const f = facts(tx, context);
  const ratio = round1(score);
  const n = f.prior.length;

  // Rank blocks by how far the event sits from the neighbor centroid.
  const devs = Object.entries(BLOCKS)
    .map(([name, range]) => ({ name, dev: blockDeviation(eventVector, centroid, range) }))
    .sort((a, b) => b.dev - a.dev);
  const top = devs[0].name;

  // Which single recent-history signal dominates, if recent is a top block.
  const recentDim = Object.entries(RECENT_DIMS)
    .map(([name, i]) => ({ name, dev: Math.abs(eventVector[i] - centroid[i]) }))
    .sort((a, b) => b.dev - a.dev)[0].name;

  const recentHot = top === "recent";

  if (top === "geo" || (recentHot && recentDim === "impossibleTravel")) {
    const cp = tx.card_present ? "card-present" : "online";
    // The score badge and ratio cell already show the multiple; no second clause.
    return `First ${cp} charge outside ${profile.homeCity.name} in ${n} transactions`;
  }

  if (recentHot && recentDim === "burstCount") {
    return `${f.burstCount} charges at ${tx.merchant} inside ${f.burstMinutes} minutes, each around ${tx.currency} ${tx.amount}`;
  }

  if (top === "amount" || (recentHot && (recentDim === "ladder" || recentDim === "amountRatio"))) {
    const rises = f.rises >= 2 ? `, ${f.rises} rises in a row` : "";
    return `Amount ${round1(f.amountRatio)}x this card's typical spend at ${tx.merchant}${rises}`;
  }

  return `${ratio}x farther from this card's baseline than its neighbors are from each other`;
}
