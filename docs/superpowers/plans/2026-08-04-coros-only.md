# COROS-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make COROS the single data source, backfill the account's full activity history, remove Strava completely, and give strength and yoga the same insight treatment running gets.

**Architecture:** A read-only sport census establishes which COROS `sportType` codes exist in the account. A new `backfill` job kind — modelled on the existing workout-less `read_now` — walks history backwards in 90-day chunks through an **activities-only** path that never touches plan reconciliation. Once history is in, Strava code and columns are deleted; surviving Strava-only rows are kept as source-less activities. Finally the insights route becomes discipline-aware: metrics are selected per discipline rather than filtered to runs.

**Tech Stack:** TypeScript, pnpm workspaces, Hono on Cloudflare Workers, Drizzle ORM over D1/SQLite, Vitest, React + TanStack Query, Node/tsx for the COROS bridge.

**Spec:** `docs/superpowers/specs/2026-08-04-coros-only-design.md`

## Global Constraints

- **Backfill must never call `importPlan`.** An old date range legitimately contains none of today's workouts; `import-plan.ts` rules 8 and 9 would archive the live plan and its scheduled workouts. Activities-only, end to end.
- **Phase 1 must be run against the real account before Phase 2 lands.** `ingestActivities` (`apps/worker/src/services/completion.ts:406-481`) absorbs a Strava-only row when the matching COROS activity arrives (±1h, pair score ≥ 0.6), preserving `activities.id` and its completion match. Deleting the merge code first would produce duplicate rows instead.
- **Sport gate stays `COROS_GARDEN_SPORT_TYPES`** (`packages/providers/src/coros/raw-types.ts:159`) — run 100–103, strength 402, yoga 403/904, plus whatever Task 1's census proves is needed. Bike/swim/walk/cardio stay out.
- **Never delete a user's activity.** Strava orphans are kept, not removed.
- **Metric honesty:** every analytics result uses the existing `MetricResult` contract (`packages/analytics/src/metric.ts`) — `ok` with an explicit `sampleSize` and `comparisonNote`, or `insufficient_data` with `needed`/`have`. Never fabricate a value to fill a card.
- **Copy rule:** user-facing text says "session" when it may mean a lift or a yoga practice. "Run" is reserved for actual runs.
- Tests run with `pnpm test`; a single project with `pnpm vitest run <path>`. Typecheck with `pnpm typecheck`.
- Commit after every task.

---

# Phase 0 — Sport census

### Task 1: COROS sport census script

Answers the question the rest of the plan rests on: does the account's historical yoga sit under a `sportType` we actually map? Read-only — no ingest, no writes, no detail fetches.

**Files:**
- Create: `services/coros-bridge/src/census.ts`
- Modify: `services/coros-bridge/package.json` (add `census` script)
- Modify: `package.json` (add `coros:census` root script)

**Interfaces:**
- Consumes: `CorosClient` from `./coros-client.js` (`getActivities(startDay, endDay)` already paginates: size 200, follows `totalPage`); `createPrompter` from `./prompt.js`; `redactUserId` from `./sanitize.js`; `COROS_GARDEN_SPORT_TYPES` and `corosSportName` from `@rg/providers`.
- Produces: `docs/reports/coros-sport-census-<YYYY-MM-DD>.json` with shape `{ kind, date, userIdRedacted, spanStart, spanEnd, totalActivities, codes: Array<{ sportType, name, admitted, discipline, count, earliest, latest, sampleNames }> }`.

- [ ] **Step 1: Read the two scripts this one mirrors**

Read `services/coros-bridge/src/spike.ts:1-45` for the report-file convention (`docs/reports/`, `redactUserId`, `stripUserIds`) and `services/coros-bridge/src/coros-client.ts:389-411` for `getActivities` pagination. Follow their structure — login prompt, client construction, JSON report written with `mkdirSync`/`writeFileSync`.

- [ ] **Step 2: Write the census script**

```ts
/**
 * Read-only sport census: which COROS sportType codes does this account
 * actually have, over its whole history, and which does Run Garden admit?
 *
 * Writes docs/reports/coros-sport-census-<date>.json. No ingest, no writes,
 * no per-activity detail fetches.
 *
 * Run with: pnpm coros:census
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COROS_GARDEN_SPORT_TYPES, corosSportName } from "@rg/providers";
import { CorosClient, type CorosRegion } from "./coros-client.js";
import { createPrompter } from "./prompt.js";
import { redactUserId } from "./sanitize.js";

/** How far back to sweep. COROS predates any plausible account, so this is a ceiling, not a guess. */
const CENSUS_START = "2010-01-01";

interface CodeRow {
  sportType: number;
  name: string;
  admitted: boolean;
  discipline: string | null;
  count: number;
  earliest: string;
  latest: string;
  sampleNames: string[];
}

async function main(): Promise<void> {
  const prompt = createPrompter();
  const email = await prompt.ask("COROS email: ");
  const password = await prompt.askHidden("COROS password: ");
  const region = ((await prompt.ask("Region [global]: ")) || "global") as CorosRegion;
  prompt.close();

  const client = new CorosClient({ region });
  await client.login(email, password);

  const today = new Date().toISOString().slice(0, 10);
  const items = await client.getActivities(CENSUS_START, today);

  const byCode = new Map<number, CodeRow>();
  for (const item of items) {
    const date = String(item.date);
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const existing = byCode.get(item.sportType);
    if (existing) {
      existing.count += 1;
      if (iso < existing.earliest) existing.earliest = iso;
      if (iso > existing.latest) existing.latest = iso;
      if (existing.sampleNames.length < 3 && item.name && !existing.sampleNames.includes(item.name)) {
        existing.sampleNames.push(item.name);
      }
    } else {
      byCode.set(item.sportType, {
        sportType: item.sportType,
        name: corosSportName(item.sportType),
        admitted: COROS_GARDEN_SPORT_TYPES.has(item.sportType),
        discipline: COROS_GARDEN_SPORT_TYPES.get(item.sportType) ?? null,
        count: 1,
        earliest: iso,
        latest: iso,
        sampleNames: item.name ? [item.name] : [],
      });
    }
  }

  const codes = [...byCode.values()].sort((a, b) => b.count - a.count);
  const dates = items.map((i) => String(i.date)).sort();
  const report = {
    kind: "coros-sport-census" as const,
    date: today,
    userIdRedacted: redactUserId(client.userId),
    spanStart: dates[0] ?? null,
    spanEnd: dates[dates.length - 1] ?? null,
    totalActivities: items.length,
    codes,
  };

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/reports");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `coros-sport-census-${today}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${items.length} activities, ${codes.length} distinct sport types\n`);
  for (const c of codes) {
    const mark = c.admitted ? `✓ ${c.discipline}` : "✗ dropped";
    console.log(
      `  ${String(c.sportType).padEnd(5)} ${c.name.padEnd(14)} ${String(c.count).padStart(5)}  ${c.earliest}..${c.latest}  ${mark}`,
    );
    if (!c.admitted && c.sampleNames.length > 0) console.log(`        e.g. ${c.sampleNames.join(", ")}`);
  }
  console.log(`\nwrote ${outPath}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : "census failed");
  process.exit(1);
});
```

- [ ] **Step 3: Verify `client.userId` and the prompter API exist as used**

Run: `grep -n "userId\|askHidden\|ask(" services/coros-bridge/src/coros-client.ts services/coros-bridge/src/prompt.ts | head -20`
If `CorosClient` exposes the user id under a different name, or `prompt` has a different method for hidden input, adjust the two call sites in Step 2 to match. Do not invent an API.

- [ ] **Step 4: Add the scripts**

In `services/coros-bridge/package.json`, add to `scripts`: `"census": "tsx src/census.ts"`.
In root `package.json`, add to `scripts`: `"coros:census": "pnpm --filter @rg/coros-bridge census"`.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Run the census against the real account**

Run: `pnpm coros:census`
Read the printed table. **This is a decision point, not a formality:**
- Every code marked `✗ dropped` that is plainly yoga, a lift, or a run is a gap in `COROS_GARDEN_SPORT_TYPES`.
- Add each such code to the map in `packages/providers/src/coros/raw-types.ts:159` with the right discipline, and add a case to the `corosSportName` switch (`:169`).
- For each code added, add an assertion to Task 5's normalizer test.
- If the census shows yoga only under 403 and/or 904, no map change is needed — record that in the commit message.

- [ ] **Step 7: Commit**

```bash
git add services/coros-bridge/src/census.ts services/coros-bridge/package.json package.json docs/reports/coros-sport-census-*.json packages/providers/src/coros/raw-types.ts
git commit -m "feat(bridge): read-only COROS sport census

Reports every distinct sportType in the account's full history with counts,
date ranges, and sample names, marking which Run Garden admits. Run before
the backfill so history is not built on an unverified sport map."
```

---

# Phase 1 — Resumable deep backfill

### Task 2: `backfill_state` table

**Files:**
- Modify: `packages/database/src/schema/ops.ts`
- Create: migration via `pnpm db:generate`

**Interfaces:**
- Produces: `backfillState` Drizzle table, exported through `packages/database/src/schema/index.ts`'s existing re-export of `ops.ts`.

- [ ] **Step 1: Add the table**

Append to `packages/database/src/schema/ops.ts`:

```ts
/**
 * Checkpoint for the one-shot deep activity backfill. One row per user.
 * The backfill walks history backwards in chunks; this row is what makes a
 * slept Mac resume at the pending chunk instead of restarting.
 */
