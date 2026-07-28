"use client";

// The unified alert panel: everything about a pinned story in one right-side
// column. Top to bottom: score header, the one-liner and charge trail, the
// "How This Alert Was Caught" teaching section (animated scatter + arithmetic),
// the scoring timings, and the evidence link. Fixed-right on desktop, bottom
// sheet on small screens. Keyed by the caller on story.id, so it remounts (and
// the scatter animation replays) once per story.

import { useState } from "react";
import { topEvent, type Story, type WallEvent } from "@/lib/wall-story";
import QdrantPanel, { type PanelSubject } from "./qdrant-panel";

// The panel's desktop footprint. The width class below, the wall's story-fit
// math, and the ticker's right padding all read this, so they cannot drift.
// ponytail: 30rem in px assumes the 16px root font. Three sites move together —
// this constant, the lg:w-[30rem] class below, and the ticker's
// lg:pr-[calc(30rem+1.5rem)] in page.tsx.
const PANEL_REM = 30;
export const PANEL_PX = PANEL_REM * 16;
export const LG_MIN = 1024; // Tailwind lg breakpoint; the panel is fixed-right at/above this

// The score as a filled meter with a tick at the alert threshold, so it reads
// as "how far past the line" instead of a bare multiplier. The track spans
// 0-METER_MAX; hotter scores clamp the fill and the number carries the rest.
const METER_MAX = 6;
const METER_THRESHOLD = 2; // display twin of qdrant-panel's THRESHOLD

export function ScoreMeter({ score, size = "sm" }: { score: number; size?: "sm" | "lg" }) {
  const fill = Math.min(score / METER_MAX, 1) * 100;
  const tick = (METER_THRESHOLD / METER_MAX) * 100;
  const dims = size === "lg" ? "h-3 w-36" : "h-2.5 w-24";
  return (
    <span
      className={`relative inline-block ${dims} overflow-hidden rounded-full bg-slate-700/60 align-middle`}
      title="How unusual this charge is for this customer. Alerts start past 2."
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-red-500/90"
        style={{ width: `${fill}%` }}
      />
      <span
        className="absolute inset-y-0 w-0.5 bg-slate-200/80"
        style={{ left: `${tick}%` }}
      />
    </span>
  );
}

// One-line summary for a same-merchant, same-city burst of similar amounts
// (the card-testing shape). Null when the rows differ enough to earn a list:
// different cities (geo-hop) or a widening amount spread (escalating amounts).
function burstSummary(events: WallEvent[]): string | null {
  if (events.length < 4) return null;
  const [first] = events;
  if (!events.every((e) => e.merchant === first.merchant && e.city === first.city)) return null;
  const amounts = events.map((e) => e.amount);
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  if (min <= 0 || max / min >= 5) return null;
  const times = events.map((e) => Date.parse(e.ts));
  const spanS = Math.round((Math.max(...times) - Math.min(...times)) / 1000);
  const span = spanS >= 120 ? `${Math.round(spanS / 60)} min` : `${Math.max(spanS, 1)} s`;
  return `${first.currency} ${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")} each, all in ${span}`;
}

// The GET /api/alert/[id] shape the evidence expander renders.
interface Evidence {
  stored: { score: number | null };
  recomputed: { score: number } | null;
  neighbors: {
    id: string | number;
    merchant: string;
    amount: number;
    currency: string;
    city: string;
    ts: string;
    distance: number;
  }[];
}

