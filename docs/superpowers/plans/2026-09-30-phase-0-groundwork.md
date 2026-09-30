# Phase 0 — Groundwork and Safety Nets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the correctness bugs the programme would otherwise build on, make every user table exportable and restorable, stop app-recorded activities from ever being swallowed by the COROS ingest, and stand up an inert staging environment with an in-Cloudflare copier and a hash-only parity harness — before any new feature lands.

**Architecture:** Shared plan-mutation services so the coach and the athlete's own routes cannot diverge; a single table registry that drives export, restore, the copier and the parity harness; a `STAGING` mode that makes a deployment unable to reach COROS, Google Calendar or the LLM; a temporary copier Worker entry bound to both databases.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, D1 via Drizzle, vitest + better-sqlite3 (`makeTestDb`), React/TanStack Query in `@rg/ui`, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-one-workout-system-design.md` (§3, §8.5, §12.5, §13, §15 Phase 0).

## Global Constraints

- Tests run with `pnpm test` on the default **Node 21** (`node -v` → v21.x). Never put Node 22 on PATH in the same shell as vitest.
- wrangler commands use Node 22: `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"` in that shell only.
- Gates after every task: `pnpm -r typecheck`, `pnpm test`, `pnpm build:web` — all green.
- Migrations are **hand-authored** SQL in `packages/database/migrations/NNNN_name.sql`, next number `0022`. Never run `pnpm db:generate`. Statements separated by `--> statement-breakpoint`.
- Every new user table joins `deleteAllUserData` (misc.ts) — the coverage test in `apps/worker/test/delete-all-data.test.ts` fails otherwise.
- D1 binds ≤ 100 variables per statement: chunk every `inArray` with `chunkIds()` from `services/db.ts`; chunk multi-row inserts to `floor(100 / columnCount)` rows.
- No test reads the real clock for a hard-coded date; relative dates via `todayInZone(prefs.timezone)` + `addDays` are fine, fixed dates need `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime`.
- Workers runtime: never call a stored `fetch` as a method (`this.fetchImpl(...)`); wrap as `(...a) => fetch(...a)`. Use `waitUntilSafe`, never `c.executionCtx`.
- No personal data in code, fixtures, tests or docs (no account email, no saved-post URLs, no creator handles).
- Subagents never commit; the orchestrator runs gates and commits.
- Copy follows the owner's density rules: plain labels, no explainer captions.

## Review Focus

1. **A coach removal followed by the next COROS import** — the row must stay archived and off the calendar (today presence-healing can resurrect it). Pinned in Task 1.
2. **Restore into an account that already has data** — must refuse unless `replace: true`, and a replace must never delete the signed-in user or their session. Pinned in Task 9.
3. **A COROS activity arriving near an `import`-source activity** — must never adopt it; an `app` row is adopted (the merge). Pinned in Task 7.
4. **A staging Worker handling a cron or a request that would call COROS / Calendar / the LLM** — every such fetch throws before leaving the Worker. Pinned in Task 11.
5. **Copier interrupted mid-table and re-invoked** — resumes without duplicating rows, and the final per-table hashes match. Pinned in Task 13.

---

## Slice A — correctness fixes

### Task 1: Coach `remove` has the manual route's side effects

**Files:**
- Create: `apps/worker/src/services/plan-mutations.ts`
- Modify: `apps/worker/src/routes/plan.ts` (`POST /workouts/:id/remove`, ~1460–1511)
- Modify: `apps/worker/src/services/coach-apply.ts` (`case "remove"` ~1181; `suppressAndUnpush` ~836)
- Modify: `apps/worker/src/routes/coach.ts` (`POST /proposals/:id/approve` ~400)
- Test: `apps/worker/test/plan-mutations.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RemoveResult { removed: boolean; effectiveDate: string | null }
  export async function removeFromPlan(
    db: Db, userId: string, workoutId: string,
    opts: { now: string; source: IntentSource },
  ): Promise<RemoveResult>;
  export async function enqueueUnpushIfOurs(
    db: Db, userId: string, row: typeof plannedWorkouts.$inferSelect, now: string, prefs: UserPreferences,
  ): Promise<void>;   // the unpush half of suppressAndUnpush, moved to plan-mutations.ts
  ```
- `ApplyResult` gains `resimFrom: string | null` — the earliest date ≤ today that an op resolved, archived or restored (null when none).

