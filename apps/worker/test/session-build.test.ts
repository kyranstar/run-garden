/**
 * Building a slot's session on its day, previewing ahead, locking on Start (Phase 2 spec §2a "Build API";
 * programme spec §7.2 determinism, §7.3 payload, §9.2 discipline, §10.1–10.2).
 *
 * The service tests pass `today` and `now` explicitly (fixed dates: nothing here can go stale); the route tests
 * use the real today, because the routes do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  adaptiveConfigSchema,
  addDays,
  newId,
  nowInstant,
  sessionLead,
  todayInZone,
  type AdaptiveConfig,
  type UserPreferences,
} from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import {
  BUILD_CONFIG_KEYS,
  buildSession,
  buildSessionOutcome,
  composeBuild,
  loadSession,
  NotBuiltError,
  NotTodayError,
  recordCheck,
  SessionLockedError,
  SessionNotFoundError,
  StaleBuildError,
  startSession,
  type SessionResponse,
} from "../src/services/session-build.js";
import { loadEngineContext, loadProgramState, saveProgramState } from "../src/services/engine-inputs.js";
import { placeSlots, slotId } from "../src/services/program-slots.js";
import { dayCollides } from "../src/services/day-placement.js";
import { applyMove } from "../src/services/jobs.js";
import { conditionRoutes, sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const {
  plannedWorkouts,
  programs,
  programBlocks,
  sessionBuilds,
  conditionChecks,
  userConditions,
  exercisePrefs,
  performedSessions,
  performedSets,
  accountState,
} = schema;

// Each test builds a few whole sessions (a few ms each on a quiet machine); a busy one can stretch that.
vi.setConfig({ testTimeout: 30_000 });

// The routes hand the calendar sync to waitUntil; the tests count the hand-offs.
const calendar = vi.hoisted(() => ({ syncs: 0 }));
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => {
    calendar.syncs += 1;
    return {};
  }),
}));

/** A Wednesday; noon in Los Angeles (the test user's zone). */
const TODAY = "2026-10-07";
const NOW = "2026-10-07T19:00:00.000Z";
const LATER = "2026-10-07T19:05:00.000Z";

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let programId: string;

/** Runs just before each statement the application executes (a test arms it to land a concurrent change there). */
let beforeStatement: ((sql: string) => void) | null;

beforeEach(async () => {
  statements = [];
  beforeStatement = null;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (sql) => {
      statements.push(sql);
      beforeStatement?.(sql);
    },
  });
  ({ userId, prefs } = await makeTestUser(db));
  programId = await seedProgram(userId);
});

const ctx = (over: Partial<{ today: string; now: string }> = {}) => ({ today: TODAY, now: NOW, prefs, ...over });

async function seedProgram(owner: string, config: Partial<AdaptiveConfig> = {}): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id,
    userId: owner,
    kind: "adaptive",
    name: "Mobility",
    status: "active",
    disciplines: ["yoga", "strength"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30, ...config }),
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  });
  return id;
}

