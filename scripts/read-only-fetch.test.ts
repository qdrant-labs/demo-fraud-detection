// Proves the read-only lock before it is trusted against the live collection.
//
// A stub HTTP server stands in for Qdrant and records every request that
// actually reaches the wire. A real QdrantClient is pointed at it, the lock is
// installed, and each call the demo could make is attempted. The two reads must
// arrive; every write must throw WriteBlocked and leave no trace on the server.
//
//   npx tsx scripts/read-only-fetch.test.ts
//
// No cluster, no credentials, no network.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { QdrantClient } from "@qdrant/js-client-rest";
import { guard, installReadOnlyFetch, srvTime, WriteBlocked } from "./read-only-fetch";

const seen: string[] = [];

const server = createServer((req, res) => {
  seen.push(`${req.method} ${req.url?.split("?")[0]}`);
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  // Shapes the client accepts, plus the `time` field the tap reads.
  const body = req.url?.includes("/points/scroll")
    ? { result: { points: [], next_page_offset: null }, status: "ok", time: 0.004 }
    : req.url?.includes("/points/query")
      ? { result: { points: [] }, status: "ok", time: 0.007 }
      : req.url === "/"
        ? { title: "qdrant - vector search engine", version: "1.18.2", commit: "stub" }
        : { result: true, status: "ok", time: 0.001 };
  res.end(JSON.stringify(body));
});

async function expectBlocked(what: string, fn: () => Promise<unknown>): Promise<void> {
  const before = seen.length;
  await assert.rejects(fn, WriteBlocked, `${what} should have been blocked`);
  assert.equal(seen.length, before, `${what} reached the wire`);
}

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  installReadOnlyFetch();
  guard.tapping = true;
  const q = new QdrantClient({ url: `http://127.0.0.1:${port}`, apiKey: "stub" });

  // The two reads scoreEvent makes must go through.
  await q.scroll("c", { limit: 1 });
  await q.query("c", { query: [0], limit: 1 });
  // The client's own version check issues a GET /, so compare the writes-capable
  // methods only.
  assert.deepEqual(
    seen.filter((s) => !s.startsWith("GET ")),
    ["POST /collections/c/points/scroll", "POST /collections/c/points/query"],
  );

  // Everything that would mutate the live collection must not.
  await expectBlocked("upsert", () =>
    q.upsert("c", { wait: true, points: [{ id: 1, vector: { features: [0] } }] }),
  );
  await expectBlocked("delete points", () => q.delete("c", { wait: true, points: [1] }));
  await expectBlocked("delete by filter", () =>
    q.delete("c", { wait: true, filter: { must: [{ key: "score", match: { value: 1 } }] } }),
  );
  await expectBlocked("createPayloadIndex", () =>
    q.createPayloadIndex("c", { field_name: "ts", field_schema: "datetime", wait: true }),
  );
  await expectBlocked("createCollection", () =>
    q.createCollection("c", { vectors: { features: { size: 1, distance: "Euclid" } } }),
  );
  await expectBlocked("deleteCollection", () => q.deleteCollection("c"));
  await expectBlocked("updateCollection", () =>
    q.updateCollection("c", { optimizers_config: { indexing_threshold: 0 } }),
  );
  await expectBlocked("setPayload", () => q.setPayload("c", { payload: { a: 1 }, points: [1] }));

  // Reads that are not the scored path still work: the script needs collection
  // info, and GET carries no risk.
  await q.getCollection("c");
  assert.ok(seen.includes("GET /collections/c"));

  // The tap read Qdrant's own processing time off both stages, in ms.
  await new Promise((r) => setImmediate(r)); // clone().json() resolves a microtask later
  assert.deepEqual(srvTime.scroll, [4]);
  assert.deepEqual(srvTime.query, [7]);

  assert.equal(guard.blocked, 8);
  console.log(`read-only lock OK: 2 reads through, ${guard.blocked} writes blocked, srv time tapped`);
  server.close();
}

main().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