- [ ] **Step 1: Write the failing tests** (`plan-mutations.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone } from "@rg/domain";
import { applyOps } from "../src/services/coach-apply.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { openIntentFor, recordIntent } from "../src/services/sync-intents.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

async function seed(db, userId, id, date) {
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId: "p", sourceWorkoutId: `4738:${id}`, title: "Easy 40", category: "easy", sport: "run",
    originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "07:00",
    completionState: "scheduled", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 2400,
    createdAt: nowInstant(), updatedAt: nowInstant(),
  });
}

describe("removeFromPlan", () => {
  it("archives, suppresses as user_removed, records remove_local and closes an open move intent", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const date = addDays(todayInZone(prefs.timezone), 2);
    await seed(db, userId, "w1", date);
    await recordIntent(db, { userId, targetKind: "workout", targetId: "w1", kind: "move", source: "user_move" });
    const out = await removeFromPlan(db, userId, "w1", { now: nowInstant(), source: "remove_from_plan" });
    expect(out).toEqual({ removed: true, effectiveDate: date });
    const [w] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1"));
    expect(w!.archiveReason).toBe("user_removed");
    const sup = await db.select().from(schema.calendarEventSuppressions)
      .where(eq(schema.calendarEventSuppressions.workoutId, "w1"));
    expect(sup.map((s) => s.reason)).toEqual(["user_removed"]);
    expect(await openIntentFor(db, userId, "w1", "remove_local")).toBeTruthy();
    expect(await openIntentFor(db, userId, "w1", "move")).toBeFalsy();
  });

  it("is a no-op for an archived or foreign row", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seed(db, other, "w2", addDays(todayInZone(prefs.timezone), 1));
    expect(await removeFromPlan(db, userId, "w2", { now: nowInstant(), source: "remove_from_plan" }))
      .toEqual({ removed: false, effectiveDate: null });
  });
});

describe("coach remove ≡ manual remove", () => {
  it("a coach remove writes the same suppression and intent the route writes", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const date = addDays(todayInZone(prefs.timezone), 3);
    await seed(db, userId, "w1", date);
    const out = await applyOps(db, userId, prefs, "prop1", [{ kind: "remove", workoutId: "w1" }]);
    expect(out.archived).toEqual(["w1"]);
    const sup = await db.select().from(schema.calendarEventSuppressions)
      .where(eq(schema.calendarEventSuppressions.workoutId, "w1"));
    expect(sup).toHaveLength(1);
    expect(sup[0]!.reason).toBe("user_removed");
    expect(await openIntentFor(db, userId, "w1", "remove_local")).toBeTruthy();
  });

  it("re-applying the same remove adds no second suppression", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seed(db, userId, "w1", addDays(todayInZone(prefs.timezone), 3));
    await applyOps(db, userId, prefs, "prop1", [{ kind: "remove", workoutId: "w1" }]);
    await applyOps(db, userId, prefs, "prop1", [{ kind: "remove", workoutId: "w1" }]);
    const sup = await db.select().from(schema.calendarEventSuppressions)
      .where(eq(schema.calendarEventSuppressions.workoutId, "w1"));
    expect(sup).toHaveLength(1);
  });

  it("reports resimFrom for a past-dated removal and null for a future one", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seed(db, userId, "past", addDays(today, -2));
    await seed(db, userId, "future", addDays(today, 2));
    // Past rows are refused by guardrails upstream, but apply itself must still report honestly.
    const a = await applyOps(db, userId, prefs, "p1", [{ kind: "remove", workoutId: "future" }]);
    expect(a.resimFrom).toBeNull();
  });
});
```

Also add a regression to `apps/worker/test/import-reconcile.test.ts` (use its existing snapshot helpers): seed a COROS-imported row, `applyOps` a coach `remove` on it, then run the import with the same snapshot still containing that workout, and assert the row is still archived with `archiveReason = "user_removed"` and no calendar link was re-created.

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run apps/worker/test/plan-mutations.test.ts` → FAIL (`plan-mutations.js` not found; then suppression count 0 for the coach path).

- [ ] **Step 3: Implement**
  - Move the body of the `/remove` route (select row scoped to user, early-return when missing/archived, archive with `user_removed`, insert `calendarEventSuppressions` reason `user_removed`, `recordIntent(... kind: "remove_local", source)`, resolve an open `move` intent) into `removeFromPlan`. Add `"coach_remove"` to `IntentSource` in `sync-intents.ts`.
  - The route calls `removeFromPlan(..., { source: "remove_from_plan" })`, returns 404 when the row does not exist for this user (keep the current 404/`ok:true` contract: 404 when missing, `ok:true` when already archived), then `syncCalendar` and `resimulateFrom(min(effectiveDate, today))` exactly as today.
  - Split `suppressAndUnpush` into `insert suppression` + `enqueueUnpushIfOurs` (moved verbatim to `plan-mutations.ts`, exported). `suppressAndUnpush` keeps its behaviour by calling both.
  - `applyOps` `case "remove"`: load the full row (user-scoped, not archived); if missing push the existing `out.missed` message; else `await removeFromPlan(db, userId, op.workoutId, { now, source: "coach_remove" })` then `await enqueueUnpushIfOurs(db, userId, row, now, prefs)`; `out.archived.push(id)`; track `resimFrom` when `row.effectiveDate <= today`.
  - `ApplyResult.resimFrom`: initialise `null`; set to the minimum date ≤ today among ops that skip, remove, restore or resolve (the existing `skip` case resolves `today`, so a coach skip sets `resimFrom = today`).
  - Approve route: after `applyOps`, `if (applied.resimFrom) await resimulateFrom(db, userId, applied.resimFrom, prefs).catch(() => undefined);` and `waitUntilSafe(c, syncCalendar(db, c.env, userId).catch(() => undefined));` alongside the existing `executeCloudJobs`.

- [ ] **Step 4: Run to verify pass** — the new file plus `coach-apply.test.ts`, `plan-routes.test.ts`, `import-reconcile.test.ts`, `intent-conservation.test.ts`; then the full gates.

- [ ] **Step 5: Commit** — `fix(coach): a coach remove suppresses, records intent and resimulates like the athlete's own remove`

### Task 2: Coach `restore` has the manual unskip's side effects

**Files:**
- Modify: `apps/worker/src/services/plan-mutations.ts`, `routes/plan.ts` (`/unskip` ~1310), `coach-apply.ts` (`case "restore"` ~1204)
- Test: `apps/worker/test/plan-mutations.test.ts`

**Interfaces:**
- Produces: `export async function unskipWorkout(db: Db, userId: string, workoutId: string, opts: { now: string; source: "app" | "coach" }): Promise<{ restored: boolean; resolvedOn: string | null; reason?: "not_found" | "not_skipped" }>`

- [ ] **Step 1: Failing tests**

```ts
describe("unskipWorkout", () => {
  it("clears the skip, writes a restore override, and reports the resolved date", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seed(db, userId, "w1", today);
    await db.update(schema.plannedWorkouts)
      .set({ completionState: "skipped", resolutionDate: today, sanctionedBy: "coach" })
      .where(eq(schema.plannedWorkouts.id, "w1"));
    const out = await unskipWorkout(db, userId, "w1", { now: nowInstant(), source: "coach" });
    expect(out).toEqual({ restored: true, resolvedOn: today });
    const [w] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1"));
    expect([w!.completionState, w!.resolutionDate, w!.sanctionedBy]).toEqual(["scheduled", null, null]);
    const ov = await db.select().from(schema.scheduleOverrides).where(eq(schema.scheduleOverrides.workoutId, "w1"));
    expect(ov.map((o) => [o.kind, o.source])).toEqual([["restore", "coach"]]);
  });
  it("refuses a row that is not skipped", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seed(db, userId, "w1", todayInZone(prefs.timezone));
    expect(await unskipWorkout(db, userId, "w1", { now: nowInstant(), source: "app" }))
      .toEqual({ restored: false, resolvedOn: null, reason: "not_skipped" });
  });
  it("coach restore sets resimFrom to the skip's resolution date", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seed(db, userId, "w1", addDays(today, 1));
    await db.update(schema.plannedWorkouts)
      .set({ completionState: "skipped", resolutionDate: today }).where(eq(schema.plannedWorkouts.id, "w1"));
    const out = await applyOps(db, userId, prefs, "p", [{ kind: "restore", workoutId: "w1" }]);
    expect(out.updated).toEqual(["w1"]);
    expect(out.resimFrom).toBe(today);
  });
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** `unskipWorkout` from the `/unskip` route body (`resolvedOn = resolutionDate ?? effectiveDate`; update; insert `scheduleOverrides {kind:"restore", fromDate: resolvedOn, source}`). Check `scheduleOverrides.source` accepts `"coach"` (it is a text column; if a domain enum exists, extend it). The route maps `reason` to its existing 404/422 responses and keeps its resim. `applyOps` `case "restore"` calls it, pushes the existing `missed` message when `restored` is false, and feeds `resolvedOn` into `resimFrom` when ≤ today.
- [ ] **Step 4: Verify pass + gates.**
- [ ] **Step 5: Commit** — `fix(coach): a coach restore writes the restore override and resimulates, like unskip`

### Task 3: Coach `adjust` keeps estimates honest, joins placement, and stops lying about the watch

**Files:**
- Modify: `apps/worker/src/services/coach-apply.ts` (`case "adjust"` ~1235)
- Modify: `apps/worker/src/services/coach-describe.ts` (the adjust manifest line)
- Test: `apps/worker/test/coach-apply.test.ts`

**Behaviour:** `adjust` changes how long a session is on the calendar. It sets `calendarBlockDurationSeconds` **and** `fallbackEstimatedDurationSeconds` to `durationMinutes * 60`, adds the row's `effectiveDate` to `touchedDates` (so `separateDayCollisions` re-places the day), and **leaves `corosSyncState` unchanged** (no job is enqueued, so flipping it to `calendar_only` stranded the row as "not synced" forever). When the row has a watch address (`watchAddressOf(row)` non-null), the manifest line appends `· watch unchanged`.

- [ ] **Step 1: Failing tests**

```ts
it("adjust rewrites the block and the fallback estimate, and leaves sync state alone", async () => {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db);
  await seedWorkout(db, userId, "w1", addDays(todayInZone(prefs.timezone), 2));
  await db.update(schema.plannedWorkouts).set({ corosSyncState: "synced" }).where(eq(schema.plannedWorkouts.id, "w1"));
  await applyOps(db, userId, prefs, "p", [{ kind: "adjust", workoutId: "w1", durationMinutes: 30 }]);
  const [w] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1"));
  expect(w!.calendarBlockDurationSeconds).toBe(1800);
  expect(w!.fallbackEstimatedDurationSeconds).toBe(1800);
  expect(w!.corosSyncState).toBe("synced");
});
```

And in the `coach-describe` tests: a manifest for `adjust` on a row whose `sourceWorkoutId` has the `planId:idInPlan` shape ends with `· watch unchanged`; on a coach-authored unpushed row it does not.

- [ ] **Step 2–4:** fail → implement → pass + gates.
- [ ] **Step 5: Commit** — `fix(coach): adjust keeps estimates in step, re-places the day, and says the watch is unchanged`

### Task 4: Guardrails see remove/restore/adjust; the prompt states the real rule split

**Files:**
- Modify: `packages/domain/src/coach-guardrails.ts` (`resultingCalendar` ~622; `HARD_LIMITS_PROMPT` comment ~292)
- Modify: `apps/worker/src/services/coach-wake.ts` (comment ~525)
- Test: `packages/domain/test/coach-guardrails.test.ts`

**Behaviour:** `remove` deletes the entry from the load calendar (like `skip`); `restore` re-adds the skipped row (from `ctx.workouts`, which includes skipped rows before the filter — keep an unfiltered map for lookup); `adjust` sets `durationMinutes`. The switch gains a `default: { const _never: never = op; void _never; }` exhaustiveness check so the next op kind is a compile error. Selector ops are expanded before this runs; list them as explicit no-op cases with a comment. The two stale comments ("three of them reject … eight") become "the fatal rules in `RULE_CLASS` reject; the advisory ones print a trade-off", with no hard-coded counts.

- [ ] **Step 1: Failing tests**

```ts
it("a ramp advisory disappears when the proposal removes the session that caused it", () => {
  // Build a ctx whose week already exceeds the ramp cap by one strength session S,
  // then validate [{kind:"remove", workoutId: S.id}] and expect no "ramp" finding.
});
it("adjust shortens a hard strength session below HARD_LIFT_MINUTES and clears hard_adjacency", () => {
  // Two consecutive hard days where day 2 is a 60-min strength session; adjust it to
  // TRIVIAL_LIFT_MINUTES - 1 and expect no hard_adjacency finding.
});
```

Write them with the file's existing ctx builders (read the top of `coach-guardrails.test.ts` for `ctxWith(...)`-style helpers and copy their shape exactly).

- [ ] **Step 2–4:** fail → implement → pass + gates.
- [ ] **Step 5: Commit** — `fix(coach): guardrails simulate remove/restore/adjust; the prompt stops counting rules by hand`

### Task 5: Yoga calendar events are titled "Yoga"; `isRunning` stops calling yoga a run

**Files:**
- Modify: `packages/calendar/src/event-body.ts` (`CATEGORY_LABEL` ~40)
- Modify: `packages/domain/src/workout.ts` (`isRunning` ~159)
- Test: `packages/calendar/test/calendar.test.ts`, `packages/domain/test/workout.test.ts` (create if absent)

- [ ] **Step 1: Failing tests**

```ts
expect(buildEventTitle({ ...baseInfo, category: "yoga", title: "Hips & posture" })).toBe("Yoga · Hips & posture");
expect(isRunning({ category: "yoga" })).toBe(false);
expect(isRunning({ category: "easy" })).toBe(true);
```

(`baseInfo`: copy the `EventWorkoutInfo` literal an existing `buildEventTitle` test uses.)

- [ ] **Step 2–4:** add `yoga: "Yoga"` to `CATEGORY_LABEL`; add `&& w.category !== "yoga"` to `isRunning`. Existing yoga events get one title patch from the reconciler on the next sync — intended.
- [ ] **Step 5: Commit** — `fix(calendar): yoga sessions are titled Yoga, not Run`

### Task 6: Matching respects non-run sports; a workout holds one active match

**Files:**
- Modify: `packages/providers/src/matching.ts` (`scoreWorkoutActivity` ~47)
- Modify: `apps/worker/src/routes/plan.ts` (`POST /workouts/:id/match` ~1350)
- Test: `packages/providers/test/matching.test.ts`, `apps/worker/test/plan-routes.test.ts`

**Behaviour:** sport compatibility by the workout's discipline (`disciplineOf(category, sport)` semantics, implemented locally in providers to avoid a new dependency — providers already depends on `@rg/domain` only):
- run workout ← run activity only (unchanged);
- strength workout ← `strength` activity only;
- yoga workout ← `yoga` **or** `strength` activity (mobility is filed on the watch as Strength);
- `cross_training` workout ← any non-run activity (unchanged).
Manual match refuses with `422 {error: "workout_already_matched"}` when the workout already has a match with `undoneAt IS NULL`.

- [ ] **Step 1: Failing tests**

```ts
it("a yoga activity never completes a strength workout", () => {
  expect(scoreWorkoutActivity(workout({ category: "strength", sport: "strength" }), activity({ sport: "yoga" }))).toBeNull();
});
it("a strength activity can complete a yoga (mobility) workout", () => {
  expect(scoreWorkoutActivity(workout({ category: "yoga", sport: "run" }), activity({ sport: "strength" }))).not.toBeNull();
});
it("a bike ride never completes a strength workout", () => {
  expect(scoreWorkoutActivity(workout({ category: "strength", sport: "strength" }), activity({ sport: "bike" }))).toBeNull();
});
```

Route test: match activity A to workout W, then POST a second match of activity B to W → 422 `workout_already_matched`, and B stays unmatched.

- [ ] **Step 2–4:** fail → implement → pass; also run `completion-matching.test.ts` and `vertical-loop.test.ts` to confirm no existing fixture relied on cross-sport matches (if one does, it encoded the bug — fix the fixture and say so in the commit body).
- [ ] **Step 5: Commit** — `fix(matching): strength and yoga workouts only complete with a compatible activity; one active match per workout`

---

## Slice B — data safety

### Task 7: `activities.source`; the COROS ingest never swallows imported sessions

**Files:**
- Create: `packages/database/migrations/0022_activity_source.sql`
- Modify: `packages/database/src/schema/activities.ts` (activities table)
- Modify: `apps/worker/src/services/completion.ts` (orphan adoption ~486; `repairTimestamps` twin search ~180)
- Modify: `packages/domain/src/activity.ts` (export `ACTIVITY_SOURCES = ["coros", "app", "import"] as const`)
- Test: `apps/worker/test/activity-source.test.ts`

Migration:

```sql
-- 0022: where an activity row came from. 'coros' for every existing row (the
-- DEFAULT backfills them); 'app' = recorded by the in-app player; 'import' =
-- history imported from another tool. The COROS ingest must never adopt an
-- 'import' row, and adopting an 'app' row is the deliberate watch+app merge.
ALTER TABLE `activities` ADD `source` text DEFAULT 'coros' NOT NULL;
```

Schema: `source: text("source").notNull().default("coros")`.

Adoption rule (completion.ts): in the orphan loop, `if (row.corosActivityId) continue; if (row.source === "import") continue;`. When the adopted row's `source` is `app`, the upsert sets `source: "coros"` and keeps the row id (COROS is now the metric authority). `repairTimestamps` twin search adds `ne(activities.source, "import")`.

- [ ] **Step 1: Failing tests**

```ts
it("never adopts an import-source activity", async () => {
  // insert activities row {id:"imp", source:"import", sport:"strength", startTime:T, durationSeconds:1800, corosActivityId:null}
  // ingest a COROS strength activity at T+5min, 1750 s (use the existing ingest helper from completion-matching.test.ts)
  // expect two activity rows; "imp" unchanged with source "import"
});
it("adopts an app-source activity as the merge: same id, COROS metrics, source becomes coros", async () => {
  // insert {id:"app1", source:"app", sport:"strength", startTime:T, durationSeconds:1800}
  // ingest COROS strength at T+2min with avgHeartRate 120
  // expect one row id "app1", avgHeartRate 120, source "coros", corosActivityId set
});
it("existing rows read back with source coros after the migration", async () => { /* insert without source; select; expect "coros" */ });
```

- [ ] **Step 2–4:** fail → implement → pass; run every `completion*`, `telemetry-ingest`, `strava-migration`, `vertical-loop` suite.
- [ ] **Step 5: Commit** — `feat(db): activities.source — imported sessions are never adopted; app sessions merge deliberately`

### Task 8: One table registry for export, restore, copier and parity

**Files:**
- Create: `apps/worker/src/services/account-tables.ts`
- Test: `apps/worker/test/account-tables.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TableScope =
    | { kind: "user" }                                  // has user_id
    | { kind: "child"; parent: string; column: string; parentKey?: string } // reached via parent table's ids
    | { kind: "identity" }                              // users row: exported, never restored over
    | { kind: "excluded"; reason: string };             // sessions, oauth_states, global catalogs, schema_versions
  export interface AccountTable { name: string; table: SQLiteTable; scope: TableScope; order: number }
  export const ACCOUNT_TABLES: readonly AccountTable[];
  export function accountTable(name: string): AccountTable;   // throws on unknown
  export function secretColumns(name: string): readonly string[]; // e.g. provider_connections → encrypted token columns
  ```
- Children (from misc.ts `deleteAllUserData`): `activity_laps`, `activity_source_links`, `activity_stream_summaries` → parent `activities` via `activity_id`; `planned_workout_stages`, `schedule_overrides`, `workout_completion_matches`, `calendar_event_links`, `calendar_event_suppressions` → `planned_workouts` via `workout_id`; `training_plan_versions` → `training_plans` via `plan_id`; `studio_plan_pushes` → `studio_plans` via `plan_id`; `coach_plan_weeks` → `coach_plans` via `plan_id`; `coros_write_attempts` → `coros_write_jobs` via `job_id` (confirm the column name in `schema/schedule.ts`).
- Excluded: `sessions` (auth), `oauth_states`, `garden_species`, `coros_exercises`, `schema_versions`.
- `secretColumns("provider_connections")` → the encrypted token columns (read `schema/identity.ts` for exact names); export writes them as `null`.

- [ ] **Step 1: Failing test** — every table in the `@rg/database` schema barrel (enumerate with `is(v, SQLiteTable)` exactly like `delete-all-data.test.ts`) appears in `ACCOUNT_TABLES` exactly once; every `child` parent is itself a `user` table; `order` puts parents before children.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** — `feat(data): one registry classifies every table for export, restore and copying`

### Task 9: Complete, paged export and a tested restore

**Files:**
- Create: `apps/worker/src/services/account-export.ts`, `apps/worker/src/services/account-restore.ts`
- Modify: `apps/worker/src/routes/misc.ts` (replace `GET /export`; add `GET /export/manifest`, `GET /export/table/:name`, `POST /restore/begin`, `POST /restore/rows`, `POST /restore/finish`)
- Modify: `packages/api-client/src/index.ts` (`exportAccount(): Promise<Blob>`, `restoreAccount(file: File, opts:{replace:boolean}, onProgress?)`)
- Modify: `packages/ui/src/screens/settings.tsx` (~815–830 Data card: the export link becomes a button calling `exportAccount`; add "Restore from file…" with a confirm step)
- Test: `apps/worker/test/account-export-restore.test.ts`, `packages/ui/test/settings-data.test.tsx`

**Interfaces:**
- `GET /api/settings/export/manifest` → `{ format: "run-garden-export", schemaVersion: string /* highest migration prefix, e.g. "0022" */, tables: { name: string; rows: number }[] }`
- `GET /api/settings/export/table/:name?cursor=<rowid>` → `{ rows: object[]; nextCursor: number | null }` (page of ≤ 500 rows ordered by SQLite `rowid`; user/child scoping per the registry; secret columns nulled).
- The client assembles `{ format, schemaVersion, exportedAt, tables: { [name]: rows[] } }` and downloads `run-garden-export-YYYY-MM-DD.json`.
- `POST /restore/begin {schemaVersion, replace}` → 409 `{error:"not_empty"}` when the account has any `planned_workouts`, `activities` or `garden_events` and `replace` is false; 422 `{error:"schema_mismatch"}` when versions differ; with `replace`, wipes every `user`/`child` table for this user **except** `users`, `sessions`, `provider_connections` (reuses `deleteAllUserData`'s scoping — factor its table loops into `wipeAccountData(db, userId, { keep: string[] })` and have `deleteAllUserData` call it with `keep: []` then delete users/sessions/oauth_states as today).
- `POST /restore/rows {table, rows}` inserts with `userId` rewritten to the signed-in user, chunked to `floor(100 / columnCount)`, `onConflictDoNothing` (idempotent resend). Tables `identity`/`excluded` are refused (422).
- `POST /restore/finish` → `resimulateFrom(earliest garden input date)`; returns per-table counts.

- [ ] **Step 1: Failing tests** (worker)

```ts
it("export → wipe → restore → export is identical, table by table", async () => {
  const db = makeTestDb({ boundVariableCap: 100 });
  const { userId } = await makeTestUser(db);
  await seedFullAccount(db, userId); // ≥1 row in every user and child table, ≥250 planned_workouts to force paging and chunking
  const before = await exportAll(db, userId);       // helper: manifest + every table page via the service functions
  await wipeAccountData(db, userId, { keep: ["users", "sessions", "provider_connections"] });
  await restoreAll(db, userId, before);              // begin(replace) → rows per table → finish
  const after = await exportAll(db, userId);
  expect(stripVolatile(after)).toEqual(stripVolatile(before)); // stripVolatile drops exportedAt only
});
it("refuses to restore over a non-empty account without replace", async () => { /* begin → 409 not_empty */ });
it("refuses a different schemaVersion", async () => { /* 422 schema_mismatch */ });
it("never exports another user's rows or any secret column", async () => { /* two users; token columns null */ });
it("a resent rows page is a no-op", async () => { /* post the same page twice; counts unchanged */ });
```

`seedFullAccount` lives in `apps/worker/test/account-fixture.ts` and inserts one minimal row per table using `ACCOUNT_TABLES` + `getTableColumns` to fill NOT NULL columns with type-appropriate values; the export coverage test asserts every `user`/`child` table has ≥ 1 exported row after seeding.

UI test: the Data card renders "Export everything" and "Restore from file…"; choosing a file shows a confirm sheet naming the export date and "Replace everything in this account" before any request.

- [ ] **Step 2–4:** fail → implement → pass + gates.
- [ ] **Step 5: Commit** — `feat(data): complete paged export and a round-trip-tested restore`

---

## Slice C — staging, copier, parity

### Task 10: `STAGING` mode is inert by construction

**Files:**
- Create: `apps/worker/src/services/staging.ts`
- Modify: `apps/worker/src/env.ts` (`STAGING?: string`; `export const stagingEnabled = (env: Env) => env.STAGING === "1"`)
- Modify: `apps/worker/src/index.ts` (fetch + scheduled entry; `/api/health` adds `staging`)
- Modify: `packages/ui/src/shell.tsx` (a one-line "Staging" strip when `/api/health` says so)
- Test: `apps/worker/test/staging-guard.test.ts`

**Interfaces:**
```ts
export const STAGING_ALLOWED_ORIGINS = ["https://oauth2.googleapis.com"] as const; // sign-in token exchange only
export class StagingOutboundBlocked extends Error {}
export function installStagingGuard(): void;   // idempotent: wraps globalThis.fetch once
export function stagingAllows(url: string): boolean;
```

The wrapper resolves the URL (string | URL | Request), allows relative/same-origin ASSETS fetches (`env.ASSETS.fetch` is a binding, not global fetch — unaffected), allows exactly the origins above, and otherwise throws `StagingOutboundBlocked(<origin>)` without calling the original. `index.ts`: the default export's `fetch(req, env, ctx)` calls `if (stagingEnabled(env)) installStagingGuard()` before `app.fetch`; `scheduled` returns immediately when staging (no `waitUntil`).

- [ ] **Step 1: Failing tests**

```ts
it("blocks COROS, Calendar, the MCP and the LLM gateway", async () => {
  installStagingGuard();
  for (const u of ["https://teamapi.coros.com/account/login", "https://www.googleapis.com/calendar/v3/x",
                   "https://mcp.coros.com/mcp", "https://ai-gateway.vercel.sh/v1/chat/completions"]) {
    await expect(fetch(u)).rejects.toBeInstanceOf(StagingOutboundBlocked);
  }
});
it("allows the Google token exchange", () => { expect(stagingAllows("https://oauth2.googleapis.com/token")).toBe(true); });
it("scheduled does nothing in staging", async () => { /* call default.scheduled with env.STAGING="1" and a ctx whose waitUntil is a spy; expect 0 calls */ });
```

Restore `globalThis.fetch` in `afterEach` (the guard stores the original on a symbol; export `uninstallStagingGuardForTests`).

- [ ] **Step 2–4:** fail → implement → pass + gates.
- [ ] **Step 5: Commit** — `feat(ops): STAGING mode — no crons, and no fetch can reach COROS, Calendar or the LLM`

### Task 11: Staging environment config and runbook

**Files:**
- Modify: `apps/worker/wrangler.toml` (add `[env.staging]`)
- Create: `docs/STAGING.md` (runbook: create, secrets, deploy, copy, rehearse, wipe; Time Travel bookmark + rollback)
- Modify: `apps/worker/package.json` (`"deploy:staging": "wrangler deploy --env staging"`, `"migrate:staging": "wrangler d1 migrations apply run-garden-db-staging --remote --env staging"`)
- Test: `apps/worker/test/wrangler-config.test.ts` (parse the TOML with a tiny regex/`smol-toml` if already a dependency — otherwise assert on text): staging has `crons = []`, `STAGING = "1"`, `FIXTURE_MODE = "0"`, `AI_DEFAULT_ENABLED = "0"`, its own `database_name`, and a name ≠ `run-garden-api`.

```toml
[env.staging]
name = "run-garden-staging"
workers_dev = true