/** A slot as placement writes it. */
async function seedSlot(date: string, o: { owner?: string; program?: string; origin?: string | null } = {}): Promise<string> {
  const owner = o.owner ?? userId;
  const program = o.program ?? programId;
  const id = slotId(program, date);
  await db.insert(plannedWorkouts).values({
    id,
    userId: owner,
    planId: program,
    sourceWorkoutId: id,
    title: "Mobility",
    category: "yoga",
    sport: "yoga",
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: "18:00",
    sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800,
    fallbackEstimatedDurationSeconds: 1800,
    corosSyncState: "calendar_only",
    completionState: "scheduled",
    origin: o.origin === undefined ? "program" : o.origin,
    contentState: "outline",
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function rowOf(id: string) {
  const [r] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
  return r!;
}

async function buildsOf(workoutId: string) {
  return (await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, workoutId))).sort((a, b) => a.version - b.version);
}

async function activateTmj(owner: string = userId): Promise<void> {
  await db.insert(userConditions).values({ id: `${owner}:tmj`, userId: owner, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
}

/**
 * A restore of the account begins just before the first statement matching `at` (the restore marker is written, as
 * `begin` writes it). Returns how many statements had run when it began.
 */
function restoreBeginsAt(at: RegExp): () => number {
  const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).$client;
  let began = -1;
  beforeStatement = (sql) => {
    if (!at.test(sql)) return;
    beforeStatement = null;
    sqlite
      .prepare("INSERT INTO account_state (user_id, restore_id, restore_started_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(userId, "restore-1", NOW, NOW);
    began = statements.length;
  };
  return () => began;
}

/** The slot keys and the move each holds. */
const moves = (s: SessionResponse): Record<string, string> =>
  Object.fromEntries(s.build!.items.map((i) => [i.slotKey, i.exerciseId]));

describe("building today's session", () => {
  it("stores version 1 and returns it, with its view, payload and the row updated per spec", async () => {
    const id = await seedSlot(TODAY);
    const res = await buildSession(db, userId, id, { overrides: { mode: "consistent" } }, ctx());

    expect(res).toMatchObject({ workoutId: id, date: TODAY, contentState: "built", locked: false, checks: {} });
    const build = res.build!;
    expect(build).toMatchObject({ version: 1, date: TODAY, mode: "consistent", minutes: 30, builtAt: NOW, locationId: "home" });
    expect(build.engineVersion).toMatch(/\S/);
    expect(build.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(build.steps.length).toBeGreaterThan(0);
    // The payload carries everything the sheet and player render, offline: every move in the plan and in its
    // alternatives, with its how-to text.
    const offered = Object.values(build.alternatives).flat().map((a) => a.id);
    for (const exId of [...build.items.map((i) => i.exerciseId), ...offered]) {
      expect(build.exercises[exId], exId).toBeDefined();
      expect(build.exercises[exId]!.text.steps.length).toBeGreaterThan(0);
      expect(build.exercises[exId]).not.toHaveProperty("providers");
    }
    for (const step of build.steps) if (step.exerciseId) expect(build.exercises[step.exerciseId]).toBeDefined();
    const targeted = build.items.filter((i) => i.block === "core").map((i) => i.exerciseId);
    expect(targeted.length).toBeGreaterThan(0);
    for (const exId of targeted) expect(build.targets[exId]).toBeDefined();

    expect(res.view).toMatchObject({
      mode: "consistent",
      minutes: 30,
      location: { id: "home", name: "Home" },
      block: { number: 1, week: 1, weeks: 5, events: ["Block 1 started."] },
    });
    expect(res.view!.block!.core.map((c) => c.family)).toEqual(["squat", "hinge", "row", "press", "carry"]);
    expect(res.view!.theme).toEqual(build.theme ? { id: build.theme, name: expect.any(String) } : null);

    const stored = await buildsOf(id);
    expect(stored.map((b) => [b.version, b.lockedAt])).toEqual([[1, null]]);
    expect(stored[0]).toMatchObject({ id: build.buildId, userId, engineVersion: build.engineVersion, inputsHash: build.inputsHash, createdAt: NOW });

    // §9.2: a session holding a core lift is strength. Title "<program> · <theme>", length rounded up to 5 min.
    const row = await rowOf(id);
    const seconds = Math.ceil(build.plannedSeconds / 300) * 300;
    expect(row).toMatchObject({
      title: res.view!.theme ? `Mobility · ${res.view!.theme.name}` : "Mobility",
      category: "strength",
      sport: "strength",
      contentState: "built",
      calendarBlockDurationSeconds: seconds,
      fallbackEstimatedDurationSeconds: seconds,
      sessionParams: { checks: {}, overrides: { mode: "consistent" }, swaps: {} },
      updatedAt: NOW,
    });
    // The first build starts the program's first block.
    expect(await loadProgramState(db, programId)).toMatchObject({ id: build.blockRef, number: 1, startedAt: TODAY });
  });

  it("a session with no core lift is yoga (§9.2)", async () => {
    const id = await seedSlot(TODAY);
    const res = await buildSession(db, userId, id, { overrides: { mode: "recovery" } }, ctx());
    expect(res.build!.items.some((i) => i.block === "core")).toBe(false);
    expect(await rowOf(id)).toMatchObject({ category: "yoga", sport: "yoga" });
  });

  it("a mode outside the program's modes falls back to the nearest allowed one, with a plain reason (ruling 2a-R7)", async () => {
    const only = await seedProgram(userId, { modes: ["recovery", "consistent"] });
    const id = await seedSlot(TODAY, { program: only });
    const res = await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    expect(res.view!.mode).toBe("consistent");
    expect(res.build!.mode).toBe("consistent");
    expect(res.view!.modeReasons[0]).toBe("Your program doesn't include build sessions, so this is a consistent one.");
  });

  it("an allowed override is left alone", async () => {
    const only = await seedProgram(userId, { modes: ["recovery", "build"] });
    const id = await seedSlot(TODAY, { program: only });
    const res = await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    expect(res.view!.mode).toBe("build");
    expect(res.view!.modeReasons.some((r) => r.includes("doesn't include"))).toBe(false);
  });

  it("a tie goes to the lower mode", async () => {
    const only = await seedProgram(userId, { modes: ["recovery", "build"] });
    const id = await seedSlot(TODAY, { program: only });
    const res = await buildSession(db, userId, id, { overrides: { mode: "consistent" } }, ctx());
    expect(res.view!.mode).toBe("recovery");
    expect(res.view!.modeReasons[0]).toContain("consistent");
  });

  it("a proposal outside the program's modes falls back too, whatever the proposal was", async () => {
    // Find what a blank day proposes, then forbid it.
    const open = await seedProgram(userId);
    const probe = await buildSession(db, userId, await seedSlot(TODAY, { program: open }), {}, ctx());
    const proposed = probe.view!.proposedMode;
    const allowed = (["recovery", "consistent", "build"] as const).filter((m) => m !== proposed);
    const narrow = await seedProgram(userId, { modes: [...allowed] });
    const res = await buildSession(db, userId, await seedSlot(TODAY, { program: narrow }), {}, ctx());
    expect(allowed).toContain(res.view!.mode);
    expect(res.view!.proposedMode).toBe(res.view!.mode);
    expect(res.view!.modeReasons[0]).toContain(`doesn't include ${proposed} sessions`);
  });

  it("a care profile's recovery stands in a program without recovery: safety over preference (ruling 2a-R10)", async () => {
    await activateTmj();
    const noRecovery = await seedProgram(userId, { modes: ["consistent", "build"], careProfiles: ["tmj"] });
    const id = await seedSlot(TODAY, { program: noRecovery });
    const flare = await buildSession(db, userId, id, { checks: { tmj: { pre: 7, feelingOff: false } } }, ctx());
    expect(flare.view).toMatchObject({ mode: "recovery", proposedMode: "recovery" });
    expect(flare.view!.modeReasons.some((r) => r.includes("doesn't include"))).toBe(false);
    const off = await buildSession(db, userId, id, { checks: { tmj: { pre: null, feelingOff: true } } }, ctx({ now: LATER }));
    expect(off.view).toMatchObject({ mode: "recovery", proposedMode: "recovery" });
    // Asked for on such a day, recovery is not refused either.
    const asked = await buildSession(db, userId, id, { checks: { tmj: { pre: 7, feelingOff: false } }, overrides: { mode: "recovery" } }, ctx({ now: LATER }));
    expect(asked.view!.mode).toBe("recovery");
    // On a calm day the program's modes bind again.
    const calm = await buildSession(db, userId, id, { checks: { tmj: { pre: 1, feelingOff: false } }, overrides: { mode: "recovery" } }, ctx({ now: LATER }));
    expect(calm.view!.mode).toBe("consistent");
    expect(calm.view!.modeReasons[0]).toBe("Your program doesn't include recovery sessions, so this is a consistent one.");
  });

  it("the proposed mode is always one the program includes, also beside an allowed override (audit M7)", async () => {
    const open = await seedProgram(userId);
    const probe = await buildSession(db, userId, await seedSlot(TODAY, { program: open }), {}, ctx());
    const proposed = probe.view!.proposedMode;
    expect(proposed).not.toBe("recovery");
    const allowed = (["recovery", "consistent", "build"] as const).filter((m) => m !== proposed);
    const narrow = await seedProgram(userId, { modes: [...allowed] });
    const res = await buildSession(db, userId, await seedSlot(TODAY, { program: narrow }), { overrides: { mode: allowed[0] } }, ctx());
    expect(res.view!.mode).toBe(allowed[0]);
    expect(allowed).toContain(res.view!.proposedMode);
  });

  it("editing the program's modes rebuilds today's session within them (audit I1)", async () => {
    const id = await seedSlot(TODAY);
    const first = await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    expect(first.view!.mode).toBe("build");
    await db
      .update(programs)
      .set({ config: adaptiveConfigSchema.parse({ defaultMinutes: 30, modes: ["recovery", "consistent"] }) })
      .where(eq(programs.id, programId));
    const again = await buildSession(db, userId, id, {}, ctx({ now: LATER }));
    expect(again.build!.version).toBe(2);
    expect(again.view!.mode).toBe("consistent");
    expect(again.view!.modeReasons[0]).toBe("Your program doesn't include build sessions, so this is a consistent one.");
  });

  it("the build reads only the program settings the inputs hash covers (audit I1)", async () => {
    const context = await loadEngineContext(db, userId, programId, { prefs });
    const read = new Set<string>();
    const config = new Proxy(context.config, {
      get: (target, key, receiver) => {
        if (typeof key === "string") read.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    for (const overrides of [{}, { mode: "build" as const }]) {
      composeBuild({ date: TODAY, programId, context: { ...context, config }, block: null, history: [], checks: {}, overrides, swaps: {} });
    }
    expect(read.size).toBeGreaterThan(0);
    expect([...read].filter((k) => !(BUILD_CONFIG_KEYS as readonly string[]).includes(k))).toEqual([]);
  });

  it("an identical request returns the stored build — same version, nothing written", async () => {
    const id = await seedSlot(TODAY);
    const first = await buildSession(db, userId, id, {}, ctx());
    statements.length = 0;
    const again = await buildSession(db, userId, id, {}, ctx({ now: LATER }));
    expect(again.build).toEqual(first.build);
    expect(statements.filter(isWrite)).toEqual([]);
    expect((await buildsOf(id)).map((b) => b.version)).toEqual([1]);
  });

  it("says whether the row's calendar event has something new: its title, discipline or booked length (ruling 2a-R8)", async () => {
    const id = await seedSlot(TODAY);
    const first = await buildSessionOutcome(db, userId, id, {}, ctx());
    expect(first.calendarChanged).toBe(true);
    // A new version that keeps the theme, the discipline and the length (30 minutes is the default) changes nothing shown.
    const same = await buildSessionOutcome(db, userId, id, { overrides: { minutes: 30 } }, ctx({ now: LATER }));
    expect(same.session.build!.version).toBe(2);
    expect(same.calendarChanged).toBe(false);
    expect((await buildSessionOutcome(db, userId, id, {}, ctx({ now: LATER }))).calendarChanged).toBe(false);
    const shorter = await buildSessionOutcome(db, userId, id, { overrides: { minutes: 15 } }, ctx({ now: LATER }));
    expect(shorter.session.build!.version).toBe(3);
    expect(shorter.calendarChanged).toBe(true);
    const ahead = await seedSlot(addDays(TODAY, 1));
    expect((await buildSessionOutcome(db, userId, ahead, {}, ctx())).calendarChanged).toBe(false);
  });

  it("answers from the row and build it just wrote: nothing is read back after the writes (ruling 2a-R8)", async () => {
    const id = await seedSlot(TODAY);
    const afterLastWrite = () => statements.slice(statements.map(isWrite).lastIndexOf(true) + 1);
    for (const [req, now] of [[{}, NOW], [{ overrides: { minutes: 45 } }, LATER]] as const) {
      statements.length = 0;
      const built = await buildSession(db, userId, id, req, ctx({ now }));
      expect(afterLastWrite()).toEqual([]);
      expect(await loadSession(db, userId, id, TODAY)).toEqual(built);
    }
    const ahead = await seedSlot(addDays(TODAY, 1));
    for (const req of [{}, { overrides: { minutes: 20 } }]) {
      statements.length = 0;
      const preview = await buildSession(db, userId, ahead, req, ctx({ now: LATER }));
      expect(afterLastWrite()).toEqual([]);
      expect(await loadSession(db, userId, ahead, TODAY)).toEqual(preview);
    }
  });

  it("a slot moved away and back shows its stored build as built again: the cache hit restores the state (audit M1)", async () => {
    const id = await seedSlot(TODAY);
    const first = await buildSession(db, userId, id, {}, ctx());
    for (const toDate of [addDays(TODAY, 1), TODAY]) {
      await applyMove(db, { userId, workoutId: id, toDate, toTime: "18:00", source: "app", corosWritesEnabled: false });
    }
    // Moving reverted the row to an outline (ruling 2a-R7); its build for this date still stands.
    expect((await loadSession(db, userId, id, TODAY)).contentState).toBe("outline");
    const again = await buildSession(db, userId, id, {}, ctx({ now: LATER }));
    expect(again.build).toEqual(first.build);
    expect(again.contentState).toBe("built");
    expect((await rowOf(id)).contentState).toBe("built");
    expect((await loadSession(db, userId, id, TODAY)).contentState).toBe("built");
    expect((await buildsOf(id)).map((b) => b.version)).toEqual([1]);
  });

  it("a built slot moved to another day is an outline named by its program, not by the old build's theme (UI M13)", async () => {
    const id = await seedSlot(TODAY);
    const built = await buildSession(db, userId, id, { overrides: { mode: "build" } }, ctx());
    expect(built.view!.theme).not.toBeNull();
    expect((await rowOf(id)).title).toBe(`Mobility · ${built.view!.theme!.name}`);
    // Renamed since: the outline takes the program's name as it is now.
    await db.update(programs).set({ name: "Evening care" }).where(eq(programs.id, programId));
    await applyMove(db, { userId, workoutId: id, toDate: addDays(TODAY, 1), toTime: "18:00", source: "app", corosWritesEnabled: false });
    expect(await rowOf(id)).toMatchObject({ title: "Evening care", contentState: "outline", effectiveDate: addDays(TODAY, 1) });
  });

  it("moved away, refreshed as an outline by a placement pass, and back: the cache hit writes the build's title, discipline and length again (re-review R2)", async () => {
    const id = await seedSlot(TODAY);
    const first = await buildSessionOutcome(db, userId, id, { overrides: { mode: "build", minutes: 45 } }, ctx());
    const built = await rowOf(id);
    // A build with a core lift, longer than the outline: everything R2 is about differs from the outline.
    expect(built).toMatchObject({ category: "strength", sport: "strength", contentState: "built" });
    expect(built.title).toBe(first.session.view!.theme ? `Mobility · ${first.session.view!.theme.name}` : "Mobility");
    expect(built.calendarBlockDurationSeconds).toBeGreaterThan(1800);

    await applyMove(db, { userId, workoutId: id, toDate: addDays(TODAY, 1), toTime: "18:00", source: "app", corosWritesEnabled: false });
    // Any placement pass while it is away makes it the program's outline again (rule 5).
    await placeSlots(db, userId, programId, TODAY, prefs, NOW);
    expect(await rowOf(id)).toMatchObject({ title: "Mobility", category: "yoga", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, contentState: "outline" });
    await applyMove(db, { userId, workoutId: id, toDate: TODAY, toTime: "18:00", source: "app", corosWritesEnabled: false });

    // A run just clear of the outline's 30 minutes, and not of the build's own length.
    const clear = (at: string, seconds: number) =>
      !dayCollides(
        [
          { key: id, category: "strength", workoutSeconds: seconds, currentTime: "18:00", pinned: false },
          { key: "run", category: "easy", workoutSeconds: 1800, currentTime: at, pinned: false },
        ],
        prefs,
      );
    const runAt = ["18:30", "18:35", "18:40", "18:45", "18:50", "18:55", "19:00", "19:05", "19:10", "19:15", "19:20"].find((t) => clear(t, 1800))!;
    expect(clear(runAt, built.fallbackEstimatedDurationSeconds!)).toBe(false);
    await db.insert(plannedWorkouts).values({
      id: "run-after", userId, planId: "coros-plan", sourceWorkoutId: "src-run-after", title: "Easy run", category: "easy", sport: "run",
      originalPlanDate: TODAY, lastVerifiedCorosDate: TODAY, effectiveDate: TODAY, effectiveTime: runAt,
      sourceContentFingerprint: "fp", fallbackEstimatedDurationSeconds: 1800, calendarBlockDurationSeconds: 1800,
      completionState: "scheduled", createdAt: NOW, updatedAt: NOW,
    });

    const again = await buildSessionOutcome(db, userId, id, {}, ctx({ now: LATER }));
    // The stored build, unchanged (a cache hit, nothing rebuilt)…
    expect(again.session.build).toEqual(first.session.build);
    expect((await buildsOf(id)).map((b) => b.version)).toEqual([1]);
    // …and the row says what that build says, as a fresh build would have written it.
    expect(await rowOf(id)).toMatchObject({
      title: built.title,
      category: "strength",
      sport: "strength",
      calendarBlockDurationSeconds: built.calendarBlockDurationSeconds,
      fallbackEstimatedDurationSeconds: built.fallbackEstimatedDurationSeconds,
      contentState: "built",
      sessionParams: built.sessionParams,
    });
    expect(again.calendarChanged).toBe(true);
    // The longer session no longer overlaps the run: the collision pass ran over the day.
    const day = (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.effectiveDate, TODAY))).filter((r) => !r.archivedAt);
    expect(day).toHaveLength(2);
    expect(
      dayCollides(
        day.map((r) => ({ key: r.id, category: r.category, workoutSeconds: r.fallbackEstimatedDurationSeconds!, currentTime: r.effectiveTime, pinned: false })),
        prefs,
      ),
    ).toBe(false);
  });

  it("an override rebuilds as version 2, and only the latest unlocked version is kept", async () => {
    const id = await seedSlot(TODAY);
    await buildSession(db, userId, id, {}, ctx());
    const shorter = await buildSession(db, userId, id, { overrides: { minutes: 15 } }, ctx({ now: LATER }));
    expect(shorter.build).toMatchObject({ version: 2, minutes: 15 });
    expect(shorter.view!.minutes).toBe(15);
    expect(shorter.build!.plannedSeconds).toBeLessThanOrEqual(15 * 60);
    expect((await buildsOf(id)).map((b) => b.version)).toEqual([2]);
    expect(await rowOf(id)).toMatchObject({ calendarBlockDurationSeconds: 900, fallbackEstimatedDurationSeconds: 900 });
    // A request that leaves the overrides out keeps the day's choices.
    const same = await buildSession(db, userId, id, {}, ctx({ now: LATER }));
    expect(same.build!.version).toBe(2);
  });

  it("a swap applies: the slot holds the chosen alternative", async () => {
    const id = await seedSlot(TODAY);
    const first = await buildSession(db, userId, id, { overrides: { mode: "consistent" } }, ctx());
    const [slotKey, options] = Object.entries(first.build!.alternatives).find(([, alts]) => alts.length > 0)!;
    const from = moves(first)[slotKey]!;
    const to = options[0]!.id;
    const swapped = await buildSession(db, userId, id, { swaps: { [slotKey]: { from, to } } }, ctx({ now: LATER }));
    expect(swapped.build!.version).toBe(2);
    expect(moves(swapped)[slotKey]).toBe(to);
    expect(swapped.build!.steps.filter((s) => s.slotKey === slotKey && s.kind !== "rest").every((s) => s.exerciseId === to)).toBe(true);
    expect(swapped.build!.params).toEqual({ checks: {}, overrides: { mode: "consistent" }, swaps: { [slotKey]: { from, to } } });
    expect((await rowOf(id)).sessionParams).toMatchObject({ swaps: { [slotKey]: { from, to } } });
  });

  it("records the body's checks as pre checks for the slot and day, replacing them on a re-check", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    const first = await buildSession(db, userId, id, { checks: { tmj: { pre: 6, feelingOff: false } } }, ctx());
    // A jaw at 6 is a recovery day (the profile's own rule).
    expect(first.build!.mode).toBe("recovery");
    expect(first.checks).toEqual({ tmj: { pre: 6, feelingOff: false } });
    const again = await buildSession(db, userId, id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx({ now: LATER }));
    expect(again.checks).toEqual({ tmj: { pre: 1, feelingOff: false } });
    const rows = await db.select().from(conditionChecks).where(eq(conditionChecks.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ profileId: "tmj", kind: "pre", value: 1, feelingOff: false, localDate: TODAY, workoutId: id, performedSessionId: null, at: LATER });
    expect((await rowOf(id)).sessionParams).toMatchObject({ checks: { tmj: { pre: 1, feelingOff: false } } });
  });

  it("uses today's daily check as the pre-check when the request has none", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    await recordCheck(db, userId, { profileId: "tmj", value: 7, feelingOff: false }, ctx());
    const res = await buildSession(db, userId, id, {}, ctx());
    expect(res.checks).toEqual({ tmj: { pre: 7, feelingOff: false } });
    expect(res.build!.mode).toBe("recovery");
    expect(res.view!.modeReasons.join(" ")).toMatch(/7/);
    // A pre-check of its own wins over the daily one.
    const own = await buildSession(db, userId, id, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx({ now: LATER }));
    expect(own.checks).toEqual({ tmj: { pre: 2, feelingOff: false } });
  });

  it("the chip and the pre-check are one reading: whichever was given last builds the session (ruling 2a-R13)", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    const pre = await buildSessionOutcome(db, userId, id, { checks: { tmj: { pre: 3, feelingOff: false } } }, ctx());
    expect(pre.session.checks).toEqual({ tmj: { pre: 3, feelingOff: false } });
    expect(pre.session.build!.mode).not.toBe("recovery");

    // Later, on the Today chip: feeling off. The slot's reading is now that one, on GET and on the next build.
    await recordCheck(db, userId, { profileId: "tmj", value: null, feelingOff: true }, ctx({ now: LATER }));
    expect((await loadSession(db, userId, id, TODAY)).checks).toEqual({ tmj: { pre: null, feelingOff: true } });
    const off = await buildSessionOutcome(db, userId, id, {}, ctx({ now: LATER }));
    expect(off.session.checks).toEqual({ tmj: { pre: null, feelingOff: true } });
    expect(off.session.build!.inputsHash).not.toBe(pre.session.build!.inputsHash);
    expect(off.session.build).toMatchObject({ version: 2, mode: "recovery", params: { checks: { tmj: { pre: null, feelingOff: true } } } });

    // The pre-check given again, the same as before, after the chip's: it is the latest reading once more.
    const AFTER = "2026-10-07T19:10:00.000Z";
    const again = await buildSessionOutcome(db, userId, id, { checks: { tmj: { pre: 3, feelingOff: false } } }, ctx({ now: AFTER }));
    expect(again.session.checks).toEqual({ tmj: { pre: 3, feelingOff: false } });
    expect((await loadSession(db, userId, id, TODAY)).checks).toEqual({ tmj: { pre: 3, feelingOff: false } });
    expect((await buildSessionOutcome(db, userId, id, {}, ctx({ now: AFTER }))).session.build!.buildId).toBe(again.session.build!.buildId);
  });

  it("a pre-check with no number and no \"feeling off\" is no answer: the day's check stands (audit I2)", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    const ownPre = () => db.select().from(conditionChecks).where(and(eq(conditionChecks.userId, userId), eq(conditionChecks.kind, "pre")));
    await recordCheck(db, userId, { profileId: "tmj", value: 7, feelingOff: false }, ctx());
    const unanswered = { tmj: { pre: null, feelingOff: false } };
    const res = await buildSession(db, userId, id, { checks: unanswered }, ctx());
    expect(res.checks).toEqual({ tmj: { pre: 7, feelingOff: false } });
    expect(res.build!.params.checks).toEqual({ tmj: { pre: 7, feelingOff: false } });
    expect(res.build!.mode).toBe("recovery");
    expect(await ownPre()).toEqual([]);
    expect((await loadSession(db, userId, id, TODAY)).checks).toEqual({ tmj: { pre: 7, feelingOff: false } });

    // Answered, then un-answered: the slot's own pre-check goes, and the day's check stands again.
    const answered = await buildSession(db, userId, id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx({ now: LATER }));
    expect(answered.checks).toEqual({ tmj: { pre: 1, feelingOff: false } });
    expect(await ownPre()).toHaveLength(1);
    const cleared = await buildSession(db, userId, id, { checks: unanswered }, ctx({ now: LATER }));
    expect(cleared.checks).toEqual({ tmj: { pre: 7, feelingOff: false } });
    expect(await ownPre()).toEqual([]);

    // "Feeling off" with no number is an answer.
    const off = await buildSession(db, userId, id, { checks: { tmj: { pre: null, feelingOff: true } } }, ctx({ now: LATER }));
    expect(off.checks).toEqual({ tmj: { pre: null, feelingOff: true } });
    expect(await ownPre()).toHaveLength(1);
  });

  it("an own pre-check row that carries no answer falls back to the day's check; with none, the profile is unanswered (audit I2)", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    // A row as the build wrote it before the rule: no number, not feeling off.
    await db.insert(conditionChecks).values({
      id: newId(), userId, profileId: "tmj", kind: "pre", value: null, feelingOff: false, localDate: TODAY, at: NOW,
      performedSessionId: null, workoutId: id,
    });
    expect((await loadSession(db, userId, id, TODAY)).checks).toEqual({});
    await recordCheck(db, userId, { profileId: "tmj", value: 7, feelingOff: false }, ctx());
    expect((await loadSession(db, userId, id, TODAY)).checks).toEqual({ tmj: { pre: 7, feelingOff: false } });
    expect((await buildSession(db, userId, id, {}, ctx())).build!.mode).toBe("recovery");
  });

  it("refuses a check for a profile that is not active", async () => {
    const id = await seedSlot(TODAY);
    await expect(buildSession(db, userId, id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx())).rejects.toThrow(
      "unknown_profile",
    );
    expect(await buildsOf(id)).toEqual([]);
  });

  it("a block rotation is persisted to program_blocks, and the rebuild after it reuses the build", async () => {
    // Block 1, a week in, whose squat left the library: the build rotates it (the engine's own rule).
    const blockRef = await saveProgramState(
      db,
      programId,
      {
        id: "b1",
        number: 1,
        startedAt: addDays(TODAY, -7),
        weeks: 5,
        core: { squat: "retiredSquat", hinge: "rdl", row: null, press: null, carry: null },
        rotations: [],
      },
      NOW,
    );
    const id = await seedSlot(TODAY);
    const res = await buildSession(db, userId, id, { overrides: { mode: "consistent" } }, ctx());
    expect(res.view!.block).toMatchObject({ number: 1, week: 2 });
    expect(res.view!.block!.events).toEqual([expect.stringMatching(/^retiredSquat → .+: no longer in the library\.$/)]);
    expect(res.build!.blockRef).toBe(blockRef);

    const [stored] = await db.select().from(programBlocks).where(eq(programBlocks.programId, programId));
    const intent = stored!.intent as { core: Record<string, string | null>; rotations: Array<Record<string, unknown>> };
    expect(intent.core.squat).not.toBe("retiredSquat");
    expect(intent.rotations).toEqual([
      { family: "squat", from: "retiredSquat", to: intent.core.squat, date: TODAY, why: "no longer in the library" },
    ]);

    statements.length = 0;
    const again = await buildSession(db, userId, id, { overrides: { mode: "consistent" } }, ctx({ now: LATER }));
    expect(again.build!.version).toBe(1);
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("builds over a history whose moves left the library", async () => {
    const sid = newId();
    await db.insert(performedSessions).values({
      id: sid, userId, workoutId: null, activityId: null, buildId: null, source: "import", sourceRef: "old-1",
      localDate: addDays(TODAY, -2), startedAt: null, endedAt: null, seconds: 1200, plannedSeconds: null, minutes: 20,
      mode: "consistent", theme: null, locationId: null, blockRef: null, blockNumber: null, completed: true,
      stepsTotal: null, stepsDone: null, movesDone: [{ exerciseId: "retiredMove", seconds: 60 }], note: null,
      newMove: null, payloadHash: "h", createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(performedSets).values({
      id: newId(), performedSessionId: sid, entryIndex: 0, exerciseId: "retiredMove", implement: null, format: "straight",
      perSide: false, setIndex: 0, side: null, reps: 8, seconds: null, loadValue: 20, loadUnit: "lb", loadKg: null, done: true, flags: [],
    });
    const id = await seedSlot(TODAY);
    const res = await buildSession(db, userId, id, {}, ctx());
    expect(res.build!.steps.length).toBeGreaterThan(0);
    expect(res.build!.exercises).not.toHaveProperty("retiredMove");
  });

  it("never offers a 👎-rated move as an alternative (ruling 2a-R1), nor one marked not for me", async () => {
    const id = await seedSlot(TODAY);
    const first = await buildSession(db, userId, id, { overrides: { mode: "consistent" } }, ctx());
    const offered = [...new Set(Object.values(first.build!.alternatives).flat().map((a) => a.id))];
    expect(offered.length).toBeGreaterThan(1);
    const [disliked, excluded] = offered;
    await db.insert(exercisePrefs).values([
      { id: `${userId}:${disliked}`, userId, exerciseId: disliked!, rating: -1, excluded: false, pinned: false, introducedOn: null, updatedAt: NOW },
      { id: `${userId}:${excluded}`, userId, exerciseId: excluded!, rating: null, excluded: true, pinned: false, introducedOn: null, updatedAt: NOW },
    ]);
    const read = await loadSession(db, userId, id, TODAY);
    const now = Object.values(read.build!.alternatives).flat().map((a) => a.id);
    expect(now).not.toContain(disliked);
    expect(now).not.toContain(excluded);
    // The stored build is unchanged: the filter is the response's.
    const [stored] = await buildsOf(id);
    expect(JSON.stringify(stored!.payload)).toContain(`"${disliked}"`);
  });

  it("another user's workout, a non-program row, an archived slot → not found", async () => {
    const { userId: other } = await makeTestUser(db);
    const theirProgram = await seedProgram(other);
    const theirs = await seedSlot(TODAY, { owner: other, program: theirProgram });
    await expect(buildSession(db, userId, theirs, {}, ctx())).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(loadSession(db, userId, theirs, TODAY)).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(startSession(db, userId, theirs, "any", NOW)).rejects.toBeInstanceOf(SessionNotFoundError);

    const coros = await seedSlot(addDays(TODAY, 1), { origin: null });
    await expect(buildSession(db, userId, coros, {}, ctx())).rejects.toBeInstanceOf(SessionNotFoundError);
    const archived = await seedSlot(addDays(TODAY, 2));
    await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "user_removed" }).where(eq(plannedWorkouts.id, archived));
    await expect(buildSession(db, userId, archived, {}, ctx())).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(await db.select().from(sessionBuilds)).toEqual([]);
  });

  it("a restore that begins while a build runs: nothing is written after it began (audit M10)", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    const began = restoreBeginsAt(/^\s*WITH e AS/);
    const res = await buildSession(db, userId, id, { checks: { tmj: { pre: 3, feelingOff: false } } }, ctx());
    expect(beforeStatement).toBeNull();
    expect(statements.slice(began()).filter(isWrite)).toEqual([]);
    expect(res.build).toBeNull();
    expect(await buildsOf(id)).toEqual([]);
    expect(await db.select().from(conditionChecks)).toEqual([]);
    expect(await db.select().from(programBlocks)).toEqual([]);
    expect((await rowOf(id)).contentState).toBe("outline");
  });

  it("the stored build, with an answer to record: recorded, unless a restore began meanwhile (audit M10)", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    await recordCheck(db, userId, { profileId: "tmj", value: 7, feelingOff: false }, ctx());
    const first = await buildSession(db, userId, id, {}, ctx());
    // The day's check given again as the slot's own: the build is the stored one, the answer is the slot's.
    const ownPre = () => db.select().from(conditionChecks).where(and(eq(conditionChecks.userId, userId), eq(conditionChecks.kind, "pre")));
    const began = restoreBeginsAt(/^\s*WITH e AS/);
    const during = await buildSession(db, userId, id, { checks: { tmj: { pre: 7, feelingOff: false } } }, ctx({ now: LATER }));
    expect(statements.slice(began()).filter(isWrite)).toEqual([]);
    expect(during.build).toEqual(first.build);
    expect(await ownPre()).toEqual([]);
    await db.delete(accountState);
    const after = await buildSession(db, userId, id, { checks: { tmj: { pre: 7, feelingOff: false } } }, ctx({ now: LATER }));
    expect(after.build).toEqual(first.build);
    expect(await ownPre()).toHaveLength(1);
  });

  it("writes nothing while a restore is replacing the account", async () => {
    const id = await seedSlot(TODAY);
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });
    statements.length = 0;
    const res = await buildSession(db, userId, id, { overrides: { mode: "recovery" } }, ctx());
    expect(res.build).toBeNull();
    expect(statements.filter(isWrite)).toEqual([]);
    await expect(recordCheck(db, userId, { profileId: "tmj", value: 1, feelingOff: false }, ctx())).resolves.toBeNull();
    expect(statements.filter(isWrite)).toEqual([]);
  });
});

