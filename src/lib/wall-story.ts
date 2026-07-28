// The wall's event and story model: the wire shape the SSE stream delivers, and
// the pure queue logic that turns alerted events into the story rail.
//
// Split out of the wall so the queue rules are readable and checkable on their
// own. Both reducers are pure and take the pinned story's id, because the two
// rules that have broken before are both about the pinned story surviving:
// a burst must not push it past the cap, and the TTL must not expire it while a
// viewer is reading it. The self-check at the bottom pins both.
//
// No node imports here: the wall is a client component.

// The wire shape the wall consumes. Narrower than the stream route's own
// interface on purpose: the route's version pulls StageTimings from score.ts and
// Contrast from explain.ts, both of which reach world.ts (node:crypto), so the
// client keeps its own copy of the fields it renders.
export interface WallEvent {
  id: string | number;
  tenant_id: string;
  ts: string;
  amount: number;
  currency: string;
  merchant: string;
  city: string;
  lat: number;
  lon: number;
  home_city: string;
  home_lat: number;
  home_lon: number;
  score: number;
  alerted: boolean;
  explanation: string;
  // Generator events carry the full per-stage timings; browser-attack pickups
  // are replayed from payload, not rescored, so theirs is null.
  timings: { scroll: number; knn: number; upsert: number; total: number } | null;
  // Alerted events only.
  vector?: number[];
  neighbor_ids?: (string | number)[];
  d_event?: number;
  d_local?: number;
  // "This charge vs this customer's normal" rows (shape mirrors explain.ts Contrast).
  contrasts?: { field: string; event: string; usual: string }[];
}

// One coalesced attack. A burst of alerts from the same customer within
// COALESCE_MS is one story, not six.
export interface Story {
  id: string; // first event's id
  tenant_id: string;
  events: WallEvent[]; // all alerted, newest appended
  home: { city: string; lat: number; lon: number };
  lastAt: number; // performance.now() of the last appended event
  played: boolean;
}

// The queue's four tuning knobs. The first two are read only by the reducers
// below; the wall reads the TTL pair for the story card's fade.
const COALESCE_MS = 20_000; // same-customer alerts within this window = one story
const STORY_CAP = 10; // stories kept in the rail, newest first; oldest is dropped
export const STORY_TTL_MS = 60_000; // unpinned queue entries fade out and drop after this
export const STORY_FADE_MS = 5_000; // fade duration at the end of the TTL

// The story's worst charge. One function so the queue card, the alert header,
// and the "How This Alert Was Caught" arithmetic all point at the same event —
// picking it independently in each place is how the header ratio and the
// panel's ratio used to drift apart on multi-charge stories.
export function topEvent(story: Story): WallEvent {
  return story.events.reduce((m, e) => (e.score > m.score ? e : m), story.events[0]);
}

// Coalesce an alerted event into an existing same-customer story within
// COALESCE_MS (whether or not it is displayed), else start a new story at the
// front of the rail. Appends keep events[0] stable, which the panel memo needs.
export function enqueue(
  prev: Story[],
  ev: WallEvent,
  now: number,
  pinnedId: string | null,
): Story[] {
  const idx = prev.findIndex(
    (s) => s.tenant_id === ev.tenant_id && now - s.lastAt < COALESCE_MS,
  );
  if (idx !== -1) {
    const s = prev[idx];
    const updated: Story = { ...s, events: [...s.events, ev], lastAt: now };
    const next = [...prev];
    next[idx] = updated;
    return next;
  }
  const story: Story = {
    id: String(ev.id),
    tenant_id: ev.tenant_id,
    events: [ev],
    home: { city: ev.home_city, lat: ev.home_lat, lon: ev.home_lon },
    lastAt: now,
    played: false,
  };
  // Newest first; drop the oldest past the cap, but never evict the story the
  // viewer has pinned. Under a burst of alerts the pinned (older) story would
  // otherwise slide past the cap and its panel would vanish mid-view.
  const all = [story, ...prev];
  if (all.length <= STORY_CAP) return all;
  const kept = all.slice(0, STORY_CAP);
  if (pinnedId && !kept.some((s) => s.id === pinnedId)) {
    const pinned = all.find((s) => s.id === pinnedId);
    if (pinned) return [...all.slice(0, STORY_CAP - 1), pinned];
  }
  return kept;
}

