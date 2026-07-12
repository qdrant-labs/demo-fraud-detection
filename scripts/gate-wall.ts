// Phase 3 gate: connect to the running dev server's /api/stream as an SSE
// client, force a reconnect every ~2 minutes over a ~10-minute run, and assert
// the wall's determinism + liveness contract.
//
// Asserts:
//   - determinism: an event ID that arrives again (across a reconnect) carries
//     identical GENERATED content (tenant, amount, merchant, ts). The score is
//     NOT checked: it reads live collection state, so re-scoring the same event
//     later legitimately drifts. The wall's contract is deterministic event
//     generation plus idempotent upserts, not a frozen score.
//   - buckets monotonic within each connection (the server-emitted processing
//     bucket, not ts: injected motif events carry future timestamps by design).
//   - at least one alerted event over the run (motif injection is ~10% of buckets).
//   - no delivery gap longer than ~10 s.
//   - reports p95 total scoring time from the events' stage timings.
//
// Run (with `npm run dev` already up):
//   npx tsx --env-file=.env scripts/gate-wall.ts [totalSec] [reconnectSec]

const BASE = process.env.WALL_URL ?? "http://localhost:3000";
const TOTAL_MS = (Number(process.argv[2]) || 600) * 1000;
const RECONNECT_MS = (Number(process.argv[3]) || 120) * 1000;
const GAP_LIMIT_MS = 10_000;

interface WallEvent {
  id: string | number;
  tenant_id: string;
  ts: string;
  amount: number;
  merchant: string;
  score: number;
  alerted: boolean;
  bucket: number | null;
  timings: { total: number } | null;
}

// State across the whole run (survives reconnects).
const sigById = new Map<string | number, string>();
let rawArrivals = 0;
let duplicates = 0;
let determinismMismatches = 0;
let alertedCount = 0;
let maxGapMs = 0;
let lastDeliveryAt = 0;
const latencies: number[] = [];

// Per-connection bucket monotonicity.
let bucketViolations = 0;

// Deterministic content signature: what the generator produced, independent of
// live-state-dependent scoring.
function sigOf(ev: WallEvent): string {
  return `${ev.tenant_id}|${ev.ts}|${ev.amount}|${ev.merchant}`;
}

function onEvent(ev: WallEvent, connState: { lastBucket: number }): void {
  rawArrivals++;
  const now = Date.now();
  if (lastDeliveryAt > 0) maxGapMs = Math.max(maxGapMs, now - lastDeliveryAt);
  lastDeliveryAt = now;

  // Bucket monotonicity within this connection (generator events carry a bucket).
  if (ev.bucket !== null) {
    if (ev.bucket < connState.lastBucket) bucketViolations++;
    connState.lastBucket = Math.max(connState.lastBucket, ev.bucket);
  }

  const sig = sigOf(ev);
  if (sigById.has(ev.id)) {
    duplicates++;
    if (sigById.get(ev.id) !== sig) determinismMismatches++;
    return; // deduped, not "delivered" again
  }
  sigById.set(ev.id, sig);
  if (ev.alerted) alertedCount++;
  if (ev.timings) latencies.push(ev.timings.total);
}

// Read one SSE connection until aborted, calling `handle` for each tx event.
async function readConnection(
  signal: AbortSignal,
  handle: (ev: WallEvent) => void,
): Promise<void> {
  const resp = await fetch(`${BASE}/api/stream`, {
    signal,
    headers: { accept: "text/event-stream" },
  });
  if (!resp.ok || !resp.body) throw new Error(`stream HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (event === "tx" && data) handle(JSON.parse(data) as WallEvent);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  } finally {
    reader.releaseLock();
  }
}

// Two connections open at once regenerate the same buckets, so their event IDs
// must overlap and every shared ID must carry identical generated content. This
// exercises the determinism claim directly, without depending on abort timing.
async function determinismProbe(seconds: number): Promise<{ overlap: number; mismatches: number }> {
  const a = new Map<string | number, string>();
  const b = new Map<string | number, string>();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), seconds * 1000);
  try {
    await Promise.all([
      readConnection(ac.signal, (ev) => a.set(ev.id, sigOf(ev))),
      readConnection(ac.signal, (ev) => b.set(ev.id, sigOf(ev))),
    ]);
  } finally {
    clearTimeout(timer);
  }
  let overlap = 0;
  let mismatches = 0;
  for (const [id, sig] of a) {
    if (b.has(id)) {
      overlap++;
      if (b.get(id) !== sig) mismatches++;
    }
  }
  return { overlap, mismatches };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const started = Date.now();
  let reconnects = 0;
  console.log(
    `Gate: ${TOTAL_MS / 1000}s run, reconnect every ${RECONNECT_MS / 1000}s, target ${BASE}/api/stream`,
  );

  console.log("  Determinism probe: two concurrent connections for 8s...");
  const probe = await determinismProbe(8);
  console.log(`  probe: ${probe.overlap} shared IDs, ${probe.mismatches} content mismatches`);

  while (Date.now() - started < TOTAL_MS) {
    const ac = new AbortController();
    const killAt = Math.min(RECONNECT_MS, TOTAL_MS - (Date.now() - started));
    const timer = setTimeout(() => ac.abort(), killAt);
    const connState = { lastBucket: -Infinity };
    try {
      await readConnection(ac.signal, (ev) => onEvent(ev, connState));
    } catch (err) {
      console.error("connection error:", (err as Error).message);
      // Back off before retrying: a browser EventSource does this natively;
      // without it a dead server turns this loop into a reconnect storm.
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      clearTimeout(timer);
    }
    reconnects++;
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `  [${elapsed}s] reconnect #${reconnects}: ${sigById.size} unique, ${duplicates} deduped, ${alertedCount} alerts`,
    );
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = pct(sorted, 50);
  const p95 = pct(sorted, 95);

  console.log("\n=== Phase 3 Gate Summary ===");
  const rows: [string, string, boolean][] = [
    ["Raw arrivals", String(rawArrivals), true],
    ["Unique events delivered", String(sigById.size), true],
    ["Duplicates deduped", String(duplicates), true],
    ["Determinism probe: shared IDs", String(probe.overlap), probe.overlap > 0],
    ["Determinism probe: mismatches", String(probe.mismatches), probe.mismatches === 0],
    ["Reconnect determinism mismatches", String(determinismMismatches), determinismMismatches === 0],
    ["Bucket monotonicity violations", String(bucketViolations), bucketViolations === 0],
    ["Alerted events", String(alertedCount), alertedCount >= 1],
    ["Max delivery gap (ms)", String(maxGapMs), maxGapMs <= GAP_LIMIT_MS],
    ["Reconnects", String(reconnects), true],
    ["p50 total scoring (ms)", p50.toFixed(1), true],
    ["p95 total scoring (ms)", p95.toFixed(1), true],
  ];
  for (const [k, v, ok] of rows) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${k.padEnd(32)} ${v}`);
  }

  const passed =
    probe.overlap > 0 &&
    probe.mismatches === 0 &&
    determinismMismatches === 0 &&
    bucketViolations === 0 &&
    alertedCount >= 1 &&
    maxGapMs <= GAP_LIMIT_MS;
  console.log(passed ? "\nGATE PASSED" : "\nGATE FAILED");
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