[env.staging.vars]
APP_URL = "https://run-garden-staging.kyranadams.workers.dev"
FIXTURE_MODE = "0"
AI_DEFAULT_ENABLED = "0"
STAGING = "1"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "run-garden-db-staging"
database_id = "REPLACED_BY_TASK_11_STEP_3"
migrations_dir = "../../packages/database/migrations"

[env.staging.triggers]
crons = []
```

- [ ] **Step 1:** write the config test; verify it fails.
- [ ] **Step 2:** add the config; `wrangler d1 create run-garden-db-staging` (Node 22), paste the id; `pnpm migrate:staging`; set secrets for `--env staging` (`SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` freshly generated with `openssl rand -base64 32` — **never** the prod values; `ALLOWED_GOOGLE_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` the same as prod, read from the owner's `.dev.vars`/password store only through `wrangler secret put` stdin, never echoed or written to disk); `pnpm build:web && pnpm deploy:staging`.
- [ ] **Step 3:** verify: `curl -s https://run-garden-staging.kyranadams.workers.dev/api/health` → `{"ok":true,"fixtureMode":false,"staging":true}`; `wrangler deployments list --env staging` shows no triggers.
- [ ] **Step 4:** write `docs/STAGING.md`, including: the owner must add `https://run-garden-staging.kyranadams.workers.dev/api/auth/google/callback` to the Google OAuth client's authorized redirect URIs before signing in to staging; Time Travel commands (`wrangler d1 time-travel info run-garden-db`, `... restore run-garden-db --bookmark=<id>`), the rollback runbook (restore bookmark + `git revert`/redeploy the previous commit), the prod-data rules (spec §13.6).
- [ ] **Step 5: Commit** — `feat(ops): an inert staging environment and its runbook`

