# Sync Transparency (Intent-Ledger Reconciler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two non-communicating COROS sync state machines with one intent-ledger + reconciler so sync is automatic, false alarms are structurally impossible, and the UI shows one honest derived status.

**Architecture:** Every app-side schedule mutation records an append-only `sync_intents` row. A pure reconciler consults intents at the three decision points (mutation time, snapshot-import time, job-result time), applies last-edit-wins (open intent beats COROS; no intent → adopt COROS), and posts dismissible undo notes instead of stuck states. Sync status is derived on read, never trusted from stored columns. The bridge job payload contract and `create-executor.ts` safety core are **not modified**; the bridge gains only a `read_now` job kind and adaptive polling.

**Tech Stack:** Cloudflare Worker (Hono), Drizzle + D1 (better-sqlite3 in tests), Zod, vitest, React (packages/ui), Node sidecar bridge (services/coros-bridge).

**Spec:** `docs/superpowers/specs/2026-08-03-sync-transparency-design.md`

**Out of this plan (separate follow-up plan):** the desktop shell work — login item via tauri-plugin-autostart, tray menu, sidecar-lifetime-tied-to-app. It is Rust-side, touches no worker code, and ships independently.

## Global Constraints

- Tests run under **Node 21** (machine default): `pnpm test`. Builds/wrangler need Node 22. Never run `wrangler deploy` from this plan; push-to-main deploys via CI after typecheck+tests.
- `git commit` SIGKILLs if the multi-GB Rust `target/` tree gets scanned: always `git add <specific paths>`, never `git add -A`.
- The bridge executor (`services/coros-bridge/src/create-executor.ts`, `write-executor.ts`) and the claim/result payload shapes for existing kinds are **frozen** — do not edit them.
- `import-plan.ts` admission/mirror-dedup/recycled-slot logic is a **port-don't-redesign zone**: tasks below only add `archiveReason` stamping and swap the rules-4/5/6 decision block; do not restructure anything else in that file.
- Structured codes only: no executor prose ever written to rows or shown to users.
- All new timestamps are ISO strings via `nowInstant()` from `@rg/domain`; ids via `newId()`.
- Commit after every task with a `feat:`/`refactor:`/`test:` message; include the repo's standard trailer lines used by prior commits.

---

### Task 1: Schema — `sync_intents`, `sync_notes`, `archive_reason`, migration 0005

**Files:**
- Modify: `packages/database/src/schema/schedule.ts` (append tables; add column)
- Modify: `packages/database/src/schema/index.ts` (export new tables — follow how `corosWriteJobs` is exported)
- Create: `packages/database/migrations/0005_*.sql` (generated)
- Test: `apps/worker/test/sync-intents.test.ts` (created in Task 2; this task verifies migration application via existing suite)

**Interfaces:**
- Produces: `syncIntents`, `syncNotes` Drizzle tables; `plannedWorkouts.archiveReason: string | null`. All later tasks import these from `@rg/database`.

- [ ] **Step 1: Add schema.** Append to `packages/database/src/schema/schedule.ts`:

```ts
export const syncIntents = sqliteTable(
  "sync_intents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    targetKind: text("target_kind").notNull(), // workout | studio_session
    targetId: text("target_id").notNull(), // planned_workouts.id | studio_plan_pushes.id
    kind: text("kind").notNull(), // move | create | delete | remove_local | restore
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    source: text("source").notNull(), // user_move | calendar_drag | studio_push | studio_retire | remove_from_plan | auto_resolve | undo
    createdAt: text("created_at").notNull(),
    /** Newer intent of the same (targetId, kind) that replaced this one. */
    supersededBy: text("superseded_by"),
    /** Set when the reconciler verified this intent landed on COROS (or it needs no write). */
    resolvedAt: text("resolved_at"),
  },
  (t) => [
    index("sync_intents_target_idx").on(t.targetId),
    index("sync_intents_user_open_idx").on(t.userId, t.resolvedAt),
  ],
);

export const syncNotes = sqliteTable(
  "sync_notes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    workoutId: text("workout_id"),
    kind: text("kind").notNull(), // kept_local_change | adopted_coros_change | adopted_coros_edit | adopted_coros_removal
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    dismissedAt: text("dismissed_at"),
  },
  (t) => [index("sync_notes_user_idx").on(t.userId, t.dismissedAt)],
);
```

And add to `plannedWorkouts` columns, directly under `archivedAt`:

```ts
    /** Why archivedAt is set: absence_confirmed | user_removed | duplicate_mirror. */
    archiveReason: text("archive_reason"),
```

- [ ] **Step 2: Generate migration.** Run: `cd packages/database && pnpm generate`. Verify a new `migrations/0005_*.sql` exists containing `CREATE TABLE sync_intents`, `CREATE TABLE sync_notes`, and `ALTER TABLE planned_workouts ADD ... archive_reason`.
- [ ] **Step 3: Verify migrations apply.** Run: `pnpm test -- --run apps/worker/test/exercise-catalog.test.ts` (any suite exercises `makeTestDb()`, which applies every migration). Expected: PASS.
- [ ] **Step 4: Commit.** `git add packages/database/src/schema packages/database/migrations && git commit -m "feat(sync): sync_intents + sync_notes tables, planned_workouts.archive_reason"`

---

### Task 2: Intent ledger service

**Files:**
- Create: `apps/worker/src/services/sync-intents.ts`
- Test: `apps/worker/test/sync-intents.test.ts`

**Interfaces:**
- Produces:
  - `type IntentSource = "user_move" | "calendar_drag" | "studio_push" | "studio_retire" | "remove_from_plan" | "auto_resolve" | "undo"`
  - `recordIntent(db, input: { userId; targetKind: "workout" | "studio_session"; targetId; kind: "move" | "create" | "delete" | "remove_local" | "restore"; payload?: Record<string, unknown>; source: IntentSource }): Promise<string>` — supersedes any open intent of the same `(targetId, kind)`, returns the new intent id.
  - `openIntentFor(db, userId: string, targetId: string, kind?: string): Promise<typeof syncIntents.$inferSelect | null>` — latest intent with `resolvedAt IS NULL AND supersededBy IS NULL`.
  - `resolveIntent(db, intentId: string, now: string): Promise<void>`
  - `openMoveIntents(db, userId): Promise<Array<typeof syncIntents.$inferSelect>>` — all open `kind = "move"`, `targetKind = "workout"`.
  - `appRequestedDates(db, userId): Promise<Map<string, Set<string>>>` — for the studio drift check: every move intent (open OR resolved, `targetKind = "workout"`) mapped `plannedWorkouts.sourceWorkoutId → Set of payload.toDate values`. Join `syncIntents.targetId = plannedWorkouts.id`.

- [ ] **Step 1: Write failing tests** in `apps/worker/test/sync-intents.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeTestDb, makeTestUser } from "./helpers.js";
import {
  appRequestedDates,
  openIntentFor,
  recordIntent,
  resolveIntent,
} from "../src/services/sync-intents.js";
import { nowInstant, newId } from "@rg/domain";
import { schema } from "@rg/database";

describe("sync intents", () => {
  it("records an intent and finds it open", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const id = await recordIntent(db, {
      userId, targetKind: "workout", targetId: "w1", kind: "move",
      payload: { toDate: "2026-08-10", toTime: "07:00", fromDate: "2026-08-08" },
      source: "user_move",
    });
    const open = await openIntentFor(db, userId, "w1");
    expect(open?.id).toBe(id);
    expect(open?.payload?.["toDate"]).toBe("2026-08-10");
  });

  it("a newer intent supersedes the older one of the same kind+target", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const first = await recordIntent(db, {
      userId, targetKind: "workout", targetId: "w1", kind: "move",
      payload: { toDate: "2026-08-10" }, source: "user_move",
    });
    const second = await recordIntent(db, {
      userId, targetKind: "workout", targetId: "w1", kind: "move",
      payload: { toDate: "2026-08-11" }, source: "calendar_drag",
    });
    const open = await openIntentFor(db, userId, "w1");
    expect(open?.id).toBe(second);
    const rows = await db.select().from(schema.syncIntents);
    expect(rows.find((r) => r.id === first)?.supersededBy).toBe(second);
  });

  it("resolveIntent closes it", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const id = await recordIntent(db, {
      userId, targetKind: "workout", targetId: "w1", kind: "move",
      payload: { toDate: "2026-08-10" }, source: "user_move",
    });
    await resolveIntent(db, id, nowInstant());
    expect(await openIntentFor(db, userId, "w1")).toBeNull();
  });

  it("appRequestedDates maps sourceWorkoutId to requested dates, resolved included", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const workoutId = newId();
    await db.insert(schema.plannedWorkouts).values({
      id: workoutId, userId, planId: "p", sourceWorkoutId: "4738:12",
      title: "Upper A — wk 1", category: "strength", sport: "strength",
      originalPlanDate: "2026-08-08", lastVerifiedCorosDate: "2026-08-08",
      effectiveDate: "2026-08-08", effectiveTime: "07:00",
      sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600,
      createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    const id = await recordIntent(db, {
      userId, targetKind: "workout", targetId: workoutId, kind: "move",
      payload: { toDate: "2026-08-09" }, source: "user_move",
    });
    await resolveIntent(db, id, nowInstant());
    const map = await appRequestedDates(db, userId);
    expect(map.get("4738:12")?.has("2026-08-09")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL** (module not found): `pnpm test -- --run apps/worker/test/sync-intents.test.ts`
- [ ] **Step 3: Implement** `apps/worker/src/services/sync-intents.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import { plannedWorkouts, syncIntents } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

export type IntentSource =
  | "user_move" | "calendar_drag" | "studio_push" | "studio_retire"
  | "remove_from_plan" | "auto_resolve" | "undo";