describe("a day ahead, a day gone (Review Focus 2)", () => {
  it("a future slot builds a preview: version 0, the row untouched, overwritten by the next preview, never lockable", async () => {
    const tomorrow = addDays(TODAY, 1);
    const id = await seedSlot(tomorrow);
    const preview = await buildSession(db, userId, id, {}, ctx());
    expect(preview).toMatchObject({ date: tomorrow, contentState: "outline", locked: false });
    expect(preview.build).toMatchObject({ version: 0, date: tomorrow });
    expect(await rowOf(id)).toMatchObject({ contentState: "outline", title: "Mobility", sessionParams: null, updatedAt: NOW });
    // A preview never starts or rotates the program's blocks.
    expect(await db.select().from(programBlocks)).toEqual([]);

    const again = await buildSession(db, userId, id, { overrides: { minutes: 20 } }, ctx({ now: LATER }));
    expect(again.build).toMatchObject({ version: 0, minutes: 20 });
    expect((await buildsOf(id)).map((b) => b.version)).toEqual([0]);
    expect((await loadSession(db, userId, id, TODAY)).build).toEqual(again.build);

    await expect(startSession(db, userId, id, again.build!.buildId, NOW)).rejects.toBeInstanceOf(NotTodayError);
    expect((await buildsOf(id))[0]!.lockedAt).toBeNull();
  });

  it("a preview's unanswered check is no answer either (audit I2)", async () => {
    await activateTmj();
    const id = await seedSlot(addDays(TODAY, 1));
    const preview = await buildSession(db, userId, id, { checks: { tmj: { pre: null, feelingOff: false } } }, ctx());
    expect(preview.build!.params.checks).toEqual({});
    const plain = await buildSession(db, userId, id, {}, ctx({ now: LATER }));
    expect(plain.build!.inputsHash).toBe(preview.build!.inputsHash);
  });

  it("a past slot is not today: 409 not_today, nothing built", async () => {
    const id = await seedSlot(addDays(TODAY, -1));
    await expect(buildSession(db, userId, id, {}, ctx())).rejects.toBeInstanceOf(NotTodayError);
    expect(await buildsOf(id)).toEqual([]);
  });
});

