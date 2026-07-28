// Per-stage timing slots for the scorer's direct REST calls, used to attribute
// the deployed per-decision cost (Qdrant reports ~2 ms; the deployed function
// was measuring ~100 ms). qdrant.ts's restCall reports into the current scope:
//   fetch ms = request sent -> response HEADERS
//   body ms  = body read + JSON parse
// Scoped per withFetchTiming() call via AsyncLocalStorage, so concurrent SSE
// viewers on one instance each read their own slots. Evals and bench scripts
// never enter a scope; the report calls are no-ops and the getters return null.

import { AsyncLocalStorage } from "node:async_hooks";

interface Slots {
  lastMs: number | null;
  bodyMs: number | null;
}

const scope = new AsyncLocalStorage<Slots>();

// Run one scored event inside its own timing scope.
export function withFetchTiming<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ lastMs: null, bodyMs: null }, fn);
}

export function reportFetchMs(ms: number): void {
  const store = scope.getStore();
  if (store) store.lastMs = ms;
}

export function reportBodyMs(ms: number): void {
  const store = scope.getStore();
  if (store) store.bodyMs = ms;
}

// The most recent restCall's timings inside the current scope.
export function lastFetchMs(): number | null {
  return scope.getStore()?.lastMs ?? null;
}

export function lastBodyMs(): number | null {
  return scope.getStore()?.bodyMs ?? null;
}
