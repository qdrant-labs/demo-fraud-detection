// Phase 4 gate: for 3 alerted generator events, fetch the rendered /alert/[id]
// page over plain HTTP and assert the score recomputed server-side (from the
// pinned neighbor vectors) equals the score stored in Qdrant, to 4 decimals.
//
// The page embeds both numbers as data attributes so this check parses them
// without scraping prose. Run gate-wall first so alerted generator events exist.
//
// Run (with `npm run dev` up): npx tsx --env-file=.env scripts/gate-evidence.ts

import { COLLECTION, qdrant } from "../src/lib/qdrant";

const BASE = process.env.WALL_URL ?? "http://localhost:3000";
const WANT = 3;

function attr(html: string, name: string): number | null {
  const m = html.match(new RegExp(`${name}="([-0-9.]+)"`));
  return m ? Number(m[1]) : null;
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
    const resp = await fetch(`${BASE}/alert/${id}`);
    if (!resp.ok) {
      console.log(`  FAIL  ${id}  HTTP ${resp.status}`);
      failures++;
      continue;
    }
    const html = await resp.text();
    const pageStored = attr(html, "data-stored-score");
    const recomputed = attr(html, "data-recomputed-score");
    const dEvent = attr(html, "data-recomputed-d-event");
    const dLocal = attr(html, "data-recomputed-d-local");

    if (pageStored === null || recomputed === null) {
      console.log(`  FAIL  ${id}  score attributes missing`);
      failures++;
      continue;
    }
    // Round both to 4 decimals and compare.
    const ok =
      pageStored.toFixed(4) === recomputed.toFixed(4) &&
      stored.toFixed(4) === recomputed.toFixed(4);
    if (!ok) failures++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${id}  stored=${stored.toFixed(4)} page-stored=${pageStored.toFixed(4)} recomputed=${recomputed.toFixed(4)} (d_event=${dEvent?.toFixed(3)}, d_local=${dLocal?.toFixed(3)})`,
    );
  }

  console.log(failures === 0 ? "\nGATE PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