export interface RecordIntentInput {
  userId: string;
  targetKind: "workout" | "studio_session";
  targetId: string;
  kind: "move" | "create" | "delete" | "remove_local" | "restore";
  payload?: Record<string, unknown>;
  source: IntentSource;
}

/** Append an intent; any open intent of the same (target, kind) is superseded. */
export async function recordIntent(db: Db, input: RecordIntentInput): Promise<string> {
  const now = nowInstant();
  const id = newId();
  await db
    .update(syncIntents)
    .set({ supersededBy: id })
    .where(
      and(
        eq(syncIntents.userId, input.userId),
        eq(syncIntents.targetId, input.targetId),
        eq(syncIntents.kind, input.kind),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
      ),
    );
  await db.insert(syncIntents).values({
    id,
    userId: input.userId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    kind: input.kind,
    payload: input.payload ?? null,
    source: input.source,
    createdAt: now,
  });
  return id;
}

export async function openIntentFor(
  db: Db,
  userId: string,
  targetId: string,
  kind?: string,
): Promise<typeof syncIntents.$inferSelect | null> {
  const rows = await db
    .select()
    .from(syncIntents)
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetId, targetId),
        ...(kind ? [eq(syncIntents.kind, kind)] : []),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
      ),
    );
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows[0] ?? null;
}

export async function resolveIntent(db: Db, intentId: string, now: string): Promise<void> {
  await db.update(syncIntents).set({ resolvedAt: now }).where(eq(syncIntents.id, intentId));
}

export async function openMoveIntents(
  db: Db,
  userId: string,
): Promise<Array<typeof syncIntents.$inferSelect>> {
  return db
    .select()
    .from(syncIntents)
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetKind, "workout"),
        eq(syncIntents.kind, "move"),
        isNull(syncIntents.resolvedAt),
        isNull(syncIntents.supersededBy),
      ),
    );
}

/**
 * Every date the APP itself asked a workout to move to (open or resolved),
 * keyed by the workout's COROS wire id. The studio drift check uses this to
 * recognize its own account's moves instead of calling them user edits.
 */
export async function appRequestedDates(db: Db, userId: string): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({
      sourceWorkoutId: plannedWorkouts.sourceWorkoutId,
      payload: syncIntents.payload,
    })
    .from(syncIntents)
    .innerJoin(plannedWorkouts, eq(syncIntents.targetId, plannedWorkouts.id))
    .where(
      and(
        eq(syncIntents.userId, userId),
        eq(syncIntents.targetKind, "workout"),
        eq(syncIntents.kind, "move"),
      ),
    );
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const toDate = r.payload?.["toDate"];
    if (typeof toDate !== "string") continue;
    const set = map.get(r.sourceWorkoutId) ?? new Set<string>();
    set.add(toDate);
    map.set(r.sourceWorkoutId, set);
  }
  return map;
}
```

- [ ] **Step 4: Run tests, verify PASS.** `pnpm test -- --run apps/worker/test/sync-intents.test.ts`
- [ ] **Step 5: Commit.** `git add apps/worker/src/services/sync-intents.ts apps/worker/test/sync-intents.test.ts && git commit -m "feat(sync): intent ledger service"`

---

### Task 3: `archiveReason` stamping + sync notes service

**Files:**
- Modify: `apps/worker/src/services/import-plan.ts` (rule 8 archive at ~line 469; unarchive at ~line 360; mirror-dedupe archive at ~line 553)
- Modify: `apps/worker/src/routes/plan.ts` (`POST /workouts/:id/remove` handler at ~line 524 — wherever it sets `archivedAt`, also set `archiveReason: "user_removed"` and record a `remove_local` intent)
- Create: `apps/worker/src/services/sync-notes.ts`
- Test: `apps/worker/test/sync-notes.test.ts`

**Interfaces:**
- Consumes: `recordIntent` (Task 2).
- Produces:
  - `postSyncNote(db, input: { userId; workoutId?: string; kind: "kept_local_change" | "adopted_coros_change" | "adopted_coros_edit" | "adopted_coros_removal"; payload: Record<string, unknown> }): Promise<string>` — sets `expiresAt = now + 7 days`.
  - `activeSyncNotes(db, userId): Promise<Array<typeof syncNotes.$inferSelect>>` — not dismissed, not expired.
  - `dismissSyncNote(db, userId, noteId): Promise<void>`
  - `planned_workouts.archiveReason` now always set alongside `archivedAt`: `"absence_confirmed"` (rule 8), `"user_removed"` (remove route), `"duplicate_mirror"` (mirror dedupe); cleared (`null`) wherever `archivedAt` is cleared (unarchive block).

- [ ] **Step 1: Write failing tests** in `apps/worker/test/sync-notes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { activeSyncNotes, dismissSyncNote, postSyncNote } from "../src/services/sync-notes.js";

