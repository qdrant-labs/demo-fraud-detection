"use client";

// The launcher's core UI: the persona card, three attack cards, and the live
// launch status (per-event progress + running highest score streamed from
// /api/attack as NDJSON). Rendered inside the wall's launch drawer; the real
// wall is right behind it, so a launched attack flares on the map. When the
// sequence alerts, "See The Evidence" pins its story in the wall's alert panel.

import { useState } from "react";
import type { PersonaSummary } from "@/lib/world";

type Motif = "geo_hop" | "card_testing" | "ladder";

interface Card {
  motif: Motif;
  title: string;
  blurb: string;
}

// Plain-language description of each fraud pattern, one line each.
const CARDS: Card[] = [
  {
    motif: "geo_hop",
    title: "Geo-Hop",
    blurb:
      "Two card-present charges in cities minutes apart, faster than any flight.",
  },
  {
    motif: "card_testing",
    title: "Card Testing Burst",
    blurb:
      "A burst of tiny online charges at one merchant, seconds apart, probing a stolen card.",
  },
  {
    motif: "ladder",
    title: "Amount Ladder",
    blurb:
      "Charges at one merchant that climb each step, minutes apart, testing the limit.",
  },
];

interface EventLine {
  type: "event";
  index: number;
  total: number;
  id: string;
  merchant: string;
  city: string;
  amount: number;
  currency: string;
  score: number;
  alerted: boolean;
  explanation: string;
}

interface SummaryLine {
  type: "summary";
  highScore: number;
  highId: string;
  alerted: boolean;
  alertPath: string;
}

type Status = "idle" | "launching" | "done";

export default function AttackPanel({
  tenantId,
  persona,
  onNewPersona,
  onSeeEvidence,
}: {
  tenantId: string;
  persona: PersonaSummary;
  onNewPersona: () => void;
  // Supplied by the wall: pin the story containing this event id in the alert
  // panel. Absent in contexts with no wall behind the drawer.
  onSeeEvidence?: (eventId: string) => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [active, setActive] = useState<Motif | null>(null);
  const [events, setEvents] = useState<EventLine[]>([]);
  const [summary, setSummary] = useState<SummaryLine | null>(null);
  const [error, setError] = useState<string | null>(null);

  const running = events.reduce((m, e) => Math.max(m, e.score), 0);

  async function launch(motif: Motif) {
    if (status === "launching") return;
    setStatus("launching");
    setActive(motif);
    setEvents([]);
    setSummary(null);
    setError(null);

    try {
      const resp = await fetch("/api/attack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A fresh nonce per tap so a repeat launch produces new event IDs.
        body: JSON.stringify({
          tenant_id: tenantId,
          motif,
          nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }),
      });
      if (!resp.ok || !resp.body) {
        const msg = await resp.text().catch(() => "");
        throw new Error(msg || `Launch failed (HTTP ${resp.status}).`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!raw) continue;
          const line = JSON.parse(raw) as EventLine | SummaryLine | { type: "error"; message: string };
          if (line.type === "event") setEvents((prev) => [...prev, line]);
          else if (line.type === "summary") setSummary(line);
          else if (line.type === "error") setError(line.message);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStatus("done");
    }
  }

  const activeCard = CARDS.find((c) => c.motif === active);

  return (
    <div className="flex flex-col gap-6">
      {/* Persona card */}
      <section className="rounded-xl border border-slate-700/60 bg-slate-800/30 px-4 py-4">
        <p className="text-xs uppercase tracking-wide text-slate-500">You Are</p>
        <p className="mt-0.5 text-lg font-semibold">Customer #{tenantId}</p>
        <ul className="mt-2 space-y-1 text-sm text-slate-300">
          <li>Lives in {persona.homeCity}.</li>
          <li>Usually shops {formatList(persona.favoriteCategories)}.</li>
          <li>
            Typical charge {persona.currency} {persona.typicalAmountRange[0].toLocaleString("en-US")} to{" "}
            {persona.typicalAmountRange[1].toLocaleString("en-US")}.
          </li>
        </ul>
        <button
          onClick={onNewPersona}
          className="mt-3 text-xs text-slate-500 underline underline-offset-2 hover:text-slate-300"
        >
          New Persona
        </button>
      </section>

      {/* Attack cards */}
      <section className="grid gap-3">
        {CARDS.map((card) => (
          <button
            key={card.motif}
            onClick={() => launch(card.motif)}
            disabled={status === "launching"}
            className={
              "rounded-xl border px-4 py-4 text-left transition-colors disabled:opacity-60 " +
              (active === card.motif
                ? "border-red-500/50 bg-red-500/10"
                : "border-slate-700/60 bg-slate-800/30 hover:border-slate-500/60 hover:bg-slate-800/60")
            }
          >
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold">{card.title}</span>
              {active === card.motif && status === "launching" ? (
                <span className="text-xs text-slate-400">Launching…</span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-400">{card.blurb}</p>
          </button>
        ))}
      </section>

      {/* Live launch status */}
      {status !== "idle" && activeCard ? (
        <section className="rounded-xl border border-slate-700/60 bg-slate-900/60 px-4 py-4">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold">{activeCard.title}</span>
            <span className="font-mono text-sm text-slate-300">
              {events.length}
              {events[0] ? ` / ${events[0].total}` : ""} Scored
            </span>
          </div>

          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Highest Score</span>
            <span
              className={
                "font-mono text-lg font-semibold " +
                // Color by the server's alert verdict, not a client-side copy
                // of the threshold that can drift.
                (events.some((e) => e.alerted) ? "text-red-400" : "text-slate-200")
              }
            >
              {running.toFixed(2)}x
            </span>
          </div>

          <ul className="mt-3 space-y-1 font-mono text-xs text-slate-400">
            {events.map((e) => (
              <li key={e.id} className="flex justify-between gap-3">
                <span className="truncate">
                  {e.currency} {e.amount.toLocaleString("en-US")} at {e.merchant}, {e.city}
                </span>
                <span className={e.alerted ? "text-red-400" : "text-slate-500"}>
                  {e.score.toFixed(2)}x
                </span>
              </li>
            ))}
          </ul>

          {error ? (
            <p className="mt-3 text-sm text-red-400">{error}</p>
          ) : status === "launching" ? (
            <p className="mt-3 text-sm text-slate-300">Watch the wall.</p>
          ) : summary ? (
            <div className="mt-3">
              <p className="text-sm text-slate-300">
                {summary.alerted
                  ? "Your attack flared on the wall."
                  : "Scored, no alert. Watch the wall."}
              </p>
              {summary.alerted && onSeeEvidence ? (
                <button
                  onClick={() => onSeeEvidence(summary.highId)}
                  className="mt-2 inline-block rounded-lg bg-red-500/15 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/25"
                >
                  See The Evidence
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
