// Phase 5 gate: the browser-attack hero moment on the single-page wall. With the
// dev server up, this connects an SSE client to /api/stream (simulating the
// projected wall), assigns a persona via GET /api/persona, then launches each of
// the three attack cards and measures the flare end to end.
//
// Per motif it asserts / reports:
//   (a) time from POST start to the first scored event in the attack stream
//   (b) time from POST start to that event ID arriving on the wall SSE (flare)
//   (c) highest score and whether it alerted
//   (d) GET /api/alert/[id] returns 200, reports alerted:true, and its stored
//       score matches the attack's reported highest score
// Every motif's highest-scoring event MUST alert (the demo's hero). A motif
// that fails to alert is a FAILING gate: scores are reported honestly and no
// threshold is tuned to force a pass.
//
// Also: a repeat-launch check (same persona + motif twice -> distinct IDs, both
// alert).
//
// Run (with `npm run dev` already up):
//   npx tsx --env-file=.env scripts/gate-hero.ts

const BASE = process.env.WALL_URL ?? "http://localhost:3000";
const MOTIFS = ["geo_hop", "card_testing", "ladder"] as const;
type Motif = (typeof MOTIFS)[number];

const SCORE_TOLERANCE = 1e-3;
const FLARE_TIMEOUT_MS = 8000;

// Assign a tenant the way the wall's drawer does: GET /api/persona.
async function assignTenant(): Promise<string> {
  const resp = await fetch(`${BASE}/api/persona`);
  if (!resp.ok) throw new Error(`persona HTTP ${resp.status}`);
  const { tenantId } = (await resp.json()) as { tenantId: string };
  return tenantId;
}

interface AttackResult {
  firstEventMs: number;
  ids: string[];
  highScore: number;
  highId: string;
  alerted: boolean;
}

// POST an attack and read its NDJSON stream. Returns first-event latency, all
// event IDs, and the summary's highest score / id / alert flag.
async function launch(tenant: string, motif: Motif): Promise<AttackResult> {
  const start = Date.now();
  const resp = await fetch(`${BASE}/api/attack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant_id: tenant,
      motif,
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  });
  if (!resp.ok || !resp.body) throw new Error(`attack HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstEventMs = -1;
  const ids: string[] = [];
  let summary: { highScore: number; highId: string; alerted: boolean } | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const raw = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!raw) continue;
      const line = JSON.parse(raw);
      if (line.type === "event") {
        if (firstEventMs < 0) firstEventMs = Date.now() - start;
        ids.push(line.id);
      } else if (line.type === "summary") {
        summary = { highScore: line.highScore, highId: line.highId, alerted: line.alerted };
      } else if (line.type === "error") {
        throw new Error(`attack stream error: ${line.message}`);
      }
    }
  }
  if (!summary) throw new Error("attack stream ended without a summary");
  return { firstEventMs, ids, ...summary };
}

// A persistent wall SSE reader that records the arrival time of every event ID.
class WallReader {
  arrivals = new Map<string | number, number>();
  private ac = new AbortController();
  private ready: Promise<void>;

  constructor() {
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    void this.read(resolveReady);
  }