describe("sync notes", () => {
  it("posts, lists, dismisses", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const id = await postSyncNote(db, {
      userId, workoutId: "w1", kind: "adopted_coros_change",
      payload: { previousDate: "2026-08-08", newDate: "2026-08-09" },
    });
    let notes = await activeSyncNotes(db, userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind).toBe("adopted_coros_change");
    await dismissSyncNote(db, userId, id);
    notes = await activeSyncNotes(db, userId);
    expect(notes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.** `pnpm test -- --run apps/worker/test/sync-notes.test.ts`
- [ ] **Step 3: Implement** `apps/worker/src/services/sync-notes.ts`:

```ts
import { and, eq, gt, isNull } from "drizzle-orm";
import { syncNotes } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "./db.js";

const NOTE_TTL_MS = 7 * 24 * 60 * 60_000;

export type SyncNoteKind =
  | "kept_local_change" | "adopted_coros_change" | "adopted_coros_edit" | "adopted_coros_removal";

export async function postSyncNote(
  db: Db,
  input: { userId: string; workoutId?: string; kind: SyncNoteKind; payload: Record<string, unknown> },
): Promise<string> {
  const now = nowInstant();
  const id = newId();
  await db.insert(syncNotes).values({
    id,
    userId: input.userId,
    workoutId: input.workoutId ?? null,
    kind: input.kind,
    payload: input.payload,
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + NOTE_TTL_MS).toISOString(),
  });
  return id;
}

export async function activeSyncNotes(
  db: Db,
  userId: string,
): Promise<Array<typeof syncNotes.$inferSelect>> {
  return db
    .select()
    .from(syncNotes)
    .where(
      and(
        eq(syncNotes.userId, userId),
        isNull(syncNotes.dismissedAt),
        gt(syncNotes.expiresAt, nowInstant()),
      ),
    );
}

export async function dismissSyncNote(db: Db, userId: string, noteId: string): Promise<void> {
  await db
    .update(syncNotes)
    .set({ dismissedAt: nowInstant() })
    .where(and(eq(syncNotes.id, noteId), eq(syncNotes.userId, userId)));
}
```

- [ ] **Step 4: Stamp `archiveReason`.** In `import-plan.ts`: rule-8 archive `.set({ archivedAt: now, ... })` gains `archiveReason: "absence_confirmed"`; mirror-dedupe archive gains `archiveReason: "duplicate_mirror"`; the unarchive block (`updates.archivedAt = null`) gains `updates.archiveReason = null`. In `plan.ts` remove handler: add `archiveReason: "user_removed"` beside its `archivedAt` set, and before responding call `recordIntent(db, { userId, targetKind: "workout", targetId: workoutId, kind: "remove_local", source: "remove_from_plan" })`.
- [ ] **Step 5: Run full worker suite, verify PASS.** `pnpm test -- --run apps/worker/test/`
- [ ] **Step 6: Commit.** `git add apps/worker/src/services/sync-notes.ts apps/worker/src/services/import-plan.ts apps/worker/src/routes/plan.ts apps/worker/test/sync-notes.test.ts && git commit -m "feat(sync): sync notes service + archiveReason stamping"`

---

### Task 4: Pure reconciler core

**Files:**
- Create: `apps/worker/src/services/reconcile.ts`
- Test: `apps/worker/test/reconcile.test.ts`

**Interfaces:**
- Produces (all pure, no db):

```ts
export interface WorkoutFacts {
  workoutId: string;
  effectiveDate: string;
  lastVerifiedCorosDate: string;
  /** src.date from THIS snapshot; the caller only builds facts for present rows. */
  observedDate: string;
  openIntent: { id: string; toDate: string } | null;
  pendingJob: { id: string; destinationDate: string } | null;
}
export type ReconcileAction =
  | { act: "none" }
  | { act: "verify_job"; jobId: string; intentId: string | null }
  | { act: "adopt_coros"; toDate: string; note: { previousDate: string } | null }
  | { act: "app_wins"; intentId: string; keepDate: string; supersedeJobId: string | null;
      note: { displacedDate: string } };
export function reconcileWorkout(f: WorkoutFacts): ReconcileAction;
```

- [ ] **Step 1: Write failing tests** in `apps/worker/test/reconcile.test.ts` — every branch:

```ts
import { describe, expect, it } from "vitest";
import { reconcileWorkout, type WorkoutFacts } from "../src/services/reconcile.js";

const base: WorkoutFacts = {
  workoutId: "w1",
  effectiveDate: "2026-08-08",
  lastVerifiedCorosDate: "2026-08-08",
  observedDate: "2026-08-08",
  openIntent: null,
  pendingJob: null,
};

describe("reconcileWorkout", () => {
  it("everything agrees → none", () => {
    expect(reconcileWorkout(base)).toEqual({ act: "none" });
  });

  it("COROS reports our pending destination → verify_job", () => {
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-10",
      openIntent: { id: "i1", toDate: "2026-08-10" },
      pendingJob: { id: "j1", destinationDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({ act: "verify_job", jobId: "j1", intentId: "i1" });
  });

  it("upstream change, no open intent → adopt with note (displaces a synced value)", () => {
    const f: WorkoutFacts = { ...base, observedDate: "2026-08-09" };
    expect(reconcileWorkout(f)).toEqual({
      act: "adopt_coros",
      toDate: "2026-08-09",
      note: { previousDate: "2026-08-08" },
    });
  });

  it("upstream change while our move is pending → app wins, supersede, note", () => {
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-09",
      openIntent: { id: "i1", toDate: "2026-08-10" },
      pendingJob: { id: "j1", destinationDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({
      act: "app_wins",
      intentId: "i1",
      keepDate: "2026-08-10",
      supersedeJobId: "j1",
      note: { displacedDate: "2026-08-09" },
    });
  });

  it("upstream change with open intent but no job (writes were off) → app wins, no job to supersede", () => {
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-09",
      openIntent: { id: "i1", toDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({
      act: "app_wins",
      intentId: "i1",
      keepDate: "2026-08-10",
      supersedeJobId: null,
      note: { displacedDate: "2026-08-09" },
    });
  });

  it("COROS moved TO the open intent's date without our job → verify intent, dates agree", () => {
    // e.g. the user also moved it in the COROS app to the same day.
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-10",
      openIntent: { id: "i1", toDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({ act: "verify_job", jobId: "", intentId: "i1" });
  });

  it("waiting for our move to land (observed still at origin) → none", () => {
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-08",
      openIntent: { id: "i1", toDate: "2026-08-10" },
      pendingJob: { id: "j1", destinationDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({ act: "none" });
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `apps/worker/src/services/reconcile.ts`:

```ts
/**
 * SYNC RECONCILER CORE — the single decision table for workout-date sync.
 *
 * Policy (spec §2): last-edit-wins with the tie broken toward the app. An OPEN
 * intent is by definition the most recent thing the user did in-app; COROS's
 * change time is unknowable inside a snapshot window, so when both changed,
 * the intent stands and the COROS value is surfaced as an undo note. With no
 * open intent, COROS is adopted automatically.
 *
 * Pure on purpose: every transition is unit-testable without a database.
 */

export interface WorkoutFacts {
  workoutId: string;
  effectiveDate: string;
  lastVerifiedCorosDate: string;
  observedDate: string;
  openIntent: { id: string; toDate: string } | null;
  pendingJob: { id: string; destinationDate: string } | null;
}

export type ReconcileAction =
  | { act: "none" }
  | { act: "verify_job"; jobId: string; intentId: string | null }
  | { act: "adopt_coros"; toDate: string; note: { previousDate: string } | null }
  | {
      act: "app_wins";
      intentId: string;
      keepDate: string;
      supersedeJobId: string | null;
      note: { displacedDate: string };
    };

export function reconcileWorkout(f: WorkoutFacts): ReconcileAction {
  const upstreamChanged = f.observedDate !== f.lastVerifiedCorosDate;

  if (!upstreamChanged) {
    return { act: "none" }; // includes "our move hasn't landed yet"
  }

  // COROS now shows a new date.
  if (f.pendingJob && f.observedDate === f.pendingJob.destinationDate) {
    return { act: "verify_job", jobId: f.pendingJob.id, intentId: f.openIntent?.id ?? null };
  }
  if (f.openIntent && f.observedDate === f.openIntent.toDate) {
    // No job (or a job aimed elsewhere), but COROS already agrees with the
    // intent — converged by the user's own hand on the other side.
    return { act: "verify_job", jobId: f.pendingJob?.id ?? "", intentId: f.openIntent.id };
  }
  if (f.openIntent) {
    return {
      act: "app_wins",
      intentId: f.openIntent.id,
      keepDate: f.openIntent.toDate,
      supersedeJobId: f.pendingJob?.id ?? null,
      note: { displacedDate: f.observedDate },
    };
  }
  return {
    act: "adopt_coros",
    toDate: f.observedDate,
    note: { previousDate: f.lastVerifiedCorosDate },
  };
}
```

- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit.** `git add apps/worker/src/services/reconcile.ts apps/worker/test/reconcile.test.ts && git commit -m "feat(sync): pure reconciler core"`

---

### Task 5: Moves through the ledger — `applyMove`, `emitPendingWork`, `applyJobResult`

**Files:**
- Modify: `apps/worker/src/services/jobs.ts`
- Modify: `packages/domain/src/states.ts` (extend `CorosSyncState` with `"sync_issue"`, add label `sync_issue: "Sync issue"`)
- Modify: `apps/worker/src/routes/devices.ts` (`/bridge/sync` calls `emitPendingWork` after import)
- Test: `apps/worker/test/jobs-reconcile.test.ts`

**Interfaces:**
- Consumes: `recordIntent`, `openIntentFor`, `openMoveIntents`, `resolveIntent` (Task 2); `postSyncNote` (Task 3).
- Produces:
  - `applyMove` unchanged signature; now records a `move` intent (source `"user_move"` for `"app"`/`"reschedule"`, `"calendar_drag"` for `"calendar_edit"`) then delegates job emission to `emitPendingWork`.
  - `emitPendingWork(db, userId: string, opts: { corosWritesEnabled: boolean }): Promise<number>` — for every open move intent whose workout's `lastVerifiedCorosDate !== payload.toDate` and which has no in-flight job: supersede stale in-flight jobs for that workout and enqueue a `move_scheduled_workout` job (same insert shape as today's `applyMove`, `originalDate: workout.lastVerifiedCorosDate`, `destinationDate: intent payload.toDate`). Returns jobs enqueued. No-ops when `!corosWritesEnabled` or `!writeCapableDeviceExists`.
  - `applyJobResult` — `verified`/`already_in_desired_state` additionally resolves the open move intent. `upstream_changed`/`verification_failed` no longer produce `needs_attention`: app-wins re-emit (below). Exhausted retries and `rolled_back`/`unsupported` now write `corosSyncState: "sync_issue"` (was `calendar_only`) and leave the intent OPEN so retry can re-derive from it.

- [ ] **Step 1: Write failing tests** in `apps/worker/test/jobs-reconcile.test.ts`. Use `makeTestUser`, `registerTestDevice`, and a helper to insert a planned workout (copy the insert literal from Task 2's `appRequestedDates` test). Cases:

```ts
// 1. applyMove with writes enabled + capable device: records open move intent,
//    enqueues one queued job, outcome state "syncing" (device online).
// 2. applyMove with corosWritesEnabled=false: intent recorded, NO job, outcome
//    corosSyncState "calendar_only"; then emitPendingWork with writes enabled
//    (device registered) enqueues exactly one job; calling it again enqueues none.
// 3. applyJobResult outcome "verified": job verified, intent resolved
//    (openIntentFor returns null), lastVerifiedCorosDate = observedDate.
// 4. applyJobResult outcome "upstream_changed" with observedDate "2026-08-09",
//    open intent toDate "2026-08-10", attemptCount < maxAttempts:
//    - old job status "superseded", a NEW queued job exists with
//      originalDate "2026-08-09" / destinationDate "2026-08-10",
//    - a sync note kind "kept_local_change" exists with
//      payload {displacedDate:"2026-08-09", keptDate:"2026-08-10"},
//    - workout corosSyncState NOT "needs_attention".
// 5. applyJobResult outcome "write_failed" with attemptCount at maxAttempts:
//    job failed, workout corosSyncState "sync_issue", intent still open.
```

Write each as a real test (arrange: applyMove → read job id from `corosWriteJobs` → call `applyJobResult(db, userId, { jobId, deviceId, outcome, observedDate?, finishedAt: nowInstant(), signature: "s" } as never, prefs)`).

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** In `jobs.ts`:

(a) Extract today's job-insert block (supersede + insert, lines ~112-135) into:

```ts
async function enqueueMoveJob(
  db: Db,
  v: { userId: string; workout: typeof plannedWorkouts.$inferSelect; toDate: string; now: string },
): Promise<string> {
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: v.now })
    .where(
      and(
        eq(corosWriteJobs.workoutId, v.workout.id),
        inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
      ),
    );
  const jobId = newId();
  await db.insert(corosWriteJobs).values({
    id: jobId,
    userId: v.userId,
    workoutId: v.workout.id,
    kind: "move_scheduled_workout",
    expectedSourceVersion: v.workout.sourceVersion ?? null,
    expectedContentFingerprint: v.workout.sourceContentFingerprint,
    originalDate: v.workout.lastVerifiedCorosDate,
    destinationDate: v.toDate,
    requestedAt: v.now,
    status: "queued",
    updatedAt: v.now,
  });
  return jobId;
}
```

(b) In `applyMove`, after the `scheduleOverrides` insert, record the intent:

```ts
  const intentId = await recordIntent(db, {
    userId: req.userId,
    targetKind: "workout",
    targetId: workout.id,
    kind: "move",
    payload: { fromDate, toDate: req.toDate, toTime: req.toTime },
    source: req.source === "calendar_edit" ? "calendar_drag" : "user_move",
  });
```

Keep the existing `dateChanged` / `writesPossible` / state logic, but replace the inline supersede+insert with `jobId = await enqueueMoveJob(db, { userId: req.userId, workout, toDate: req.toDate, now })`, and in the `!dateChanged` branch call `await resolveIntent(db, intentId, now)` (a same-COROS-date time change needs no COROS write).

(c) Add `emitPendingWork` (export):

```ts
/**
 * The reconciler's job-emission pass: every open move intent that still
 * disagrees with COROS and has no in-flight job gets one. Called after
 * applyMove, after every bridge snapshot import, and when writes are enabled
 * in Settings — so intents queued while writes were off (or no device was
 * paired) heal the moment writing becomes possible.
 */
export async function emitPendingWork(
  db: Db,
  userId: string,
  opts: { corosWritesEnabled: boolean },
): Promise<number> {
  if (!opts.corosWritesEnabled) return 0;
  if (!(await writeCapableDeviceExists(db, userId))) return 0;
  const now = nowInstant();
  const intents = await openMoveIntents(db, userId);
  if (intents.length === 0) return 0;
  const inflight = await db
    .select()
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
      ),
    );
  const inflightByWorkout = new Map(inflight.map((j) => [j.workoutId, j]));
  let emitted = 0;
  for (const intent of intents) {
    const toDate = intent.payload?.["toDate"];
    if (typeof toDate !== "string") continue;
    const workout = (
      await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, intent.targetId)).limit(1)
    )[0];
    if (!workout || workout.archivedAt) continue;
    if (workout.lastVerifiedCorosDate === toDate) {
      await resolveIntent(db, intent.id, now);
      continue;
    }
    const existing = inflightByWorkout.get(workout.id);
    if (existing?.destinationDate === toDate) continue;
    await enqueueMoveJob(db, { userId, workout, toDate, now });
    const online = await anyDeviceOnline(db, userId);
    await db
      .update(plannedWorkouts)
      .set({ corosSyncState: online ? "syncing" : "waiting_for_device", updatedAt: now })
      .where(eq(plannedWorkouts.id, workout.id));
    emitted += 1;
  }
  return emitted;
}
```

(d) In `applyJobResult`, rewrite the `upstream_changed`/`verification_failed` case:

```ts
    case "upstream_changed":
    case "verification_failed": {
      if (result.observedDate) workoutUpdates.lastVerifiedCorosDate = result.observedDate;
      const intent = await openIntentFor(db, userId, job.workoutId, "move");
      if (intent && attemptCount < job.maxAttempts) {
        // Last-edit-wins, tie to the app: the user's open intent stands. The
        // job is re-derived against the newly observed origin and the
        // displaced COROS value is surfaced as an undo note — never a stuck
        // "needs attention".
        jobStatus = "superseded";
        corosSyncState = "syncing";
        workoutUpdates.corosSyncState = "syncing";
        const workout = (
          await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, job.workoutId)).limit(1)
        )[0];
        if (workout) {
          await enqueueMoveJob(db, {
            userId,
            workout: {
              ...workout,
              lastVerifiedCorosDate: result.observedDate ?? workout.lastVerifiedCorosDate,
            },
            toDate: job.destinationDate,
            now,
          });
          await postSyncNote(db, {
            userId,
            workoutId: job.workoutId,
            kind: "kept_local_change",
            payload: { displacedDate: result.observedDate, keptDate: job.destinationDate },
          });
        }
      } else {
        jobStatus = "failed";
        corosSyncState = "sync_issue";
        workoutUpdates.corosSyncState = "sync_issue";
      }
      break;
    }
