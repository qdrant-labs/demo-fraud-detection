// Proves a FAILED ensureCollection() is not memoized.
//
// The 2026-07-31 outage: the cloud cluster restarted at 15:41 UTC and came back
// with the collection intact. The wall stayed on "Reconnecting" for an hour
// anyway, until a redeploy at 16:41 UTC of the same commit brought it back.
//
// The cause was module state, not the cluster. `src/app/api/stream/route.ts`
// awaits ensureCollection() on its first line, and the memo in qdrant.ts held a
// REJECTED promise: `??=` only assigns when the target is nullish, and a
// rejected promise is not nullish. So one failure against the restarting cluster
// stuck to the warm serverless instance, every EventSource reconnect re-threw
// the original error, and only replacing the instances cleared it.
//
// A stub HTTP server stands in for Qdrant: unavailable first, healthy after.
// The second call must reach the wire again; the third must not.
//
//   npx tsx scripts/ensure-collection.test.ts
//
// No cluster, no credentials, no network beyond loopback.

import assert from "node:assert/strict";
import { createServer } from "node:http";

let down = true; // flipped once the "cluster" finishes restarting
const seen: string[] = [];

const server = createServer((req, res) => {
  const path = req.url?.split("?")[0] ?? "";
  req.resume();

  // The client's own version check. Not part of what ensureCollection does, so
  // it is answered but not recorded.
  if (path === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ title: "qdrant - vector search engine", version: "1.18.2", commit: "stub" }),
    );
    return;
  }

  seen.push(`${req.method} ${path}`);

  if (down) {
    // What a restarting cluster serves while it reloads its collections.
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: { error: "Service unavailable" }, time: 0 }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(
      path.endsWith("/exists")
        ? { result: { exists: true }, status: "ok", time: 0.001 }
        : { result: { operation_id: 1, status: "completed" }, status: "ok", time: 0.001 },
    ),
  );
});

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  // Environment first, THEN import: qdrant.ts captures COLLECTION at import time
  // and a static import would hoist above these assignments.
  process.env.QDRANT_URL = `http://127.0.0.1:${port}`;
  process.env.QDRANT_COLLECTION = "ensure_probe";
  delete process.env.QDRANT_API_KEY;
  const { COLLECTION, ensureCollection } = await import("../src/lib/qdrant");
  assert.equal(COLLECTION, "ensure_probe", "the stub collection name did not take");

  // 1. The cluster is down, so the call fails. Expected, and fine on its own.
  await assert.rejects(ensureCollection(), /Service Unavailable/);
  const afterFailure = seen.length;
  assert.ok(afterFailure > 0, "the first ensure never reached the wire");

  // 2. The cluster is back. The next call must RETRY. This is the regression:
  //    with the failure memoized it re-throws without touching the wire, and the
  //    only cure is a redeploy.
  down = false;
  await ensureCollection().catch((err: Error) => {
    // The stack on `err` points at the FIRST call above, because it IS the first
    // call's rejection replayed out of the memo. That is the whole defect.
    throw new Error(
      `a failed ensure was memoized: the retry replayed the first rejection (${err.message})`,
    );
  });
  assert.ok(seen.length > afterFailure, "the retry never reached the wire");

  // 3. A SUCCESSFUL ensure stays memoized - the SSE route calls this on every
  //    connection and must not pay 6 round trips per reconnect.
  const afterSuccess = seen.length;
  await ensureCollection();
  assert.equal(seen.length, afterSuccess, "a successful ensure should not re-run");

  console.log(
    `ensureCollection OK: failure retried (${afterSuccess - afterFailure} calls), success memoized`,
  );
  server.close();
}

main().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
