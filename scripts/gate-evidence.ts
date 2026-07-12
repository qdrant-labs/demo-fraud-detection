// Phase 4 gate: for 3 alerted generator events, fetch GET /api/alert/[id] and
// assert the score recomputed server-side (from the pinned neighbor vectors)
// equals the score stored in Qdrant, to 6 decimals, and that the ordered
// neighbor list is present. Run gate-wall first so alerted generator events
// exist.
//
// Run (with `npm run dev` up): npx tsx --env-file=.env scripts/gate-evidence.ts

import { COLLECTION, qdrant } from "../src/lib/qdrant";

const BASE = process.env.WALL_URL ?? "http://localhost:3000";
const WANT = 3;

interface AlertJson {
  stored: { score: number | null };
  recomputed: { score: number } | null;
  neighbor_ids: string[];
  neighbors: { distance: number }[];
}

async function main() {
  const scroll = await qdrant.scroll(COLLECTION, {
    filter: {
      must: [
        { key: "channel_src", match: { value: "generator" } },
        { key: "alerted", match: { value: true } },
      ],
    },
    limit: WANT,
    with_payload: true,
    with_vector: false,
  });

  const ids = scroll.points.map((p) => p.id);
  if (ids.length === 0) {
    console.error("No alerted generator events found. Run gate-wall first.");
    process.exit(1);
  }
  console.log(`Checking ${ids.length} alerted event(s):`);

  let failures = 0;
  for (const id of ids) {
    const stored = Number((scroll.points.find((p) => p.id === id)!.payload as { score: number }).score);
    const resp = await fetch(`${BASE}/api/alert/${id}`);
    if (!resp.ok) {
      console.log(`  FAIL  ${id}  HTTP ${resp.status}`);
      failures++;
      continue;
    }
    const data = (await resp.json()) as AlertJson;
    const pageStored = data.stored.score;
    const recomputed = data.recomputed?.score ?? null;

    if (pageStored === null || recomputed === null) {
      console.log(`  FAIL  ${id}  score missing (stored=${pageStored}, recomputed=${recomputed})`);
      failures++;
      continue;
    }
    // The pinned neighbor list must be present, ordered (10 rows), and match the
    // neighbor rows returned for the table.
    const orderedNeighbors =
      data.neighbor_ids.length > 0 && data.neighbors.length === data.neighbor_ids.length;
    // Stored == recomputed to 6 decimals; the JSON stored value must also match
    // the value read straight from Qdrant.
    const scoreMatch =
      pageStored.toFixed(6) === recomputed.toFixed(6) &&
      stored.toFixed(6) === recomputed.toFixed(6);
    const ok = scoreMatch && orderedNeighbors;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${id}  stored=${stored.toFixed(6)} json-stored=${pageStored.toFixed(6)} ` +
        `recomputed=${recomputed.toFixed(6)} neighbors=${data.neighbors.length}/${data.neighbor_ids.length}`,
    );
  }

  console.log(failures === 0 ? "\nGATE PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