// Drop queue entries past their TTL. The pinned story is exempt so a viewer who
// is studying one never has it yanked away; it expires after unpinning. Returns
// the same array when nothing dropped, so an unchanged queue does not re-render.
export function expire(prev: Story[], now: number, pinnedId: string | null): Story[] {
  const next = prev.filter((s) => s.id === pinnedId || now - s.lastAt < STORY_TTL_MS);
  return next.length === prev.length ? prev : next;
}

// Self-check (run: npx tsx src/lib/wall-story.ts). Guarded so the browser bundle
// never touches process. Same pattern as mapview.ts.
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("wall-story.ts")) {
  const assert = (ok: boolean, msg: string) => {
    if (!ok) throw new Error("wall-story self-check failed: " + msg);
  };
  const ev = (id: string, tenant: string, score = 1): WallEvent =>
    ({
      id,
      tenant_id: tenant,
      ts: "2026-07-28T00:00:00.000Z",
      amount: 10,
      currency: "USD",
      merchant: "M",
      city: "London",
      lat: 51.5,
      lon: -0.1,
      home_city: "London",
      home_lat: 51.5,
      home_lon: -0.1,
      score,
      alerted: true,
      explanation: "",
      timings: null,
    }) as WallEvent;

  // Same customer inside the window coalesces into one story, newest appended,
  // and events[0] stays put (the panel memo depends on that identity).
  let q = enqueue([], ev("a1", "t1"), 1000, null);
  q = enqueue(q, ev("a2", "t1"), 2000, null);
  assert(q.length === 1 && q[0].events.length === 2, "coalesce same customer");
  assert(q[0].events[0].id === "a1" && q[0].id === "a1", "lead event stable");

  // Past the window it starts a new story at the front.
  q = enqueue(q, ev("a3", "t1"), 2000 + COALESCE_MS + 1, null);
  assert(q.length === 2 && q[0].id === "a3", "new story past the window");

  // topEvent picks the worst charge, not the first.
  const multi = enqueue(enqueue([], ev("b1", "t2", 2.1), 0, null), ev("b2", "t2", 5.4), 10, null);
  assert(topEvent(multi[0]).id === "b2", "topEvent picks the worst charge");

  // The cap drops the oldest when nothing is pinned...
  let cap: Story[] = [];
  for (let i = 0; i < STORY_CAP + 3; i++) {
    cap = enqueue(cap, ev(`c${i}`, `t${i}`), i * (COALESCE_MS + 1), null);
  }
  assert(cap.length === STORY_CAP, "cap holds");
  assert(!cap.some((s) => s.id === "c0"), "oldest dropped when nothing is pinned");

  // ...but the pinned story survives it (the booth bug: a burst evicted the
  // story the viewer had pinned and its panel vanished mid-alert).
  let pin: Story[] = [];
  for (let i = 0; i < STORY_CAP; i++) {
    pin = enqueue(pin, ev(`p${i}`, `t${i}`), i * (COALESCE_MS + 1), null);
  }
  const oldest = pin[pin.length - 1].id;
  for (let i = 0; i < 5; i++) {
    pin = enqueue(pin, ev(`x${i}`, `u${i}`), (STORY_CAP + i) * (COALESCE_MS + 1), oldest);
  }
  assert(pin.length === STORY_CAP, "cap still holds with a pin");
  assert(pin.some((s) => s.id === oldest), "pinned story survives the cap");

  // The TTL drops stale entries, spares the pinned one, and keeps array identity
  // when nothing expired.
  const fresh = enqueue([], ev("d1", "t9"), 0, null);
  assert(expire(fresh, STORY_TTL_MS - 1, null) === fresh, "identity kept when nothing expires");
  assert(expire(fresh, STORY_TTL_MS + 1, null).length === 0, "stale entry dropped");
  assert(expire(fresh, STORY_TTL_MS + 1, "d1").length === 1, "pinned entry exempt from the TTL");

  console.log("wall-story self-check ok");
}
