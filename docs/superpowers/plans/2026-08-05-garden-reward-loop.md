# Garden Reward Loop (Bundle 1 "The moment lands") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four structural drops in the garden's reward loop — stale query, fragile same-day preview, day-late refresh-mortal ceremony, zero event-triggered motion — per `docs/superpowers/specs/2026-08-05-garden-reward-loop-design.md`.

**Architecture:** Signal-driven query invalidation off `lastCorosReadAt`; `buildGardenView` preview folds forward read-only across unresolved gaps; a `garden_seen` watermark table + pure `selectArrival` selector replaces localStorage visit tracking and drives a sequential ceremony queue; renderer gains transform-only sprout-in, a single system-driven highlight, and an analytic one-shot impulse channel in the atmosphere canvas.

**Tech Stack:** Cloudflare Worker (Hono + Drizzle/D1), React 18 + TanStack Query, SVG renderer + canvas atmosphere, vitest.

## Global Constraints

- **Node 21 for all tests** (`pnpm test` — better-sqlite3 ABI is NODE_MODULE_VERSION 120; Node 22 fails `vertical-loop.test.ts` with an ABI error, which is environment, not code). Node 22 only for wrangler/builds. Machine default is 21.
- **`git commit` scans a multi-GB Rust `target/` tree and can SIGKILL** — always `git add <specific paths>`, never `git add -A`/`.`.
- **Engine `SIMULATION_VERSION` stays 3.** No changes under `packages/garden-engine/src` except none at all — this bundle touches worker/UI/renderer only.
- **Renderer determinism contract:** never extend an existing rng stream; new randomness needs fresh seeded keys; CSS entrance/glow must not change geometry draw order. Filters on at most ONE plant at a time.
- **Reduced motion:** every new animation is skipped when `reducedMotion` (renderer) / `prefers-reduced-motion` (CSS) — plants appear instantly, no impulse layer (it's already unmounted), bars may still transition width (subtle, acceptable) but keep the rule inside the existing `no-preference` media block anyway.
- **Copy tone (canon):** the garden asks, never accuses; amber never red; one loss voice at a time (existing `lossVoiced` logic untouched).
- Commit after each task with a conventional message; push happens once at Task 9 (CI applies the D1 migration remotely — `deploy.yml:58-64`).

---

### Task 1: `garden_seen` table + migration

**Files:**
- Modify: `packages/database/src/schema/garden.ts` (append table)
- Create: `packages/database/migrations/0009_*.sql` (via drizzle-kit; animal name auto-generated)
- Test: `apps/worker/test/garden-seen-route.test.ts` (created here with a schema smoke test; route tests join it in Task 3)

**Interfaces:**
- Produces: `schema.gardenSeen` with columns `{ userId (pk), lastSeenDate, lastSeenSeq, celebratedSpeciesIds (json string[]), updatedAt }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/worker/test/garden-seen-route.test.ts
/** garden_seen: the server-side arrival watermark (spec §3). */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { makeTestDb, makeTestUser } from "./helpers.js";

describe("garden_seen table", () => {
  it("stores and reads a seen watermark row", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.gardenSeen).values({
      userId,
      lastSeenDate: "2026-08-04",
      lastSeenSeq: 3,
      celebratedSpeciesIds: ["poppy"],
      updatedAt: nowInstant(),
    });
    const [row] = await db
      .select()
      .from(schema.gardenSeen)
      .where(eq(schema.gardenSeen.userId, userId));
    expect(row?.lastSeenDate).toBe("2026-08-04");
    expect(row?.lastSeenSeq).toBe(3);
    expect(row?.celebratedSpeciesIds).toEqual(["poppy"]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`gardenSeen` not exported / table missing):
`pnpm --filter @rg/worker test -- garden-seen-route`

- [ ] **Step 3: Add the table** to `packages/database/src/schema/garden.ts` (bottom of file, matching the file's existing style):

```ts
/** Arrival watermark: the newest durable garden event the user has seen,
 * plus same-day (preview) unlocks already celebrated. One row per user. */
export const gardenSeen = sqliteTable("garden_seen", {
  userId: text("user_id").primaryKey(),
  lastSeenDate: text("last_seen_date").notNull(),
  lastSeenSeq: integer("last_seen_seq").notNull(),
  celebratedSpeciesIds: text("celebrated_species_ids", { mode: "json" })
    .notNull()
    .$type<string[]>(),
  updatedAt: text("updated_at").notNull(),
});
```

- [ ] **Step 4: Generate the migration:** `pnpm --filter @rg/database generate` — inspect the new `packages/database/migrations/0009_*.sql` (one CREATE TABLE, nothing else).

- [ ] **Step 5: Re-run the test — expect PASS**, then commit:
```bash
git add packages/database/src/schema/garden.ts packages/database/migrations apps/worker/test/garden-seen-route.test.ts
git commit -m "feat(garden): garden_seen watermark table + migration"
```

---

### Task 2: preview folds forward across unresolved gaps

**Files:**
- Modify: `apps/worker/src/services/garden-sync.ts:513-533` (`buildGardenView` preview block)
- Test: `apps/worker/test/garden-preview.test.ts` (new)

**Interfaces:**
- Consumes: existing `buildDayInput(db, userId, date, prefs)` and `simulateDay` (already imported in garden-sync.ts).
- Produces: unchanged `GardenView` shape; behavior change only — `view.snapshot` is the folded today-snapshot whenever the fold ran, `view.previewEvents` are **today's** events only.

- [ ] **Step 1: Write the failing tests.** Model setup on `garden-timeline.test.ts` (same helpers: seed `gardenState` + `gardenDayInputs`, or drive via `advanceGarden` with fixture activities — copy that file's arrangement). Assertions:

```ts
// apps/worker/test/garden-preview.test.ts
/** Spec §2: same-day preview must survive a durable-sim lag (fold forward
 * read-only), return only TODAY's events, and never persist anything. */
it("previews today's run even when the durable sim is 2 days behind", async () => {
  // arrange: durable sim caught up to today-3; a completed run exists today
  const view = await buildGardenView(db, userId, prefs);
  expect(view.previewEvents.some((e) => e.kind === "run_completed")).toBe(true);
  expect(view.previewEvents.every((e) => e.date === today)).toBe(true); // no intermediate-day events
  expect((view.snapshot as GardenSnapshot).state.weatherState).toMatch(/rain/);
  // durable state untouched:
  const [row] = await db.select().from(gardenState).where(eq(gardenState.userId, userId));
  expect(row!.lastSimulatedDate).toBe(addDays(today, -3));
});
it("falls back to the durable snapshot beyond the 14-day cap", async () => {
  // arrange durable sim 20 days behind → previewEvents [] and snapshot === durable
});
it("still previews with zero completions when the fold changes weather", async () => {
  // durable at yesterday, no run today, daysSinceCompletedRun crossing a stage
  // → snapshot advanced (weather may differ), previewEvents may be empty
});
```

Write them fully (arrange code copied from garden-timeline.test.ts patterns), run: expect FAIL (today only previews at exact-yesterday).

- [ ] **Step 2: Implement the fold.** Replace the preview block in `buildGardenView`:

```ts
// Same-day feedback: fold the sim forward read-only from the last durable
// day through today — resolved days as recorded, unresolved days neutral —
// so a lagging durable sim can never silence today's run (spec §2).
let previewEvents: GardenEvent[] = [];
const today = todayInZone(prefs.timezone);
const gapDays = daysBetween(snapshot.state.lastSimulatedDate, today);
if (gapDays >= 1 && gapDays <= 14) {
  try {
    let cursor = snapshot;
    for (let date = addDays(snapshot.state.lastSimulatedDate, 1); date <= today; date = addDays(date, 1)) {
      let input: GardenDayInput;
      try {
        input = await buildDayInput(db, userId, date, prefs);
      } catch {
        input = { date, completedRuns: [], missedRuns: [], restObserved: false, restModeActive: cursor.state.restMode, planGap: false };
      }
      const step = simulateDay(cursor, input);
      cursor = step.snapshot;
      if (date === today) previewEvents = step.events;
    }
    snapshot = cursor;
  } catch {
    // Preview is cosmetic — never let it break the garden read.
    previewEvents = [];
  }
}
```

Check `buildDayInput`'s real signature/return first; if `advanceGarden` builds inputs with extra fields (e.g. `weekAdherence`), mirror its exact per-day construction — extract a shared `dayInputFor(db, userId, date, prefs)` helper used by both rather than duplicating. `daysBetween` — import from `@rg/domain` (it exists; `simulate.ts` uses it).

- [ ] **Step 3: Run the new tests — expect PASS.** Then run the neighboring suites to catch regressions:
`pnpm --filter @rg/worker test -- garden` (timeline + preview + any garden suite)

- [ ] **Step 4: Commit:**
```bash
git add apps/worker/src/services/garden-sync.ts apps/worker/test/garden-preview.test.ts
git commit -m "feat(garden): same-day preview folds forward across unresolved gaps"
```

---

### Task 3: seen state over the wire

**Files:**
- Modify: `apps/worker/src/services/garden-sync.ts` (GardenView interface + `buildGardenView` return: add `seen`)
- Modify: `apps/worker/src/routes/garden.ts` (POST `/seen`)
- Modify: `packages/api-client/src/index.ts` (types + `gardenSeen` POST fn; `seen` on garden response type)
- Test: extend `apps/worker/test/garden-seen-route.test.ts`

**Interfaces:**
- Produces (server): `GET /api/garden` → `{ ..., seen: { lastSeenDate: string; lastSeenSeq: number; celebratedSpeciesIds: string[] } | null }`; `POST /api/garden/seen` body = same shape (non-null) → `{ ok: true }`, 400 on malformed body.
- Produces (client): `api.gardenSeen(body: GardenSeenState): Promise<{ ok: boolean }>` and `GardenSeenState` type exported from api-client.

- [ ] **Step 1: Failing route tests** (mount `gardenRoutes` exactly as `garden-timeline.test.ts` does):

```ts
it("GET /api/garden returns seen: null before any mark", async () => { /* expect body.seen === null */ });
it("POST /api/garden/seen upserts and GET returns it", async () => {
  // POST { lastSeenDate: "2026-08-04", lastSeenSeq: 2, celebratedSpeciesIds: ["poppy"] } → 200
  // POST again with lastSeenSeq: 5 → GET shows 5 (upsert, not insert-only)
});
it("POST /api/garden/seen rejects malformed body", async () => { /* missing fields → 400 */ });
```

- [ ] **Step 2: Implement.** In `garden.ts` routes:

```ts
gardenRoutes.post("/seen", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const body = await c.req.json<{ lastSeenDate?: string; lastSeenSeq?: number; celebratedSpeciesIds?: string[] }>().catch(() => null);
  if (
    !body ||
    typeof body.lastSeenDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(body.lastSeenDate) ||
    typeof body.lastSeenSeq !== "number" ||
    !Array.isArray(body.celebratedSpeciesIds) ||
    body.celebratedSpeciesIds.some((s) => typeof s !== "string") ||
    body.celebratedSpeciesIds.length > 64
  ) {
    return c.json({ error: "bad_request" }, 400);
  }
  await db
    .insert(gardenSeen)
    .values({ userId, lastSeenDate: body.lastSeenDate, lastSeenSeq: body.lastSeenSeq, celebratedSpeciesIds: body.celebratedSpeciesIds, updatedAt: nowInstant() })
    .onConflictDoUpdate({
      target: gardenSeen.userId,
      set: { lastSeenDate: body.lastSeenDate, lastSeenSeq: body.lastSeenSeq, celebratedSpeciesIds: body.celebratedSpeciesIds, updatedAt: nowInstant() },
    });
  return c.json({ ok: true });
});
```

In `buildGardenView`: read the row (`db.select().from(gardenSeen).where(eq(gardenSeen.userId, userId))`) and add `seen: row ? { lastSeenDate: row.lastSeenDate, lastSeenSeq: row.lastSeenSeq, celebratedSpeciesIds: row.celebratedSpeciesIds } : null` to the returned object + the `GardenView` interface. In api-client: add the `GardenSeenState` interface, extend the garden response type, add `gardenSeen: (body: GardenSeenState) => post<{ ok: boolean }>("/api/garden/seen", body)`.

- [ ] **Step 3: Run tests — PASS.** `pnpm --filter @rg/worker test -- garden-seen-route`

- [ ] **Step 4: Commit:**
```bash
git add apps/worker/src/services/garden-sync.ts apps/worker/src/routes/garden.ts packages/api-client/src/index.ts apps/worker/test/garden-seen-route.test.ts
git commit -m "feat(garden): seen watermark over the wire (GET field + POST /api/garden/seen)"
```

---

### Task 4: `arrival.ts` — the pure arrival selector

**Files:**
- Create: `packages/ui/src/screens/arrival.ts`
- Modify: `packages/ui/src/screens/garden.tsx` (delete `eventSentence` + `BEAT_PRIORITY`; import from arrival.ts — full wiring happens in Task 5, this task only moves + re-imports so the screen still compiles)
- Test: `packages/ui/test/arrival.test.ts` (new)

**Interfaces:**
- Consumes: `GardenEvent` (`@rg/domain`), `SPECIES_BY_ID` (`@rg/garden-engine`), `addDays` (`@rg/domain`), `GardenSeenState` (`@rg/api-client`).
- Produces (exact, used by Task 5):

```ts
export type ArrivalEvent = GardenEvent & { preview?: boolean };
export interface ArrivalCeremony { kind: "species" | "ground"; speciesId?: string; ground?: string; fromPreview: boolean; }
export interface ArrivalPlan {
  ceremonies: ArrivalCeremony[];
  beatLines: string[];      // ≤3
  beatOverflow: boolean;
  todayLines: string[];     // ≤2
  todayOverflow: boolean;
  enteringPlantIds: string[];
  sparkles: Array<{ kind: "plant"; plantId: string; speciesId: string } | { kind: "wildlife"; wildlifeId: string }>;
  markSeenImmediately: boolean;   // brand-new garden: mark silently, celebrate nothing
  nextSeen: GardenSeenState;      // what POST /seen should write after presentation
}
export function selectArrival(events: ArrivalEvent[], seen: GardenSeenState | null, todayDate: string): ArrivalPlan;
export function eventSentence(e: GardenEvent): string | null;  // moved from garden.tsx, now rarity-aware
export function shouldInvalidateGarden(prev: string | null, next: string | null): boolean; // Task 6 helper
```

- [ ] **Step 1: Failing tests** — the heart of the bundle; write all of these:

```ts
// packages/ui/test/arrival.test.ts  (build events with a tiny helper: ev(kind, date, seq, extra))
describe("selectArrival", () => {
  it("brand-new garden (no durable events): markSeenImmediately, no ceremonies");
  it("missing seen row + durable history: watermark defaults to start-of-yesterday (yesterday's events arrive, older don't)");
  it("durable species_unlocked past the watermark → species ceremony; at/before → none");
  it("preview species_unlocked → ceremony with fromPreview: true, even with seen row current");
  it("celebratedSpeciesIds suppresses a preview unlock's ceremony");
  it("region_unlocked past watermark → ground ceremony, ordered before species; species ordered rare-first");
  it("events consumed by ceremonies don't repeat as beat/today lines");
  it("beat and today lines BOTH render when both exist (suppression-ternary regression)");
  it("caps: 4 beat events → 3 lines + beatOverflow; 3 preview lines → 2 + todayOverflow");
  it("enteringPlantIds = plant_added past watermark ∪ preview plant_added");
  it("sparkles: rare/uncommon plant_added + wildlife_arrived in window; common plants absent");
  it("nextSeen: tip of durable events; celebrated = preview-unlock speciesIds ∪ retained same-day priors");
});
describe("eventSentence rarity", () => {
  it("rare → 'A rare Garden dahlia has taken root — a lucky find.'");
  it("uncommon → 'An uncommon Coneflower took root.'");
  it("common unchanged: 'A White clover took root.'");
  it("rare tree seed → 'A rare Milestone oak seed was planted.'");
});
```

Run: `pnpm --filter @rg/ui test -- arrival` — FAIL (module missing).

- [ ] **Step 2: Implement `arrival.ts`.** Move `eventSentence`, `WEATHER_*`-independent helpers stay put; port `BEAT_PRIORITY`. Core selector:

```ts
const after = (e: ArrivalEvent, wm: { d: string; s: number }) => e.date > wm.d || (e.date === wm.d && e.seq > wm.s);

