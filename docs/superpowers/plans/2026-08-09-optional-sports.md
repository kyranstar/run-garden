# Optional Sports (Adventures) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import every Coros sport, and make non-discipline sports ("adventures") boost the garden and shield the surrounding days from decay — while their absence never hurts.

**Architecture:** A canonical sport registry in `@rg/domain` replaces the bridge's admission gate (nothing is dropped anymore). The garden engine gains a cross-cutting "adventure" day input — qualifying adventures freeze all decay clocks for the day and earn recovery-aware grace days after; boosts flow through the existing lifeBonus pattern. `SIMULATION_VERSION` 3→4 triggers a full deterministic resim so backfilled history is honored retroactively. Run/strength/yoga discipline mechanics are untouched.

**Tech Stack:** TypeScript pnpm monorepo; Drizzle/D1 (no migration needed); vitest (`pnpm test` at root, or `pnpm vitest run <file>`); Hono worker; React UI.

**Spec:** `docs/superpowers/specs/2026-08-09-optional-sports-design.md` (approved).

## Global Constraints

- Determinism: the sim must be a pure function of stored day inputs. No `Date.now()`, no rng. Same inputs twice → deep-equal state.
- Gentle tone: the garden asks, never accuses. No copy may scold an absence of adventures.
- Optional means optional: no code path may let an adventure's absence reduce any axis, notch any bar, or appear in loss voices. `overall` balance stays `min` over run/strength/yoga only.
- Clocks freeze, never reset: a hike is not a run. `daysSinceCompletedRun/Strength/Yoga` are never set to 0 by an adventure.
- Existing stored `sport` strings (`run`, `strength`, `yoga`, `ski`) must keep their exact ids — no data migration.
- Plan matching stays run-only (`packages/providers/src/matching.ts` untouched).
- Worktree note: run everything from `/Users/kyranadams/src/run-garden/.claude/worktrees/garden-ux-audit`. Commit after every task.

---

### Task 1: Sport registry in `@rg/domain`

**Files:**
- Create: `packages/domain/src/sport.ts`
- Modify: `packages/domain/src/index.ts` (add `export * from "./sport.js";` after the `./activity.js` line)
- Test: `packages/domain/test/sport.test.ts` (new dir; vitest picks up `packages/*/test`)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `SportDef { id: string; label: string; corosCodes: number[]; adventure: boolean }`, `SPORTS: readonly SportDef[]`, `SPORT_BY_ID: ReadonlyMap<string, SportDef>`, `sportIdForCorosCode(code: number): string`, `sportLabel(id: string): string`, `isAdventureSport(id: string): boolean`. Later tasks import all of these from `@rg/domain`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/sport.test.ts
import { describe, expect, it } from "vitest";
import { isAdventureSport, SPORT_BY_ID, sportIdForCorosCode, sportLabel, SPORTS } from "../src/index.js";