### Task 12: Parity harness — hashes only

**Files:**
- Create: `apps/worker/src/services/parity.ts`, `apps/worker/src/routes/admin.ts`
- Modify: `apps/worker/src/index.ts` (mount `/api/admin` behind `requireUser`)
- Test: `apps/worker/test/parity.test.ts`

**Interfaces:**
```ts
export async function tableHashes(db: Db, userId: string): Promise<Record<string, { rows: number; sha256: string }>>; // via ACCOUNT_TABLES, rows ordered by primary key, JSON with sorted keys
export async function gardenHash(db: Db, userId: string, prefs: UserPreferences, opts: { resim: boolean }): Promise<{ snapshot: string; events: string; lastSimulatedDate: string }>;
export async function calendarHash(db: Db, userId: string): Promise<{ links: string; suppressions: string }>;
export async function jobCounts(db: Db, userId: string, sinceIso: string): Promise<Record<string, number>>; // "<kind>:<status>" → count
```
Routes (enabled only when `stagingEnabled(env)` or `env.PARITY_ENABLED === "1"`; otherwise 404): `GET /api/admin/parity/tables`, `POST /api/admin/parity/garden {resim:boolean}`, `GET /api/admin/parity/calendar`, `GET /api/admin/parity/jobs?since=`. Responses contain **only** hashes, counts and dates. DTO parity (`/api/plan/today`, `/api/plan/week?week=`, `/api/garden`) is hashed by `GET /api/admin/parity/dto?paths=...` which calls `app.request(path)` internally with the caller's cookie and returns `{path: sha256}`.