export const backfillState = sqliteTable("backfill_state", {
  userId: text("user_id").primaryKey(),
  /** idle | running | done | error */
  status: text("status").notNull().default("idle"),
  /** Oldest date any completed chunk has covered. */
  earliestDateReached: text("earliest_date_reached"),
  chunksCompleted: integer("chunks_completed").notNull().default(0),
  activitiesIngested: integer("activities_ingested").notNull().default(0),
  /** Consecutive chunks that returned zero activities; 2 ends the walk. */
  consecutiveEmptyChunks: integer("consecutive_empty_chunks").notNull().default(0),
  /** Accumulated tally of sportType codes seen but not admitted. */
  skippedSportTypes: text("skipped_sport_types", { mode: "json" }).$type<Record<string, number>>(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  lastErrorCategory: text("last_error_category"),
  updatedAt: text("updated_at").notNull(),
});
```

`sqliteTable`, `text`, and `integer` are already imported at the top of `ops.ts`.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/database/migrations/000N_*.sql` creating `backfill_state`.

- [ ] **Step 3: Verify the test harness picks it up**

Run: `pnpm vitest run apps/worker/test/sync-routes.test.ts`
Expected: PASS. `makeTestDb()` (`apps/worker/test/helpers.ts:15`) applies every migration file, so a broken migration surfaces here immediately.

- [ ] **Step 4: Commit**

```bash
git add packages/database/src/schema/ops.ts packages/database/migrations
git commit -m "feat(db): backfill_state checkpoint table"
```

---

### Task 3: `nextBackfillAction` — the chunk walker

The entire sequencing decision as one pure function, so it is testable without a database, a bridge, or COROS.

**Files:**
- Create: `apps/worker/src/services/backfill.ts`
- Create: `apps/worker/test/backfill.test.ts`

**Interfaces:**
- Consumes: `addDays`, `type LocalDate` from `@rg/domain`.
- Produces:
  - `const CHUNK_DAYS = 90`
  - `const MAX_EMPTY_CHUNKS = 2`
  - `const DEFAULT_FLOOR_YEARS = 5`
  - `interface BackfillCheckpoint { earliestDateReached: string | null; consecutiveEmptyChunks: number }`
  - `interface ChunkOutcome { activitiesFound: number }`
  - `type BackfillAction = { kind: "continue"; chunkStart: string; chunkEnd: string } | { kind: "done"; reason: "empty_run" | "floor_reached" }`
  - `function firstChunk(today: string, rollingWindowDays: number): { chunkStart: string; chunkEnd: string }`
  - `function nextBackfillAction(checkpoint: BackfillCheckpoint, outcome: ChunkOutcome, floorDate: string): BackfillAction`

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/test/backfill.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CHUNK_DAYS,
  firstChunk,
  nextBackfillAction,
} from "../src/services/backfill.js";

describe("firstChunk", () => {
  it("starts just behind the rolling snapshot window, not at today", () => {
    // The rolling snapshot already owns the last 14 days; backfill must not
    // redo that work.
    const { chunkStart, chunkEnd } = firstChunk("2026-08-04", 14);
    expect(chunkEnd).toBe("2026-07-21");
    // 90 days INCLUSIVE of chunkEnd — the same span nextBackfillAction uses.
    expect(chunkStart).toBe("2026-04-23");
  });
});

