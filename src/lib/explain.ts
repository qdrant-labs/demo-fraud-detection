// Deterministic one-liner for an alert, grounded in the actual neighbors and
// context: no invented numbers. It picks a template from which feature BLOCK
// deviates most between the event vector and its neighbor centroid, then fills
// the sentence with facts recomputed from the tenant's real recent history.
//
// shortcut: a five-template library keyed on the top deviating block
// (impossible-travel, geo, burst, amount/ladder, generic fallback). Extend the
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
  let travelMinutes = 0;
  const prevCity = last?.city;
  if (last) {
    const ms = nowMs - Date.parse(last.ts);
    travelMinutes = Math.max(1, Math.round(ms / 60_000));
    const hours = ms / 3_600_000;
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

  return { prior, burstCount, burstMinutes, kmh, travelMinutes, prevCity, amountRatio, ladderRatio, rises };
}

// One "this charge vs this customer" row for the alert card. `usual` renders
// behind a "usually" prefix in the UI, so it holds only the behavior itself.
export interface Contrast {
  field: string;
  event: string;
  usual: string;
}

function money(currency: string, n: number): string {
  return `${currency} ${n >= 10 ? Math.round(n) : round1(n)}`;
}

// Home-city local clock, using the same whole-hour longitude offset the world
// uses to place tenant active windows (world.ts toUtcHour).
function localParts(tsMs: number, lonOffset: number) {
  const d = new Date(tsMs + lonOffset * 3_600_000);
  return { hour: d.getUTCHours(), hhmm: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` };
}

export function explainAlert(args: {
  tx: Transaction;
  eventVector: number[];
  centroid: number[];
  context: PriorTx[];
  profile: TenantProfile;
}): { explanation: string; contrasts: Contrast[] } {
  const { tx, eventVector, centroid, context, profile } = args;
  const f = facts(tx, context);
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
  const impossibleTravel = recentHot && recentDim === "impossibleTravel";

  // --- Headline: one template keyed on the top deviating block. -------------
  // `headlineKey` names the story the headline already tells, so the contrast
  // rows below never repeat it.
  let explanation: string;
  let headlineKey: string;

  // Impossible travel gets its own line: the speed between the two charges is
  // the whole story, so show it. Falls through to the geo line when there is no
  // prior to measure against.
  if (impossibleTravel && f.prevCity && f.kmh > 0) {
    const kmh = Math.round(f.kmh).toLocaleString("en-US");
    explanation = `Charge in ${tx.city} ${f.travelMinutes} min after ${f.prevCity}, ${kmh} km/h apart`;
    headlineKey = "travel";
  } else if (top === "geo" || impossibleTravel) {
    const cp = tx.card_present ? "in-person" : "online";
    // The score badge and ratio cell already show the multiple; no second clause.
    explanation = `First ${cp} charge outside ${profile.homeCity.name} in ${n} transactions`;
    headlineKey = "place";
  } else if (recentHot && recentDim === "burstCount") {
    explanation = `${f.burstCount} charges at ${tx.merchant} inside ${f.burstMinutes} min, each around ${tx.currency} ${tx.amount}`;
    headlineKey = "pace";
  } else if (top === "amount" || (recentHot && (recentDim === "ladder" || recentDim === "amountRatio"))) {
    const rises = f.rises >= 2 ? `, ${f.rises} rises in a row` : "";
    explanation = `Amount ${round1(f.amountRatio)}x this customer's typical spend at ${tx.merchant}${rises}`;
    headlineKey = "amount";
  } else {
    explanation = `This charge breaks several normal patterns for this customer`;
    headlineKey = "";
  }

  // --- Contrast rows: this charge vs this customer's normal. ----------------
  // Candidates ranked by the same deviation signal that picked the headline;
  // the recent-history block competes as its individual signals. Each builder
  // states the abnormal fact and the normal fact it breaks; builders return
  // null when their story does not hold up in the raw numbers, so a noisy
  // block deviation never produces an unsupported sentence.
  const lonOffset = Math.round(profile.homeCity.lon / 15);
  const nowMs = Date.parse(tx.ts);
  const homeKm = haversineKm(profile.homeCity.lat, profile.homeCity.lon, tx.lat, tx.lon);
  const amounts = f.prior.map((p) => p.amount).sort((a, b) => a - b);
  const median = amounts.length ? amounts[Math.floor(amounts.length / 2)] : tx.amount;

  // Median minutes between the customer's recent consecutive charges.
  const gaps: number[] = [];
  for (let i = 1; i < f.prior.length; i++) {
    gaps.push((Date.parse(f.prior[i].ts) - Date.parse(f.prior[i - 1].ts)) / 60_000);
  }
  gaps.sort((a, b) => a - b);
  const medianGapMin = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const gapText =
    medianGapMin >= 120
      ? `one charge every ${Math.round(medianGapMin / 60)} hours`
      : medianGapMin >= 1
        ? `one charge every ${Math.round(medianGapMin)} minutes`
        : "";

  const local = localParts(nowMs, lonOffset);
  const startLocal = (profile.activeHourStart + lonOffset + 24) % 24;
  const endLocal = (profile.activeHourEnd + lonOffset + 24) % 24;
  const inWindow =
    startLocal <= endLocal
      ? local.hour >= startLocal && local.hour <= endLocal
      : local.hour >= startLocal || local.hour <= endLocal;

  const builders: Record<string, () => Contrast | null> = {
    newMerchant: () =>
      profile.merchants.some((m) => m.name === tx.merchant)
        ? null
        : {
            field: "Merchant",
            event: `first charge at ${tx.merchant}`,
            usual: `one of ${profile.merchants.length} known merchants`,
          },
    pace: () =>
      f.burstCount >= 3 && gapText
        ? {
            field: "Pace",
            event: `${f.burstCount} charges in ${f.burstMinutes} min`,
            usual: gapText,
          }
        : null,
    travel: () =>
      f.prevCity && f.kmh > 500
        ? {
            field: "Travel",
            event: `${tx.city} ${f.travelMinutes} min after ${f.prevCity}`,
            usual: `charges near ${profile.homeCity.name}`,
          }
        : null,
    place: () =>
      homeKm >= 100
        ? {
            field: "Place",
            event: `${tx.city}, ${Math.round(homeKm).toLocaleString("en-US")} km from home`,
            usual: `near ${profile.homeCity.name}`,
          }
        : null,
    amount: () => {
      if (f.rises >= 2) {
        // rises counts the steps; the run of charges is one longer.
        return {
          field: "Amount",
          event: `${f.rises + 1} rising charges in a row at ${tx.merchant}`,
          usual: `steady near ${money(tx.currency, median)}`,
        };
      }
      if (f.amountRatio >= 1.5 || f.amountRatio <= 0.5) {
        return {
          field: "Amount",
          event: money(tx.currency, tx.amount),
          usual: `near ${money(tx.currency, median)}`,
        };
      }
      return null;
    },
    time: () =>
      inWindow
        ? null
        : {
            field: "Time",
            event: `${local.hhmm} in ${profile.homeCity.name}`,
            usual: `active ${String(startLocal).padStart(2, "0")}:00-${String(endLocal).padStart(2, "0")}:00`,
          },
    channel: () =>
      // onlineShare is generated in [0.2, 0.6], so only the online-when-usually-in-person
      // direction can occur.
      !tx.card_present && profile.onlineShare < 0.35
        ? { field: "Channel", event: "online", usual: "in person" }
        : null,
    currency: () =>
      tx.currency !== profile.homeCity.currency
        ? { field: "Currency", event: tx.currency, usual: profile.homeCity.currency }
        : null,
    category: () =>
      profile.categories.includes(tx.merchant_cat)
        ? null
        : {
            field: "Category",
            event: tx.merchant_cat.replace(/_/g, " "),
            usual: profile.categories.map((c) => c.replace(/_/g, " ")).join(", "),
          },
  };

  // Rank: block deviations plus the recent block's individual signals.
  const blockToStory: Record<string, string> = {
    amount: "amount",
    timeOfDay: "time",
    geo: "place",
    category: "category",
    channel: "channel",
    cardPresent: "channel",
    currency: "currency",
    newMerchant: "newMerchant",
  };
  const recentToStory: Record<string, string> = {
    burstCount: "pace",
    impossibleTravel: "travel",
    amountRatio: "amount",
    ladder: "amount",
  };
  const ranked: { key: string; dev: number }[] = [];
  for (const { name, dev } of devs) {
    if (name === "recent" || name === "dayOfWeek") continue;
    const key = blockToStory[name];
    if (key) ranked.push({ key, dev });
  }
  for (const [name, i] of Object.entries(RECENT_DIMS)) {
    const key = recentToStory[name];
    if (key) ranked.push({ key, dev: Math.abs(eventVector[i] - centroid[i]) });
  }
  ranked.sort((a, b) => b.dev - a.dev);

  const contrasts: Contrast[] = [];
  const used = new Set<string>([headlineKey]);
  const floor = (ranked[0]?.dev ?? 0) * 0.2;
  for (const { key, dev } of ranked) {
    if (contrasts.length >= 3) break;
    if (used.has(key) || dev < floor) continue;
    const row = builders[key]?.();
    used.add(key);
    if (row) contrasts.push(row);
  }

  return { explanation, contrasts };
}
