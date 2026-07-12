"use client";

// The /launch page chrome: header with the wall link, then the shared
// AttackPanel (persona card, attack cards, live status, embedded wall strip).
// The attack UI itself lives in attack-panel.tsx so the wall's inline drawer
// renders the exact same thing.

import Link from "next/link";
import type { PersonaSummary } from "@/lib/world";
import AttackPanel from "./attack-panel";

export default function LaunchClient({
  tenantId,
  persona,
}: {
  tenantId: string;
  persona: PersonaSummary;
}) {
  return (
    <main className="min-h-screen bg-[#07090d] px-5 py-8 text-slate-100">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <header className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- static 2KB SVG, no optimizer needed */}
          <img
            src="/qdrant-fraud-detection-mark.svg"
            alt="Fraud Detection by Qdrant"
            className="h-11 w-11"
          />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Fraud Detection</h1>
            <p className="mt-1 text-sm text-slate-400">
              Pick an attack and watch it flare on the wall.
            </p>
          </div>
          <Link
            href="/"
            className="ml-auto shrink-0 rounded-lg border border-slate-600/60 bg-slate-800/40 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-700/50"
          >
            Open The Wall
          </Link>
        </header>

        <AttackPanel
          tenantId={tenantId}
          persona={persona}
          onNewPersona={() => window.location.reload()}
          embeddedWall
        />
      </div>
    </main>
  );
}