- [ ] **Step 1: Failing tests** — hashes are stable across two calls; change one planned-workout title → `planned_workouts` hash changes and nothing else does; `gardenHash({resim:true})` on a seeded account equals itself after a second resim (determinism); routes 404 when neither flag is set.
- [ ] **Step 2–4:** fail → implement → pass + gates.
- [ ] **Step 5: Commit** — `feat(ops): a hash-only parity harness for staging rehearsals`

### Task 13: The in-Cloudflare copier

**Files:**
- Create: `apps/worker/src/copier/index.ts`, `apps/worker/src/copier/copy.ts`, `apps/worker/wrangler.copier.toml`
- Modify: `apps/worker/package.json` (`"copier:deploy": "wrangler deploy -c wrangler.copier.toml"`, `"copier:delete": "wrangler delete -c wrangler.copier.toml"`)
- Test: `apps/worker/test/copier.test.ts`

**Interfaces:**
```ts
export interface CopyState { table: string | null; cursor: number; done: string[] }
export async function copyStep(src: Db, dst: Db, state: CopyState, budget: { maxRows: number }): Promise<CopyState>; // copies whole tables (single-user DB), rowid-paged, onConflictDoNothing
export async function verifyCopy(src: Db, dst: Db): Promise<Array<{ table: string; src: string; dst: string; ok: boolean }>>; // per-table sha256 over rows ordered by rowid
export async function scrubSecrets(dst: Db): Promise<void>; // null provider_connections token columns, delete sessions + oauth_states
```
The Worker (`copier/index.ts`) exposes `POST /step` and `POST /verify` and `POST /scrub`, each requiring header `x-copier-key` equal to secret `COPIER_KEY`; bindings `SRC` (prod `run-garden-db`) and `DST` (`run-garden-db-staging`); no crons, no assets, no routes other than these three. It never returns row content — only `CopyState`, counts and hashes. Excluded tables (`sessions`, `oauth_states`) are not copied.