describe("Start (Review Focus 3)", () => {
  it("locks the latest build; idempotent; any build after it is 409 locked with the locked build unchanged", async () => {
    const id = await seedSlot(TODAY);
    await buildSession(db, userId, id, {}, ctx());
    const built = await buildSession(db, userId, id, { overrides: { minutes: 20 } }, ctx());
    const started = await startSession(db, userId, id, built.build!.buildId, LATER);
    expect(started).toMatchObject({ contentState: "started", locked: true });
    expect(started.build).toEqual(built.build);
    const stored = await buildsOf(id);
    expect(stored.map((b) => [b.version, b.lockedAt])).toEqual([[2, LATER]]);
    expect(await rowOf(id)).toMatchObject({ contentState: "started", updatedAt: LATER });

    // Whatever build id a second Start names, the started slot comes back as it is.
    expect(await startSession(db, userId, id, "another", "2026-10-07T20:00:00.000Z")).toEqual(started);
    expect((await buildsOf(id))[0]!.lockedAt).toBe(LATER);

    statements.length = 0;
    for (const req of [{}, { overrides: { minutes: 45 } }, { swaps: { "core:0": { from: "a", to: "b" } } }]) {
      const err = await buildSession(db, userId, id, req, ctx()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionLockedError);
      expect((err as SessionLockedError).session.build).toEqual(built.build);
    }
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("a check recorded after the build: Start refuses with the fresh build and locks nothing (audit I3)", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    const before = await buildSession(db, userId, id, {}, ctx());
    expect(before.build!.mode).not.toBe("recovery");
    await recordCheck(db, userId, { profileId: "tmj", value: 8, feelingOff: false }, ctx({ now: LATER }));

    const err = await startSession(db, userId, id, before.build!.buildId, LATER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleBuildError);
    const fresh = (err as StaleBuildError).session;
    expect(fresh).toMatchObject({ contentState: "built", locked: false, checks: { tmj: { pre: 8, feelingOff: false } } });
    expect(fresh.build).toMatchObject({ version: 2, mode: "recovery", params: { checks: { tmj: { pre: 8, feelingOff: false } } } });
    expect((await buildsOf(id)).map((b) => [b.version, b.lockedAt])).toEqual([[2, null]]);
    expect((await rowOf(id)).contentState).toBe("built");

    // Started from the build it was shown, it locks that build.
    const started = await startSession(db, userId, id, fresh.build!.buildId, LATER);
    expect(started).toMatchObject({ contentState: "started", locked: true });
    expect(started.build).toEqual(fresh.build);
  });

  it("an input changed since the build (a rating) makes it stale too; the same inputs lock (audit I3)", async () => {
    const id = await seedSlot(TODAY);
    const built = await buildSession(db, userId, id, {}, ctx());
    const offered = Object.values(built.build!.alternatives).flat()[0]!.id;
    await db.insert(exercisePrefs).values({ id: `${userId}:${offered}`, userId, exerciseId: offered, rating: 1, excluded: false, pinned: false, introducedOn: null, updatedAt: NOW });
    const err = await startSession(db, userId, id, built.build!.buildId, LATER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleBuildError);
    const fresh = (err as StaleBuildError).session;
    expect(fresh.build!.version).toBe(2);
    expect(fresh.build!.inputsHash).not.toBe(built.build!.inputsHash);
    expect((await startSession(db, userId, id, fresh.build!.buildId, LATER)).locked).toBe(true);
  });

  it("a build id that is no longer the day's: Start refuses with the current build, writing nothing (audit I3)", async () => {
    const id = await seedSlot(TODAY);
    const v1 = await buildSession(db, userId, id, {}, ctx());
    const v2 = await buildSession(db, userId, id, { overrides: { minutes: 20 } }, ctx({ now: LATER }));
    statements.length = 0;
    const err = await startSession(db, userId, id, v1.build!.buildId, LATER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleBuildError);
    expect((err as StaleBuildError).session.build).toEqual(v2.build);
    expect(statements.filter(isWrite)).toEqual([]);
    expect((await buildsOf(id)).map((b) => [b.version, b.lockedAt])).toEqual([[2, null]]);
  });

  /**
   * A concurrent Start, landed just before the first statement matching `at`: its lock of the shown build, and — when
   * it has finished — the slot marked started.
   */
  function startLandsAt(at: RegExp, workoutId: string, buildId: string, finished: boolean): void {
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).$client;
    beforeStatement = (sql) => {
      if (!at.test(sql)) return;
      beforeStatement = null;
      sqlite.prepare("UPDATE session_builds SET locked_at = ? WHERE id = ?").run(LATER, buildId);
      if (finished) sqlite.prepare("UPDATE planned_workouts SET content_state = 'started', updated_at = ? WHERE id = ?").run(LATER, workoutId);
    };
  }

  for (const [moment, at, finished] of [
    ["has locked the build as the build stores its version", /^insert into "session_builds"/i, false],
    ["has finished as the build updates the row", /^update "planned_workouts"/i, true],
    // Locked after the build's race read, not yet marked started: the row update itself must see the lock (re-review R3).
    ["has locked the build as the build updates the row", /^update "planned_workouts"/i, false],
  ] as const) {
    it(`a Start that ${moment} wins: the build is refused with the locked session and leaves nothing behind (audit M2)`, async () => {
      const id = await seedSlot(TODAY);
      const v1 = await buildSession(db, userId, id, {}, ctx());
      const shown = await rowOf(id);
      startLandsAt(at, id, v1.build!.buildId, finished);
      const err = await buildSession(db, userId, id, { overrides: { minutes: 20 } }, ctx({ now: LATER })).catch((e: unknown) => e);
      expect(beforeStatement).toBeNull();
      expect(err).toBeInstanceOf(SessionLockedError);
      const session = (err as SessionLockedError).session;
      expect(session.locked).toBe(true);
      expect(session.build).toEqual(v1.build);
      expect((await buildsOf(id)).map((b) => [b.version, b.lockedAt])).toEqual([[1, LATER]]);
      // The row still describes the locked build, not the refused one.
      expect(await rowOf(id)).toMatchObject({
        contentState: finished ? "started" : "built",
        title: shown.title,
        calendarBlockDurationSeconds: shown.calendarBlockDurationSeconds,
        sessionParams: shown.sessionParams,
      });
    });
  }

  it("a restore that begins while Start checks the build: nothing is locked (audit M10)", async () => {
    const id = await seedSlot(TODAY);
    const built = await buildSession(db, userId, id, {}, ctx());
    const began = restoreBeginsAt(/^\s*WITH e AS/);
    const res = await startSession(db, userId, id, built.build!.buildId, LATER);
    expect(beforeStatement).toBeNull();
    expect(statements.slice(began()).filter(isWrite)).toEqual([]);
    expect(res.locked).toBe(false);
    expect((await buildsOf(id)).map((b) => b.lockedAt)).toEqual([null]);
    expect((await rowOf(id)).contentState).toBe("built");
  });

  it("start with nothing built today is 409 not_built", async () => {
    const id = await seedSlot(TODAY);
    await expect(startSession(db, userId, id, "none", NOW)).rejects.toBeInstanceOf(NotBuiltError);
  });

  it("GET reads the slot: no build yet, then the built one, the day's checks and the lock", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    expect(await loadSession(db, userId, id, TODAY)).toEqual({
      workoutId: id,
      date: TODAY,
      contentState: "outline",
      locked: false,
      checks: {},
      build: null,
      view: null,
      profiles: [expect.objectContaining({ profileId: "tmj" })],
      choices: expect.objectContaining({ modes: ["recovery", "consistent", "build"] }),
    });
    await recordCheck(db, userId, { profileId: "tmj", value: 3, feelingOff: true }, ctx());
    const built = await buildSession(db, userId, id, {}, ctx());
    const read = await loadSession(db, userId, id, TODAY);
    expect(read).toEqual(built);
    expect(read.checks).toEqual({ tmj: { pre: 3, feelingOff: true } });
  });
});

