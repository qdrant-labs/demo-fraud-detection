// Splits a scoring stage's wall time at the fetch boundary, to attribute the
// ~100 ms per-decision cost measured on the deployment (Qdrant reports 1.9 ms
// for the same work, and locally the whole stack costs ~5 ms per call, so the
// overhead is specific to the deployed environment).
//
// fetch resolves at response HEADERS, so per stage:
//   stage wall - fetch wall  = the JS client's body read + parse + validation
//   fetch wall - engine time = network + TLS + platform scheduling
//
// Timing is scoped per withFetchTiming() call via AsyncLocalStorage, so
// concurrent SSE viewers on one instance each read their own slot. Fetches
// outside a timed scope pass through the wrapper untouched. Evals and bench
// scripts never enter a scope, and lastFetchMs() returns null there.
// scripts/read-only-fetch.ts also replaces global fetch, but the two never run
// in the same process (this is app code, that is bench tooling).

import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<{ lastMs: number | null }>();
let installed = false;

// Run one scored event inside its own timing scope.
export function withFetchTiming<T>(fn: () => Promise<T>): Promise<T> {
  install();
  return scope.run({ lastMs: null }, fn);
}

// The wall time of the most recent fetch inside the current scope.
export function lastFetchMs(): number | null {
  return scope.getStore()?.lastMs ?? null;
}

function install(): void {
  if (installed) return;
  installed = true;
  const real = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const store = scope.getStore();
    if (!store) return real(...args);
    const t0 = performance.now();
    try {
      return await real(...args);
    } finally {
      store.lastMs = performance.now() - t0;
    }
  };
}