```

And in the `verified`/`already_in_desired_state` case add:

```ts
      const intent = await openIntentFor(db, userId, job.workoutId, "move");
      if (intent) await resolveIntent(db, intent.id, now);
```

In the exhausted `ambiguous`/`write_failed`, `rolled_back`, and `unsupported` branches, change `"calendar_only"` to `"sync_issue"` (both the local variable and `workoutUpdates.corosSyncState`). Also carry the new attempt count on re-emit: `enqueueMoveJob` inserts a fresh job with `attemptCount: 0` by default — add an optional `attemptCount` to its input and pass `attemptCount` from the superseded job in the upstream_changed branch, so the retry budget spans re-derivations.

(e) In `packages/domain/src/states.ts` extend the union and labels:

```ts
  | "needs_attention" // legacy — no longer produced; healed by migration
  | "sync_issue"; // terminal write failure; user can retry
```
and `sync_issue: "Sync issue",` in `COROS_SYNC_LABELS`.

(f) In `devices.ts` `/bridge/sync`, after the `importPlanSnapshot` block (inside the same `if`), add:

```ts
      const { emitPendingWork } = await import("../services/jobs.js");
      stats.emittedJobs = await emitPendingWork(db, userId, {
        corosWritesEnabled: prefs.corosWritesEnabled,
      });
```

(Use a static import at top of file instead if no cycle results — `devices.ts` already imports from `jobs.js`, so extend that import.) Confirm the field name on preferences: `packages/domain/src/preferences.ts` defines `corosWritesEnabled` (default false).

- [ ] **Step 4: Run, verify PASS**: `pnpm test -- --run apps/worker/test/jobs-reconcile.test.ts`, then the full suite `pnpm test -- --run apps/worker/test/` (vertical-loop exercises applyMove/applyJobResult; update any assertion that expected `needs_attention`/`calendar_only` from these paths to the new states).
- [ ] **Step 5: Commit.** `git add apps/worker/src/services/jobs.ts packages/domain/src/states.ts apps/worker/src/routes/devices.ts apps/worker/test/jobs-reconcile.test.ts && git commit -m "feat(sync): moves flow through the intent ledger with last-edit-wins"`

---

### Task 6: Snapshot import through the reconciler (rules 4/5/6 replaced)

**Files:**
- Modify: `apps/worker/src/services/import-plan.ts` (the date-decision block, lines ~375-427)
- Test: `apps/worker/test/import-reconcile.test.ts`

**Interfaces:**
- Consumes: `reconcileWorkout` (Task 4), `openIntentFor`/`resolveIntent` (Task 2), `postSyncNote` (Task 3), `emitPendingWork` (Task 5 — called by the bridge/sync route AFTER import, so import itself only supersedes; it does not enqueue).
- Produces: same `importPlanSnapshot` signature; `stats.conflicts` now counts app-wins events (rename in comments only, field name stays for compatibility).

- [ ] **Step 1: Write failing tests** in `apps/worker/test/import-reconcile.test.ts`. Build snapshots the way `vertical-loop.test.ts` does (a minimal `TrainingPlanInfo` + `SourcePlannedWorkout[]`; copy its fixture literals as a starting point). Cases:

```ts
// 1. Rule 5 replacement — upstream moved a workout, no open intent:
//    effectiveDate follows COROS, corosSyncState "synced", a sync note
//    kind "adopted_coros_change" exists with payload
//    {previousDate: <old lastVerified>, newDate: <new>}.
// 2. First import of a brand-new workout: NO sync note (nothing displaced).
// 3. Rule 6 replacement — open intent toDate "2026-08-10" + pending job,
//    snapshot says "2026-08-09": effectiveDate STAYS "2026-08-10",
//    lastVerifiedCorosDate becomes "2026-08-09", pending job is superseded,
//    note kind "kept_local_change" exists, corosSyncState is NOT
//    "needs_attention" (it is "calendar_only" until emitPendingWork runs —
//    then assert emitPendingWork enqueues the re-derived job).
// 4. Rule 4 unchanged — pending job destination matches snapshot date:
//    job "verified", intent resolved, state "synced".
// 5. Healing unchanged — calendar_only row whose dates agree becomes "synced".
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** In `import-plan.ts`, bulk-load the open intents once before the per-workout loop (never query per row). Add imports `import { openMoveIntents, resolveIntent } from "./sync-intents.js";` and `import { postSyncNote } from "./sync-notes.js";` and `import { reconcileWorkout } from "./reconcile.js";`. Before the loop:

```ts
  const intentByWorkout = new Map(
    (await openMoveIntents(db, input.userId)).flatMap((i) => {
      const toDate = i.payload?.["toDate"];
      return typeof toDate === "string" ? [[i.targetId, { id: i.id, toDate }] as const] : [];
    }),
  );
```

Replace the block from `if (corosDate !== current.lastVerifiedCorosDate) {` through the end of its `else if` healing chain (lines ~378-427) with:

```ts
    const action = reconcileWorkout({
      workoutId: current.id,
      effectiveDate: current.effectiveDate,
      lastVerifiedCorosDate: current.lastVerifiedCorosDate,
      observedDate: corosDate,
      openIntent: intentByWorkout.get(current.id) ?? null,
      pendingJob: pendingJob
        ? { id: pendingJob.id, destinationDate: pendingJob.destinationDate }
        : null,
    });

    switch (action.act) {
      case "verify_job": {
        if (action.jobId) {
          await db
            .update(corosWriteJobs)
            .set({ status: "verified", verifiedAt: now, completedAt: now, updatedAt: now })
            .where(eq(corosWriteJobs.id, action.jobId));
        }
        if (action.intentId) await resolveIntent(db, action.intentId, now);
        updates.lastVerifiedCorosDate = corosDate;
        updates.corosSyncState = "synced";
        stats.verifiedJobs += 1;
        touched = true;
        break;
      }
      case "app_wins": {
        // Last-edit-wins, tie to the app (spec §2): the open intent is the
        // most recent thing the user did; COROS's displaced value becomes an
        // undo note, and emitPendingWork (run by the bridge/sync route right
        // after this import) re-derives the write against the new origin.
        updates.lastVerifiedCorosDate = corosDate;
        updates.corosSyncState = "calendar_only"; // until the re-emit lands
        if (action.supersedeJobId) {
          await db
            .update(corosWriteJobs)
            .set({ status: "superseded", updatedAt: now })
            .where(eq(corosWriteJobs.id, action.supersedeJobId));
        }
        await postSyncNote(db, {
          userId: input.userId,
          workoutId: current.id,
          kind: "kept_local_change",
          payload: { displacedDate: action.note.displacedDate, keptDate: action.keepDate },
        });
        stats.conflicts += 1;
        touched = true;
        break;
      }
      case "adopt_coros": {
        updates.lastVerifiedCorosDate = corosDate;
        updates.effectiveDate = corosDate;
        updates.originalPlanDate = current.originalPlanDate;
        updates.calendarSyncState =
          current.calendarSyncState === "user_deleted" ? "user_deleted" : "pending";
        updates.corosSyncState = "synced";
        if (current.completionState === "unresolved") updates.completionState = "scheduled";
        if (action.note) {
          await postSyncNote(db, {
            userId: input.userId,
            workoutId: current.id,
            kind: "adopted_coros_change",
            payload: { previousDate: action.note.previousDate, newDate: corosDate },
          });
        }
        stats.updatedDates += 1;
        touched = true;
        break;
      }
      case "none": {
        if (
          !pendingJob &&
          current.effectiveDate === corosDate &&
          (current.corosSyncState === "calendar_only" ||
            current.corosSyncState === "needs_attention" ||
            current.corosSyncState === "sync_issue")
        ) {
          // Healing: both sides provably agree; whatever flagged the row is over.
          updates.corosSyncState = "synced";
          const open = intentByWorkout.get(current.id);
          if (open && open.toDate === corosDate) await resolveIntent(db, open.id, now);
          touched = true;
        }
        break;
      }
    }
```

