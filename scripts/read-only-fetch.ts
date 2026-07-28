// A read-only lock on the Qdrant REST client, for measuring against the LIVE
// collection.
//
// `persist: false` is not enough on its own: an alerted event upserts anyway
// (src/lib/score.ts, the `persist = alerted || ...` line), and
// ensureCollection() issues five createPayloadIndex writes. So instead of
// promising not to write, this replaces global fetch and lets exactly two
// requests out of the process - the context scroll and the kNN query that
// scoreEvent makes. Everything else throws WriteBlocked before it reaches the
// cluster. @qdrant/js-client-rest resolves the global `fetch` at call time
// (openapi-typescript-fetch calls the bare identifier), so wrapping it here
// covers the calls made inside the client.
//
// It also taps Qdrant's own `time` field off each response, which is the
// server-side processing time with no network in it. That is the number a
// same-region caller pays, measured from anywhere.
//
// Verified by scripts/read-only-fetch.test.ts against a stub server: a real
// QdrantClient's upsert, delete, createPayloadIndex and createCollection are all
// refused, and no request for them reaches the wire.

const ALLOWED_POST = ["/points/scroll", "/points/query"];

export class WriteBlocked extends Error {}

// Qdrant's self-reported processing time per stage, in ms, in request order.
// Collected only while `tapping` is on, so a warmup phase does not land in the
// measured series.
export const srvTime: { scroll: number[]; query: number[] } = { scroll: [], query: [] };

export const guard = { tapping: false, blocked: 0 };

export function installReadOnlyFetch(): void {
  const realFetch = globalThis.fetch;

  globalThis.fetch = async function readOnlyFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const path = new URL(url).pathname;

    if (method !== "GET") {
      const allowed = method === "POST" && ALLOWED_POST.some((p) => path.endsWith(p));
      if (!allowed) {
        guard.blocked++;
        throw new WriteBlocked(`read-only fetch blocked ${method} ${path}`);
      }
    }

    const res = await realFetch(input, init);

    const stage = path.endsWith("/points/scroll")
      ? "scroll"
      : path.endsWith("/points/query")
        ? "query"
        : null;
    // The clone is parsed off the hot path and never awaited here, so the parse
    // cannot land inside the stage window score.ts is timing.
    if (guard.tapping && stage && res.ok) {
      res
        .clone()
        .json()
        .then((j: { time?: number }) => {
          if (typeof j.time === "number") srvTime[stage].push(j.time * 1000);
        })
        .catch(() => {});
    }
    return res;
  };
}