/**
 * What the session sheet labels and picks from (Phase 2a Task 7): the switched-on profiles in their own words, and
 * the choices its chips offer — the program's modes, the themes a build can take, the account's places.
 */
describe("the sheet's profiles and choices", () => {
  it("an outline: the switched-on profiles with their check and care labels; no profile, none", async () => {
    const id = await seedSlot(TODAY);
    expect((await loadSession(db, userId, id, TODAY)).profiles).toEqual([]);
    await activateTmj();
    expect((await loadSession(db, userId, id, TODAY)).profiles).toEqual([
      { profileId: "tmj", check: { label: "Jaw / head", min: 0, max: 10 }, care: "Jaw care" },
    ]);
  });

  it("the program's modes; the themes, each with the modes it suits, a cared-for profile's only when cared for", async () => {
    await activateTmj();
    const plain = await loadSession(db, userId, await seedSlot(TODAY), TODAY);
    expect(plain.choices.modes).toEqual(["recovery", "consistent", "build"]);
    expect(plain.choices.themes.length).toBeGreaterThan(1);
    for (const t of plain.choices.themes) {
      expect(t).toEqual({ id: expect.any(String), name: expect.any(String), modes: expect.any(Array) });
      expect(t.modes.length).toBeGreaterThan(0);
    }
    const caring = await seedProgram(userId, { careProfiles: ["tmj"], modes: ["consistent", "build"] });
    const cared = await loadSession(db, userId, await seedSlot(TODAY, { program: caring }), TODAY);
    expect(cared.choices.modes).toEqual(["consistent", "build"]);
    expect(cared.choices.themes.length).toBeGreaterThan(plain.choices.themes.length);
  });

  it("the places: the library's Home with none set up; the default place first otherwise", async () => {
    const id = await seedSlot(TODAY);
    expect((await loadSession(db, userId, id, TODAY)).choices.locations).toEqual([{ id: "home", name: "Home" }]);
    await db.insert(schema.locations).values([
      { id: "l-gym", userId, name: "Gym", equipment: ["mat"], implements: {}, isDefault: false, createdAt: NOW, updatedAt: NOW },
      { id: "l-home", userId, name: "Flat", equipment: ["mat"], implements: {}, isDefault: true, createdAt: LATER, updatedAt: NOW },
    ]);
    expect((await loadSession(db, userId, id, TODAY)).choices.locations).toEqual([
      { id: "l-home", name: "Flat" },
      { id: "l-gym", name: "Gym" },
    ]);
  });

  it("a build stores the Today card's line of moves with its view, made from the build itself", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    await buildSession(db, userId, id, {}, ctx());
    const [stored] = await db.select().from(schema.sessionBuilds).where(eq(schema.sessionBuilds.workoutId, id));
    const payload = stored!.payload as { build: Parameters<typeof sessionLead>[0]; view: { lead: unknown } };
    expect(payload.view.lead).toEqual(sessionLead(payload.build));
    expect((payload.view.lead as { moves: unknown[] }).moves.length).toBeGreaterThan(0);
  });

  it("a build, the stored build returned unchanged and a locked session carry the same", async () => {
    await activateTmj();
    const id = await seedSlot(TODAY);
    const read = await loadSession(db, userId, id, TODAY);
    const built = await buildSession(db, userId, id, {}, ctx());
    const again = await buildSession(db, userId, id, {}, ctx({ now: LATER }));
    expect(built.profiles).toEqual(read.profiles);
    expect(built.choices).toEqual(read.choices);
    expect(again.choices).toEqual(read.choices);
    const started = await startSession(db, userId, id, again.build!.buildId, LATER);
    expect(started.choices).toEqual(read.choices);
  });
});