Note: `adopt_coros` fires only when `observedDate !== lastVerifiedCorosDate`, so the note-on-displacement rule is automatic; brand-new rows never reach here (they take the `!current` insert path).

- [ ] **Step 4: Run, verify PASS** — new file, then the full suite (vertical-loop rules 4/5/6 assertions may need the new note/no-`needs_attention` expectations).
- [ ] **Step 5: Commit.** `git add apps/worker/src/services/import-plan.ts apps/worker/test/import-reconcile.test.ts && git commit -m "feat(sync): snapshot import decides through the reconciler"`

---

### Task 7: Studio — intent-aware drift, adoption instead of `changed_on_coros`

**Files:**
- Modify: `apps/worker/src/services/studio-push.ts` (`ObservedWorkout`, `detectDrift`, `loadObserved`, drift handling in `pushStudioPlan`, `planPush` untouchable set)
- Modify: `packages/domain/src/studio.ts` (add `"adopted"` to `StudioPlanPushStatus`)
- Modify: `apps/worker/src/routes/studio.ts` (new `POST /adoption/:pushId/undo` route)
- Test: extend `apps/worker/test/studio-push.test.ts`

**Interfaces:**
- Consumes: `appRequestedDates` (Task 2), `postSyncNote` (Task 3).
- Produces:
  - `ObservedWorkout.archiveReason: string | null` replaces `archived: boolean`; only `"absence_confirmed"` means gone.
  - `detectDrift(rows, observed, appMoves: Map<string, Set<string>>): DriftFinding[]` with `DriftKind = "missing" | "renamed" | "moved" | "app_moved"` and `DriftFinding.observedDay?: string`.
  - Drift handling in `pushStudioPlan`: `app_moved` → row keeps `status "verified"`, records `corosHappenDay = observedDay`; `missing`/`renamed`/`moved` → `status "adopted"`, `error: null`, `corosHappenDay` recorded, sync note posted (`adopted_coros_removal` for missing, `adopted_coros_edit` otherwise, payload `{ pushId, studioPlanId, sessionTitle, happenDay }`).
  - `planPush` treats `status === "adopted"` rows as untouchable (excluded from deletes/creates, counted in `batch.blocked`).
  - Undo route flips an adopted row back under studio management and re-pushes (details in Step 3d).

- [ ] **Step 1: Write failing tests** (extend `studio-push.test.ts`, which already unit-tests `detectDrift`/`planPush` — follow its fixture style):

```ts
// 1. detectDrift: observed date differs from happenDay BUT appMoves contains
//    that (sourceWorkoutId → observed date) → finding kind "app_moved" with
//    observedDay set, NOT "moved".
// 2. detectDrift: archiveReason "user_removed" or "duplicate_mirror" → NO
//    "missing" finding; "absence_confirmed" → "missing".
// 3. planPush: a row with status "adopted" appears in batch.blocked and in no
//    delete/create.
// 4. pushStudioPlan (db-level, follow existing db tests in the file): a
//    verified row whose observation moved WITHOUT an app move intent ends
//    status "adopted", error null, and a sync note kind "adopted_coros_edit"
//    exists; a row whose observation moved WITH a matching app move intent
//    stays "verified" and records corosHappenDay.
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.**

(a) `ObservedWorkout`: replace `archived: boolean` with `archiveReason: string | null`; `loadObserved` selects `archiveReason: plannedWorkouts.archiveReason` and also keeps `archivedAt` to preserve the "row exists but archived without reason (legacy)" case: map to `archiveReason: r.archiveReason ?? (r.archivedAt ? "absence_confirmed" : null)` — legacy archived rows keep today's semantics until Task 8's healing backfills reasons.

(b) `detectDrift` new signature and body:

```ts
export type DriftKind = "missing" | "renamed" | "moved" | "app_moved";
export interface DriftFinding {
  pushId: string;
  kind: DriftKind;
  observedDay?: string;
}

export function detectDrift(
  rows: PushRow[],
  observed: Map<string, ObservedWorkout>,
  appMoves: Map<string, Set<string>>,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const row of rows) {
    if (row.status !== "verified") continue;
    if (!row.corosIdInPlan || !row.corosPlanId) continue;
    const key = `${row.corosPlanId}:${row.corosIdInPlan}`;
    const seen = observed.get(key);
    if (!seen) continue;
    if (seen.archiveReason === "absence_confirmed") {
      findings.push({ pushId: row.id, kind: "missing" });
    } else if (seen.archiveReason) {
      // user_removed / duplicate_mirror: the app's own bookkeeping, not a
      // COROS-side deletion. Not drift.
    } else if (seen.title !== row.sessionTitle) {
      findings.push({ pushId: row.id, kind: "renamed", observedDay: seen.corosDate });
    } else if (seen.corosDate !== row.happenDay) {
      findings.push(
        appMoves.get(key)?.has(seen.corosDate)
          ? { pushId: row.id, kind: "app_moved", observedDay: seen.corosDate }
          : { pushId: row.id, kind: "moved", observedDay: seen.corosDate },
      );
    }
  }
  return findings;
}
```

(c) In `pushStudioPlan`, replace the drift-marking loop:

```ts
  const drift = detectDrift(
    rows,
    await loadObserved(db, opts.userId),
    await appRequestedDates(db, opts.userId),
  );
  const driftedPushIds = new Set<string>();
  for (const finding of drift) {
    const row = rows.find((r) => r.id === finding.pushId)!;
    if (finding.kind === "app_moved") {
      // Our own move, recognized from the intent ledger: still ours. Record
      // where the workout actually is so a future delete is addressed right.
      await db
        .update(studioPlanPushes)
        .set({ corosHappenDay: finding.observedDay, updatedAt: now })
        .where(eq(studioPlanPushes.id, finding.pushId));
      continue;
    }
    // A genuine external edit is ADOPTED (spec §2): COROS's version becomes
    // the truth, the studio stops managing the session, and an undo note
    // offers to re-push the original. Never a permanent unmanaged state.
    driftedPushIds.add(finding.pushId);
    await db
      .update(studioPlanPushes)
      .set({
        status: "adopted",
        error: null,
        ...(finding.observedDay ? { corosHappenDay: finding.observedDay } : {}),
        updatedAt: now,
      })
      .where(eq(studioPlanPushes.id, finding.pushId));
    await postSyncNote(db, {
      userId: opts.userId,
      kind: finding.kind === "missing" ? "adopted_coros_removal" : "adopted_coros_edit",
      payload: {
        pushId: row.id,
        studioPlanId: opts.studioPlanId,
        sessionTitle: row.sessionTitle,
        happenDay: row.happenDay,
      },
    });
  }
```

In `planPush`, change the untouchable set to status-based:

```ts
  const untouchable = new Set([
    ...input.driftedPushIds,
    ...input.rows.filter((r) => r.status === "adopted" || r.error === CHANGED_ON_COROS).map((r) => r.id),
  ]);