describe("sport registry", () => {
  it("keeps the existing stored ids stable", () => {
    expect(sportIdForCorosCode(100)).toBe("run");
    expect(sportIdForCorosCode(102)).toBe("run"); // trail run
    expect(sportIdForCorosCode(402)).toBe("strength");
    expect(sportIdForCorosCode(403)).toBe("yoga");
    expect(sportIdForCorosCode(904)).toBe("yoga");
    expect(sportIdForCorosCode(500)).toBe("ski");
  });

  it("names the newly admitted sports", () => {
    expect(sportIdForCorosCode(104)).toBe("hike");
    expect(sportIdForCorosCode(105)).toBe("hike"); // mtn climb
    expect(sportIdForCorosCode(501)).toBe("snowboard");
    expect(sportIdForCorosCode(502)).toBe("xc-ski");
    expect(sportIdForCorosCode(503)).toBe("ski-touring");
    expect(sportIdForCorosCode(900)).toBe("walk");
    expect(sportIdForCorosCode(801)).toBe("climb"); // bouldering
  });

  it("collapses the bike/swim ranges like the old corosSportName did", () => {
    expect(sportIdForCorosCode(204)).toBe("bike"); // MTB
    expect(sportIdForCorosCode(299)).toBe("bike");
    expect(sportIdForCorosCode(301)).toBe("swim"); // open water
  });

  it("admits unknown codes as other, never throws", () => {
    expect(sportIdForCorosCode(31337)).toBe("other");
  });

  it("classifies disciplines vs adventures", () => {
    expect(isAdventureSport("run")).toBe(false);
    expect(isAdventureSport("strength")).toBe(false);
    expect(isAdventureSport("yoga")).toBe(false);
    expect(isAdventureSport("hike")).toBe(true);
    expect(isAdventureSport("walk")).toBe(true);
    // Unknown stored strings are non-discipline → adventure by default.
    expect(isAdventureSport("coros_9999")).toBe(true);
  });

  it("labels every registered sport and falls back gracefully", () => {
    for (const s of SPORTS) expect(sportLabel(s.id)).toBe(s.label);
    expect(sportLabel("mystery")).toBe("Mystery");
    expect(SPORT_BY_ID.get("hike")?.label).toBe("Hike");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`pnpm vitest run packages/domain/test/sport.test.ts` → module not found)

- [ ] **Step 3: Implement `packages/domain/src/sport.ts`**

```ts
/**
 * The canonical sport registry: every COROS activity code the app admits, its
 * stored `sport` id, UI label, and whether it counts as an "adventure" — a
 * sport the garden welcomes but never demands. The three disciplines
 * (run/strength/yoga) are the only sports with decay clocks; everything else
 * is adventure-flagged and the effort threshold (garden-engine) is the gate,
 * not the sport.
 *
 * Ids are stored in activities.sport — existing values (run, strength, yoga,
 * ski) must never change. Codes from docs/research/coros-community-clients.md
 * §7.4.
 */
export interface SportDef {
  id: string;
  label: string;
  corosCodes: number[];
  adventure: boolean;
}

export const SPORTS: readonly SportDef[] = [
  { id: "run", label: "Run", corosCodes: [100, 101, 102, 103], adventure: false },
  { id: "strength", label: "Strength", corosCodes: [402], adventure: false },
  { id: "yoga", label: "Yoga", corosCodes: [403, 904], adventure: false },
  { id: "hike", label: "Hike", corosCodes: [104, 105], adventure: true },
  { id: "climb", label: "Climb", corosCodes: [106, 800, 801, 802, 10003], adventure: true },
  { id: "bike", label: "Ride", corosCodes: [200, 201, 202, 203, 204, 205, 299, 9807], adventure: true },
  { id: "swim", label: "Swim", corosCodes: [300, 301], adventure: true },
  { id: "cardio", label: "Cardio", corosCodes: [400, 401], adventure: true },
  { id: "ski", label: "Ski", corosCodes: [500], adventure: true },
  { id: "snowboard", label: "Snowboard", corosCodes: [501], adventure: true },
  { id: "xc-ski", label: "XC Ski", corosCodes: [502], adventure: true },
  { id: "ski-touring", label: "Ski Touring", corosCodes: [503, 10002], adventure: true },
  { id: "row", label: "Row", corosCodes: [700, 701], adventure: true },
  { id: "paddle", label: "Paddle", corosCodes: [702, 704], adventure: true },
  { id: "windsurf", label: "Windsurf", corosCodes: [705, 706], adventure: true },
  { id: "walk", label: "Walk", corosCodes: [900], adventure: true },
  { id: "jump-rope", label: "Jump Rope", corosCodes: [901], adventure: true },
  { id: "stairs", label: "Stairs", corosCodes: [902], adventure: true },
  { id: "elliptical", label: "Elliptical", corosCodes: [903], adventure: true },
  { id: "triathlon", label: "Triathlon", corosCodes: [10000], adventure: true },
  { id: "multisport", label: "Multisport", corosCodes: [10001], adventure: true },
  { id: "custom", label: "Custom", corosCodes: [98], adventure: true },
  { id: "other", label: "Other", corosCodes: [], adventure: true },
] as const;

export const SPORT_BY_ID: ReadonlyMap<string, SportDef> = new Map(SPORTS.map((s) => [s.id, s]));

const BY_CODE: ReadonlyMap<number, string> = new Map(
  SPORTS.flatMap((s) => s.corosCodes.map((c) => [c, s.id] as const)),
);

/** Stored `sport` id for a COROS activity sportType. Total — unknown → "other". */
export function sportIdForCorosCode(code: number): string {
  const hit = BY_CODE.get(code);
  if (hit) return hit;
  if (code >= 200 && code < 300) return "bike";
  if (code >= 300 && code < 400) return "swim";
  return "other";
}

/** UI label for a sport id; unknown ids get a capitalized fallback, never crash. */
export function sportLabel(id: string): string {
  return SPORT_BY_ID.get(id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** Adventure = any sport that is not one of the three disciplines. */
export function isAdventureSport(id: string): boolean {
  return SPORT_BY_ID.get(id)?.adventure ?? (id !== "run" && id !== "strength" && id !== "yoga");
}
```

- [ ] **Step 4: Add the export to `packages/domain/src/index.ts`**, run the test — expect PASS. Also run `pnpm -w tsc -b` or the repo's typecheck (`pnpm typecheck` if present; check root package.json scripts) to confirm nothing broke.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(domain): canonical sport registry for all Coros-importable sports"`

---

### Task 2: Providers + bridge admit everything through the registry

**Files:**
- Modify: `packages/providers/src/coros/raw-types.ts` (delete `COROS_ADMITTED_SPORT_TYPES` and `corosSportName`; keep `COROS_RUN_SPORT_TYPES`)
- Modify: `packages/providers/src/coros/normalize.ts:5,284` (`sport: sportIdForCorosCode(item.sportType)`)
- Modify: `services/coros-bridge/src/snapshot.ts:112-117`, `services/coros-bridge/src/backfill.ts:58-63` (no more skipping)
- Modify: `services/coros-bridge/src/census.ts` (registry-based names)
- Test: `services/coros-bridge/test/backfill.test.ts`, `services/coros-bridge/test/cloud-sync-backfill.test.ts` (update expectations)

**Interfaces:**
- Consumes: `sportIdForCorosCode` from `@rg/domain` (Task 1).
- Produces: bridge payloads whose `activities[].sport` is a registry id; `skippedSportTypes` now tallies codes that resolved to `"other"` (admitted-but-unnamed), no longer dropped ones.

- [ ] **Step 1: Update the existing bridge tests first.** Find assertions about skipped sports (`grep -n "skippedSportTypes\|skipped" services/coros-bridge/test/*.test.ts`). Change them to the new contract: an activity with an unmapped sportType (e.g. 31337) is **admitted** with `sport: "other"` and tallied in `skippedSportTypes`; a hike (104) is admitted with `sport: "hike"` and NOT tallied. Add a case if none covers it:

```ts
it("admits every sport type; unknown codes become 'other' and are tallied", async () => {
  // arrange the fake client to return activities with sportType 104 and 31337
  // (follow the file's existing fake-client fixture pattern)
  const chunk = await buildActivityBackfill(client, "2026-01-01", "2026-01-31", undefined, { delayMs: 0 });
  expect(chunk.activities.map((a) => a.sport).sort()).toEqual(["hike", "other"]);
  expect(chunk.skippedSportTypes).toEqual({ "31337": 1 });
});
```

- [ ] **Step 2: Run bridge tests — expect the updated ones to FAIL.**

- [ ] **Step 3: Implement.** In both `snapshot.ts` and `backfill.ts`, replace the gate:

```ts
// before (both files):
if (!COROS_ADMITTED_SPORT_TYPES.has(item.sportType)) {
  const key = String(item.sportType);
  skipped[key] = (skipped[key] ?? 0) + 1;
  continue;
}
// after — everything is admitted; tally only codes the registry can't name,
// so the census still surfaces new COROS codes worth naming:
if (sportIdForCorosCode(item.sportType) === "other") {
  const key = String(item.sportType);
  skipped[key] = (skipped[key] ?? 0) + 1;
}
```

In `normalize.ts`, swap `corosSportName(item.sportType)` → `sportIdForCorosCode(item.sportType)` (import from `@rg/domain`). Delete `corosSportName` and `COROS_ADMITTED_SPORT_TYPES` from `raw-types.ts` and fix `census.ts` (it imported both): census now reports `sportIdForCorosCode(item.sportType)` per code and flags rows where that is `"other"` as "unnamed — add to registry". Update the snapshot.ts comment "Completed activities (run/strength/yoga)" to "Completed activities (all sports)". Check `packages/providers/src/index.ts` for re-exports of the deleted symbols and remove them.

- [ ] **Step 4: Run the full bridge + providers suites — expect PASS.** `pnpm vitest run services/coros-bridge` (grep the repo for other `COROS_ADMITTED_SPORT_TYPES`/`corosSportName` references first: `grep -rn "corosSportName\|COROS_ADMITTED_SPORT_TYPES" --include="*.ts" packages services apps` must come back empty).

- [ ] **Step 5: Commit** — `git commit -am "feat(providers,bridge): admit every Coros sport via the registry — nothing dropped"`

---

### Task 3: Bridge syncs today's recovery score into daily health

**Files:**
- Modify: `services/coros-bridge/src/snapshot.ts` (daily-health section, ~line 131)
- Test: whichever bridge test covers `buildSnapshot`'s health mapping (`grep -n "health" services/coros-bridge/test/*.test.ts`); extend it.

**Interfaces:**
- Consumes: `client.getDashboard(): Promise<CorosDashboardSubset>` (`coros-client.ts:424`, already implemented, currently uncalled) — `recoveryPct?: number`.
- Produces: the latest-dated `DailyHealth` record in the snapshot payload carries `recoveryScore` (0–100). The worker ingest (`apps/worker/src/routes/devices.ts:282,297`) already writes it with COALESCE — no worker change.

- [ ] **Step 1: Write the failing test** (adapt to the file's fake-client pattern; the fake must implement `getDashboard`):

```ts
it("attaches the dashboard recovery % to the latest daily-health record", async () => {
  // fake client: getDailyMetrics returns days for happenDay 20260101 and 20260102,
  // getDashboard returns { recoveryPct: 72 }
  const snap = await buildSnapshot(client, "2026-01-01", "2026-01-02", resolver, {});
  const latest = snap.health.find((h) => h.date === "2026-01-02");
  expect(latest?.recoveryScore).toBe(72);
  expect(snap.health.find((h) => h.date === "2026-01-01")?.recoveryScore).toBeUndefined();
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement in `snapshot.ts`.** Before the health mapping:

```ts
// Recovery % lives only on the dashboard (today's value) — one cheap query.
// Historical days keep undefined; the worker's COALESCE never overwrites a
// stored value with null.
let dashboard: CorosDashboardSubset | undefined;
try {
  dashboard = await client.getDashboard();
} catch {
  dashboard = undefined;
}
```

Then in the `.map()`, compute the latest happenDay first (outside the map): `const latestDay = days.reduce((m, d) => Math.max(m, Number(d.happenDay ?? 0)), 0);` and inside the map's `base` object add:

```ts
recoveryScore:
  Number(d.happenDay) === latestDay ? numberOrUndefined(dashboard?.recoveryPct) : undefined,
```

(`recoveryScore` must be inside `base` so the `contentFingerprint` covers it — a changed recovery % must produce a new fingerprint.) Confirm the bridge's `DailyHealth` type (imported from `@rg/domain`, `packages/domain/src/health.ts:8`) already has `recoveryScore?: number` — it does; no type change.

- [ ] **Step 4: Run bridge tests — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(bridge): sync today's Coros recovery % into daily health"`

---

### Task 4: Engine adventure module (pure rules)

**Files:**
- Create: `packages/garden-engine/src/adventure.ts`
- Modify: `packages/garden-engine/src/index.ts` (export the new module)
- Test: `packages/garden-engine/test/adventure.test.ts`

**Interfaces:**
- Consumes: `isAdventureSport` from `@rg/domain`; `LocalDate` type.
- Produces (Tasks 5 & 6 depend on these exact names):

```ts
export interface AdventureInput { sport: string; trainingLoad?: number; durationMin?: number }
export const ADVENTURE_TUNING: {
  minLoad: number; minDurationMin: number;      // 40 / 45 — qualifies
  bigLoad: number; bigDurationMin: number;      // 80 / 150 — banks a grace day
  graceCap: number;                             // 2
  recoveryThreshold: number;                    // 60 — grace while recoveryScore < this
};
export function qualifiesAsAdventure(a: AdventureInput): boolean
export function isBigAdventure(a: AdventureInput): boolean
export function recoveryScoreFrom(recoveryScore?: number | null, fatigueScore?: number | null): number | undefined
export function adventureGraceDay(
  s: { lastAdventureDate: LocalDate | null; adventureGraceDays: number },
  opts: { date: LocalDate; hasSession: boolean; adventureToday: boolean; restMode: boolean; planGap: boolean; recoveryScore?: number },
): boolean
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/garden-engine/test/adventure.test.ts
import { describe, expect, it } from "vitest";
import {
  ADVENTURE_TUNING,
  adventureGraceDay,
  isBigAdventure,
  qualifiesAsAdventure,
  recoveryScoreFrom,
} from "../src/index.js";

const base = { lastAdventureDate: "2026-06-06", adventureGraceDays: 0 };
const day = (date: string, over: Partial<Parameters<typeof adventureGraceDay>[1]> = {}) => ({
  date,
  hasSession: false,
  adventureToday: false,
  restMode: false,
  planGap: false,
  ...over,
});

describe("qualifying threshold", () => {
  it("qualifies on load OR duration, at the boundary", () => {
    expect(qualifiesAsAdventure({ sport: "hike", trainingLoad: 40 })).toBe(true);
    expect(qualifiesAsAdventure({ sport: "hike", trainingLoad: 39 })).toBe(false);
    expect(qualifiesAsAdventure({ sport: "walk", durationMin: 45 })).toBe(true);
    expect(qualifiesAsAdventure({ sport: "walk", durationMin: 44 })).toBe(false);
    expect(qualifiesAsAdventure({ sport: "walk" })).toBe(false); // no data → neutral
  });
  it("big days at the boundary", () => {
    expect(isBigAdventure({ sport: "hike", durationMin: 150 })).toBe(true);
    expect(isBigAdventure({ sport: "hike", durationMin: 149, trainingLoad: 79 })).toBe(false);
    expect(isBigAdventure({ sport: "ski", trainingLoad: 80 })).toBe(true);
  });
});

describe("recoveryScoreFrom", () => {
  it("prefers the true recovery score, falls back to 100 - fatigue, else undefined", () => {
    expect(recoveryScoreFrom(72, 90)).toBe(72);
    expect(recoveryScoreFrom(null, 30)).toBe(70);
    expect(recoveryScoreFrom(undefined, undefined)).toBeUndefined();
    expect(recoveryScoreFrom(null, 130)).toBe(0); // clamped
  });
});

describe("adventureGraceDay", () => {
  it("recovery path: grace while under the threshold, inside the window", () => {
    expect(adventureGraceDay(base, day("2026-06-07", { recoveryScore: 59 }))).toBe(true);
    expect(adventureGraceDay(base, day("2026-06-08", { recoveryScore: 59 }))).toBe(true);
    expect(adventureGraceDay(base, day("2026-06-07", { recoveryScore: 60 }))).toBe(false);
    // outside the graceCap window: never, however tired
    expect(adventureGraceDay(base, day("2026-06-09", { recoveryScore: 10 }))).toBe(false);
  });
  it("heuristic path: spends the bank only when no recovery data exists", () => {
    const banked = { ...base, adventureGraceDays: 1 };
    expect(adventureGraceDay(banked, day("2026-06-07"))).toBe(true);
    expect(adventureGraceDay(base, day("2026-06-07"))).toBe(false); // empty bank
    // recovery data present and fine → bank is irrelevant
    expect(adventureGraceDay(banked, day("2026-06-07", { recoveryScore: 95 }))).toBe(false);
  });
  it("never a grace day when something else already explains the day", () => {
    const banked = { ...base, adventureGraceDays: 2 };
    expect(adventureGraceDay(banked, day("2026-06-07", { hasSession: true }))).toBe(false);
    expect(adventureGraceDay(banked, day("2026-06-07", { adventureToday: true }))).toBe(false);
    expect(adventureGraceDay(banked, day("2026-06-07", { restMode: true }))).toBe(false);
    expect(adventureGraceDay(banked, day("2026-06-07", { planGap: true }))).toBe(false);
    expect(adventureGraceDay({ lastAdventureDate: null, adventureGraceDays: 2 }, day("2026-06-07"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm vitest run packages/garden-engine/test/adventure.test.ts`).

- [ ] **Step 3: Implement `packages/garden-engine/src/adventure.ts`**

```ts
import type { LocalDate } from "@rg/domain";

/**
 * Adventures: sports the garden welcomes but never demands. A qualifying
 * adventure day freezes every decay clock (like rest mode); a big day earns
 * grace for the days after, sized by Coros's own recovery model when we have
 * it. Nothing here can ever hurt the garden — see the spec's "optional means
 * optional" constraint.
 */
export interface AdventureInput {
  sport: string;
  trainingLoad?: number;
  durationMin?: number;
}

export const ADVENTURE_TUNING = {
  /** A real session, not a stroll: load ≥ minLoad OR duration ≥ minDurationMin. */
  minLoad: 40,
  minDurationMin: 45,
  /** A big day (backpacking, a long tour) banks one grace day for after. */
  bigLoad: 80,
  bigDurationMin: 150,
  /** Max consecutive shielded days after the last adventure. */
  graceCap: 2,
  /** Grace continues while Coros recovery (0-100) sits below this. */
  recoveryThreshold: 60,
} as const;

export function qualifiesAsAdventure(a: AdventureInput): boolean {
  return (a.trainingLoad ?? 0) >= ADVENTURE_TUNING.minLoad ||
    (a.durationMin ?? 0) >= ADVENTURE_TUNING.minDurationMin;
}

export function isBigAdventure(a: AdventureInput): boolean {
  return (a.trainingLoad ?? 0) >= ADVENTURE_TUNING.bigLoad ||
    (a.durationMin ?? 0) >= ADVENTURE_TUNING.bigDurationMin;
}

/** Coros recovery % when synced; 100 - fatigue as the historical proxy; else unknown. */
export function recoveryScoreFrom(
  recoveryScore?: number | null,
  fatigueScore?: number | null,
): number | undefined {
  if (recoveryScore != null) return recoveryScore;
  if (fatigueScore != null) return Math.max(0, Math.min(100, 100 - fatigueScore));
  return undefined;
}

function wholeDaysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * Is this a shielded recovery day after an adventure? Only on days that would
 * otherwise decay — a discipline session, rest mode, or a plan gap already
 * explains the day. Recovery data decides when present; the banked heuristic
 * answers for dates without health data (old backfilled history).
 */
export function adventureGraceDay(
  s: { lastAdventureDate: LocalDate | null; adventureGraceDays: number },
  opts: {
    date: LocalDate;
    hasSession: boolean;
    adventureToday: boolean;
    restMode: boolean;
    planGap: boolean;
    recoveryScore?: number;
  },
): boolean {
  if (opts.adventureToday || opts.hasSession || opts.restMode || opts.planGap) return false;
  if (!s.lastAdventureDate) return false;
  const since = wholeDaysBetween(s.lastAdventureDate, opts.date);
  if (since < 1 || since > ADVENTURE_TUNING.graceCap) return false;
  if (opts.recoveryScore !== undefined) return opts.recoveryScore < ADVENTURE_TUNING.recoveryThreshold;
  return s.adventureGraceDays > 0;
}
```

Add to `packages/garden-engine/src/index.ts`:

```ts
export {
  ADVENTURE_TUNING,
  adventureGraceDay,
  isBigAdventure,
  qualifiesAsAdventure,
  recoveryScoreFrom,
  type AdventureInput,
} from "./adventure.js";
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(garden-engine): adventure rules — qualifying threshold, big days, recovery-aware grace"`

---

### Task 5: Wire adventures into `simulateDay` (+ version bump)

**Files:**
- Modify: `packages/garden-engine/src/types.ts` (`SIMULATION_VERSION`, `GardenDayInput`, `EngineGardenState`, `weekDisciplines`)
- Modify: `packages/garden-engine/src/simulate.ts` (defaults, week rollover, §1/§4/§5/§6 freeze, adventure effects)
- Modify: `packages/domain/src/garden.ts:95-104` (`GARDEN_EVENT_KINDS` gains `"adventure_logged"`)
- Test: `packages/garden-engine/test/simulate.test.ts` (append a `describe("adventures", ...)` block)

**Interfaces:**
- Consumes: everything Task 4 produces.
- Produces: `GardenDayInput.adventures?: AdventureInput[]`, `GardenDayInput.recoveryScore?: number`; `EngineGardenState.lastAdventureDate?: LocalDate | null`, `EngineGardenState.adventureGraceDays?: number`, `weekDisciplines.adventure?: boolean`; event kind `"adventure_logged"` with `detail` = sport id; `SIMULATION_VERSION = 4`.

- [ ] **Step 1: Write the failing tests.** Append to `simulate.test.ts`, using its existing `emptyDay`/`sessionDay`/`initialSnapshot` helpers (`START = "2026-03-02"`, a Monday). A helper for adventure days:

```ts
function adventureDay(date: string, extra: Partial<GardenDayInput> = {}): GardenDayInput {
  return { ...emptyDay(date), adventures: [{ sport: "hike", trainingLoad: 90, durationMin: 200 }], ...extra };
}

describe("adventures", () => {
  it("freezes all clocks on a qualifying adventure day — freeze, never reset", () => {
    let snap = initialSnapshot(START);
    // 3 plain days: run clock 3, strength/yoga clocks 3
    for (let i = 1; i <= 3; i++) snap = simulateDay(snap, emptyDay(addDays(START, i))).snapshot;
    const before = snap.state.daysSinceCompletedRun;
    snap = simulateDay(snap, adventureDay(addDays(START, 4))).snapshot;
    expect(snap.state.daysSinceCompletedRun).toBe(before); // held, not reset
    expect(snap.state.daysSinceStrength).toBe(3);
    expect(snap.state.daysSinceYoga).toBe(3);
    expect(snap.state.lastAdventureDate).toBe(addDays(START, 4));
    expect(snap.state.weekDisciplines.adventure).toBe(true);
  });

  it("a sub-threshold stroll is recorded but garden-neutral", () => {
    let snap = initialSnapshot(START);
    const d1 = simulateDay(snap, {
      ...emptyDay(addDays(START, 1)),
      adventures: [{ sport: "walk", durationMin: 20 }],
    }).snapshot;
    const d1plain = simulateDay(snap, emptyDay(addDays(START, 1))).snapshot;
    expect(d1.state).toEqual(d1plain.state); // identical outcome
  });

  it("boosts moisture, soil and the life bonus (capped by the shared reservoirs)", () => {
    let snap = initialSnapshot(START);
    const before = snap.state;
    const after = simulateDay(snap, adventureDay(addDays(START, 1))).snapshot.state;
    // Adventure days are frozen: applyDailyDecay does NOT run, so the only
    // moisture change is the adventure's own +0.05 watering.
    expect(after.moisture).toBeCloseTo(Math.min(1, before.moisture + 0.05), 5);
    expect(after.soilHealth).toBeGreaterThan(before.soilHealth);
    expect(after.lifeBonusBiodiversity).toBeCloseTo(0.03, 5);
    expect(after.lifeBonusFlowering).toBeCloseTo(0.02, 5);
  });

  it("recovery-aware grace: tired days after a trip are shielded, capped at 2", () => {
    let snap = initialSnapshot(START);
    snap = simulateDay(snap, adventureDay(addDays(START, 1))).snapshot;
    const clocks = snap.state.daysSinceStrength;
    snap = simulateDay(snap, { ...emptyDay(addDays(START, 2)), recoveryScore: 40 }).snapshot;
    snap = simulateDay(snap, { ...emptyDay(addDays(START, 3)), recoveryScore: 55 }).snapshot;
    expect(snap.state.daysSinceStrength).toBe(clocks); // two shielded days
    snap = simulateDay(snap, { ...emptyDay(addDays(START, 4)), recoveryScore: 30 }).snapshot;
    expect(snap.state.daysSinceStrength).toBe(clocks + 1); // window over: cap is 2
  });

  it("heuristic grace: a big day banks a shield for dates without health data", () => {
    let snap = initialSnapshot(START);
    snap = simulateDay(snap, adventureDay(addDays(START, 1))).snapshot; // big → banks 1
    expect(snap.state.adventureGraceDays).toBe(1);
    const clocks = snap.state.daysSinceStrength;
    snap = simulateDay(snap, emptyDay(addDays(START, 2))).snapshot; // spends it
    expect(snap.state.daysSinceStrength).toBe(clocks);
    expect(snap.state.adventureGraceDays).toBe(0);
    snap = simulateDay(snap, emptyDay(addDays(START, 3))).snapshot; // bank empty → decays
    expect(snap.state.daysSinceStrength).toBe(clocks + 1);
  });

  it("suppresses missed-run punishment on adventure days", () => {
    let snap = initialSnapshot(START);
    const withMiss = simulateDay(snap, {
      ...adventureDay(addDays(START, 1)),
      missedRuns: [{ workoutId: "w1" }],
    }).snapshot;
    const noMiss = simulateDay(snap, adventureDay(addDays(START, 1))).snapshot;
    expect(withMiss.state.moisture).toBeCloseTo(noMiss.state.moisture, 5);
  });

  it("emits adventure_logged with the sport as detail", () => {
    const { events } = simulateDay(initialSnapshot(START), adventureDay(addDays(START, 1)));
    const e = events.find((x) => x.kind === "adventure_logged");
    expect(e?.detail).toBe("hike");
  });

  it("is deterministic: same inputs twice, deep-equal state", () => {
    const days = [adventureDay(addDays(START, 1)), { ...emptyDay(addDays(START, 2)), recoveryScore: 40 }];
    const run = () => days.reduce((s, d) => simulateDay(s, d).snapshot, initialSnapshot(START));
    expect(run()).toEqual(run());
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (type errors first: `adventures` not on `GardenDayInput`).

- [ ] **Step 3: Implement.**

`packages/domain/src/garden.ts`: append `"adventure_logged"` to `GARDEN_EVENT_KINDS`.

`types.ts`:
- `export const SIMULATION_VERSION = 4;`
- `GardenDayInput` gains (after `weekAdherence`):

```ts
  /** Non-discipline sports completed this day (raw; the engine applies the
   * effort threshold). Absent on days without adventures — stored inputs
   * from before v4 replay unchanged. */
  adventures?: Array<{ sport: string; trainingLoad?: number; durationMin?: number }>;
  /** Coros recovery 0-100 for this date (higher = more recovered), when known. */
  recoveryScore?: number;
```

- `EngineGardenState` gains (near `lifeBonusFlowering`):

```ts
  /** Most recent qualifying adventure day — anchors the grace window. */
  lastAdventureDate?: LocalDate | null;
  /** Banked heuristic grace days (used only for dates without recovery data). */
  adventureGraceDays?: number;
```

- `weekDisciplines` type becomes `{ weekStart: LocalDate; run: boolean; strength: boolean; yoga: boolean; adventure?: boolean }`.

`simulate.ts` — import from `./adventure.js`; then:

1. Defaults block (~line 190): add `state.lastAdventureDate ??= null; state.adventureGraceDays ??= 0;` and in the `weekDisciplines ??=` literal add `adventure: false`.
2. Week rollover (~line 215): new-week literal gains `adventure: false` (the `balancedWeekCount` check is unchanged — adventures never gate balanced weeks).
3. After the sessions are split (~line 235), compute the shield:

```ts
  // Adventures: optional sports shelter the garden — never feed the clocks.
  const adventures = (input.adventures ?? []).filter(qualifiesAsAdventure);
  const adventureToday = adventures.length > 0;
  const graceDay = adventureGraceDay(
    { lastAdventureDate: state.lastAdventureDate ?? null, adventureGraceDays: state.adventureGraceDays ?? 0 },
    {
      date: input.date,
      hasSession: runs.length > 0,
      adventureToday,
      restMode: state.restMode,
      planGap: input.planGap,
      recoveryScore: input.recoveryScore,
    },
  );
  const adventureFrozen = adventureToday || graceDay;
  if (graceDay && input.recoveryScore === undefined) {
    state.adventureGraceDays = Math.max(0, (state.adventureGraceDays ?? 0) - 1);
  }
```

4. §1 missed runs: condition becomes `if (!state.restMode && !adventureFrozen) {`.
5. §4 no-run day: `} else if (!state.restMode && !adventureFrozen) {`.
6. §5 clocks: both `else if (!state.restMode)` arms become `else if (!state.restMode && !adventureFrozen)`.
7. §6 neglect: `if (!state.restMode && !input.planGap && !adventureFrozen) {`.
8. Adventure effects — insert after §3 (strength/yoga session effects), before §4:

```ts
  // 3b. Adventures tend the garden: life bonus (shared reservoirs), a light
  //     watering, a little soil. Smaller than a run's rain on purpose.
  for (const a of adventures) {
    tendLifeAxis(state, 0.03, 0.02);
    state.moisture = Math.min(1, state.moisture + 0.05);
    state.soilHealth = Math.min(1, state.soilHealth + 0.02);
    emit({ kind: "adventure_logged", detail: a.sport });
  }
  if (adventureToday) {
    state.lastAdventureDate = input.date;
    state.weekDisciplines.adventure = true;
    if (adventures.some(isBigAdventure)) {
      state.adventureGraceDays = Math.min(
        ADVENTURE_TUNING.graceCap,
        (state.adventureGraceDays ?? 0) + 1,
      );
    }
  }
```

(Confirm `emit`'s event type carries `detail` — `GardenEvent` has `detail` per the region_unlocked usage; if the emit omission type needs it, it's already `detail?`.)

- [ ] **Step 4: Run the FULL engine suite — expect PASS, including all pre-existing tests unchanged** (`pnpm vitest run packages/garden-engine`). Pre-existing tests failing = you broke non-adventure semantics; fix your wiring, not the tests.
- [ ] **Step 5: Commit** — `git commit -am "feat(garden-engine): adventures freeze clocks, earn recovery-aware grace, tend the garden — SIMULATION_VERSION 4"`

---

### Task 6: Worker builds adventure day inputs and the view shield

**Files:**
- Modify: `apps/worker/src/services/garden-sync.ts` (`buildDayInput` ~line 196-252; `buildGardenView` ~line 508-533 and the return ~line 604)
- Test: none runnable (apps/worker has no test harness) — correctness rests on Task 4/5 unit tests plus Task 9's fixture-stack verification. Keep worker logic to thin glue.

**Interfaces:**
- Consumes: `isAdventureSport`, `SPORT_BY_ID` (Task 1); `qualifiesAsAdventure`, `adventureGraceDay`, `recoveryScoreFrom`, `ADVENTURE_TUNING` (Task 4); `dailyHealth` table (`@rg/database`).
- Produces: `GardenView.adventure: { frozenToday: boolean; graceDay: boolean; lastSport: string | null; lastDate: string | null }` — the UI (Task 8) casts this off the garden payload like it does `restMode`.

- [ ] **Step 1: Extend `buildDayInput`.** In the unplanned-activities loop's file section (the loop at line 201 `continue`s past non-discipline sports — leave that), add after that loop:

```ts
  // Adventures: every non-discipline sport on this date. Raw load/duration —
  // the engine applies the effort threshold so the stored inputs stay honest.
  const adventures = dayActivities
    .filter((a) => {
      const d = (a.startTimeLocal ?? a.startTime).slice(0, 10);
      return d === date && isAdventureSport(a.sport);
    })
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => ({
      sport: a.sport,
      trainingLoad: a.trainingLoad ?? undefined,
      durationMin: Math.round(a.durationSeconds / 60),
    }));
```

and where `input: GardenDayInput` is assembled (line 245), add conditionally (keeps stored JSON lean and pre-v4 inputs byte-identical):

```ts
  if (adventures.length > 0) input.adventures = adventures;
  const healthRow = await db
    .select()
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), eq(dailyHealth.date, date)))
    .limit(1);
  const recovery = recoveryScoreFrom(healthRow[0]?.recoveryScore, healthRow[0]?.fatigueScore);
  if (recovery !== undefined) input.recoveryScore = recovery;
```

(Note: `dayActivities` at line 197 selects unmatched activities only — adventures never match planned workouts, so they are always in this set. Import `dailyHealth` from `@rg/database` and the engine/domain helpers at the top.)

- [ ] **Step 2: Extend `buildGardenView`.** Hoist today's input out of the preview `if` so the shield can use it, and preview adventure days too (same-day feedback for a hike):

```ts
  let todayInput: GardenDayInput | null = null;
  let previewEvents: GardenEvent[] = [];
  const today = todayInZone(prefs.timezone);
  if (addDays(snapshot.state.lastSimulatedDate, 1) === today) {
    try {
      todayInput = await buildDayInput(db, userId, today, prefs);
      if (todayInput.completedRuns.length > 0 || (todayInput.adventures?.length ?? 0) > 0) {
        const preview = simulateDay(snapshot, todayInput);
        snapshot = preview.snapshot;
        previewEvents = preview.events;
      }
    } catch {
      // Preview is cosmetic — never let it break the garden read.
    }
  }
```

Then before the `return`, compute the shield + the caption's noun:

```ts
  // Adventure shield for the caption: is today sheltered, and by what?
  const st = snapshot.state;
  const qualifyingToday = (todayInput?.adventures ?? []).filter(qualifiesAsAdventure);
  const frozenToday = qualifyingToday.length > 0;
  const graceDay =
    !frozenToday &&
    adventureGraceDay(
      { lastAdventureDate: st.lastAdventureDate ?? null, adventureGraceDays: st.adventureGraceDays ?? 0 },
      {
        date: today,
        hasSession: (todayInput?.completedRuns.length ?? 0) > 0,
        adventureToday: false,
        restMode: st.restMode,
        planGap: todayInput?.planGap ?? false,
        recoveryScore: todayInput?.recoveryScore,
      },
    );
  let lastSport: string | null = qualifyingToday[0]?.sport ?? null;
  if (!lastSport && graceDay && st.lastAdventureDate) {
    const row = (await db
      .select()
      .from(activities)
      .where(and(eq(activities.userId, userId), gte(activities.startTime, `${st.lastAdventureDate}T00:00:00`)))
      .orderBy(desc(activities.startTime))
      .limit(10)).find((a) => isAdventureSport(a.sport));
    lastSport = row?.sport ?? null;
  }
```

and add to the returned object:

```ts
    adventure: {
      frozenToday,
      graceDay,
      lastSport,
      lastDate: frozenToday ? today : (st.lastAdventureDate ?? null),
    },
```

with the matching field on the `GardenView` interface (~line 499):

```ts
  /** Today's adventure shield: sheltered day + what to name in the caption. */
  adventure: { frozenToday: boolean; graceDay: boolean; lastSport: string | null; lastDate: string | null };
```

- [ ] **Step 3: Typecheck + full test suite** (`pnpm vitest run` at root, plus the repo typecheck). `buildGardenTimeline` (line ~661 comment) reuses stored inputs — confirm it compiles untouched.
- [ ] **Step 4: Commit** — `git commit -am "feat(worker): adventure day inputs (load/duration/recovery) and the view's adventure shield"`

---

### Task 7: History screen speaks every sport

**Files:**
- Modify: `packages/ui/src/screens/runs.tsx:30-73,207`
- Modify: the UI stylesheet where `.chip-run`/`.chip-strength` live (`grep -rn "chip-strength" packages/ui/src apps/web/src` to find it) — add `.chip-adventure`
- Test: `packages/ui/test/render-smoke.test.ts` covers screens render — run it; no new unit test (presentation only).

**Interfaces:**
- Consumes: `sportLabel`, `isAdventureSport` from `@rg/domain`.

- [ ] **Step 1: Implement.**
  - `type DisciplineFilter = "all" | "run" | "strength" | "yoga" | "adventure";`
  - `FILTERS` gains `{ key: "adventure", label: "Adventures", chipClass: "chip-adventure" }`.
  - Delete the local `SPORT_LABELS` map; wherever it was read (`grep -n "SPORT_LABELS" packages/ui/src/screens/runs.tsx`), call `sportLabel(a.sport)` instead.
  - Update the stale comment above it (lines 39-44): adventures now do have a chip.
  - Filter predicate (line 207):

```ts
  const items = (runs.data?.activities ?? []).filter((a) =>
    filter === "all" ? true : filter === "adventure" ? isAdventureSport(a.sport) : a.sport === filter,
  );
```

  - `EMPTY_COPY` gains:

```ts
  adventure: {
    art: "🥾",
    title: "No adventures yet",
    body: "Hikes, rides, ski days and every other outing from COROS land here — the garden rests easy while you roam.",
  },
```

  - Add `.chip-adventure` beside the other chip classes (pick a warm neutral consistent with the existing palette — match the CSS file's conventions).

- [ ] **Step 2: Run UI tests + typecheck — expect PASS.**
- [ ] **Step 3: Commit** — `git commit -am "feat(ui): activity history labels every sport; Adventures filter chip"`

---

### Task 8: Garden page — caption voice, week marks, event copy

**Files:**
- Modify: `packages/ui/src/screens/garden.tsx` (`ForecastLine` ~line 492; loss-voice gate ~line 1040-1044; both `<ForecastLine>` call sites ~1280, ~1528; balance-detail week line ~457-460; `eventLine` switch ~line 178; `WeekRibbon` ~line 594)
- Test: `packages/ui/test/render-smoke.test.ts` — run; visual verification is Task 9.

**Interfaces:**
- Consumes: `view.adventure` payload (Task 6) — cast like `restMode` is at line 914: `const adventure = garden.data.adventure as { frozenToday: boolean; graceDay: boolean; lastSport: string | null; lastDate: string | null } | undefined;`; `sportLabel`, `isAdventureSport` from `@rg/domain`; existing `weekdayFull`, `api.activities`.

- [ ] **Step 1: Implement the caption.** `ForecastLine` gains an optional `adventure` prop (the cast type above). At the TOP of its line-choosing chain (before the `f.recovering` branch — the shield outranks everything, and it is reassurance, not loss):

```tsx
  if (adventure?.frozenToday) {
    const noun = adventure.lastSport ? sportLabel(adventure.lastSport).toLowerCase() : "adventure";
    line = (
      <>
        Today's <strong>{noun}</strong> tends the garden from afar — no rain owed.
      </>
    );
  } else if (adventure?.graceDay) {
    const noun = adventure.lastSport ? sportLabel(adventure.lastSport).toLowerCase() : "adventure";
    line = adventure.lastDate ? (
      <>
        {weekdayFull(adventure.lastDate)}'s <strong>{noun}</strong> is still keeping the beds shaded.
      </>
    ) : (
      <>Still restoring from your adventure — the garden holds its water.</>
    );
  } else if (f.recovering) {
```

Pass `adventure={adventure}` at both `<ForecastLine>` call sites. At the loss-voice gate (line ~1042-1044), a sheltered day must not count as a loss voice AND must still let the ForecastLine speak; the flag feeds bar-caption suppression, so extend it:

```ts
  const sheltered = adventure?.frozenToday || adventure?.graceDay;
  const forecastSpeaksLoss =
    viewingLive && !restMode.active && !sheltered && !fc.recovering && (fc.next !== null || fc.victim !== null);
```

- [ ] **Step 2: Balance-detail week line** (line 457-460) — adventures appear only when present, never as a dash (optional means no nag):

```tsx
        This week: Run {wkMark(wk.run)} · Lift {wkMark(wk.strength)} · Yoga {wkMark(wk.yoga)}
        {wk.adventure ? " · Adventure ✓" : ""}
```

(Keep the balanced-week sentence keyed off the original trio only.)

- [ ] **Step 3: Event feed copy** — in the `eventLine` switch (~line 178 area) add:

```ts
    case "adventure_logged":
      return e.detail
        ? `A ${sportLabel(e.detail).toLowerCase()} fed the garden — wild air does it good.`
        : "An adventure fed the garden — wild air does it good.";
```

(Check the switch's `e` type exposes `detail`; the `region_unlocked` case already reads it.)

- [ ] **Step 4: Week ribbon marks.** In `WeekRibbon`, add a query for the week's activities and mark adventure days with a small ring around the day dot:

```tsx
  const acts = useQuery({ queryKey: ["runs"], queryFn: () => api.activities(40), staleTime: 5 * 60_000 });
  const adventureDates = useMemo(
    () =>
      new Set(
        ((acts.data?.activities ?? []) as ActivityDto[])
          .filter((a) => a.date >= monday && a.date <= addDays(monday, 6) && isAdventureSport(a.sport))
          .map((a) => a.date),
      ),
    [acts.data, monday],
  );
```

(Reusing queryKey `["runs"]` shares the cache with the history screen.) Then on the day-dot span (line ~640) append the class: `` `week-day-dot${w ? ` cat-${w.category}` : " week-day-empty"}${adventureDates.has(date) ? " week-day-adventure" : ""}` `` and add CSS beside the week-ribbon styles: a subtle ring, e.g. `.week-day-adventure { box-shadow: 0 0 0 2px var(--adventure-ring, #b8a06a55); border-radius: 50%; }` — match the stylesheet's variable conventions.

- [ ] **Step 5: Run UI tests + typecheck — expect PASS. Commit** — `git commit -am "feat(ui): garden speaks for adventures — sheltered captions, week marks, feed line"`

---

### Task 9: Fixtures, verification, rollout notes

**Files:**
- Modify: `apps/worker/src/services/fixtures.ts` (add adventure activities to the fixture history; it already writes `recoveryScore` at line ~637)
- Modify: `packages/providers/src/fixture-provider.ts` if the fixture stack sources activities there (check which one the dev stack uses)
- Docs: append a rollout section to the spec file.

- [ ] **Step 1: Add fixture adventures.** In the fixture generator, add (a) a big Saturday hike (`sport: "hike"`, `durationSeconds: 4 * 3600`, `trainingLoad: 120`) followed by a low `recoveryScore` day, and (b) a mid-week sub-threshold walk (`durationSeconds: 20 * 60`, no load) — so both the shield and the neutral case are visible on the fixture stack. Follow the file's existing deterministic id/date patterns.

- [ ] **Step 2: Full verification (superpowers:verification-before-completion).**
  - `pnpm vitest run` at root — all green, paste the summary.
  - Repo typecheck/lint commands from root `package.json` — green.
  - Fixture stack (worktree needs `.dev.vars` copied and `apps/web/dist` mkdir'd; wrangler needs Node 22 via `~/.nvm/versions/node/v22.23.1/bin`; ports `RG_API_PORT=8899 RG_WEB_PORT=5199`): boot, screenshot the garden page showing (1) the sheltered caption after the fixture hike, (2) the Adventures chip filtering history, (3) the week ribbon ring. Screenshot before/after per the standing review workflow.
- [ ] **Step 3: Rollout notes** — append to the spec doc:
  - Deploy order: worker+web deploy first (SIMULATION_VERSION 4 auto-resims each garden on next read — protective-only changes expected); then run "Backfill history" from Settings (or `pnpm coros:backfill`) to fetch previously-dropped activities; `pnpm coros:census` to confirm zero unnamed codes (or add them to the registry); the late-arriving activities trigger `resimulateFrom` for their dates.
  - Threshold calibration: after backfill, eyeball the census/load distribution — if a typical easy hike lands under load 40, lower `ADVENTURE_TUNING.minLoad`.
- [ ] **Step 4: Commit** — `git commit -am "chore(fixtures,docs): adventure fixtures + rollout notes"`

---

## Self-review checklist (run after writing, before executing)

- Spec coverage: registry/import (T1-2), recovery sync (T3), engine mechanics incl. version bump (T4-5), day inputs + view (T6), UI surface (T7-8), backfill/rollout + calibration (T9). Insights picker, weekly review, matching: deliberately untouched (spec "not in scope").
- Type consistency: `AdventureInput`, `ADVENTURE_TUNING`, `adventureGraceDay(s, opts)`, `view.adventure {frozenToday, graceDay, lastSport, lastDate}` are used with identical shapes in Tasks 4, 5, 6, 8.
- No placeholders: every step carries its code or an exact grep/command to find the site.