describe("the daily check", () => {
  it("one per profile per day, replaced on a re-check", async () => {
    await activateTmj();
    expect(await recordCheck(db, userId, { profileId: "tmj", value: 4, feelingOff: false }, ctx())).toEqual({
      profileId: "tmj",
      date: TODAY,
      value: 4,
      feelingOff: false,
    });
    await recordCheck(db, userId, { profileId: "tmj", value: 2, feelingOff: false }, ctx({ now: LATER }));
    await recordCheck(db, userId, { profileId: "tmj", value: 5, feelingOff: false }, ctx({ today: addDays(TODAY, 1), now: LATER }));
    const rows = await db.select().from(conditionChecks).where(and(eq(conditionChecks.userId, userId), eq(conditionChecks.kind, "daily")));
    expect(rows.map((r) => [r.localDate, r.value]).sort()).toEqual([
      [TODAY, 2],
      [addDays(TODAY, 1), 5],
    ]);
  });

  it("refuses a profile that is not active", async () => {
    await expect(recordCheck(db, userId, { profileId: "tmj", value: 4, feelingOff: false }, ctx())).rejects.toThrow("unknown_profile");
  });
});

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  } as Env;
}

describe("the routes", () => {
  let cookie: string;
  let today: string;
  beforeEach(async () => {
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    today = todayInZone(prefs.timezone);
  });

  const call = (method: string, path: string, body?: unknown, as: string = cookie) => {
    const app = path.startsWith("/api/conditions")
      ? mountRoutes(db, "/api/conditions", conditionRoutes)
      : mountRoutes(db, "/api/sessions", sessionRoutes);
    return app.request(
      path,
      {
        method,
        headers: { Cookie: as, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      makeEnv(),
    );
  };

  it("GET, build, start: 200 with the session; a build after Start is 409 locked with the locked build", async () => {
    const id = await seedSlot(today);
    const got = await call("GET", `/api/sessions/${id}`);
    expect(got.status).toBe(200);
    expect(((await got.json()) as SessionResponse).build).toBeNull();

    const built = await call("POST", `/api/sessions/${id}/build`, { overrides: { mode: "recovery" } });
    expect(built.status).toBe(200);
    const session = (await built.json()) as SessionResponse;
    expect(session.build).toMatchObject({ version: 1, mode: "recovery" });

    const started = await call("POST", `/api/sessions/${id}/start`, { buildId: session.build!.buildId });
    expect(started.status).toBe(200);
    expect(((await started.json()) as SessionResponse).locked).toBe(true);

    const after = await call("POST", `/api/sessions/${id}/build`, { overrides: { minutes: 45 } });
    expect(after.status).toBe(409);
    const body = (await after.json()) as { error: string; session: SessionResponse };
    expect(body.error).toBe("locked");
    expect(body.session.build).toEqual(session.build);
  });

  it("Start names the build it was shown: 409 stale with the fresh session when the day's inputs moved on; 422 without one (audit I3)", async () => {
    await activateTmj();
    const id = await seedSlot(today);
    const built = (await (await call("POST", `/api/sessions/${id}/build`, {})).json()) as SessionResponse;
    for (const body of [undefined, {}, { buildId: "" }, { buildId: built.build!.buildId, extra: 1 }]) {
      const r = await call("POST", `/api/sessions/${id}/start`, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(((await r.json()) as { error: string }).error).toBe("invalid_start");
    }
    expect((await call("POST", "/api/conditions/checks", { profileId: "tmj", value: 8, feelingOff: false })).status).toBe(200);
    const stale = await call("POST", `/api/sessions/${id}/start`, { buildId: built.build!.buildId });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: string; session: SessionResponse };
    expect(body.error).toBe("stale");
    expect(body.session).toMatchObject({ locked: false, checks: { tmj: { pre: 8, feelingOff: false } } });
    expect(body.session.build).toMatchObject({ version: 2, mode: "recovery" });
    const started = await call("POST", `/api/sessions/${id}/start`, { buildId: body.session.build!.buildId });
    expect(started.status).toBe(200);
    expect(((await started.json()) as SessionResponse).locked).toBe(true);
  });

  it("the build route syncs the calendar only when the row's title, discipline or booked length changed (ruling 2a-R8)", async () => {
    const id = await seedSlot(today);
    calendar.syncs = 0;
    expect((await call("POST", `/api/sessions/${id}/build`, {})).status).toBe(200);
    expect(calendar.syncs).toBe(1);
    // A new version with the same theme, discipline and length; then the stored build again.
    expect((await call("POST", `/api/sessions/${id}/build`, { overrides: { minutes: 30 } })).status).toBe(200);
    expect((await call("POST", `/api/sessions/${id}/build`, {})).status).toBe(200);
    expect(calendar.syncs).toBe(1);
    expect((await call("POST", `/api/sessions/${id}/build`, { overrides: { minutes: 15 } })).status).toBe(200);
    expect(calendar.syncs).toBe(2);
  });

  it("a body with no JSON builds with nothing changed", async () => {
    const id = await seedSlot(today);
    const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(
      `/api/sessions/${id}/build`,
      { method: "POST", headers: { Cookie: cookie } },
      makeEnv(),
    );
    expect(res.status).toBe(200);
  });

  it("409 not_today for a past slot; Start on a preview is 409 not_today; 404 for another user's slot", async () => {
    const past = await seedSlot(addDays(today, -1));
    const res = await call("POST", `/api/sessions/${past}/build`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_today", date: addDays(today, -1), today });

    const ahead = await seedSlot(addDays(today, 1));
    expect((await call("POST", `/api/sessions/${ahead}/build`, {})).status).toBe(200);
    const start = await call("POST", `/api/sessions/${ahead}/start`, { buildId: "any" });
    expect(start.status).toBe(409);
    expect(((await start.json()) as { error: string }).error).toBe("not_today");

    const { userId: other } = await makeTestUser(db);
    const theirs = await seedSlot(today, { owner: other, program: await seedProgram(other) });
    for (const [method, path] of [
      ["GET", `/api/sessions/${theirs}`],
      ["POST", `/api/sessions/${theirs}/build`],
      ["POST", `/api/sessions/${theirs}/start`],
    ] as const) {
      const r = await call(method, path, method === "POST" ? (path.endsWith("/start") ? { buildId: "any" } : {}) : undefined);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  it("422 for an invalid body, and for a check on a profile that is not active", async () => {
    const id = await seedSlot(today);
    for (const body of [
      { overrides: { mode: "sprint" } },
      { overrides: { minutes: 5 } },
      { checks: { tmj: { pre: 11, feelingOff: false } } },
      { surprise: true },
    ]) {
      const r = await call("POST", `/api/sessions/${id}/build`, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(((await r.json()) as { error: string }).error).toBe("invalid_build");
    }
    const r = await call("POST", `/api/sessions/${id}/build`, { checks: { tmj: { pre: 1, feelingOff: false } } });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toBe("unknown_profile");
  });

  it("POST /api/conditions/checks records the day's check; 422 for an unknown or inactive profile", async () => {
    await activateTmj();
    const ok = await call("POST", "/api/conditions/checks", { profileId: "tmj", value: 2, feelingOff: false });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ check: { profileId: "tmj", date: today, value: 2, feelingOff: false } });
    const bad = await call("POST", "/api/conditions/checks", { profileId: "knee", value: 2 });
    expect(bad.status).toBe(422);
    const junk = await call("POST", "/api/conditions/checks", { profileId: "tmj", value: 12 });
    expect(junk.status).toBe(422);
  });

  it("a restore in progress refuses the writes (423)", async () => {
    const id = await seedSlot(today);
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    expect((await call("POST", `/api/sessions/${id}/build`, {})).status).toBe(423);
    expect((await call("POST", `/api/sessions/${id}/start`, { buildId: "any" })).status).toBe(423);
    expect((await call("POST", "/api/conditions/checks", { profileId: "tmj", value: 1 })).status).toBe(423);
    expect((await call("GET", `/api/sessions/${id}`)).status).toBe(200);
  });
});