```

(`CHANGED_ON_COROS` remains only for legacy rows until Task 8 heals them; keep the constant and its doc comment, marked legacy.) Also update the two `mapCreateResult`/`mapDeleteResult` returns of `terminal(CHANGED_ON_COROS)` to instead return `{ status: "adopted", error: null, persistIds: false, clearIds: false, job: "failed" }` — an `already_present`-on-another-day or `stamp_mismatch` is the same "the user took this over" fact discovered at write time; `applyStudioJobResult` needs no change (it writes `transition.status`). Add `"adopted"` to `PushRow.status`'s doc and to `StudioPlanPushStatus` in `packages/domain/src/studio.ts`.

(d) Undo route in `routes/studio.ts` (mount beside existing push routes, `requireUser`):

```ts
studioRoutes.post("/adoption/:pushId/undo", requireUser, async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const pushId = c.req.param("pushId");
  const row = (
    await db.select().from(studioPlanPushes).where(eq(studioPlanPushes.id, pushId)).limit(1)
  )[0];
  if (!row || row.status !== "adopted") return c.json({ error: "not_adopted" }, 404);
  const plan = (
    await db
      .select()
      .from(studioPlans)
      .where(and(eq(studioPlans.id, row.planId), eq(studioPlans.userId, userId)))
      .limit(1)
  )[0];
  if (!plan) return c.json({ error: "not_found" }, 404);
  const stillObserved = Boolean(row.corosIdInPlan);
  await db
    .update(studioPlanPushes)
    .set(
      stillObserved
        ? // Re-pushing will delete the user's edited copy and recreate the
          // original: force the fingerprint stale so the diff plans exactly that.
          { status: "verified", error: null, sessionFingerprint: "undo-forced", updatedAt: nowInstant() }
        : // Deleted on COROS: nothing to remove; a plain recreate suffices.
          { status: "failed", error: null, corosIdInPlan: null, corosProgramId: null,
            corosEntityId: null, corosPlanId: null, corosHappenDay: null,
            sessionFingerprint: "undo-forced", updatedAt: nowInstant() },
    )
    .where(eq(studioPlanPushes.id, pushId));
  await recordIntent(db, {
    userId, targetKind: "studio_session", targetId: pushId, kind: "restore", source: "undo",
  });
  const prefs = await loadPreferences(db, userId);
  const summary = await pushStudioPlan(db, {
    userId, studioPlanId: row.planId, today: todayInZone(prefs.timezone),
  });
  return c.json({ ok: summary.ok, summary });
});
```

(Match the file's existing imports — `studioPlans`, `studioPlanPushes`, `loadPreferences`, `todayInZone`, `pushStudioPlan` are all already imported or trivially added.)

- [ ] **Step 4: Run, verify PASS** — `pnpm test -- --run apps/worker/test/studio-push.test.ts apps/worker/test/studio-routes.test.ts`, then full suite.
- [ ] **Step 5: Commit.** `git add apps/worker/src/services/studio-push.ts apps/worker/src/routes/studio.ts packages/domain/src/studio.ts apps/worker/test/studio-push.test.ts && git commit -m "feat(sync): studio drift is intent-aware; external edits adopted with undo"`

---

### Task 8: Legacy healing migration

**Files:**
- Create: `apps/worker/src/services/heal-legacy-sync.ts`
- Modify: `apps/worker/src/index.ts` (hourly cron calls it)
- Test: `apps/worker/test/heal-legacy-sync.test.ts`

**Interfaces:**
- Consumes: `recordIntent` (Task 2).
- Produces: `healLegacySyncState(db, userId): Promise<{ healed: boolean }>` — idempotent via an `auditEvents` marker `kind: "sync_ledger_migrated"`.

- [ ] **Step 1: Write failing tests**: seed legacy rows, run twice, assert idempotence:

```ts
// 1. studio_plan_pushes row with error 'changed_on_coros' → status 'adopted', error null.
// 2. planned_workouts corosSyncState 'needs_attention' with
//    effectiveDate === lastVerifiedCorosDate → 'synced'.
// 3. planned_workouts corosSyncState 'calendar_only' with
//    effectiveDate !== lastVerifiedCorosDate → an open move intent exists with
//    payload.toDate === effectiveDate (source 'auto_resolve'); state untouched.
// 4. archived row with a 'user_removed' suppression → archiveReason 'user_removed';
//    archived row with missingReads >= 2 and no suppression → 'absence_confirmed'.
// 5. Second call returns { healed: false } and changes nothing.
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `heal-legacy-sync.ts`:

```ts
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  auditEvents,
  calendarEventSuppressions,
  plannedWorkouts,
  studioPlanPushes,
  studioPlans,
} from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { recordIntent } from "./sync-intents.js";
import type { Db } from "./db.js";

/**
 * One-shot migration of pre-ledger sync state (spec §1 "Migration & healing").
 * Idempotent: guarded by an audit marker. Runs from the hourly cron so prod
 * heals itself without a wrangler-side write (prod D1 writes via wrangler are
 * classifier-blocked).
 */
export async function healLegacySyncState(db: Db, userId: string): Promise<{ healed: boolean }> {
  const marker = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(and(eq(auditEvents.userId, userId), eq(auditEvents.kind, "sync_ledger_migrated")))
    .limit(1);
  if (marker.length > 0) return { healed: false };
  const now = nowInstant();

  // 1. Falsely-drifted studio rows rejoin management as adoptions (their undo
  //    path then works like any other adopted row).
  const planIds = (
    await db.select({ id: studioPlans.id }).from(studioPlans).where(eq(studioPlans.userId, userId))
  ).map((p) => p.id);
  if (planIds.length > 0) {
    await db
      .update(studioPlanPushes)
      .set({ status: "adopted", error: null, updatedAt: now })
      .where(
        and(inArray(studioPlanPushes.planId, planIds), eq(studioPlanPushes.error, "changed_on_coros")),
      );
  }

  // 2. needs_attention rows whose dates already agree are provably fine.
  const flagged = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        inArray(plannedWorkouts.corosSyncState, ["needs_attention", "calendar_only"]),
      ),
    );
  for (const w of flagged) {
    if (w.effectiveDate === w.lastVerifiedCorosDate) {
      await db
        .update(plannedWorkouts)
        .set({ corosSyncState: "synced", updatedAt: now })
        .where(eq(plannedWorkouts.id, w.id));
    } else if (!w.archivedAt) {
      // 3. A real local-vs-COROS date gap becomes an open intent the
      //    reconciler will emit for when writing is possible.
      await recordIntent(db, {
        userId,
        targetKind: "workout",
        targetId: w.id,
        kind: "move",
        payload: { toDate: w.effectiveDate, toTime: w.effectiveTime, fromDate: w.lastVerifiedCorosDate },
        source: "auto_resolve",
      });
    }
  }

  // 4. archiveReason backfill.
  const archived = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        isNotNull(plannedWorkouts.archivedAt),
        isNull(plannedWorkouts.archiveReason),
      ),
    );
  const suppressions = await db.select().from(calendarEventSuppressions);
  const reasonByWorkout = new Map<string, string>();
  for (const s of suppressions) {
    if (s.reason === "user_removed" || s.reason === "duplicate_mirror") {
      reasonByWorkout.set(s.workoutId, s.reason);
    }
  }
  for (const w of archived) {
    // With no suppression evidence, absence is the only safe default.
    const reason = reasonByWorkout.get(w.id) ?? "absence_confirmed";
    await db
      .update(plannedWorkouts)
      .set({ archiveReason: reason, updatedAt: now })
      .where(eq(plannedWorkouts.id, w.id));
  }

  await db.insert(auditEvents).values({
    id: newId(),
    userId,
    kind: "sync_ledger_migrated",
    detail: { flagged: flagged.length, archivedBackfilled: archived.length },
    createdAt: now,
  });
  return { healed: true };
}
```

(The `?? "absence_confirmed"` double is deliberate — with no suppression evidence, absence is the only safe default; simplify to a single expression.)

- [ ] **Step 4: Wire into the hourly cron.** In `apps/worker/src/index.ts` `hourly` handler, alongside the existing per-user work, add `await healLegacySyncState(db, user.id);` (match how the handler iterates users; it already loads them for reconcile+garden).
- [ ] **Step 5: Run, verify PASS**; full suite.
- [ ] **Step 6: Commit.** `git add apps/worker/src/services/heal-legacy-sync.ts apps/worker/src/index.ts apps/worker/test/heal-legacy-sync.test.ts && git commit -m "feat(sync): one-shot legacy sync-state healing"`

---

### Task 9: Centralized device presence + derived sync status

**Files:**
- Create: `apps/worker/src/services/sync-status.ts`
- Modify: `apps/worker/src/services/jobs.ts`, `apps/worker/src/routes/devices.ts` (`GET /` online calc), `apps/worker/src/routes/plan.ts` (~line 122-126), `apps/worker/src/routes/studio.ts` (~line 126 and the 412 gate ~line 273) — all four replace their inline liveness math with `devicePresence`.
- Modify: `apps/worker/src/routes/devices.ts` — **delete** the dead `POST /bridge/heartbeat` handler.
- Test: `apps/worker/test/sync-status.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DevicePresence {
  registered: boolean;      // any non-revoked device
  online: boolean;          // lastSeenAt within 3 min AND not paused
  paused: boolean;          // any non-revoked device is paused
  writeCapable: boolean;    // non-revoked device with move-write capabilities
}
export async function devicePresence(db: Db, userId: string): Promise<DevicePresence>;

export type SyncStatusState = "in_sync" | "syncing" | "waiting_for_mac" | "not_synced" | "sync_issue";
export interface SyncStatus {
  state: SyncStatusState;
  pendingCount: number;      // queued/claimed/in_progress/verifying jobs
  issueCount: number;        // failed jobs with an open intent + failed/unaddressable studio rows
  lastCorosReadAt: string | null; // latest ok sync_runs kind 'coros_read' finishedAt
  paused: boolean;
  writesEnabled: boolean;
  registered: boolean;
}
export async function computeSyncStatus(db: Db, userId: string, prefs: UserPreferences): Promise<SyncStatus>;
```

State priority (first match wins): `not_synced` when `!prefs.corosWritesEnabled || !presence.writeCapable`; `sync_issue` when `issueCount > 0`; `waiting_for_mac` when `pendingCount > 0 && !presence.online`; `syncing` when `pendingCount > 0`; else `in_sync`.

- [ ] **Step 1: Write failing tests** in `sync-status.test.ts` covering: writes off → `not_synced`; writes on + capable device online + no jobs → `in_sync`; queued job + stale `lastSeenAt` → `waiting_for_mac`; queued job + fresh `lastSeenAt` → `syncing`; failed move job with open intent → `sync_issue`; paused device → `paused: true` and `online: false` even with fresh `lastSeenAt`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `sync-status.ts`:

