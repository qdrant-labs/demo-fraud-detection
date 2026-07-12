// Public browser attack launcher. POST { tenant_id, motif, nonce? } generates
// one of the three deterministic fraud motifs against a seeded persona, scores
// each event strictly in sequence (scoreEvent upserts before the next scores,
// so a burst's recent-history features see the burst forming), and streams the
// progress back as NDJSON so a phone on conference wifi sees per-event progress
// instead of a blank wait. Every scored event lands in Qdrant with channel_src
// = browser_attack, so the wall's pickup scroll flares it on the projected
// screen. This route is a public trust boundary: the body is validated before
// any Qdrant work.

import { scoreEvent } from "@/lib/score";
import {
  makeProfile,
  motifSequence,
  TENANT_COUNT,
  WORLD_SEED,
  type Motif,
} from "@/lib/world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MOTIFS = ["card_testing", "geo_hop", "ladder"] as const;
type AttackMotif = (typeof MOTIFS)[number];

function isMotif(v: unknown): v is AttackMotif {
  return typeof v === "string" && (MOTIFS as readonly string[]).includes(v);
}

// A seeded tenant is t0000..t0199 (TENANT_COUNT). Anything else is rejected.
function tenantIndex(v: unknown): number | null {
  if (typeof v !== "string" || !/^t\d{4}$/.test(v)) return null;
  const i = Number(v.slice(1));
  return i >= 0 && i < TENANT_COUNT ? i : null;
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Body must be JSON.");
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (!isMotif(b.motif)) {
    return badRequest("motif must be one of card_testing, geo_hop, ladder.");
  }
  const index = tenantIndex(b.tenant_id);
  if (index === null) {
    return badRequest("tenant_id must be a seeded tenant t0000-t0199.");
  }

  const motif = b.motif as Extract<Motif, AttackMotif>;
  const profile = makeProfile(index);
  const startTs = Date.now();
  // The seed makes IDs unique per launch: a second launch of the same card on
  // the same persona produces NEW deterministic IDs, not overwrites. A client
  // nonce is used when supplied; otherwise the launch timestamp.
  const nonce = typeof b.nonce === "string" && b.nonce ? b.nonce : String(startTs);
  const seed = `${WORLD_SEED}:launch:${nonce}`;

  const txs = motifSequence(motif, profile, startTs, seed, "browser_attack");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function line(obj: unknown): void {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      }

      let highScore = -Infinity;
      let highId: string | number = txs[0].id;
      let highAlerted = false;

      try {
        // STRICT sequence: event N upserted (inside scoreEvent) before N+1 is
        // scored, or the recent-history features never see the burst forming.
        for (let i = 0; i < txs.length; i++) {
          const tx = txs[i];
          const s = await scoreEvent(tx);
          if (s.score > highScore) {
            highScore = s.score;
            highId = tx.id;
            highAlerted = s.alerted;
          }
          line({
            type: "event",
            index: i,
            total: txs.length,
            id: tx.id,
            merchant: tx.merchant,
            city: tx.city,
            amount: tx.amount,
            currency: tx.currency,
            score: s.score,
            alerted: s.alerted,
            explanation: s.explanation,
          });
        }
        line({
          type: "summary",
          highScore,
          highId,
          alerted: highAlerted,
          alertPath: `/alert/${highId}`,
        });
      } catch (err) {
        line({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