export function selectArrival(events: ArrivalEvent[], seen: GardenSeenState | null, todayDate: string): ArrivalPlan {
  const durable = events.filter((e) => !e.preview);
  const preview = events.filter((e) => e.preview);
  if (!seen && durable.length === 0) {
    return { ceremonies: [], beatLines: [], beatOverflow: false, todayLines: [], todayOverflow: false,
      enteringPlantIds: preview.filter((e) => e.kind === "plant_added" && e.plantId).map((e) => e.plantId!),
      sparkles: [], markSeenImmediately: true,
      nextSeen: { lastSeenDate: todayDate, lastSeenSeq: -1, celebratedSpeciesIds: [] } };
  }
  const wm = seen
    ? { d: seen.lastSeenDate, s: seen.lastSeenSeq }
    : { d: addDays(todayDate, -1), s: -1 }; // start of yesterday (migration day)
  const celebrated = new Set(seen?.celebratedSpeciesIds ?? []);
  const fresh = durable.filter((e) => after(e, wm));

  const rarityRank = { rare: 0, uncommon: 1, common: 2 } as const;
  const speciesCeremonies = [
    ...fresh.filter((e) => e.kind === "species_unlocked" && e.speciesId),
    ...preview.filter((e) => e.kind === "species_unlocked" && e.speciesId),
  ]
    .filter((e) => !celebrated.has(e.speciesId!))
    .map((e) => ({ kind: "species" as const, speciesId: e.speciesId!, fromPreview: !!e.preview }));
  // dedupe by speciesId (durable + preview can both carry it on migration edges)
  const seenIds = new Set<string>();
  const dedupedSpecies = speciesCeremonies.filter((c) => !seenIds.has(c.speciesId) && seenIds.add(c.speciesId))
    .sort((a, b) => rarityRank[SPECIES_BY_ID.get(a.speciesId)?.rarity ?? "common"] - rarityRank[SPECIES_BY_ID.get(b.speciesId)?.rarity ?? "common"]);
  const groundCeremonies = fresh
    .filter((e) => e.kind === "region_unlocked")
    .map((e) => ({ kind: "ground" as const, ground: e.detail ?? "meadow", fromPreview: false }));
  const ceremonies = [...groundCeremonies, ...dedupedSpecies];

  const consumed = new Set([
    ...(ceremonies.some((c) => c.kind === "ground") ? ["region_unlocked"] : []),
  ]);
  const consumedSpecies = new Set(dedupedSpecies.map((c) => c.speciesId));
  const notConsumed = (e: ArrivalEvent) =>
    !consumed.has(e.kind) && !(e.kind === "species_unlocked" && e.speciesId && consumedSpecies.has(e.speciesId));

  const beatSrc = fresh.filter(notConsumed)
    .sort((a, b) => (BEAT_PRIORITY[a.kind] ?? 9) - (BEAT_PRIORITY[b.kind] ?? 9))
    .map(eventSentence).filter((t): t is string => !!t);
  const todaySrc = preview.filter(notConsumed).map(eventSentence).filter((t): t is string => !!t);

  const tip = durable.reduce<{ d: string; s: number }>((acc, e) =>
    after(e, acc) ? { d: e.date, s: e.seq } : acc, wm);
  const previewCelebrated = dedupedSpecies.filter((c) => c.fromPreview).map((c) => c.speciesId);
  const retained = [...celebrated].filter((id) =>
    !durable.some((e) => e.kind === "species_unlocked" && e.speciesId === id && !after(e, tip)));

  return {
    ceremonies,
    beatLines: beatSrc.slice(0, 3), beatOverflow: beatSrc.length > 3,
    todayLines: todaySrc.slice(0, 2), todayOverflow: todaySrc.length > 2,
    enteringPlantIds: [...fresh, ...preview].filter((e) => e.kind === "plant_added" && e.plantId).map((e) => e.plantId!),
    sparkles: [...fresh, ...preview].flatMap((e) => {
      if (e.kind === "wildlife_arrived" && e.wildlifeId) return [{ kind: "wildlife" as const, wildlifeId: e.wildlifeId }];
      if (e.kind === "plant_added" && e.plantId && e.speciesId) {
        const r = SPECIES_BY_ID.get(e.speciesId)?.rarity;
        if (r === "rare" || r === "uncommon") return [{ kind: "plant" as const, plantId: e.plantId, speciesId: e.speciesId }];
      }
      return [];
    }),
    markSeenImmediately: false,
    nextSeen: { lastSeenDate: tip.d, lastSeenSeq: tip.s, celebratedSpeciesIds: [...new Set([...previewCelebrated, ...retained])] },
  };
}
```

Rarity verbs in `eventSentence` (`plant_added` case): look up `SPECIES_BY_ID.get(e.speciesId)?.rarity`; `rare` → `A rare ${name} has taken root — a lucky find.` / seed: `A rare ${name} seed was planted.`; `uncommon` → `An uncommon ${name} took root.` / `An uncommon ${name} seed was planted.`; common unchanged. `shouldInvalidateGarden = (prev, next) => !!prev && !!next && prev !== next;`

In `garden.tsx`, delete the moved code and import from `./arrival.js` (screen must still compile and behave identically — full rewiring is Task 5).

- [ ] **Step 3: Run — PASS:** `pnpm --filter @rg/ui test -- arrival`, then the whole ui package suite.

- [ ] **Step 4: Commit:**
```bash
git add packages/ui/src/screens/arrival.ts packages/ui/src/screens/garden.tsx packages/ui/test/arrival.test.ts
git commit -m "feat(garden): pure selectArrival module + rarity-aware event sentences"
```

---

### Task 5: GardenScreen rewiring — ceremony queue + unified arrival block

**Files:**
- Modify: `packages/ui/src/screens/garden.tsx` (replace lastVisit/dismissed states; ceremony queue; arrival block on both desktop + mobile branches)
- Modify: `packages/ui/src/screens/codex.tsx` (export `GroundIcon` — the inline SVG set at ~`:522-567` — as a named export taking `{ kind }`)
- Modify: `packages/ui/src/styles.css` (ceremony ground-variant + "see all" link styles reuse existing classes; add `.ceremony-ground-icon` sizing)
- Test: `packages/ui/test/render-smoke.test.ts` (extend: garden screen renders with a mocked arrival containing 2 ceremonies + beat + today lines)

**Interfaces:**
- Consumes: `selectArrival`, `ArrivalPlan`, `api.gardenSeen`.
- Produces: `UnlockCeremony` new props: `{ ceremony: ArrivalCeremony; queueLength: number; ... }` — ground variant renders `GroundIcon` + the carving copy map (moved verbatim from `eventSentence`'s `region_unlocked` ceremonies record into arrival.ts and exported as `GROUND_CEREMONY_COPY: Record<string, string>`).

- [ ] **Step 1: Wire it.** In `GardenScreen`:
  - Delete `lastVisit` memo, `beatDismissed`, `ceremonyDismissed`, the two localStorage effects, `sinceVisit`/`ceremonyEntries`/`beatLines` derivations (garden.tsx:790-1011 region).
  - `const seen = garden.data.seen ?? null;` `const arrival = useMemo(() => selectArrival(events, seen, todayDate), [events, seen, todayDate]);`
  - `const [ceremonyIndex, setCeremonyIndex] = useState(0);` — reset via `useEffect` keyed on `arrival.ceremonies.length`.
  - Mark-seen: one `useRef` guard + effect — if `arrival.markSeenImmediately`, POST immediately; else start a 6s timer when `arrival.ceremonies.length === 0`, or POST on dismissing the **last** ceremony. POST body = `arrival.nextSeen`; `.catch(() => api.gardenSeen(arrival.nextSeen)).catch(() => undefined)` (one retry, then give up — re-presented next visit).
  - Ceremony rendering: current = `arrival.ceremonies[ceremonyIndex]`; species → existing card body; ground → `GroundIcon kind` + `GROUND_CEREMONY_COPY[ground]` + eyebrow "New ground carved"; dismiss → `ceremonyIndex + 1` (past end → block collapses → mark-seen).
  - Beat/today: render BOTH sections from `arrival.beatLines` / `arrival.todayLines` (ternary deleted) + "See all → Log" link (desktop: opens the Log drawer; mobile: anchors to the log card) when either overflow flag is true.
  - Visitor line still leads `todayLines`/`beatLines` as today (`garden.tsx:1018-1020` logic kept, reading from `arrival`).
- [ ] **Step 2: Extend the smoke test** — mock `api.garden` to return events yielding 2 ceremonies (1 ground + 1 species) + 4 beat events + 3 preview lines; assert: ground card first, dismiss advances to species card, beat AND today sections both present, "See all" present. Mock `api.gardenSeen` and assert it's called once after the last dismiss with `nextSeen`.
- [ ] **Step 3: Run:** `pnpm --filter @rg/ui test` — PASS; fix fallout (the old ceremony test expectations, if any).
- [ ] **Step 4: Commit:**
```bash
git add packages/ui/src/screens/garden.tsx packages/ui/src/screens/codex.tsx packages/ui/src/styles.css packages/ui/test/render-smoke.test.ts
git commit -m "feat(garden): server-watermarked arrival block with sequential ceremony queue (species + grounds)"
```

---

### Task 6: freshness — invalidate on COROS reads and completion actions

**Files:**
- Modify: `packages/ui/src/screens/today.tsx` (SyncPanel: lastCorosReadAt watch; UnresolvedCard mutations)
- Modify: `packages/ui/src/screens/match-sheet.tsx:23-28`, `packages/ui/src/screens/runs.tsx:99-104`
- Test: covered by `arrival.test.ts` (`shouldInvalidateGarden`, written in Task 4) + smoke suite green

**Interfaces:** Consumes `shouldInvalidateGarden(prev, next)` from arrival.ts. Confirm the DTO field name on `SyncStatusDto` in api-client (`lastCorosReadAt`) before wiring — if the route exposes a different name, use that one everywhere.

- [ ] **Step 1: SyncPanel watch** (inside the existing component, after the `status` query):

```ts
const lastRead = status.data?.lastCorosReadAt ?? null;
const prevRead = useRef<string | null>(null);
useEffect(() => {
  if (shouldInvalidateGarden(prevRead.current, lastRead)) {
    void qc.invalidateQueries({ queryKey: ["garden"] });
    void qc.invalidateQueries({ queryKey: ["garden-timeline"] });
  }
  prevRead.current = lastRead;
}, [lastRead, qc]);
```

- [ ] **Step 2: Mutations** — add `void qc.invalidateQueries({ queryKey: ["garden"] });` to the three onSuccess lists (match-sheet match, runs LinkSheet link, today.tsx UnresolvedCard skip/defer + unskip if present).
- [ ] **Step 3: Run ui suite — PASS.** Manually trace: no invalidation on first poll (prev null), none when unchanged, one when advanced.
- [ ] **Step 4: Commit:**
```bash
git add packages/ui/src/screens/today.tsx packages/ui/src/screens/match-sheet.tsx packages/ui/src/screens/runs.tsx
git commit -m "feat(garden): invalidate garden queries on COROS reads and completion actions"
```

---

### Task 7: sensations — bar transition, sun tick, sprout-in, glow

**Files:**
- Modify: `packages/ui/src/styles.css` (`.balance-bar-fill` transition inside the existing `prefers-reduced-motion: no-preference` block)
- Modify: `packages/ui/src/screens/garden.tsx` (hourOfDay state + 60s interval; glow scheduler; pass `enteringPlantIds` + `highlightPlantId` to both GardenScene call sites)
- Modify: `packages/garden-renderer/src/GardenScene.tsx` (two new props; sprout keyframe in `sceneCss`; entrance class + highlight filter application)
- Test: `packages/garden-renderer/test/renderer.test.tsx` (extend)

**Interfaces:**
- Produces (renderer): `GardenSceneProps` gains `enteringPlantIds?: string[]` and `highlightPlantId?: string | null`. Filter invariant: applied to `selectedPlantId` if set, else `highlightPlantId` — never both.

- [ ] **Step 1: Failing renderer tests:**

```ts
it("wraps entering plants in the sprout class, skipped under reducedMotion", () => {
  // render with enteringPlantIds: [somePlantId] → markup contains `${p}-enter` on that plant's group only
  // render same with reducedMotion → class absent
});
it("highlightPlantId applies the outline filter; selectedPlantId wins when both set", () => {});
it("entering/highlight props never change geometry (path data identical with and without)", () => {});
```

- [ ] **Step 2: Implement renderer.** `sceneCss` gains (inside the `animate` block):

```
@keyframes ${p}-sprout { from { transform: scale(0.05); opacity: 0.4; } }
.${p}-enter > g:last-of-type { transform-box: fill-box; transform-origin: 50% 100%; animation: ${p}-sprout 600ms cubic-bezier(0.2, 0.8, 0.3, 1) both; }
```

Plant group: `className={`${p}-plant${animate && enteringPlantIds?.includes(plant.id) ? ` ${p}-enter` : ""}`}`. Filter line (`GardenScene.tsx:748`) becomes: `filter={ (selectedPlantId ? selectedPlantId === plant.id : highlightPlantId === plant.id) ? `url(#${p}-outline)` : undefined }`.

- [ ] **Step 3: Screen wiring.** `hourOfDay`: `const [hourOfDay, setHourOfDay] = useState(() => new Date().getHours() + new Date().getMinutes() / 60);` + `useEffect(() => { const id = window.setInterval(() => setHourOfDay(new Date().getHours() + new Date().getMinutes() / 60), 60_000); return () => window.clearInterval(id); }, []);` Glow scheduler: from `arrival.enteringPlantIds` resolve plants in snapshot, sort rarest-first via `SPECIES_BY_ID`, take 3; effect steps `highlightPlantId` through them 4s each then null; any `selectedPlantId` set → cancel (clear timer + set null). Pass both props at the two `GardenScene` call sites; CSS one-liner.
- [ ] **Step 4: Run renderer + ui suites — PASS.** Regenerate nothing (matrix renders unaffected — props default off).
- [ ] **Step 5: Commit:**
```bash
git add packages/garden-renderer/src/GardenScene.tsx packages/garden-renderer/test/renderer.test.tsx packages/ui/src/screens/garden.tsx packages/ui/src/styles.css
git commit -m "feat(garden): sprout-in entrance, one-plant arrival glow, live sun, bar transitions"
```

---

### Task 8: the impulse channel — rain front + sparkle

**Files:**
- Modify: `packages/garden-renderer/src/particles.ts` (impulse frame fn — pure)
- Modify: `packages/garden-renderer/src/AtmosphereLayer.tsx` (impulse prop, separate ref/effect keyed on `impulse.key`, draw after weather systems)
- Modify: `packages/garden-renderer/src/GardenScene.tsx` (pass-through prop `impulse`)
- Modify: `packages/ui/src/screens/garden.tsx` (weather-transition trigger; sparkle trigger from `arrival.sparkles`)
- Test: `packages/garden-renderer/test/particles.test.ts` (create if absent; else extend renderer test)

**Interfaces:**
- Produces: `export interface SceneImpulse { kind: "rain_front" | "sparkle"; key: string; x?: number; y?: number }` (exported from particles.ts, re-exported from renderer index). `export function impulseFrame(imp: SceneImpulse, elapsedMs: number, w: number, h: number): Array<{ x: number; y: number; r: number; alpha: number; kind: "streak" | "mote" }>` — pure; `[]` when `elapsedMs > IMPULSE_DURATION_MS[imp.kind]` (rain_front 2500, sparkle 2000).

- [ ] **Step 1: Failing tests:**

```ts
it("impulseFrame is pure: identical output for identical (impulse, elapsed)", () => {});
it("rain_front sweeps left→right: mean particle x at 300ms < mean x at 1800ms", () => {});
it("expires: elapsed > duration → []", () => {});
it("sparkle anchors: all motes within 0.15·w of the anchor x", () => {});
```

- [ ] **Step 2: Implement.** `impulseFrame` seeds from `imp.key` via the existing `rng` util (fresh keys: `impulse:${key}:${i}`); rain_front = 46 streaks, front position `f = elapsed / 2500`, streak i visible when its own `xFrac < f` with fade-in, falling at the rainfall angle; sparkle = 12 motes rising from `(x ?? 0.5, y ?? 0.6)` with per-mote phase, alpha ease-out. In `AtmosphereLayer`: `const impulseRef = useRef<{ imp: SceneImpulse; t0: number } | null>(null);` + `useEffect(() => { if (impulse) impulseRef.current = { imp: impulse, t0: performance.now() }; }, [impulse?.key]);` — **must NOT enter `atmosphereKey`** (the long-lived RAF effect stays keyed on `idPrefix` only; the file's header comment explains why — re-keying resets every particle clock). In the draw loop, after weather systems: `const ir = impulseRef.current; if (ir) { const frames = impulseFrame(ir.imp, now - ir.t0, w, h); … draw streaks as short lines / motes as glowing dots …; if (frames.length === 0) impulseRef.current = null; }`
- [ ] **Step 3: Screen triggers** (garden.tsx):

```ts
const [impulse, setImpulse] = useState<SceneImpulse | null>(null);
const prevWeather = useRef<GardenWeatherState | null>(null);
useEffect(() => {
  const w = snapshot.state.weatherState;
  if (viewingLive && prevWeather.current && prevWeather.current !== w && (w === "fresh_rain" || w === "recovery_rain")) {
    setImpulse({ kind: "rain_front", key: `rain:${snapshot.state.lastSimulatedDate}:${Date.now()}` });
  }
  prevWeather.current = w;
}, [snapshot.state.weatherState, viewingLive]);
```

Sparkle: when `arrival.sparkles.length > 0`, fire one sparkle for the first entry (plant → anchor from `plant.position.x` and a band-approx y `0.55`; wildlife → `x: 0.5, y: 0.45`), keyed `sparkle:${plantId|wildlifeId}`. GardenScene passes `impulse` through to AtmosphereLayer (only rendered when atmosphere is on — timeline-open naturally suppresses it).

- [ ] **Step 4: Run renderer suite — PASS.**
- [ ] **Step 5: Commit:**
```bash
git add packages/garden-renderer/src/particles.ts packages/garden-renderer/src/AtmosphereLayer.tsx packages/garden-renderer/src/GardenScene.tsx packages/garden-renderer/src/index.ts packages/ui/src/screens/garden.tsx packages/garden-renderer/test
git commit -m "feat(garden): one-shot atmosphere impulses — rain front on completion, sparkle on rare arrivals"
```

---

### Task 9: full verification + ship

- [ ] **Step 1:** `node --version` → confirm v21.x, then full suite: `pnpm test` — ALL green (779+ tests; the 3 pre-existing desktop e2e fixture failures on Today/Plan/Move screens are known-stale and not ours — anything else must be fixed before shipping).
- [ ] **Step 2:** `pnpm -w typecheck` (or the root script name — check root package.json scripts; deploy.yml runs it, match it locally under Node 22 if wrangler types demand).
- [ ] **Step 3:** Visual spot-check: `EXPORT_DIR=/tmp/rg-shots pnpm --filter @rg/garden-renderer test -- export-scenes` and eyeball one scene; confirm no markup regressions.
- [ ] **Step 4:** Push: `git push origin main` — CI gates (typecheck + tests) then applies migration 0009 and deploys. Watch: `gh run watch` until green.
- [ ] **Step 5:** Post-deploy sanity: `GET /api/garden` on prod returns `seen` field (via the app or `gh`-authed curl is unavailable — verify through the deployed app when next opened; the migration-day default guarantees no history dump).
