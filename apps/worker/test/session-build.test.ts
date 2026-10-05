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
  todayInZone,
  type AdaptiveConfig,
  type UserPreferences,
} from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import {
  buildSession,
  loadSession,
  NotBuiltError,
  NotTodayError,
  recordCheck,
  SessionLockedError,
  SessionNotFoundError,
  startSession,
  type SessionResponse,
} from "../src/services/session-build.js";
import { loadProgramState, saveProgramState } from "../src/services/engine-inputs.js";
import { slotId } from "../src/services/program-slots.js";
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

/** A Wednesday; noon in Los Angeles (the test user's zone). */
const TODAY = "2026-10-07";
const NOW = "2026-10-07T19:00:00.000Z";
const LATER = "2026-10-07T19:05:00.000Z";

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
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

  it("an identical request returns the stored build — same version, nothing written", async () => {
    const id = await seedSlot(TODAY);
    const first = await buildSession(db, userId, id, {}, ctx());
    statements.length = 0;
    const again = await buildSession(db, userId, id, {}, ctx({ now: LATER }));
    expect(again.build).toEqual(first.build);
    expect(statements.filter(isWrite)).toEqual([]);
    expect((await buildsOf(id)).map((b) => b.version)).toEqual([1]);
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
    await expect(startSession(db, userId, theirs, NOW)).rejects.toBeInstanceOf(SessionNotFoundError);

    const coros = await seedSlot(addDays(TODAY, 1), { origin: null });
    await expect(buildSession(db, userId, coros, {}, ctx())).rejects.toBeInstanceOf(SessionNotFoundError);
    const archived = await seedSlot(addDays(TODAY, 2));
    await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "user_removed" }).where(eq(plannedWorkouts.id, archived));
    await expect(buildSession(db, userId, archived, {}, ctx())).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(await db.select().from(sessionBuilds)).toEqual([]);
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

    await expect(startSession(db, userId, id, NOW)).rejects.toBeInstanceOf(NotTodayError);
    expect((await buildsOf(id))[0]!.lockedAt).toBeNull();
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
    const started = await startSession(db, userId, id, LATER);
    expect(started).toMatchObject({ contentState: "started", locked: true });
    expect(started.build).toEqual(built.build);
    const stored = await buildsOf(id);
    expect(stored.map((b) => [b.version, b.lockedAt])).toEqual([[2, LATER]]);
    expect(await rowOf(id)).toMatchObject({ contentState: "started", updatedAt: LATER });

    expect(await startSession(db, userId, id, "2026-10-07T20:00:00.000Z")).toEqual(started);
    expect((await buildsOf(id))[0]!.lockedAt).toBe(LATER);

    statements.length = 0;
    for (const req of [{}, { overrides: { minutes: 45 } }, { swaps: { "core:0": { from: "a", to: "b" } } }]) {
      const err = await buildSession(db, userId, id, req, ctx()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionLockedError);
      expect((err as SessionLockedError).session.build).toEqual(built.build);
    }
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("start with nothing built today is 409 not_built", async () => {
    const id = await seedSlot(TODAY);
    await expect(startSession(db, userId, id, NOW)).rejects.toBeInstanceOf(NotBuiltError);
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
    });
    await recordCheck(db, userId, { profileId: "tmj", value: 3, feelingOff: true }, ctx());
    const built = await buildSession(db, userId, id, {}, ctx());
    const read = await loadSession(db, userId, id, TODAY);
    expect(read).toEqual(built);
    expect(read.checks).toEqual({ tmj: { pre: 3, feelingOff: true } });
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

    const started = await call("POST", `/api/sessions/${id}/start`);
    expect(started.status).toBe(200);
    expect(((await started.json()) as SessionResponse).locked).toBe(true);

    const after = await call("POST", `/api/sessions/${id}/build`, { overrides: { minutes: 45 } });
    expect(after.status).toBe(409);
    const body = (await after.json()) as { error: string; session: SessionResponse };
    expect(body.error).toBe("locked");
    expect(body.session.build).toEqual(session.build);
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
    const start = await call("POST", `/api/sessions/${ahead}/start`);
    expect(start.status).toBe(409);
    expect(((await start.json()) as { error: string }).error).toBe("not_today");

    const { userId: other } = await makeTestUser(db);
    const theirs = await seedSlot(today, { owner: other, program: await seedProgram(other) });
    for (const [method, path] of [
      ["GET", `/api/sessions/${theirs}`],
      ["POST", `/api/sessions/${theirs}/build`],
      ["POST", `/api/sessions/${theirs}/start`],
    ] as const) {
      const r = await call(method, path, method === "POST" ? {} : undefined);
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
    expect((await call("POST", `/api/sessions/${id}/start`)).status).toBe(423);
    expect((await call("POST", "/api/conditions/checks", { profileId: "tmj", value: 1 })).status).toBe(423);
    expect((await call("GET", `/api/sessions/${id}`)).status).toBe(200);
  });
});