  private async read(onFirst: () => void): Promise<void> {
    const resp = await fetch(`${BASE}/api/stream`, {
      signal: this.ac.signal,
      headers: { accept: "text/event-stream" },
    });
    if (!resp.ok || !resp.body) throw new Error(`stream HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let first = true;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (first) {
          onFirst();
          first = false;
        }
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = "message";
          let data = "";
          for (const l of block.split("\n")) {
            if (l.startsWith("event:")) event = l.slice(6).trim();
            else if (l.startsWith("data:")) data += l.slice(5).trim();
          }
          if (event === "tx" && data) {
            const ev = JSON.parse(data) as { id: string | number };
            if (!this.arrivals.has(ev.id)) this.arrivals.set(ev.id, Date.now());
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    }
  }

  waitReady(): Promise<void> {
    return this.ready;
  }

  // Wait until `id` has arrived on the wall; resolve its arrival timestamp.
  async waitFor(id: string, timeoutMs: number): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const at = this.arrivals.get(id);
      if (at !== undefined) return at;
      await new Promise((r) => setTimeout(r, 40));
    }
    return null;
  }

  stop(): void {
    this.ac.abort();
  }
}

async function evidenceOf(
  id: string,
): Promise<{ status: number; storedScore: number | null; alerted: boolean }> {
  const resp = await fetch(`${BASE}/api/alert/${id}`);
  if (!resp.ok) return { status: resp.status, storedScore: null, alerted: false };
  const data = (await resp.json()) as { stored: { score: number | null }; alerted: boolean };
  return { status: resp.status, storedScore: data.stored.score, alerted: data.alerted };
}

interface MotifReport {
  motif: Motif;
  tenant: string;
  firstEventMs: number;
  flareMs: number | null;
  highScore: number;
  alerted: boolean;
  alertStatus: number;
  alertPageAlerted: boolean;
  storedScore: number | null;
  scoreMatch: boolean;
}

async function main() {
  console.log(`Phase 5 gate against ${BASE}`);
  console.log("Connecting a wall SSE client (simulating the projected wall)...");
  const wall = new WallReader();
  await wall.waitReady();
  // Give the wall a moment to establish its first poll before launching.
  await new Promise((r) => setTimeout(r, 800));

  const reports: MotifReport[] = [];
  for (const motif of MOTIFS) {
    const tenant = await assignTenant();
    const postStart = Date.now();
    const res = await launch(tenant, motif);
    const flareAt = await wall.waitFor(res.highId, FLARE_TIMEOUT_MS);
    const flareMs = flareAt === null ? null : flareAt - postStart;
    const alert = await evidenceOf(res.highId);
    const scoreMatch =
      alert.storedScore !== null && Math.abs(alert.storedScore - res.highScore) < SCORE_TOLERANCE;

    reports.push({
      motif,
      tenant,
      firstEventMs: res.firstEventMs,
      flareMs,
      highScore: res.highScore,
      alerted: res.alerted,
      alertStatus: alert.status,
      alertPageAlerted: alert.alerted,
      storedScore: alert.storedScore,
      scoreMatch,
    });
    console.log(
      `  ${motif.padEnd(13)} tenant=${tenant} firstEvent=${res.firstEventMs}ms ` +
        `flare=${flareMs === null ? "MISS" : flareMs + "ms"} high=${res.highScore.toFixed(2)}x ` +
        `alerted=${res.alerted} alertHTTP=${alert.status} alertPageAlerted=${alert.alerted} scoreMatch=${scoreMatch}`,
    );
  }

  // Repeat-launch: same persona + motif twice -> distinct IDs, both alert. Uses
  // geo_hop (a reliable alerter) so this isolates ID uniqueness + idempotency
  // from any motif-level detection question.
  const repeatTenant = await assignTenant();
  const r1 = await launch(repeatTenant, "geo_hop");
  const r2 = await launch(repeatTenant, "geo_hop");
  const overlap = r1.ids.filter((id) => r2.ids.includes(id));
  const distinctIds = overlap.length === 0;
  const bothAlert = r1.alerted && r2.alerted;
  console.log(
    `\nRepeat-launch (tenant=${repeatTenant}, geo_hop x2): distinctIds=${distinctIds} ` +
      `(overlap=${overlap.length}) bothAlert=${bothAlert} (${r1.highScore.toFixed(2)}x, ${r2.highScore.toFixed(2)}x)`,
  );

  wall.stop();

  // --- Verdict ---
  const flares = reports.map((r) => r.flareMs).filter((m): m is number => m !== null);
  console.log("\n=== Phase 5 Gate Summary ===");
  const rows: [string, string, boolean][] = [];
  for (const r of reports) {
    rows.push([`${r.motif} alerted`, `${r.highScore.toFixed(2)}x`, r.alerted]);
    rows.push([`${r.motif} alert api 200`, String(r.alertStatus), r.alertStatus === 200]);
    rows.push([`${r.motif} alert api alerted`, String(r.alertPageAlerted), r.alertPageAlerted]);
    rows.push([`${r.motif} score matches`, r.storedScore === null ? "—" : r.storedScore.toFixed(3), r.scoreMatch]);
    rows.push([`${r.motif} flare seen`, r.flareMs === null ? "MISS" : `${r.flareMs}ms`, r.flareMs !== null]);
  }
  rows.push(["Repeat-launch distinct IDs", `overlap ${overlap.length}`, distinctIds]);
  rows.push(["Repeat-launch both alert", `${r1.highScore.toFixed(2)}/${r2.highScore.toFixed(2)}`, bothAlert]);
  for (const [k, v, ok] of rows) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${k.padEnd(30)} ${v}`);
  }

  if (flares.length) {
    const sorted = [...flares].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
    console.log(
      `\nFlare latency: min=${sorted[0]}ms max=${sorted[sorted.length - 1]}ms p95=${p95}ms (POST start -> wall).`,
    );
  }
  console.log(
    "Local Qdrant RTT is ~100 ms/round trip to us-west-2, 3 trips per scored event; " +
      "a region-pinned Vercel function collapses that.",
  );

  const passed =
    reports.every(
      (r) =>
        r.alerted &&
        r.alertStatus === 200 &&
        r.alertPageAlerted &&
        r.scoreMatch &&
        r.flareMs !== null,
    ) &&
    distinctIds &&
    bothAlert;
  console.log(passed ? "\nGATE PASSED" : "\nGATE FAILED");
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export {};