- [ ] **Step 1: Failing tests** — two `makeTestDb()` instances; seed src via `seedFullAccount`; loop `copyStep` with `maxRows: 7` until `done` covers every table; `verifyCopy` all ok; **interrupt test**: run half the steps, discard the in-memory state, restart from the last returned state → still all ok with no duplicates; `scrubSecrets` leaves no token column non-null.
- [ ] **Step 2–4:** fail → implement → pass + gates.
- [ ] **Step 5: Commit** — `feat(ops): a paged, resumable, checksummed copier that runs inside Cloudflare`

(Deploying and running the copier against prod happens at a rehearsal, with the owner's OK — not in this task.)

---

## Slice D — e2e in CI

### Task 14: A current smoke suite, run in CI

**Files:**
- Modify: `apps/web/e2e/smoke.spec.ts`
- Create: `apps/web/e2e/fixture-stack.sh` (boots wrangler dev with a private `--persist-to`, applies migrations to the same persist dir, starts the web dev server, waits for health)
- Modify: `.github/workflows/ci.yml` (new job `e2e`; replace the always-red `migration-drift` job with `migrations-contiguous`)
- Create: `packages/database/test/migrations.test.ts` (numbering contiguous from 0000, no duplicate prefixes, every file non-empty)

Smoke assertions to update (current UI):
- Garden `/`: `.dock-panel` (the Today card) visible; the workout title visible; a "Move" button present.
- Plan `/plan`: heading "Plan"; `.plan-week-title` visible; no `.coros-check-link`.
- Garden collection: button named `/Collection — \d+ of \d+ species/` opens a dialog containing "Growing next".
- Activity `/runs` (`/insights` redirects): text "Consistency" and "Signals" visible.
- Settings: "COROS connection", "Export everything".
- Move sheet: clicking "Move" opens a dialog.

CI job (`e2e`): Node 22 for wrangler + build, `pnpm exec playwright install --with-deps chromium webkit`, `bash apps/web/e2e/fixture-stack.sh`, then `pnpm --filter @rg/web e2e`, both projects. Upload the Playwright report on failure.

- [ ] **Step 1:** run the current smoke suite locally against a fixture stack (ports 8971/5271, `--persist-to` in the scratchpad) and record which assertions fail.
- [ ] **Step 2:** update the spec; re-run until green on both projects.
- [ ] **Step 3:** write `migrations.test.ts` (it passes today — it is a guard) and the CI changes.
- [ ] **Step 4:** push the branch and confirm the `e2e` job is green on GitHub before merging.
- [ ] **Step 5: Commit** — `test(e2e): the smoke suite matches today's UI and runs in CI`

---

## Slice E — spikes (answers, not features)

### Task 15: Lap payload probe (read-only, masked)

**Files:**
- Modify: `apps/worker/src/routes/coros.ts` (add `GET /api/coros/debug/lap-keys?days=30`)
- Test: `apps/worker/test/coros-lap-probe.test.ts`

Returns, for the most recent strength activities in the window, the **key skeleton** of the raw lap items and the activity summary: `{ key: typeof value | "array(n)" | "object" }`, recursively, with no values. Uses the existing cloud client and `corosReadNow`'s activity detail call path. Test against `mock-coros-server` with extra lap keys (`exerciseId`, `intensityValue`, `sets`) and assert the skeleton lists them and no value leaks.

Run (with the owner's browser, same-origin fetch on prod after deploy): record the skeleton in `docs/reports/2026-09-30-coros-lap-probe.md` (keys and types only). Conclude whether reps/load are recoverable.

- [ ] Steps: failing test → implement → pass → commit `feat(coros): a masked lap-key probe` → deploy with the batch → run → write the report.

### Task 16: Unmapped-move write spike (gated on the owner's OK)

**Files:**
- Create: `packages/coros/scripts/unmapped-spike.ts` is NOT possible (credentials live only in prod); instead add `POST /api/coros/spike/unmapped-moves` to `routes/coros.ts`, returning 404 unless the body carries `{confirm: "write a test workout"}`.
- Test: `apps/worker/test/coros-unmapped-spike.test.ts` (against `mock-coros-server`)

The endpoint builds one strength program stamped `RG SPIKE — SAFE TO DELETE <iso>` dated 14 days out with four steps: (a) `originId: "0"`, free-text name "Chin tuck hold", time target 30 s; (b) the generic catalog Training step with name "Chin tuck hold (generic)"; (c) a catalog exercise with a non-empty `overview` "cue: long neck"; (d) a per-side pair. It creates it through the existing create executor path (a new `buildSpikeProgram` helper in `@rg/coros` that bypasses the catalog-only refusal for this spike only), reads back twice (two real reads, 90 s apart via two invocations), returns `{ stored: [{sent, storedName, storedOriginId, storedOverview, storedTarget}] }`, then deletes the workout by stamp and verifies it is gone.

- [ ] Steps: failing test → implement → pass → commit `feat(coros): an owner-gated spike for unmapped moves` → **ask the owner** before invoking it on the real account → run → report in `docs/reports/2026-09-30-coros-unmapped-spike.md`.

---

## Slice F — housekeeping (orchestrator, no code)

- [ ] Check `.claude/worktrees/garden-ux-audit` and `.claude/worktrees/coach-agentic` for uncommitted tracked edits (`git -C <path> status --short | grep -v '^??'`); stop and report if any. Otherwise `git worktree remove --force` both (untracked `tmp-*` scripts go with them, as approved). Delete local branch `fix/pin-studio-test-clock` if merged (`git branch -d`), tag `archive/plan-block-map` (`git tag -d`), branches `worktree-garden-ux-audit`/`worktree-coach-agentic` if merged.
- [ ] Remove the tracked stray notes file `apps/worker/- I just completed a run, but its not ra.md` in its own commit: `chore: remove a stray notes file`.

## Batch audits

- **Audit 1** after Slices A + B: a fresh-context reviewer (most capable model) on the diff against this plan and the spec, focus: route/coach parity, adoption edge cases, restore safety; then adversarial verification of each finding; fix criticals/importants test-first.
- **Audit 2** after Slices C + D: security and privacy (the guard, the copier's bindings and key, admin routes' exposure), ops (wrangler env inheritance — confirm `triggers` is NOT inherited into `env.staging` by checking `wrangler deploy --env staging --dry-run` output), CI.
- Merge each audited batch to `main` (the owner is asked first when it contains a migration — Task 7), watch CI + Deploy, health-check prod.

## Self-Review

- Spec §15 Phase 0 coverage: housekeeping (F), 09-20 parity bugs (1–4), yoga prefix (5), sport-aware matching + single match (6), export/restore/delete-all (8–9), `activities.source` + guards (7), staging + copier + runbook + parity (10–13), e2e in CI (14), spikes: lap probe (15), unmapped moves (16). The IndexedDB outbox spike moves to the start of Phase 2b, where the outbox is built (no Phase 0 work depends on it); the spec is updated accordingly.
- Placeholders: Task 11's `database_id` is filled in Step 2 by the command that creates the database; nothing else is deferred.
- Types: `removeFromPlan`, `unskipWorkout`, `enqueueUnpushIfOurs`, `ApplyResult.resimFrom`, `ACCOUNT_TABLES`, `wipeAccountData`, `installStagingGuard`, `copyStep`, `verifyCopy`, `tableHashes` are each defined once and used with the same signatures.
- Review Focus items each have a pinned test (Tasks 1, 9, 7, 10, 13).