```ts
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  corosWriteJobs,
  desktopDevices,
  studioPlanPushes,
  studioPlans,
  syncRuns,
} from "@rg/database";
import type { UserPreferences } from "@rg/domain";
import { openMoveIntents } from "./sync-intents.js";
import type { Db } from "./db.js";

export const DEVICE_ONLINE_WINDOW_MS = 3 * 60_000;
const IN_FLIGHT = ["queued", "claimed", "in_progress", "verifying"] as const;

export interface DevicePresence {
  registered: boolean;
  online: boolean;
  paused: boolean;
  writeCapable: boolean;
}

/** THE liveness computation — the only copy in the codebase. */
export async function devicePresence(db: Db, userId: string): Promise<DevicePresence> {
  const devices = await db
    .select()
    .from(desktopDevices)
    .where(and(eq(desktopDevices.userId, userId), isNull(desktopDevices.revokedAt)));
  const cutoff = Date.now() - DEVICE_ONLINE_WINDOW_MS;
  return {
    registered: devices.length > 0,
    online: devices.some((d) => !d.bridgePaused && Date.parse(d.lastSeenAt) > cutoff),
    paused: devices.some((d) => d.bridgePaused),
    writeCapable: devices.some(
      (d) =>
        d.capabilities?.["updateExistingScheduledWorkout"] === true ||
        (d.capabilities?.["addScheduledWorkout"] === true &&
          d.capabilities?.["removeScheduledWorkout"] === true),
    ),
  };
}

export type SyncStatusState = "in_sync" | "syncing" | "waiting_for_mac" | "not_synced" | "sync_issue";

export interface SyncStatus {
  state: SyncStatusState;
  pendingCount: number;
  issueCount: number;
  lastCorosReadAt: string | null;
  paused: boolean;
  writesEnabled: boolean;
  registered: boolean;
}

export async function computeSyncStatus(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<SyncStatus> {
  const presence = await devicePresence(db, userId);

  const pending = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), inArray(corosWriteJobs.status, [...IN_FLIGHT])));

  // Issues = terminal move failures the user can still retry (their intent is
  // open) + terminally failed studio rows.
  const failedJobs = await db
    .select({ workoutId: corosWriteJobs.workoutId })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.status, "failed")));
  const openIntentTargets = new Set((await openMoveIntents(db, userId)).map((i) => i.targetId));
  const failedMoveCount = new Set(
    failedJobs.map((j) => j.workoutId).filter((id) => openIntentTargets.has(id)),
  ).size;
  const failedStudio = await db
    .select({ id: studioPlanPushes.id })
    .from(studioPlanPushes)
    .innerJoin(studioPlans, eq(studioPlanPushes.planId, studioPlans.id))
    .where(and(eq(studioPlans.userId, userId), eq(studioPlanPushes.status, "failed")));
  const issueCount = failedMoveCount + failedStudio.length;

  const lastRead = (
    await db
      .select({ finishedAt: syncRuns.finishedAt })
      .from(syncRuns)
      .where(and(eq(syncRuns.kind, "coros_read"), eq(syncRuns.status, "ok"), eq(syncRuns.userId, userId)))
      .orderBy(desc(syncRuns.finishedAt))
      .limit(1)
  )[0];

  const state: SyncStatusState =
    !prefs.corosWritesEnabled || !presence.writeCapable
      ? "not_synced"
      : issueCount > 0
        ? "sync_issue"
        : pending.length > 0
          ? presence.online
            ? "syncing"
            : "waiting_for_mac"
          : "in_sync";

  return {
    state,
    pendingCount: pending.length,
    issueCount,
    lastCorosReadAt: lastRead?.finishedAt ?? null,
    paused: presence.paused,
    writesEnabled: prefs.corosWritesEnabled,
    registered: presence.registered,
  };
}
```