describe("nextBackfillAction", () => {
  const floor = "2021-08-04";

  it("continues into the next older chunk when a chunk had activities", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-22", consecutiveEmptyChunks: 0 },
      { activitiesFound: 12 },
      floor,
    );
    expect(action).toEqual({
      kind: "continue",
      chunkStart: "2026-01-22",
      chunkEnd: "2026-04-21",
    });
  });

  it("keeps going after ONE empty chunk — a single gap is just a break from training", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-22", consecutiveEmptyChunks: 0 },
      { activitiesFound: 0 },
      floor,
    );
    expect(action.kind).toBe("continue");
  });

  it("stops after two consecutive empty chunks", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-22", consecutiveEmptyChunks: 1 },
      { activitiesFound: 0 },
      floor,
    );
    expect(action).toEqual({ kind: "done", reason: "empty_run" });
  });

  it("resets the empty run when a later chunk finds activities again", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2026-04-22", consecutiveEmptyChunks: 1 },
      { activitiesFound: 3 },
      floor,
    );
    expect(action.kind).toBe("continue");
  });

  it("stops at the floor rather than walking back forever", () => {
    // Already standing on the floor: the next chunk would end at 2021-08-03,
    // below it, so there is nothing left to ask for.
    const action = nextBackfillAction(
      { earliestDateReached: "2021-08-04", consecutiveEmptyChunks: 0 },
      { activitiesFound: 5 },
      "2021-08-04",
    );
    expect(action).toEqual({ kind: "done", reason: "floor_reached" });
  });

  it("clamps a chunk that would straddle the floor", () => {
    const action = nextBackfillAction(
      { earliestDateReached: "2021-11-01", consecutiveEmptyChunks: 0 },
      { activitiesFound: 5 },
      "2021-08-04",
    );
    expect(action).toEqual({
      kind: "continue",
      chunkStart: "2021-08-04",
      chunkEnd: "2021-10-31",
    });
  });

  it("uses a 90-day chunk", () => {
    expect(CHUNK_DAYS).toBe(90);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/worker/test/backfill.test.ts`
Expected: FAIL — cannot resolve `../src/services/backfill.js`.

- [ ] **Step 3: Implement**

Create `apps/worker/src/services/backfill.ts`:

```ts
import { addDays } from "@rg/domain";

/** Days of history per backfill chunk. */
export const CHUNK_DAYS = 90;
/** Consecutive empty chunks that end the walk. One empty chunk is just a training gap. */
export const MAX_EMPTY_CHUNKS = 2;
/** How far back the walk may reach when nothing stops it sooner. */
export const DEFAULT_FLOOR_YEARS = 5;

export interface BackfillCheckpoint {
  /** Oldest date any completed chunk has covered; null before the first chunk. */
  earliestDateReached: string | null;
  consecutiveEmptyChunks: number;
}

export interface ChunkOutcome {
  activitiesFound: number;
}

export type BackfillAction =
  | { kind: "continue"; chunkStart: string; chunkEnd: string }
  | { kind: "done"; reason: "empty_run" | "floor_reached" };

/**
 * The first chunk starts where the rolling snapshot window ends — redoing the
 * last 14 days would be pure waste, and the snapshot keeps them fresh anyway.
 */
export function firstChunk(
  today: string,
  rollingWindowDays: number,
): { chunkStart: string; chunkEnd: string } {
  const chunkEnd = addDays(today, -rollingWindowDays);
  // -CHUNK_DAYS + 1 so the span is 90 days INCLUSIVE of chunkEnd — identical to
  // the span nextBackfillAction produces, or the first chunk would be a day
  // wider than every chunk after it.
  return { chunkStart: addDays(chunkEnd, -CHUNK_DAYS + 1), chunkEnd };
}

/** The floor date for a walk starting today. */
export function defaultFloor(today: string): string {
  return addDays(today, -DEFAULT_FLOOR_YEARS * 365);
}

/**
 * Given the checkpoint and what the just-completed chunk found, decide whether
 * to walk one chunk further back or stop. Pure — no database, no clock.
 */
export function nextBackfillAction(
  checkpoint: BackfillCheckpoint,
  outcome: ChunkOutcome,
  floorDate: string,
): BackfillAction {
  const emptyRun =
    outcome.activitiesFound === 0 ? checkpoint.consecutiveEmptyChunks + 1 : 0;
  if (emptyRun >= MAX_EMPTY_CHUNKS) return { kind: "done", reason: "empty_run" };

  // The completed chunk covered [earliestDateReached, ...]; the next one ends
  // the day before it began.
  const previousStart = checkpoint.earliestDateReached;
  if (previousStart == null) return { kind: "done", reason: "floor_reached" };
  const chunkEnd = addDays(previousStart, -1);
  if (chunkEnd < floorDate) return { kind: "done", reason: "floor_reached" };

  const rawStart = addDays(chunkEnd, -CHUNK_DAYS + 1);
  const chunkStart = rawStart < floorDate ? floorDate : rawStart;
  return { kind: "continue", chunkStart, chunkEnd };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/worker/test/backfill.test.ts`
Expected: PASS, 7 tests.

If the two arithmetic expectations (`2026-01-22` / `2026-04-21`, and the clamp case) disagree with `addDays`, fix the **test expectations** to match real date arithmetic — do not bend the implementation to a miscounted fixture. Verify by hand with `node -e "const {addDays}=require('./packages/domain/dist/index.js');console.log(addDays('2026-04-22',-1))"` or an equivalent one-off.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/services/backfill.ts apps/worker/test/backfill.test.ts
git commit -m "feat(worker): pure chunk walker for the deep backfill

Two consecutive empty chunks end the walk; one does not — a single empty
90-day window is an ordinary break from training, not the end of history."
```

---

### Task 4: `buildActivityBackfill` on the bridge

**Files:**
- Create: `services/coros-bridge/src/backfill.ts`
- Create: `services/coros-bridge/test/backfill.test.ts`
- Modify: `services/coros-bridge/src/index.ts` (export)

**Interfaces:**
- Consumes: `CorosClient` (`getActivities`, `getActivityDetail`), `COROS_GARDEN_SPORT_TYPES`, `normalizeCorosActivity`, `normalizeCorosLaps`, `type NameResolver` from `@rg/providers`; `type NormalizedLap` from `./snapshot.js`.
- Produces: `interface ActivityBackfillChunk { activities: SourceActivity[]; lapsByProviderId: Record<string, NormalizedLap[]>; skippedSportTypes: Record<string, number> }` and `async function buildActivityBackfill(client, rangeStart, rangeEnd, resolver, opts?: { delayMs?: number }): Promise<ActivityBackfillChunk>`.

- [ ] **Step 1: Write the failing test**

Create `services/coros-bridge/test/backfill.test.ts`. Read `services/coros-bridge/test/mock-coros-server.ts` first and reuse its client-construction helper rather than inventing a new mock.

```ts
import { describe, expect, it } from "vitest";
import { buildActivityBackfill } from "../src/backfill.js";

/** Minimal stand-in for the parts of CorosClient the backfill touches. */
function fakeClient(items: Array<Record<string, unknown>>) {
  const detailCalls: string[] = [];
  return {
    detailCalls,
    client: {
      async getActivities() {
        return items;
      },
      async getActivityDetail(labelId: string) {
        detailCalls.push(labelId);
        return { summary: { distance: 500000, workoutTime: 180000, avgHr: 140 } };
      },
    } as never,
  };
}

describe("buildActivityBackfill", () => {
  it("admits run, strength, and yoga and reports what it dropped", async () => {
    const { client } = fakeClient([
      { labelId: "a", date: 20250101, sportType: 100, startTime: 1735732800 },
      { labelId: "b", date: 20250102, sportType: 402, startTime: 1735819200 },
      { labelId: "c", date: 20250103, sportType: 403, startTime: 1735905600 },
      { labelId: "d", date: 20250104, sportType: 200, startTime: 1735992000 }, // bike
      { labelId: "e", date: 20250105, sportType: 300, startTime: 1736078400 }, // swim
    ]);

    const chunk = await buildActivityBackfill(client, "2025-01-01", "2025-01-31", undefined);

    expect(chunk.activities.map((a) => a.sport).sort()).toEqual(["run", "strength", "yoga"]);
    expect(chunk.skippedSportTypes).toEqual({ "200": 1, "300": 1 });
  });

  it("survives a detail fetch that throws, keeping the list-level activity", async () => {
    const client = {
      async getActivities() {
        return [{ labelId: "a", date: 20250101, sportType: 100, startTime: 1735732800, workoutTime: 180000 }];
      },
      async getActivityDetail() {
        throw new Error("coros 500");
      },
    } as never;

    const chunk = await buildActivityBackfill(client, "2025-01-01", "2025-01-31", undefined);

    expect(chunk.activities).toHaveLength(1);
    expect(chunk.activities[0]!.durationSeconds).toBe(1800);
  });

  it("fetches detail once per admitted activity and never for a dropped one", async () => {
    const { client, detailCalls } = fakeClient([
      { labelId: "a", date: 20250101, sportType: 100, startTime: 1735732800 },
      { labelId: "d", date: 20250104, sportType: 200, startTime: 1735992000 },
    ]);

    await buildActivityBackfill(client, "2025-01-01", "2025-01-31", undefined);

    expect(detailCalls).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run services/coros-bridge/test/backfill.test.ts`
Expected: FAIL — cannot resolve `../src/backfill.js`.

- [ ] **Step 3: Implement**

Create `services/coros-bridge/src/backfill.ts`:

```ts
/**
 * Activities-only history fetch for the deep backfill.
 *
 * Deliberately NOT buildSnapshot: feeding an old date range through the normal
 * snapshot path runs it through import-plan.ts, whose rules 8 and 9 archive
 * workouts and plans absent from the range. A 2024 range legitimately contains
 * none of today's workouts, so that path would archive the live plan. This
 * function returns activities and laps only — no plan, no health, no catalog.
 */

import type { SourceActivity } from "@rg/domain";
import {
  COROS_GARDEN_SPORT_TYPES,
  normalizeCorosActivity,
  normalizeCorosLaps,
  type NameResolver,
  type RawCorosActivityDetail,
} from "@rg/providers";
import type { CorosClient } from "./coros-client.js";
import type { NormalizedLap } from "./snapshot.js";

export interface ActivityBackfillChunk {
  activities: SourceActivity[];
  lapsByProviderId: Record<string, NormalizedLap[]>;
  skippedSportTypes: Record<string, number>;
}

export interface BackfillOptions {
  /** Pause between per-activity detail fetches. Backfill is one call per activity over years of history. */
  delayMs?: number;
}

const DEFAULT_DELAY_MS = 120;

export async function buildActivityBackfill(
  client: CorosClient,
  rangeStart: string,
  rangeEnd: string,
  resolver: NameResolver | undefined,
  opts: BackfillOptions = {},
): Promise<ActivityBackfillChunk> {
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const items = await client.getActivities(rangeStart, rangeEnd);

  const activities: SourceActivity[] = [];
  const lapsByProviderId: Record<string, NormalizedLap[]> = {};
  const skippedSportTypes: Record<string, number> = {};

  for (const item of items) {
    if (!COROS_GARDEN_SPORT_TYPES.has(item.sportType)) {
      const key = String(item.sportType);
      skippedSportTypes[key] = (skippedSportTypes[key] ?? 0) + 1;
      continue;
    }
    let detail: RawCorosActivityDetail | undefined;
    try {
      detail = await client.getActivityDetail(item.labelId, item.sportType);
    } catch {
      detail = undefined; // list-level fields still make a usable activity
    }
    activities.push(normalizeCorosActivity(item, detail));
    if (detail) {
      const laps = normalizeCorosLaps(detail);
      if (laps.length > 0) lapsByProviderId[item.labelId] = laps;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { activities, lapsByProviderId, skippedSportTypes };
}
```

Note: `resolver` is accepted for signature parity with `buildSnapshot` and future name resolution; activities carry COROS-supplied names directly, so it is currently unused. If the linter rejects the unused parameter, prefix it `_resolver`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run services/coros-bridge/test/backfill.test.ts`
Expected: PASS, 3 tests. The tests pass `delayMs` implicitly as the default 120ms — if the suite feels slow, pass `{ delayMs: 0 }` from the tests.

- [ ] **Step 5: Export it**

Add to `services/coros-bridge/src/index.ts`:

```ts
export { buildActivityBackfill, type ActivityBackfillChunk } from "./backfill.js";
```

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`

```bash
git add services/coros-bridge/src/backfill.ts services/coros-bridge/src/index.ts services/coros-bridge/test/backfill.test.ts
git commit -m "feat(bridge): activities-only history fetch for backfill

Deliberately not buildSnapshot — an old range through the snapshot path would
trip import-plan rules 8/9 and archive the live plan."
```

---

### Task 5: Worker endpoint + job wiring

**Files:**
- Modify: `apps/worker/src/routes/devices.ts` (add `/bridge/backfill-chunk`)
- Modify: `apps/worker/src/services/jobs.ts` (`backfill` kind in claim + `applyJobResult`)
- Modify: `apps/worker/src/services/backfill.ts` (enqueue + checkpoint helpers)
- Create: `apps/worker/test/backfill-route.test.ts`
- Modify: `packages/providers/test/coros-normalize.test.ts` (sport admission assertions)

**Interfaces:**
- Consumes: `nextBackfillAction`, `firstChunk`, `defaultFloor` from Task 3; `ingestActivities` from `../services/completion.js` (`(db, { userId, sources, lapsByProviderId? }) => Promise<IngestStats>` — confirm the exact `IngestInput` shape at `completion.ts` before wiring); `resimulateFrom` from `../services/garden-sync.js`; `loadPreferences`; `backfillState` from `@rg/database`.
- Produces: `enqueueBackfill(db, userId, today): Promise<{ enqueued: boolean; reason?: string }>`, `recordChunk(db, userId, chunk): Promise<void>`, `advanceBackfill(db, userId, jobId, outcome, today): Promise<void>`.

- [ ] **Step 1: Read the two patterns being followed**

Read `apps/worker/src/routes/sync.ts:159-205` (the `read_now` enqueue: in-flight guard, `workoutId: id` self-reference, `originalDate`/`destinationDate` filled to satisfy NOT NULL) and `apps/worker/src/services/jobs.ts:315-360` (the `read_now` branches in `claimNextJob` and `applyJobResult`). The `backfill` kind follows both exactly.

- [ ] **Step 2: Write the failing test**

Create `apps/worker/test/backfill-route.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { advanceBackfill, enqueueBackfill, recordChunk } from "../src/services/backfill.js";

describe("backfill orchestration", () => {
  it("enqueues a backfill job whose first chunk sits behind the rolling window", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);

    const result = await enqueueBackfill(db, userId, "2026-08-04");

    expect(result.enqueued).toBe(true);
    const jobs = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe("backfill");
    expect(jobs[0]!.destinationDate).toBe("2026-07-21");
    // workoutId self-references the job row, per the read_now/studio precedent.
    expect(jobs[0]!.workoutId).toBe(jobs[0]!.id);
  });

  it("refuses a second backfill while one is in flight", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);

    await enqueueBackfill(db, userId, "2026-08-04");
    const second = await enqueueBackfill(db, userId, "2026-08-04");

    expect(second.enqueued).toBe(false);
    expect(second.reason).toBe("already_running");
  });

  it("ingests a chunk's activities and advances the checkpoint", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-04");

    await recordChunk(db, userId, {
      chunkStart: "2026-04-22",
      chunkEnd: "2026-07-21",
      activities: [
        {
          provider: "coros",
          providerActivityId: "yoga-1",
          startTime: "2026-05-01T07:00:00Z",
          startTimeLocal: "2026-05-01T07:00:00",
          sport: "yoga",
          durationSeconds: 2700,
          contentFingerprint: "fp-yoga-1",
        },
      ],
      lapsByProviderId: {},
      skippedSportTypes: { "200": 3 },
    });

    const rows = await db.select().from(schema.activities).where(eq(schema.activities.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sport).toBe("yoga");

    const state = (
      await db.select().from(schema.backfillState).where(eq(schema.backfillState.userId, userId))
    )[0]!;
    expect(state.earliestDateReached).toBe("2026-04-22");
    expect(state.activitiesIngested).toBe(1);
    expect(state.skippedSportTypes).toEqual({ "200": 3 });
  });

  it("queues the next older chunk after a productive one", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-04");
    const job = (await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId)))[0]!;

    await recordChunk(db, userId, {
      chunkStart: "2026-04-22",
      chunkEnd: "2026-07-21",
      activities: [],
      lapsByProviderId: {},
      skippedSportTypes: {},
    });
    await advanceBackfill(db, userId, job.id, { activitiesFound: 4 }, "2026-08-04");

    const jobs = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId));
    const queued = jobs.filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.destinationDate).toBe("2026-04-21");
  });

  it("marks the backfill done after two consecutive empty chunks", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-04");
    const job = (await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId)))[0]!;

    await recordChunk(db, userId, {
      chunkStart: "2026-04-22", chunkEnd: "2026-07-21",
      activities: [], lapsByProviderId: {}, skippedSportTypes: {},
    });
    await advanceBackfill(db, userId, job.id, { activitiesFound: 0 }, "2026-08-04");
    const next = (
      await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.status, "queued"))
    )[0]!;
    await advanceBackfill(db, userId, next.id, { activitiesFound: 0 }, "2026-08-04");

    const state = (
      await db.select().from(schema.backfillState).where(eq(schema.backfillState.userId, userId))
    )[0]!;
    expect(state.status).toBe("done");
    const stillQueued = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.status, "queued"));
    expect(stillQueued).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/worker/test/backfill-route.test.ts`
Expected: FAIL — `enqueueBackfill` is not exported.

- [ ] **Step 4: Implement the orchestration helpers**

Append to `apps/worker/src/services/backfill.ts`. Import what you need at the top of the file (`and`, `eq`, `inArray` from `drizzle-orm`; `backfillState`, `corosWriteJobs` from `@rg/database`; `newId`, `nowInstant` from `@rg/domain`; `ingestActivities` from `./completion.js`; `loadPreferences` from `./calendar-sync.js`; `resimulateFrom` from `./garden-sync.js`; `type Db` from `./db.js`; `type SourceActivity` from `@rg/domain`).

```ts
/** Days the rolling snapshot already covers; backfill starts behind it. */
const ROLLING_WINDOW_DAYS = 14;
/** Job statuses that mean a backfill is already under way. */
const IN_FLIGHT = ["queued", "claimed"] as const;

/** Insert one backfill job for an explicit chunk. Mirrors read_now's workout-less shape. */
async function insertChunkJob(
  db: Db,
  userId: string,
  chunkStart: string,
  chunkEnd: string,
): Promise<string> {
  const id = newId();
  const now = nowInstant();
  await db.insert(corosWriteJobs).values({
    id,
    userId,
    // Self-referencing workoutId satisfies NOT NULL for a job that acts on no
    // workout — the same trick read_now and the studio kinds use.
    workoutId: id,
    kind: "backfill",
    expectedContentFingerprint: "",
    // The chunk range. payload is authoritative; these columns are NOT NULL and
    // a date-ranged job is exactly what they describe.
    originalDate: chunkStart,
    destinationDate: chunkEnd,
    payload: { chunkStart, chunkEnd },
    requestedAt: now,
    status: "queued",
    updatedAt: now,
  });
  return id;
}

export async function enqueueBackfill(
  db: Db,
  userId: string,
  today: string,
): Promise<{ enqueued: boolean; reason?: string }> {
  const inFlight = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.kind, "backfill"),
        inArray(corosWriteJobs.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (inFlight.length > 0) return { enqueued: false, reason: "already_running" };

  const now = nowInstant();
  const { chunkStart, chunkEnd } = firstChunk(today, ROLLING_WINDOW_DAYS);
  await db
    .insert(backfillState)
    .values({
      userId,
      status: "running",
      earliestDateReached: null,
      chunksCompleted: 0,
      activitiesIngested: 0,
      consecutiveEmptyChunks: 0,
      skippedSportTypes: {},
      startedAt: now,
      finishedAt: null,
      lastErrorCategory: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: backfillState.userId,
      set: {
        status: "running",
        earliestDateReached: null,
        chunksCompleted: 0,
        activitiesIngested: 0,
        consecutiveEmptyChunks: 0,
        skippedSportTypes: {},
        startedAt: now,
        finishedAt: null,
        lastErrorCategory: null,
        updatedAt: now,
      },
    });
  await insertChunkJob(db, userId, chunkStart, chunkEnd);
  return { enqueued: true };
}

export interface ChunkReport {
  chunkStart: string;
  chunkEnd: string;
  activities: SourceActivity[];
  lapsByProviderId: Record<string, unknown>;
  skippedSportTypes: Record<string, number>;
}

/**
 * Ingest one chunk. ACTIVITIES ONLY — never importPlan. See the file header
 * on services/coros-bridge/src/backfill.ts for why.
 */
export async function recordChunk(db: Db, userId: string, chunk: ChunkReport): Promise<void> {
  const now = nowInstant();
  const stats = await ingestActivities(db, {
    userId,
    sources: chunk.activities,
    lapsByProviderId: chunk.lapsByProviderId as never,
  });

  const existing = (
    await db.select().from(backfillState).where(eq(backfillState.userId, userId)).limit(1)
  )[0];
  const mergedSkips: Record<string, number> = { ...(existing?.skippedSportTypes ?? {}) };
  for (const [code, count] of Object.entries(chunk.skippedSportTypes)) {
    mergedSkips[code] = (mergedSkips[code] ?? 0) + count;
  }

  await db
    .update(backfillState)
    .set({
      earliestDateReached: chunk.chunkStart,
      chunksCompleted: (existing?.chunksCompleted ?? 0) + 1,
      activitiesIngested: (existing?.activitiesIngested ?? 0) + chunk.activities.length,
      skippedSportTypes: mergedSkips,
      updatedAt: now,
    })
    .where(eq(backfillState.userId, userId));

  if (stats.affectedDates.length > 0) {
    const prefs = await loadPreferences(db, userId);
    await resimulateFrom(db, userId, stats.affectedDates[0]!, prefs).catch(() => undefined);
  }
}

/** Decide what happens after a reported chunk: queue the next one, or finish. */
export async function advanceBackfill(
  db: Db,
  userId: string,
  _jobId: string,
  outcome: ChunkOutcome,
  today: string,
): Promise<void> {
  const now = nowInstant();
  const state = (
    await db.select().from(backfillState).where(eq(backfillState.userId, userId)).limit(1)
  )[0];
  if (!state) return;

  const action = nextBackfillAction(
    {
      earliestDateReached: state.earliestDateReached,
      consecutiveEmptyChunks: state.consecutiveEmptyChunks,
    },
    outcome,
    defaultFloor(today),
  );

  if (action.kind === "done") {
    await db
      .update(backfillState)
      .set({ status: "done", finishedAt: now, updatedAt: now })
      .where(eq(backfillState.userId, userId));
    return;
  }

  await db
    .update(backfillState)
    .set({
      consecutiveEmptyChunks: outcome.activitiesFound === 0 ? state.consecutiveEmptyChunks + 1 : 0,
      updatedAt: now,
    })
    .where(eq(backfillState.userId, userId));
  await insertChunkJob(db, userId, action.chunkStart, action.chunkEnd);
}
```

- [ ] **Step 5: Wire the job kind into `jobs.ts`**

In `claimNextJob`, extend the workout-less condition (currently `isStudioJobKind(job.kind) || job.kind === "read_now"` at `jobs.ts:315`) to include `|| job.kind === "backfill"`.

In `applyJobResult`, immediately after the `read_now` branch (`jobs.ts:348-359`), add:

```ts
  // `backfill` acts on no workout either. The chunk itself was already ingested
  // via /bridge/backfill-chunk; this only settles the job row. Chunk sequencing
  // lives in advanceBackfill, called by the route.
  if (job.kind === "backfill") {
    await db
      .update(corosWriteJobs)
      .set({
        status: result.outcome === "verified" ? "verified" : "failed",
        attemptCount: job.attemptCount + 1,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(corosWriteJobs.id, job.id));
    return {
      jobStatus: result.outcome === "verified" ? "verified" : "failed",
      corosSyncState: "unchanged",
    };
  }
```

- [ ] **Step 6: Add the bridge endpoint**

In `apps/worker/src/routes/devices.ts`, alongside `POST /bridge/sync` (`:166`), add:

```ts
/**
 * Deep-backfill chunk. ACTIVITIES ONLY — this endpoint must never call
 * importPlan: an old range contains none of today's workouts, and import-plan
 * rules 8/9 would archive the live plan.
 */
deviceRoutes.post("/bridge/backfill-chunk", requireDevice, async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const body = (await c.req.json()) as {
    chunkStart: string;
    chunkEnd: string;
    activities?: SourceActivity[];
    lapsByProviderId?: Record<string, unknown>;
    skippedSportTypes?: Record<string, number>;
  };
  await recordChunk(db, userId, {
    chunkStart: body.chunkStart,
    chunkEnd: body.chunkEnd,
    activities: body.activities ?? [],
    lapsByProviderId: body.lapsByProviderId ?? {},
    skippedSportTypes: body.skippedSportTypes ?? {},
  });
  const today = todayInZone((await loadPreferences(db, userId)).timezone);
  await advanceBackfill(db, userId, "", { activitiesFound: body.activities?.length ?? 0 }, today);
  return c.json({ ok: true });
});
```

Add the imports it needs at the top of `devices.ts`: `recordChunk`, `advanceBackfill` from `../services/backfill.js`; `todayInZone` and `type SourceActivity` from `@rg/domain`; `loadPreferences` from `../services/calendar-sync.js` (match whatever the file already imports).

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run apps/worker/test/backfill-route.test.ts`
Expected: PASS, 5 tests.

If `ingestActivities`'s input type does not accept `lapsByProviderId`, read `IngestInput` in `completion.ts` and pass laps the way `/bridge/sync` already does — do not invent a field.

- [ ] **Step 8: Add the sport-admission assertions**

Append to `packages/providers/test/coros-normalize.test.ts`:

```ts
describe("COROS_GARDEN_SPORT_TYPES", () => {
  it("admits every run code as run", () => {
    for (const code of [100, 101, 102, 103]) {
      expect(COROS_GARDEN_SPORT_TYPES.get(code)).toBe("run");
    }
  });

  it("admits strength 402", () => {
    expect(COROS_GARDEN_SPORT_TYPES.get(402)).toBe("strength");
  });

  it("admits both yoga codes — 904 is the one a census would otherwise miss", () => {
    expect(COROS_GARDEN_SPORT_TYPES.get(403)).toBe("yoga");
    expect(COROS_GARDEN_SPORT_TYPES.get(904)).toBe("yoga");
  });

  it("does not admit bike or swim", () => {
    expect(COROS_GARDEN_SPORT_TYPES.has(200)).toBe(false);
    expect(COROS_GARDEN_SPORT_TYPES.has(300)).toBe(false);
  });
});
```

Add an assertion here for **every code Task 1's census added to the map.** Import `COROS_GARDEN_SPORT_TYPES` at the top of the file if it is not already imported.

- [ ] **Step 9: Run the full suite and commit**

Run: `pnpm vitest run packages/providers apps/worker/test/backfill-route.test.ts apps/worker/test/backfill.test.ts && pnpm typecheck`

```bash
git add apps/worker/src/services/backfill.ts apps/worker/src/routes/devices.ts apps/worker/src/services/jobs.ts apps/worker/test/backfill-route.test.ts packages/providers/test/coros-normalize.test.ts
git commit -m "feat(worker): backfill job kind, chunk endpoint, checkpoint advance

Activities-only ingest with an explicit guard against importPlan."
```

---

### Task 6: Bridge executes the `backfill` job

**Files:**
- Modify: `services/coros-bridge/src/cloud-sync.ts`
- Create: `services/coros-bridge/test/cloud-sync-backfill.test.ts`

**Interfaces:**
- Consumes: `buildActivityBackfill` from `./backfill.js` (Task 4); the `ClaimedJob` interface at `cloud-sync.ts:74`.
- Produces: a `backfill` branch in `pollJobs`, and `ClaimedJob.payload?: { chunkStart: string; chunkEnd: string }`.

- [ ] **Step 1: Write the failing test**

Create `services/coros-bridge/test/cloud-sync-backfill.test.ts`, mirroring `cloud-sync-readnow.test.ts` (a real `CorosClient` against `mockCorosServer`, plus a stubbed `fetchImpl` standing in for the worker):

```ts
/**
 * The bridge's handling of a `backfill` job: executed through the
 * activities-only path and posted to /bridge/backfill-chunk. The second test
 * is the regression guard for the plan-archiving hazard — a backfill job must
 * never push a snapshot, because an old range through the snapshot path trips
 * import-plan rules 8/9 and archives the live plan.
 */

import { describe, expect, it } from "vitest";
import { CorosClient } from "../src/coros-client.js";
import { CloudSync, generateDeviceKeypair } from "../src/cloud-sync.js";
import { mockCorosServer } from "./mock-coros-server.js";

const noop = (): void => undefined;

async function runBackfillJob(): Promise<Array<{ path: string; body: Record<string, unknown> }>> {
  const server = mockCorosServer();
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.login(server.email, server.password);

  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let claims = 0;
  const cloudFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : (input as URL).href).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });

    if (path === "/api/devices/bridge/jobs/claim") {
      claims += 1;
      const payload =
        claims === 1
          ? {
              job: {
                id: "backfill-job-1",
                kind: "backfill",
                originalDate: "2026-04-23",
                destinationDate: "2026-07-21",
                payload: { chunkStart: "2026-04-23", chunkEnd: "2026-07-21" },
              },
              pendingCount: 1,
            }
          : { job: null, pendingCount: 0 };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const { privateKeyPem } = generateDeviceKeypair();
  const sync = new CloudSync({
    apiUrl: "https://api.example.com",
    deviceId: "dev-backfill",
    privateKeyPem,
    client,
    fetchImpl: cloudFetch,
    logger: noop,
  });

  await sync.pollJobs();
  return calls;
}

describe("CloudSync — backfill job kind", () => {
  it("posts the chunk it was asked for, then reports the job verified", async () => {
    const calls = await runBackfillJob();

    const chunkIdx = calls.findIndex((c) => c.path === "/api/devices/bridge/backfill-chunk");
    const resultIdx = calls.findIndex(
      (c) => c.path === "/api/devices/bridge/jobs/backfill-job-1/result",
    );

    expect(chunkIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(chunkIdx); // chunk posted BEFORE the result

    const chunk = calls[chunkIdx]!.body;
    expect(chunk.chunkStart).toBe("2026-04-23");
    expect(chunk.chunkEnd).toBe("2026-07-21");
    expect(Array.isArray(chunk.activities)).toBe(true);

    expect(calls[resultIdx]!.body).toMatchObject({
      jobId: "backfill-job-1",
      deviceId: "dev-backfill",
      outcome: "verified",
    });
  });

  it("never pushes a snapshot for a backfill job", async () => {
    const calls = await runBackfillJob();
    expect(calls.map((c) => c.path)).not.toContain("/api/devices/bridge/sync");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run services/coros-bridge/test/cloud-sync-backfill.test.ts`
Expected: FAIL — the backfill job falls through to the move-job branch and reports `unsupported`/`missing_source_id_in_plan`.

- [ ] **Step 3: Add `payload` to `ClaimedJob`**

In the `ClaimedJob` interface (`cloud-sync.ts:74`), add:

```ts
  /** Present for the backfill kind: the chunk this job covers. */
  payload?: { chunkStart?: string; chunkEnd?: string };
```

- [ ] **Step 4: Add the execution branch**

In `pollJobs`, immediately after the `read_now` branch (`cloud-sync.ts:217-228`), add:

```ts
      if (job.kind === "backfill") {
        const chunkStart = job.payload?.chunkStart ?? job.originalDate;
        const chunkEnd = job.payload?.chunkEnd ?? job.destinationDate;
        this.localePromise ??= loadNameResolver(this.client.fetchImpl);
        const resolver = await this.localePromise;
        let outcome: "verified" | "write_failed" = "verified";
        try {
          const chunk = await buildActivityBackfill(this.client, chunkStart, chunkEnd, resolver);
          await this.post("/api/devices/bridge/backfill-chunk", {
            chunkStart,
            chunkEnd,
            activities: chunk.activities,
            lapsByProviderId: chunk.lapsByProviderId,
            skippedSportTypes: chunk.skippedSportTypes,
          });
          this.logger(
            `[coros-bridge] job ${job.id} → backfill ${chunkStart}..${chunkEnd}, ${chunk.activities.length} activities`,
          );
        } catch (e) {
          outcome = "write_failed";
          this.logger(
            `[coros-bridge] job ${job.id} → backfill failed: ${e instanceof Error ? e.name : "unknown"}`,
          );
        }
        await this.post(`/api/devices/bridge/jobs/${job.id}/result`, {
          jobId: job.id,
          deviceId: this.deviceId,
          outcome,
          finishedAt: new Date().toISOString(),
          signature: "sig-in-headers",
        });
        continue;
      }
```

Add `import { buildActivityBackfill } from "./backfill.js";` to the imports at the top of `cloud-sync.ts`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run services/coros-bridge/test/cloud-sync-backfill.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Run the whole bridge suite and commit**

Run: `pnpm vitest run services/coros-bridge && pnpm typecheck`

```bash
git add services/coros-bridge/src/cloud-sync.ts services/coros-bridge/test/cloud-sync-backfill.test.ts
git commit -m "feat(bridge): execute backfill jobs via the activities-only path

Guarded by a test asserting a backfill job never posts a snapshot."
```

---

### Task 7: Surface — Settings control and repointed backfill route

**Files:**
- Modify: `apps/worker/src/routes/misc.ts:224-261` (replace the Strava backfill body)
- Modify: `apps/worker/src/routes/sync.ts` (add `GET /backfill-status`)
- Modify: `packages/api-client/src/index.ts`
- Modify: `packages/ui/src/screens/settings.tsx`

**Interfaces:**
- Consumes: `enqueueBackfill` from `../services/backfill.js`; `backfillState` from `@rg/database`.
- Produces: `POST /api/activity/backfill` → `{ ok, enqueued, reason? }`; `GET /api/sync/backfill-status` → `{ status, earliestDateReached, chunksCompleted, activitiesIngested, skippedSportTypes }`; api-client methods `backfillHistory()` and `backfillStatus()`.

- [ ] **Step 1: Replace the backfill route body**

In `apps/worker/src/routes/misc.ts`, replace the body of `activityRoutes.post("/backfill", ...)` (`:225-261`) with:

```ts
activityRoutes.post("/backfill", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  // Self-heal stored data first (centisecond durations/timestamps, stuck
  // provisional matches) — independent of whether a device is available.
  await repairDurations(db, userId);
  const repairedDates = await repairTimestamps(db, userId);
  const promoted = await promoteProvisionalMatches(db);
  if (repairedDates.length > 0) {
    const prefs = await loadPreferences(db, userId);
    await resimulateFrom(db, userId, repairedDates[0]!, prefs).catch(() => undefined);
  }

  const today = todayInZone((await loadPreferences(db, userId)).timezone);
  const result = await enqueueBackfill(db, userId, today);
  return c.json({ ok: true, enqueued: result.enqueued, reason: result.reason, matched: promoted });
});
```

Remove the now-unused `stravaClient` and `normalizeStravaActivity` imports from `misc.ts` if nothing else in the file uses them. Add `enqueueBackfill` and `todayInZone` imports.

- [ ] **Step 2: Add the status route**

In `apps/worker/src/routes/sync.ts`:

```ts
syncRoutes.get("/backfill-status", async (c) => {
  const row = (
    await c
      .get("db")
      .select()
      .from(backfillState)
      .where(eq(backfillState.userId, c.get("userId")))
      .limit(1)
  )[0];
  return c.json({
    status: row?.status ?? "idle",
    earliestDateReached: row?.earliestDateReached ?? null,
    chunksCompleted: row?.chunksCompleted ?? 0,
    activitiesIngested: row?.activitiesIngested ?? 0,
    skippedSportTypes: row?.skippedSportTypes ?? {},
  });
});
```

Add `backfillState` to the `@rg/database` import in that file.

- [ ] **Step 3: Add the api-client methods**

In `packages/api-client/src/index.ts`, following the shape of the neighbouring methods:

```ts
  backfillHistory: () =>
    post<{ ok: boolean; enqueued: boolean; reason?: string; matched: number }>(
      "/api/activity/backfill",
      {},
    ),
  backfillStatus: () =>
    get<{
      status: string;
      earliestDateReached: string | null;
      chunksCompleted: number;
      activitiesIngested: number;
      skippedSportTypes: Record<string, number>;
    }>("/api/sync/backfill-status"),
```

Match the file's existing `get`/`post` helper names and generic style exactly — read a neighbouring method before writing these.

- [ ] **Step 4: Add the Settings control**

In `packages/ui/src/screens/settings.tsx`, add a card near the COROS connection section:

```tsx
function BackfillCard() {
  const status = useQuery({
    queryKey: ["backfill-status"],
    queryFn: api.backfillStatus,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 5000 : false),
  });
  const start = useMutation({
    mutationFn: api.backfillHistory,
    onSuccess: () => status.refetch(),
  });
  const s = status.data;
  return (
    <div className="row">
      <div>
        <strong>History</strong>
        <p className="muted">
          {s?.status === "running"
            ? `Reading your COROS history — ${s.chunksCompleted} chunks, ${s.activitiesIngested} sessions so far, back to ${s.earliestDateReached ?? "…"}.`
            : s?.status === "done"
              ? `History loaded: ${s.activitiesIngested} sessions back to ${s.earliestDateReached}.`
              : "Pull your full run, lift, and yoga history from COROS. Runs once; your Mac needs to be awake."}
        </p>
      </div>
      <button
        className="btn btn-small"
        disabled={start.isPending || s?.status === "running"}
        onClick={() => start.mutate()}
      >
        {s?.status === "running" ? "Running…" : "Backfill history"}
      </button>
    </div>
  );
}
```

Mount `<BackfillCard />` inside the same Card that holds the connection rows. Match the file's existing class names and `useQuery`/`useMutation` import style.

- [ ] **Step 5: Typecheck, test, commit**

Run: `pnpm typecheck && pnpm vitest run apps/worker`
Expected: PASS. Any test asserting the old `strava_unavailable` backfill response must be updated to the new `{ enqueued }` shape.

```bash
git add apps/worker/src/routes/misc.ts apps/worker/src/routes/sync.ts packages/api-client/src/index.ts packages/ui/src/screens/settings.tsx
git commit -m "feat(ui,worker): backfill history control, repointed off Strava"
```

- [ ] **Step 6: RUN THE BACKFILL AGAINST THE REAL ACCOUNT**

This is a required step, not an optional verification. **Phase 2 must not start until this has run.**

1. Start the worker and the bridge as usual.
2. Settings → **Backfill history**.
3. Watch until status reads `done`.
4. Confirm in the Runs screen that historical **yoga** and **strength** sessions now appear, filtered by discipline.
5. Check `skippedSportTypes` in `GET /api/sync/backfill-status`. If it contains a code that ought to be a discipline, go back to Task 1 Step 6, add it, and re-run.

Record the outcome (sessions ingested, earliest date, skipped codes) — it goes in the Phase 2 commit message as the evidence that Strava-only rows have had their chance to be absorbed.

---

# Phase 2 — Strava removal

### Task 8: Delete Strava code

**Files:**
- Delete: `apps/worker/src/services/strava.ts`, `apps/worker/src/routes/strava.ts`, `packages/providers/src/strava/normalize.ts`
- Modify: `packages/providers/src/merge.ts`, `packages/providers/src/index.ts`, `packages/domain/src/activity.ts`, `apps/worker/src/services/completion.ts`, `apps/worker/src/index.ts`, `apps/worker/src/env.ts`
- Modify: `packages/providers/test/merge-matching.test.ts`, `apps/worker/test/vertical-loop.test.ts`

**Interfaces:**
- Produces: `merge.ts` exporting only `singleSourceActivity`; `ActivityProviderName = "coros"`; `sourceActivitySchema.provider` narrowed to `z.literal("coros")`.

- [ ] **Step 1: Delete the files**

```bash
git rm apps/worker/src/services/strava.ts apps/worker/src/routes/strava.ts packages/providers/src/strava/normalize.ts
```

- [ ] **Step 2: Reduce `merge.ts`**

Delete `scoreActivityPair`, `mergeActivityPair`, `pairSources`, `MergeScoreDetail`, and `MergeResult`. Keep `singleSourceActivity`, dropping its `stravaActivityId` line. The file's header comment becomes:

```ts
/**
 * COROS is the only activity source: one physical session, one normalized
 * activity, one source link. (Until 2026-08 this module also merged a Strava
 * copy of the same session; Strava API access became subscription-gated and
 * COROS was already authoritative for every metric.)
 */
```

- [ ] **Step 3: Narrow the domain types**

In `packages/domain/src/activity.ts`: `export type ActivityProviderName = "coros";`, change `provider: z.enum(["coros", "strava"])` to `provider: z.literal("coros")`, and delete `stravaActivityId`, `summaryPolyline`, `description`, and `externalId` from the schemas that carry them.

- [ ] **Step 4: Collapse `completion.ts`**

Remove every Strava branch: the counterpart search (`:406-481`) collapses to always creating a new activity via `singleSourceActivity`; `rowToNormalized` drops `stravaActivityId`, `summaryPolyline`, `timezone` handling that referenced Strava; the re-merge block (`:379-404`) collapses to the `singleSourceActivity` refresh path. Delete the `provisionalCompletions` counter from `IngestStats` and its increments.

Keep `promoteProvisionalMatches` for now — Task 9 removes it after the migration has used it.

- [ ] **Step 5: Unmount the routes and env**

`apps/worker/src/index.ts`: delete the `stravaRoutes` import, the `app.route("/api/strava", …)` line, the `isWebhook` special-case (`:42`), and the Strava-field stripping in the weekly-review cron (`:189-190` and its surrounding comment).
`apps/worker/src/env.ts`: delete `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_API_BASE`, `STRAVA_WEBHOOK_VERIFY_TOKEN`.

- [ ] **Step 6: Rewrite the two test files**

`packages/providers/test/merge-matching.test.ts`: delete every pair-scoring and merge test; keep and extend the `matching.ts` completion-matching tests, which are COROS-side and unaffected.
`apps/worker/test/vertical-loop.test.ts`: delete the Strava leg; the loop now runs COROS-only end to end.

- [ ] **Step 7: Typecheck until clean**

Run: `pnpm typecheck`
Expected: initially many errors — each is a real call site. Fix them one by one. Do not suppress with `any` or `@ts-expect-error`.

- [ ] **Step 8: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: remove Strava integration

Strava API access has been subscription-gated since 2026-06-01 and the
membership lapsed. COROS was already authoritative for every metric; the
deep backfill (previous phase) has absorbed matched Strava-only rows.

Includes: <paste the Task 7 Step 6 outcome — sessions ingested, earliest date>"
```

---

### Task 9: Data migration

**Files:**
- Modify: `packages/database/src/schema/activities.ts`, `packages/database/src/schema/ops.ts`
- Create: migration via `pnpm db:generate`, then hand-edit for ordering
- Modify: `apps/worker/src/routes/misc.ts` (account-deletion sweep)
- Modify: `packages/domain/src/states.ts`
- Create: `apps/worker/test/strava-migration.test.ts`

**Interfaces:**
- Produces: `activities` without `strava_activity_id` / `summary_polyline`; `workout_completion_matches` without `provisional`; no `webhook_events` table; `CompletionState` without `provisionally_completed`.

- [ ] **Step 1: Write the failing migration test**

Create `apps/worker/test/strava-migration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { makeTestDb, makeTestUser } from "./helpers.js";

describe("post-Strava schema", () => {
  it("has no strava_activity_id or summary_polyline column", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.activities).values({
      id: "a1",
      userId,
      startTime: "2026-05-01T07:00:00Z",
      sport: "yoga",
      durationSeconds: 2700,
      sourceMergeConfidence: 1,
      createdAt: "2026-05-01T07:00:00Z",
      updatedAt: "2026-05-01T07:00:00Z",
    });
    const row = (await db.select().from(schema.activities).where(eq(schema.activities.id, "a1")))[0]!;
    expect("stravaActivityId" in row).toBe(false);
    expect("summaryPolyline" in row).toBe(false);
  });

  it("keeps an activity that has no COROS source — orphans are never deleted", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.activities).values({
      id: "orphan",
      userId,
      startTime: "2024-03-01T07:00:00Z",
      sport: "run",
      durationSeconds: 1800,
      distanceMeters: 5000,
      sourceMergeConfidence: 1,
      createdAt: "2024-03-01T07:00:00Z",
      updatedAt: "2024-03-01T07:00:00Z",
    });
    const rows = await db.select().from(schema.activities).where(eq(schema.activities.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.distanceMeters).toBe(5000);
  });

  it("dropped the webhook_events table", async () => {
    const db = makeTestDb();
    expect("webhookEvents" in schema).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/worker/test/strava-migration.test.ts`
Expected: FAIL — the columns and table still exist.

- [ ] **Step 3: Update the schema**

`packages/database/src/schema/activities.ts`: delete `stravaActivityId`, `summaryPolyline`, the `activities_strava_unique` index, and the `provisional` column on `workoutCompletionMatches`.
`packages/database/src/schema/ops.ts`: delete the `webhookEvents` table.

- [ ] **Step 4: Generate and hand-order the migration**

Run: `pnpm db:generate`

Open the generated SQL and enforce this order — SQLite will not drop a column an index references:

```sql
-- 1. Settle provisional matches before the column disappears.
UPDATE workout_completion_matches SET provisional = 0 WHERE provisional = 1;
--> statement-breakpoint
-- 2. Strava source links and connections.
DELETE FROM activity_source_links WHERE provider = 'strava';
--> statement-breakpoint
DELETE FROM provider_connections WHERE provider = 'strava';
--> statement-breakpoint
-- 3. Index before column.
DROP INDEX IF EXISTS activities_strava_unique;
--> statement-breakpoint
ALTER TABLE activities DROP COLUMN strava_activity_id;
--> statement-breakpoint
ALTER TABLE activities DROP COLUMN summary_polyline;
--> statement-breakpoint
ALTER TABLE workout_completion_matches DROP COLUMN provisional;
--> statement-breakpoint
DROP TABLE IF EXISTS webhook_events;
```

- [ ] **Step 5: Remove `provisionally_completed`**

Delete the member from the `CompletionState` union in `packages/domain/src/states.ts:36`, then collapse every call site to `completed`:
- `apps/worker/src/services/completion.ts`: the `hasCoros` ternary at `:602` becomes `"completed"`; the promotion branch at `:573`; the candidate-state filter at `:525`.
- `apps/worker/src/services/import-plan.ts`: `:256`, `:351`, and the state-rank map entry at `:581`.
- `apps/worker/src/services/garden-sync.ts:161`.
- `packages/ui/src/screens/plan.tsx`: `:221`, `:231`, `:322`.

Then delete `promoteProvisionalMatches` from `completion.ts` and its call in `misc.ts`'s backfill route.

- [ ] **Step 6: Update the account-deletion sweep**

In `apps/worker/src/routes/misc.ts:1235,1257`, remove `webhookEvents` from both the destructured import and the `childTables` array. Respect the all-caps warning above that array.

- [ ] **Step 7: Report the surviving orphans**

Before running the migration against the real database, capture what will be left behind — activities with no COROS source link. These are sessions that only ever lived on Strava. They are **kept**, but you should be able to see them.

Run against the live DB (adjust for your D1/local setup):

```sql
SELECT a.id, a.start_time, a.sport, a.duration_seconds, a.distance_meters, a.title
FROM activities a
LEFT JOIN activity_source_links l
  ON l.activity_id = a.id AND l.provider = 'coros'
WHERE l.id IS NULL
ORDER BY a.start_time;
```

Save the result to `docs/reports/2026-08-04-strava-orphans.md` with a one-line summary (count, date span, disciplines). If the count is zero, record that — it means the backfill absorbed everything, which is the good outcome and worth knowing.

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run apps/worker/test/strava-migration.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(db): drop Strava columns, provisional matches, webhook_events

Index dropped before its column — SQLite refuses otherwise. Activities with
no COROS source are kept as source-less rows, not deleted; the survivors are
listed in docs/reports/2026-08-04-strava-orphans.md."
```

---

### Task 10: UI and docs cleanup

**Files:**
- Modify: `packages/ui/src/screens/onboarding.tsx`, `settings.tsx`, `garden.tsx`, `today.tsx`, `runs.tsx`, `match-sheet.tsx`
- Modify: `apps/worker/src/routes/plan.ts:197-242`
- Modify: `README.md`, `docs/DATA_MODEL.md`, `docs/SYNC_AND_RECONCILIATION.md`, `docs/ANALYTICS.md`, `docs/ARCHITECTURE.md`
- Delete: `docs/research/strava-api.md`

- [ ] **Step 1: Onboarding**

In `onboarding.tsx`: remove `"Strava"` from `STEPS` (`:13`), delete `StravaStep` (`:243-256`) and its `{step === 4 ? … }` mount (`:95`), and renumber every subsequent step index. Verify the remaining seven steps advance correctly.

- [ ] **Step 2: Settings**

Delete the Strava connection row (`:205-223`), the `stravaDisconnect` mutation (`:162-166`), and the `conn("strava")` lookup (`:169`).

- [ ] **Step 3: Banners and copy**

- `garden.tsx:705-709` and `today.tsx:325-330`: delete the lapsed-subscription banners entirely.
- `apps/worker/src/routes/plan.ts`: delete the `stravaConn` query (`:197-203`) and the `stravaStatus` field (`:242`).
- `runs.tsx:48`: → `"Completed runs, lifts, and yoga sessions appear here. Use “Backfill history” in Settings to pull your COROS history."`
- `runs.tsx:53`: → `"Completed sessions from COROS appear here. Use “Backfill history” in Settings to pull your past sessions."`
- `runs.tsx:172`: → `"Couldn't reach your Mac — open the desktop app to backfill history."`
- `match-sheet.tsx:38`: → `"…open the desktop app to sync."` (drop the Strava clause).

- [ ] **Step 4: Docs**

- `docs/DATA_MODEL.md`: rows `:15`, `:16`, `:40`, `:44`, `:79` — drop Strava from the provider lists, drop the `webhook_events` row, drop `provisional`, and describe `activities` as COROS-sourced with possible source-less legacy rows. Add the `backfill_state` row.
- `docs/SYNC_AND_RECONCILIATION.md`: delete "Strava webhook idempotency" (`:238-251`) and "Activity dedup (COROS ⇄ Strava)" (`:253-263`); in "Completion matching confidence bands" delete the `provisionally_completed` sentence (`:277-280`). Add a short "Deep backfill" section describing the chunk walk, the two-empty-chunk rule, and the activities-only constraint with its reason.
- `docs/ANALYTICS.md:275-278`: delete the Strava-stripping bullet.
- `README.md` and `docs/ARCHITECTURE.md`: remove Strava from provider lists and diagrams.
- `git rm docs/research/strava-api.md` — keep it out of the tree; its findings are quoted in the design spec.

- [ ] **Step 5: Verify no references remain**

Run: `grep -rin "strava" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.json" . | grep -v node_modules | grep -v "docs/superpowers/specs" | grep -v "^\./\.git"`
Expected: only the design spec and this plan. Anything else is an unfinished edit.

- [ ] **Step 6: Test and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add -A
git commit -m "refactor(ui,docs): remove Strava from onboarding, settings, copy, and docs"
```

---

# Phase 3 — Discipline-aware insights

### Task 11: Discipline plumbing in analytics

**Files:**
- Create: `packages/analytics/src/discipline.ts`
- Modify: `packages/analytics/src/records.ts`, `packages/analytics/src/index.ts`
- Create: `packages/analytics/test/discipline.test.ts`

**Interfaces:**
- Produces:
  - `type Discipline = "run" | "strength" | "yoga"`
  - `const DISCIPLINES: readonly Discipline[]`
  - `function disciplineLabel(d: Discipline): string`
  - `function sessionNoun(d: Discipline, plural?: boolean): string` — `"run"`/`"runs"`, `"lift"`/`"lifts"`, `"yoga session"`/`"yoga sessions"`
  - `computeRecords(input: RecordsInput & { discipline: Discipline }): ScoredRecord[]` with ids namespaced `${discipline}:${id}`
  - New records for strength/yoga: `longest_session`, `most_sessions_in_a_week`, `longest_streak`

- [ ] **Step 1: Write the failing tests**

Create `packages/analytics/test/discipline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sessionNoun } from "../src/discipline.js";
import { computeRecords } from "../src/records.js";

describe("sessionNoun", () => {
  it("never calls a lift or a yoga session a run", () => {
    expect(sessionNoun("run", true)).toBe("runs");
    expect(sessionNoun("strength", true)).toBe("lifts");
    expect(sessionNoun("yoga", true)).toBe("yoga sessions");
  });
});

describe("computeRecords", () => {
  const dates = ["2026-06-01", "2026-06-03", "2026-06-05", "2026-06-08", "2026-06-10"];

  it("namespaces record ids by discipline so one cannot suppress another", () => {
    const records = computeRecords({
      runs: [],
      weeklyAdherence: [],
      completedRunDates: dates,
      discipline: "yoga",
    });
    for (const r of records) expect(r.id.startsWith("yoga:")).toBe(true);
  });

  it("gives strength and yoga a longest-session record", () => {
    const records = computeRecords({
      runs: [
        {
          activity: {
            id: "s1", startTime: "2026-06-01T07:00:00Z", sport: "strength",
            durationSeconds: 4200, sourceMergeConfidence: 1,
          },
          laps: [],
          category: "strength",
        },
      ],
      weeklyAdherence: [],
      completedRunDates: ["2026-06-01"],
      discipline: "strength",
    });
    const longest = records.find((r) => r.id === "strength:longest_session");
    expect(longest).toBeDefined();
    expect(longest!.value).toBe("1h 10m");
  });

  it("omits pace-based records for yoga rather than inventing them", () => {
    const records = computeRecords({
      runs: [], weeklyAdherence: [], completedRunDates: dates, discipline: "yoga",
    });
    expect(records.some((r) => r.id.includes("aerobic_efficiency"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/analytics/test/discipline.test.ts`
Expected: FAIL — `../src/discipline.js` does not exist.

- [ ] **Step 3: Create `discipline.ts`**

```ts
/** The three disciplines the garden and the insights dashboard both speak. */
export type Discipline = "run" | "strength" | "yoga";

export const DISCIPLINES: readonly Discipline[] = ["run", "strength", "yoga"] as const;

export function disciplineLabel(d: Discipline): string {
  return d === "run" ? "Running" : d === "strength" ? "Strength" : "Yoga";
}

/**
 * The right noun for a session in this discipline. Copy must never call a lift
 * or a yoga session a "run".
 */
export function sessionNoun(d: Discipline, plural = false): string {
  const singular = d === "run" ? "run" : d === "strength" ? "lift" : "yoga session";
  return plural ? `${singular}s` : singular;
}

/** Metrics that depend on pace or distance, and so are meaningful for runs only. */
export const RUN_ONLY_METRICS = [
  "aerobicEfficiency",
  "decoupling",
  "lowIntensityShare",
  "easyDiscipline",
  "hrZones",
] as const;

export function supportsMetric(d: Discipline, metric: string): boolean {
  return d === "run" || !RUN_ONLY_METRICS.includes(metric as never);
}
```

- [ ] **Step 4: Extend `records.ts`**

Add `discipline: Discipline` to `RecordsInput`. In `computeRecords`, namespace every emitted id as `${input.discipline}:${id}`, gate `bestAerobicEfficiency` behind `input.discipline === "run"`, and add three discipline-agnostic records:

```ts
function longestSession(runs: RunSample[], discipline: Discipline): ScoredRecord | null {
  if (runs.length === 0) return null;
  let best = runs[0]!;
  for (const r of runs) {
    if (r.activity.durationSeconds > best.activity.durationSeconds) best = r;
  }
  const secs = best.activity.durationSeconds;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return {
    id: "longest_session",
    title: `Longest ${sessionNoun(discipline)}`,
    value: h > 0 ? `${h}h ${m}m` : `${m}m`,
    achievedOn: (best.activity.startTimeLocal ?? best.activity.startTime).slice(0, 10),
    rule: `Longest single ${sessionNoun(discipline)} by moving time.`,
    numeric: secs,
  };
}

function mostSessionsInAWeek(dates: LocalDate[], discipline: Discipline): ScoredRecord | null {
  if (dates.length === 0) return null;
  const sorted = [...dates].sort();
  let best = { count: 0, endedOn: sorted[0]! };
  for (let i = 0; i < sorted.length; i++) {
    const windowEnd = sorted[i]!;
    const count = sorted.filter(
      (d) => d <= windowEnd && daysBetween(d, windowEnd) < 7,
    ).length;
    if (count > best.count) best = { count, endedOn: windowEnd };
  }
  if (best.count < 2) return null;
  return {
    id: "most_sessions_in_a_week",
    title: `Most ${sessionNoun(discipline, true)} in a week`,
    value: `${best.count}`,
    achievedOn: best.endedOn,
    rule: `Highest count of ${sessionNoun(discipline, true)} in any rolling 7-day window.`,
    numeric: best.count,
  };
}

function longestStreak(dates: LocalDate[], discipline: Discipline): ScoredRecord | null {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return null;
  let best = { weeks: 0, endedOn: sorted[0]! };
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (daysBetween(sorted[i - 1]!, sorted[i]!) <= 7) {
      run += 1;
      if (run > best.weeks) best = { weeks: run, endedOn: sorted[i]! };
    } else {
      run = 1;
    }
  }
  if (best.weeks < 2) return null;
  return {
    id: "longest_streak",
    title: `Longest ${sessionNoun(discipline)} streak`,
    value: `${best.weeks} sessions`,
    achievedOn: best.endedOn,
    rule: `Most consecutive ${sessionNoun(discipline, true)} each within 7 days of the previous.`,
    numeric: best.weeks,
  };
}
```

Import `sessionNoun` and `type Discipline` from `./discipline.js`, and export both from `packages/analytics/src/index.ts`.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/analytics`
Expected: PASS. Fix any existing records test broken by the id namespacing — the namespacing is intended, so update expectations, not the implementation.

- [ ] **Step 6: Commit**

```bash
git add packages/analytics/src/discipline.ts packages/analytics/src/records.ts packages/analytics/src/index.ts packages/analytics/test/discipline.test.ts
git commit -m "feat(analytics): discipline vocabulary and per-discipline records"
```

---

### Task 12: Discipline-aware insights route

**Files:**
- Modify: `apps/worker/src/routes/misc.ts` (the insights handler, `:495-1049`)
- Modify: `apps/worker/test/insights-route.test.ts`

**Interfaces:**
- Consumes: `Discipline`, `DISCIPLINES`, `sessionNoun` from `@rg/analytics`.
- Produces: `GET /api/insights?discipline=run|strength|yoga` returning the existing envelope plus `discipline` and `availableDisciplines: Discipline[]`, with run-only keys **absent** for non-run disciplines. `computed_metrics` key becomes `records:v2:${discipline}`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/insights-route.test.ts` (follow the file's existing setup helpers):

```ts
describe("discipline-aware insights", () => {
  it("defaults to run and reports which disciplines have data", async () => {
    // Seed: 6 runs, 3 strength sessions, 0 yoga in the last 12 weeks.
    const res = await app.request("/api/insights", {}, env);
    const body = await res.json();
    expect(body.discipline).toBe("run");
    expect(body.availableDisciplines).toEqual(["run", "strength"]);
  });

  it("omits pace-based cards for strength rather than returning empty ones", async () => {
    const res = await app.request("/api/insights?discipline=strength", {}, env);
    const body = await res.json();
    expect(body.efficiency).toBeUndefined();
    expect(body.decoupling).toBeUndefined();
    expect(body.consistency).toBeDefined();
  });

  it("keeps every run card for the run discipline", async () => {
    const res = await app.request("/api/insights?discipline=run", {}, env);
    const body = await res.json();
    expect(body.efficiency).toBeDefined();
    expect(body.decoupling).toBeDefined();
  });

  it("never offers a discipline with no sessions", async () => {
    const res = await app.request("/api/insights?discipline=yoga", {}, env);
    const body = await res.json();
    expect(body.availableDisciplines).not.toContain("yoga");
  });

  it("scopes records per discipline", async () => {
    const res = await app.request("/api/insights?discipline=strength", {}, env);
    const body = await res.json();
    for (const r of body.records ?? []) expect(r.id.startsWith("strength:")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/worker/test/insights-route.test.ts`
Expected: FAIL — the route ignores `?discipline` and always returns run metrics.

- [ ] **Step 3: Implement**

In the insights handler:

1. Parse and validate the query param, defaulting to `run`:

```ts
  const requested = c.req.query("discipline");
  const discipline: Discipline =
    requested === "strength" || requested === "yoga" || requested === "run" ? requested : "run";
```

2. Replace the `runRows` line (`:513`) with a discipline split that keeps `allSport` intact for the load signals:

```ts
  // Load signals deliberately keep every sport — a hard lift is load your legs
  // still have to absorb — and say so in loadBasisNote. Everything else is
  // scoped to the requested discipline.
  const disciplineRows = allSport.filter((a) => a.sport === discipline);
  const runs = disciplineRows.map(rowToNormalized);
```

Rename downstream uses of `runRows` to `disciplineRows`.

3. Compute `availableDisciplines` from the same window:

```ts
  const availableDisciplines = DISCIPLINES.filter((d) => allSport.some((a) => a.sport === d));
```

4. Gate the run-only metrics and build the response conditionally:

```ts
  const isRun = discipline === "run";
  return c.json({
    discipline,
    availableDisciplines,
    consistency,
    weekly,
    ...(isRun ? { efficiency, decoupling } : {}),
    records,
    evidence,
    reviews,
    interpreted,
  });
```

Skip the work, not just the output: guard the `computeAerobicEfficiency` / `computeDecoupling` / zone-ceiling computations behind `isRun` so a yoga request does not pay for them.

5. Pass `discipline` into `computeRecords`, and change the records metric key:

```ts
const RECORDS_METRIC_KEY = (d: Discipline): string => `records:v2:${d}`;
```

Update both the read and the write of that key. The old `records:v1` row is left in place, inert.

6. Any `comparisonNote` or `explanation` string that says "run" must use `sessionNoun(discipline, true)` instead.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/worker/test/insights-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Make weekly facts discipline-aware**

`apps/worker/src/index.ts:170` filters `a.sport === "run"` for the weekly LLM facts. Change it to include all three disciplines, and label each session with its discipline so the review can distinguish them.

- [ ] **Step 6: Full suite and commit**

Run: `pnpm test && pnpm typecheck`

```bash
git add apps/worker/src/routes/misc.ts apps/worker/src/index.ts apps/worker/test/insights-route.test.ts
git commit -m "feat(worker): discipline-aware insights route

Pace-based cards are absent for strength and yoga, not empty; load signals
still span every sport."
```

---

### Task 13: Discipline selector in the UI

**Files:**
- Modify: `packages/ui/src/screens/insights.tsx`
- Modify: `packages/api-client/src/index.ts`

**Interfaces:**
- Consumes: `discipline` / `availableDisciplines` from Task 12's payload.
- Produces: `api.insights(discipline?: Discipline)`; a selector rendered only when `availableDisciplines.length > 1`.

- [ ] **Step 1: Parameterize the api-client call**

Change the insights method to accept an optional discipline and append it as a query param. Keep the existing return type, widening it with `discipline` and `availableDisciplines`, and marking `efficiency` / `decoupling` optional.

- [ ] **Step 2: Add selector state and query key**

In `InsightsScreen`:

```tsx
  const [discipline, setDiscipline] = useState<Discipline>("run");
  const { data: d, isLoading, error } = useQuery({
    queryKey: ["insights", discipline],
    queryFn: () => api.insights(discipline),
  });
```

- [ ] **Step 3: Render the selector**

Above the `StatusStrip`, and only when there is a real choice:

```tsx
  {(d?.availableDisciplines?.length ?? 0) > 1 ? (
    <div className="chip-row" role="tablist" aria-label="Discipline">
      {d!.availableDisciplines.map((key) => (
        <button
          key={key}
          role="tab"
          aria-selected={discipline === key}
          className={`chip${discipline === key ? " chip-active" : ""}`}
          onClick={() => setDiscipline(key)}
        >
          {disciplineLabel(key)}
        </button>
      ))}
    </div>
  ) : null}
```

Reuse the chip classes `runs.tsx:36` already uses for its discipline filter rather than inventing new ones.

- [ ] **Step 4: Make the cards conditional**

Wrap the "Aerobic response" Card (`insights.tsx:322-402`) in `{d.efficiency || d.decoupling ? ( … ) : null}`. Per the spec these are **absent, not empty**, for strength and yoga.

Update the derived `METRIC_GROUPS` / `StatusStrip` logic (`:151-158`) so the strip only ever offers a scroll target for a card actually rendered — the comment there already warns about exactly this, and a discipline switch is a new way to break it.

- [ ] **Step 5: Fix run-specific copy**

`insights.tsx:112` ("run by run"), `:295-296` ("from completed, matched runs"), and the Weekly-training subtitle must use the selected discipline's noun. Import `sessionNoun` from `@rg/analytics`.

- [ ] **Step 6: Verify in the running app**

Run the app (`pnpm dev`), open Insights, and switch disciplines. Confirm: the strip has no dead scroll targets on strength/yoga; no card renders empty; no copy calls a lift a run.

- [ ] **Step 7: Typecheck, test, commit**

Run: `pnpm typecheck && pnpm test && pnpm lint`

```bash
git add packages/ui/src/screens/insights.tsx packages/api-client/src/index.ts
git commit -m "feat(ui): discipline selector on the insights dashboard"
```

---

### Task 14: Post-implementation audits

The user explicitly asked for audits on the insights work. Three independent reviewers, then one synthesis.

**Files:**
- Create: `docs/reports/2026-08-04-coros-only-insights-audit.md`

- [ ] **Step 1: Dispatch three parallel audit agents**

Each gets the design spec, this plan's Phase 3, and the diff for Tasks 11–13. Run them concurrently in one message.

- **Metric correctness & honesty.** Does every non-run metric compute something true for that discipline? Are `sampleSize` and `comparisonNote` accurate? Does any card survive with too little data where the `MetricResult` contract should have suppressed it? Is `availableDisciplines` derived from the same window as the metrics (an off-by-one window would offer a discipline whose cards are all empty)?
- **Copy & framing.** Does any string call a lift or a yoga session a "run"? Do notes explain what was actually compared? Is the tone consistent with the garden's gentle register — asking, never accusing?
- **Sparse and empty states.** With a discipline holding two sessions, what renders? What about zero, and one? Does the selector ever offer a discipline that then shows nothing? Does the `StatusStrip` ever offer a scroll target for an absent card?

- [ ] **Step 2: Verify each finding before recording it**

Do not transcribe agent output. For each claimed finding, open the file and confirm it is real. Agents report plausible-sounding issues that do not exist; a finding that survives inspection is a finding, the rest are noise.

- [ ] **Step 3: Write the synthesis**

`docs/reports/2026-08-04-coros-only-insights-audit.md`: confirmed findings ranked by severity, each with file:line, why it matters, and a recommended fix. Note explicitly what was checked and found clean — a clean area is a result.

- [ ] **Step 4: Fix everything ranked high or medium**

Each fix gets a test that fails before it and passes after.

- [ ] **Step 5: Final verification**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS. Paste the actual output into the commit; do not claim green without it.

- [ ] **Step 6: Commit**

```bash
git add docs/reports/2026-08-04-coros-only-insights-audit.md
git add -A
git commit -m "fix(insights): address audit findings

Audited metric correctness, copy, and sparse states across the three
disciplines; findings and what was verified clean are in docs/reports/."
```

---

### Task 15: Update ANALYTICS.md

- [ ] **Step 1: Document the new shape**

In `docs/ANALYTICS.md`: describe the discipline parameter, which metrics are run-only and why (pace and distance do not exist for yoga), which stay all-sport (load and recovery), the per-discipline record namespacing and the `records:v2:{discipline}` key, and the rule that inapplicable cards are absent rather than empty.

- [ ] **Step 2: Commit**

```bash
git add docs/ANALYTICS.md
git commit -m "docs: ANALYTICS.md covers discipline-aware metrics"
```

---

## Verification checklist

Before calling this done, confirm with actual command output:

- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `grep -rin strava --include="*.ts" --include="*.tsx" --include="*.md" . | grep -v node_modules | grep -v docs/superpowers` returns nothing
- [ ] The backfill ran against the real account and the Runs screen shows historical yoga and strength
- [ ] `GET /api/sync/backfill-status` shows `done` with no discipline-shaped code left in `skippedSportTypes`
- [ ] Insights renders for all three disciplines with no empty cards and no dead strip targets