export default function AlertPanel({
  story,
  subject,
  onClose,
}: {
  story: Story;
  subject: PanelSubject;
  onClose: () => void;
}) {
  const lead = story.events[0];
  const top = topEvent(story);
  const multi = story.events.length > 1;
  const timings = lead.timings;

  // "Show Evidence" expands in place. The JSON is fetched once on first
  // expand (keyed by story via the remount), then collapse/expand only toggles.
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);

  async function toggleEvidence(): Promise<void> {
    if (evidenceOpen) {
      setEvidenceOpen(false);
      return;
    }
    setEvidenceOpen(true);
    if (evidence || evidenceLoading) return;
    setEvidenceLoading(true);
    try {
      const r = await fetch(`/api/alert/${top.id}`);
      if (r.ok) setEvidence((await r.json()) as Evidence);
    } finally {
      setEvidenceLoading(false);
    }
  }

  return (
    <aside
      className="pointer-events-auto fixed z-20 flex flex-col gap-5 overflow-y-auto border-slate-700/60 bg-[#0a0d12]/95 backdrop-blur
        inset-x-0 bottom-0 max-h-[58vh] border-t p-4
        lg:inset-y-0 lg:right-0 lg:left-auto lg:h-full lg:max-h-none lg:w-[30rem] lg:border-l lg:border-t-0 lg:p-6"
    >
      {/* a. Score header */}
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-red-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-400">
          Alert
        </span>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="flex items-center gap-2">
              <ScoreMeter score={top.score} size="lg" />
              <span className="font-mono text-3xl font-semibold text-red-400">
                {top.score.toFixed(1)}
              </span>
            </span>
            <p className="text-xs text-slate-400">
              times this customer&apos;s usual range &middot; alert starts past 2.0
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close And Return To World View"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-600/60 text-slate-400 transition-colors hover:bg-slate-700/50 hover:text-slate-100"
          >
            &times;
          </button>
        </div>
      </div>

      {/* b. One-liner, who and where, charge trail */}
      <div>
        {/* The top-scored event tells the fullest story: in a burst the last
            charge has seen the whole run form, the first has seen none of it. */}
        <p className="text-2xl font-semibold leading-snug text-slate-50">{top.explanation}</p>
        <p className="mt-2 text-base text-slate-300">
          Customer {story.tenant_id}, home {story.home.city}
        </p>

        {/* This charge vs this customer's normal: what the alert broke, and the
            behavior it broke. Same legibility floor as the teaching steps. */}
        {top.contrasts?.length ? (
          <ul className="mt-3 space-y-1 border-l-2 border-slate-600/60 pl-3">
            {top.contrasts.map((c) => (
              <li key={c.field} className="text-base leading-snug">
                <span className="text-slate-500">{c.field}: </span>
                <span className="font-medium text-red-300">{c.event}</span>
                <span className="text-slate-400"> — usually {c.usual}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {multi ? (
          <div className="mt-3">
            <p className="text-base text-slate-300">
              {story.events.length} Charges At {top.merchant}
            </p>
            {burstSummary(story.events) ? (
              // A same-merchant, same-city burst of similar amounts reads as six
              // near-identical rows; one line says more. Trails whose rows differ
              // (cities, escalating amounts) keep the per-charge list.
              <p className="mt-1 font-mono text-base text-slate-300">{burstSummary(story.events)}</p>
            ) : (
              <ul className="mt-1 space-y-0.5 font-mono text-base text-slate-300">
                {story.events.slice(0, 6).map((e) => (
                  <li key={String(e.id)} className="flex justify-between gap-4">
                    <span>
                      {e.currency} {e.amount.toLocaleString("en-US")}, {e.city}
                    </span>
                    <span
                      className={e.alerted ? "text-red-400" : "text-slate-400"}
                      title="Distance from typical, as a multiple of this customer's usual range"
                    >
                      {e.score.toFixed(1)}×
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="mt-3 font-mono text-base text-slate-200">
            {lead.currency} {lead.amount.toLocaleString("en-US")} at {lead.merchant}, {lead.city}
          </p>
        )}
      </div>

      {/* c. How This Alert Was Caught (steps + animated scatter + arithmetic) */}
      <QdrantPanel subject={subject} />

      {/* d. Scoring timings (generator events only; pickups carry no timings) */}
      {timings ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-lg font-semibold text-slate-100">
            Decided In {Math.round(timings.scroll + timings.knn)} ms
          </h3>
          <TimingRow label="Customer History" ms={timings.scroll} />
          <TimingRow label="Similar Charges Found" ms={timings.knn} />
          <TimingRow label="Saving the Charge" ms={timings.upsert} />
          <p className="mt-1 text-base leading-snug text-slate-300">
            The first two rows are the decision. Saving happens after it, and the
            next charge can already see the saved one.
          </p>
        </section>
      ) : null}

      {/* e. Full evidence, expanded in place: the pinned neighbor table and the
          line proving the stored score reproduces from that neighbor set. */}
      <section className="flex flex-col gap-3">
        <button
          onClick={toggleEvidence}
          aria-expanded={evidenceOpen}
          className="inline-block self-start rounded-lg bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/25"
        >
          Show Evidence
        </button>

        {evidenceOpen ? (
          evidenceLoading && !evidence ? (
            <p className="text-sm text-slate-300">Loading evidence…</p>
          ) : evidence && evidence.recomputed ? (
            <>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-700/60">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-800/50 text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Merchant</th>
                      <th className="px-3 py-2">Amount</th>
                      <th className="px-3 py-2">City</th>
                      <th className="px-3 py-2">Time</th>
                      <th className="px-3 py-2 text-right">Distance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evidence.neighbors.map((n) => (
                      <tr key={String(n.id)} className="border-t border-slate-800 text-slate-300">
                        <td className="px-3 py-2">{n.merchant}</td>
                        <td className="px-3 py-2 font-mono tabular-nums">
                          {n.currency} {n.amount.toLocaleString("en-US")}
                        </td>
                        <td className="px-3 py-2">{n.city}</td>
                        <td className="px-3 py-2 text-slate-400">{n.ts}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">
                          {n.distance.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-base text-slate-300">
                Saved score {(evidence.stored.score ?? 0).toFixed(3)}; checked again from the
                same similar charges {evidence.recomputed.score.toFixed(3)}.
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-300">Could not load the evidence.</p>
          )
        ) : null}
      </section>
    </aside>
  );
}

function TimingRow({ label, ms }: { label: string; ms: number }) {
  return (
    <div className="flex items-baseline justify-between border-b border-slate-800/70 pb-1 text-base">
      <span className="text-slate-300">{label}</span>
      <span className="font-mono tabular-nums text-slate-100">{Math.round(ms)} ms</span>
    </div>
  );
}