Delete `DEVICE_ONLINE_WINDOW_MS` from `jobs.ts` and import it from `sync-status.js`; rewrite `anyDeviceOnline` as `(await devicePresence(db, userId)).online` and `writeCapableDeviceExists` as `.writeCapable` (keep the exported function names so callers don't churn). Update the four inline-liveness call sites listed in Files; in `studio.ts`'s 412 gate keep the same `reason` derivation but source `online`/`registered` from `devicePresence`. Delete the heartbeat route.
- [ ] **Step 4: Run, verify PASS**; full suite (vertical-loop covers plan routes).
- [ ] **Step 5: Commit.** `git add apps/worker/src/services/sync-status.ts apps/worker/src/services/jobs.ts apps/worker/src/routes/devices.ts apps/worker/src/routes/plan.ts apps/worker/src/routes/studio.ts apps/worker/test/sync-status.test.ts && git commit -m "feat(sync): centralized presence + derived status; drop dead heartbeat"`

---

### Task 10: Sync routes + per-workout derived state in DTOs

**Files:**
- Create: `apps/worker/src/routes/sync.ts`
- Modify: `apps/worker/src/index.ts` (mount `app.route("/api/sync", syncRoutes)`)
- Modify: `apps/worker/src/routes/plan.ts` — `workoutDto` (or the route assembling it) derives the per-workout state instead of echoing the stored column
- Modify: `packages/api-client/src/index.ts` — add `syncStatus()`, `syncNotes()`, `dismissSyncNote(id)`, `undoSyncNote(id)`, `readNow()` (follow the file's existing fetch-wrapper style, e.g. `calendarSync`)
- Test: `apps/worker/test/sync-routes.test.ts` (use `mountRoutes` from helpers)

**Interfaces:**
- Produces routes (all `requireUser`):
  - `GET /api/sync/status` → `SyncStatus` JSON (Task 9)
  - `GET /api/sync/notes` → `{ notes: Array<{ id; kind; workoutId; payload; createdAt }> }`
  - `POST /api/sync/notes/:id/dismiss` → `{ ok: true }`
  - `POST /api/sync/notes/:id/undo` → `{ ok: true }` — behavior by kind:
    - `kept_local_change`: record move intent to `payload.displacedDate` (source `"undo"`), call `emitPendingWork`, dismiss note.
    - `adopted_coros_change`: record move intent to `payload.previousDate` (source `"undo"`) via `applyMove`-style update of `effectiveDate` — implement by calling `applyMove(db, { userId, workoutId: note.workoutId, toDate: payload.previousDate, toTime: workout.effectiveTime, source: "app", corosWritesEnabled: prefs.corosWritesEnabled })`, dismiss note.
    - `adopted_coros_edit` / `adopted_coros_removal`: forward to the studio undo (`POST /api/studio/adoption/:pushId/undo` logic — import and call a shared function or duplicate the 10-line body), dismiss note.
  - `POST /api/sync/read-now` → `{ enqueued: boolean; lastCorosReadAt: string | null }` — if latest ok `coros_read` run finished < 5 min ago, return `enqueued: false`; else insert a `read_now` job unless one is already queued/claimed:

```ts
const READ_NOW_FRESH_MS = 5 * 60_000;
// job insert shape:
await db.insert(corosWriteJobs).values({
  id, userId, workoutId: id, kind: "read_now",
  expectedContentFingerprint: "", originalDate: today, destinationDate: today,
  requestedAt: nowInstant(), status: "queued", updatedAt: nowInstant(),
});
```

- Per-workout derived state (in `plan.ts`): add a pure helper in `sync-status.ts`:

```ts
/**
 * Per-workout view, in the LEGACY CorosSyncState vocabulary so CorosPill and
 * COROS_SYNC_LABELS keep working unchanged (the line-level SyncStatusState is
 * a separate type with its own five values).
 */
export function deriveWorkoutSync(v: {
  effectiveDate: string;
  lastVerifiedCorosDate: string;
  hasOpenIntent: boolean;
  hasPendingJob: boolean;
  hasFailedJob: boolean;
  presence: DevicePresence;
  writesEnabled: boolean;
}): "synced" | "syncing" | "waiting_for_device" | "calendar_only" | "sync_issue" {
  if (v.effectiveDate === v.lastVerifiedCorosDate && !v.hasPendingJob) return "synced";
  if (v.hasPendingJob) return v.presence.online ? "syncing" : "waiting_for_device";
  if (v.hasFailedJob) return "sync_issue";
  return "calendar_only";
}
```

The plan routes that build `workoutDto` load open intents + in-flight/failed jobs for the listed workouts (two `inArray` queries, chunked with the file's existing `chunkIds` pattern if >an handful) and attach `corosSyncView: deriveWorkoutSync(...)` to the DTO alongside the legacy field.

- [ ] **Step 1: Write failing route tests** (status returns shape; read-now enqueues once and dedupes; notes dismiss/undo happy paths; undo of `kept_local_change` records an intent).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement routes + api-client + DTO derivation.**
- [ ] **Step 4: Run, verify PASS**; full suite.
- [ ] **Step 5: Commit.** `git add apps/worker/src/routes/sync.ts apps/worker/src/index.ts apps/worker/src/routes/plan.ts apps/worker/src/services/sync-status.ts packages/api-client/src/index.ts apps/worker/test/sync-routes.test.ts && git commit -m "feat(sync): status/notes/read-now routes + derived per-workout state"`

---

### Task 11: `read_now` job kind through the worker and bridge; adaptive polling

**Files:**
- Modify: `apps/worker/src/services/jobs.ts` (`claimNextJob` skips workout-load for `read_now`; `applyJobResult` short-circuits it)
- Modify: `apps/worker/src/routes/devices.ts` (claim response gains `pendingCount`)
- Modify: `services/coros-bridge/src/cloud-sync.ts` (handle `read_now`; adaptive poll)
- Test: `apps/worker/test/jobs-reconcile.test.ts` (extend); `services/coros-bridge/test/cloud-sync.test.ts` (create if absent — check `services/coros-bridge/package.json` for the vitest setup other packages use; if the package has no test runner wired, add the worker-side tests only and cover the bridge change by the typecheck)

**Interfaces:**
- Consumes: read-now enqueue (Task 10).
- Produces:
  - Claim response: `{ job: {...} | null, pendingCount: number, paused?: boolean }` — `pendingCount` = queued jobs remaining after this claim.
  - Bridge executes `read_now` by running `pushSnapshot()` and reporting `outcome: "verified"`.
  - Bridge polls every 10 s while `pendingCount > 0`, 45 s otherwise.

- [ ] **Step 1: Worker failing tests**: claiming a `read_now` job returns `workout: null` and doesn't throw; `applyJobResult` with `outcome: "verified"` marks it verified without touching `plannedWorkouts`; the claim route response contains `pendingCount`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement worker side.** In `claimNextJob`, the workout lookup condition becomes `isStudioJobKind(job.kind) || job.kind === "read_now" ? null : ...`. In `applyJobResult`, immediately after the studio-kind branch add:

```ts
  if (job.kind === "read_now") {
    await db
      .update(corosWriteJobs)
      .set({
        status: result.outcome === "verified" ? "verified" : "failed",
        attemptCount: job.attemptCount + 1,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(corosWriteJobs.id, job.id));
    return { jobStatus: result.outcome === "verified" ? "verified" : "failed", corosSyncState: "unchanged" };
  }
```

In `devices.ts` claim handler, after `claimNextJob` compute:

```ts
  const remaining = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.userId, c.get("userId")), eq(corosWriteJobs.status, "queued")));
  // include pendingCount in BOTH the null-job and job responses
```

- [ ] **Step 4: Implement bridge side** in `cloud-sync.ts`:

(a) Constants: `const FAST_POLL_MS = 10_000;`. Add field `private pendingCount = 0;` and replace the poll `setInterval` with a `setTimeout` loop:

```ts
  private schedulePoll(): void {
    if (this.stopped) return;
    const delay = this.pendingCount > 0 ? FAST_POLL_MS : this.pollMs;
    this.pollTimer = setTimeout(() => {
      this.enqueue("pollJobs", async () => {
        try {
          await this.pollJobs();
        } finally {
          this.schedulePoll();
        }
      });
    }, delay);
  }
```

`start()` sets `this.stopped = false`, enqueues the initial snapshot+poll, then calls `this.schedulePoll()`; keep the snapshot `setInterval` as-is. `stop()` sets `this.stopped = true` and `clearTimeout(this.pollTimer)`. (`pollTimer` type becomes `ReturnType<typeof setTimeout> | null`.)

(b) In `pollJobs`, parse `pendingCount` from every claim response (`this.pendingCount = claim.pendingCount ?? 0;`) and handle the new kind before `toStudioJob`:

```ts
      if (job.kind === "read_now") {
        await this.pushSnapshot();
        await this.post(`/api/devices/bridge/jobs/${job.id}/result`, {
          jobId: job.id,
          deviceId: this.deviceId,
          outcome: "verified",
          finishedAt: new Date().toISOString(),
          signature: "sig-in-headers",
        });
        this.logger(`[coros-bridge] job ${job.id} → read_now snapshot pushed`);
        continue;
      }
```

Confirm `corosWriteResultSchema` (in `@rg/domain`) accepts a result without `pathUsed`/`observedDate` — it already does for `unsupported` outcomes; if `outcome` is an enum there, verify `"verified"` is a member (it is — moves use it).

- [ ] **Step 5: Run worker tests + typecheck everything**: `pnpm test -- --run apps/worker/test/` and `pnpm typecheck`. If `services/coros-bridge` has a wired test runner, add a `cloud-sync.test.ts` that stubs `fetchImpl` to serve one `read_now` claim then `job: null`, asserts a `/bridge/sync` POST happened between claim and result. Expected: PASS.
- [ ] **Step 6: Commit.** `git add apps/worker/src/services/jobs.ts apps/worker/src/routes/devices.ts services/coros-bridge/src/cloud-sync.ts apps/worker/test/ services/coros-bridge/test/ && git commit -m "feat(sync): read_now job kind + adaptive bridge polling"`

---

### Task 12: UI — one status line, undo notes, adopted pills, Sync now

**Files:**
- Modify: `packages/ui/src/components.tsx` (`CorosPill` mapping; new `SyncStatusLine`, `SyncNotesStack`)
- Modify: `packages/ui/src/screens/today.tsx` (drop local `SyncStatusLine` lines ~24-49; use shared; render notes)
- Modify: `packages/ui/src/screens/garden.tsx` (~line 366 swap to shared component)
- Modify: `packages/ui/src/screens/plan.tsx` (status line; sheet banner variants read `corosSyncView`; move-time never-paired prompt)
- Modify: `packages/ui/src/screens/studio.tsx` (`BridgeStatusLine` presence from `/api/sync/status`; delete the disabled Forget/re-adopt block ~lines 481-501; add `adopted` pill "Edited on COROS" with an Undo button → `undoSyncNote`/studio adoption undo)
- Modify: `packages/ui/src/screens/settings.tsx` ("Sync now" button in diagnostics; show `lastCorosReadAt`)
- Modify: `apps/worker/src/services/calendar-sync.ts` (~line 192: label from the derived view via `COROS_SYNC_LABELS` — pass the derived value where the workout DTO is available, else keep stored-column label for now with a `sync_issue` mapping added)
- Test: `pnpm typecheck` + full worker suite (UI has no test runner in this repo)

**Interfaces:**
- Consumes: `syncStatus()`, `syncNotes()`, `dismissSyncNote`, `undoSyncNote`, `readNow()` from `packages/api-client` (Task 10); `corosSyncView` on workout DTOs (Task 10).
- Produces `SyncStatusLine` (shared):

```tsx
export interface SyncStatusDto {
  state: "in_sync" | "syncing" | "waiting_for_mac" | "not_synced" | "sync_issue";
  pendingCount: number;
  issueCount: number;
  lastCorosReadAt: string | null;
  paused: boolean;
  writesEnabled: boolean;
  registered: boolean;
}

export function SyncStatusLine({ status, onRetry }: { status: SyncStatusDto; onRetry?: () => void }) {
  const line = (() => {
    switch (status.state) {
      case "in_sync":
        return `Calendar, COROS and watch in sync${status.lastCorosReadAt ? ` · ${relativeTime(status.lastCorosReadAt)}` : ""}`;
      case "syncing":
        return `Syncing ${status.pendingCount} change${status.pendingCount === 1 ? "" : "s"}…`;
      case "waiting_for_mac":
        return status.paused
          ? "Sync is paused — resume in Settings"
          : `${status.pendingCount} change${status.pendingCount === 1 ? "" : "s"} waiting — wake your Mac to update your watch`;
      case "not_synced":
        return status.registered ? "COROS updates are off — enable in Settings" : "No Mac paired — pair in Settings to update COROS";
      case "sync_issue":
        return `${status.issueCount} change${status.issueCount === 1 ? "" : "s"} couldn't sync`;
    }
  })();
  // render: quiet single line; sync_issue also renders a Retry button calling onRetry
}
```

(`relativeTime` — reuse the existing helper if `components.tsx`/screens already have one for "2m ago" rendering; otherwise add a 10-line one beside the component.) Retry = `readNow()` + re-fetch status; for failed jobs the retry endpoint is the existing per-workout `retry-coros` (sheet-level) — the line-level Retry just calls `readNow()` then refetches, since `emitPendingWork` runs on the next bridge sync and re-derives failed intents.

- `SyncNotesStack`: renders `activeSyncNotes` as dismissible rows with copy by kind:
  - `kept_local_change`: `Kept your ${payload.keptDate} — COROS had moved it to ${payload.displacedDate}` · Undo
  - `adopted_coros_change`: `Moved to ${payload.newDate} on COROS` · Undo
  - `adopted_coros_edit`: `“${payload.sessionTitle}” was edited on COROS — the studio stopped managing it` · Undo
  - `adopted_coros_removal`: `“${payload.sessionTitle}” was removed on COROS` · Undo
- Move-time prompt (plan move sheet): when status is `not_synced`, the confirm copy appends: registered ? "This will only change the app calendar — COROS updates are off." : "This will only change the app calendar — pair your Mac to update COROS."
- `CorosPill` map gains `sync_issue: "Sync issue"`; screens read `corosSyncView ?? corosSyncState` so old cached DTOs render.
- App-open freshness: in the top-level data hook where the app bootstraps (today screen mount), fire `readNow()` fire-and-forget.

- [ ] **Step 1: Implement all of the above.** Match each screen's existing style primitives (the `.cal-*` classes on plan, pill components, settings row layout).
- [ ] **Step 2: Verify.** `pnpm typecheck` (Node 22 for any build steps if needed; typecheck runs on either) and `pnpm test -- --run apps/worker/test/`. Expected: PASS, zero type errors.
- [ ] **Step 3: Visual check.** Run the web app dev server per repo scripts and eyeball: Today shows the single quiet line; Plan sheet shows derived pill; Studio shows adopted pill + Undo; Settings has Sync now. (No screenshot gate — single-user app, deploy verifies.)
- [ ] **Step 4: Commit.** `git add packages/ui/src packages/api-client/src apps/worker/src/services/calendar-sync.ts && git commit -m "feat(sync): unified status line, undo notes, adopted sessions UI, sync now"`

---

### Task 13: Full-suite gate + docs

**Files:**
- Modify: `docs/SYNC_AND_RECONCILIATION.md` (rules 4/5/6 now route through `reconcileWorkout`; document intents, notes, adoption, `read_now`, derived status)

- [ ] **Step 1:** `pnpm test -- --run` (whole repo, Node 21) and `pnpm typecheck`. Expected: all green. Fix anything that isn't before proceeding.
- [ ] **Step 2:** Update the sync doc: short sections for the intent ledger, last-edit-wins policy, adoption, derived status vocabulary, and the `read_now`/adaptive-poll freshness path. Point at `reconcile.ts` as the decision table of record.
- [ ] **Step 3: Commit.** `git add docs/SYNC_AND_RECONCILIATION.md && git commit -m "docs: sync reconciliation reflects intent-ledger reconciler"`

---

## Self-Review Notes (kept for the record)

- Spec §1 core model → Tasks 1, 2, 4, 5, 6; migration/healing → Task 8. Spec §2 conflicts/undo → Tasks 4, 5, 6, 7, 10, 12. Spec §3 freshness/liveness → Tasks 9, 10, 11 (desktop shell explicitly deferred to its own plan, matching the spec's out-of-scope note for bridge-side work beyond `read_now`). Spec §4 status/UI/testing → Tasks 9, 10, 12; error handling (retry re-derives from intent) → Tasks 5, 10.
- The stored `corosSyncState` column keeps being written for backward compatibility during this plan; UI reads the derived `corosSyncView`. Dropping the column is a later cleanup, deliberately not in scope.
- `pendingCount`-driven fast polling only helps while the bridge is running; the login-item work that keeps it running is the follow-up desktop plan.
