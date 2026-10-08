/**
 * Importing the standalone tool's backup (Phase 2 spec §2c "Standalone import"; plan Task 4, Review Focus 1 and 2).
 *
 * Every backup here is SYNTHETIC (fixtures/standalone-backup.ts). The service runs with a fixed today and clock;
 * the route test asserts nothing that depends on the real one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, KG_TO_LB, newId, nowInstant, startOfIsoWeek, type UserPreferences } from "@rg/domain";
import { EXERCISES, makeEngineData, TMJ } from "@rg/exercise-library";
import { historyFromPerformed, Records } from "@rg/session-engine";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import {
  importStandalone,
  ImportBusyError,
  InvalidBackupError,
  normalizeStandaloneSession,
  standaloneContext,
  type ImportSummary,
} from "../src/services/standalone-import.js";
import { RestoreInProgressError } from "../src/services/programs.js";
import { claimUserLock } from "../src/services/locks.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { importRoutes } from "../src/routes/imports.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { backup, entry, history, kg, lb, v1Session, v2Session } from "./fixtures/standalone-backup.js";
import { ORACLE_CASE_TODAY, oracleCaseBackup, oracleCaseSessions, toolOutputs } from "./fixtures/standalone-oracle-case.js";

const {
  accountState,
  activities,
  conditionChecks,
  exercisePrefs,
  locations,
  performedSessions,
  performedSets,
  plannedWorkouts,
  programBlocks,
  programs,
  userConditions,
  userPreferences,
  workoutCompletionMatches,
} = schema;

const TODAY = "2026-10-07";
const NOW = "2026-10-07T19:00:00.000Z";
const LATER = "2026-10-14T19:00:00.000Z";

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
});

const run = (raw: unknown, over: Partial<{ today: string; now: string; dryRun: boolean; exercises: typeof EXERCISES }> = {}) =>
  importStandalone(db, userId, raw, { today: TODAY, now: NOW, timezone: prefs.timezone, dryRun: false, ...over });

/** Everything an import may touch, in a fixed order — for "nothing else changed". */
async function snapshot() {
  return {
    sessions: await db.select().from(performedSessions).orderBy(asc(performedSessions.sourceRef)),
    sets: await db.select().from(performedSets).orderBy(asc(performedSets.id)),
    checks: await db.select().from(conditionChecks).orderBy(asc(conditionChecks.id)),
    activities: await db.select().from(activities).orderBy(asc(activities.id)),
    programs: await db.select().from(programs).orderBy(asc(programs.id)),
    blocks: await db.select().from(programBlocks).orderBy(asc(programBlocks.id)),
    places: await db.select().from(locations).orderBy(asc(locations.id)),
    prefs: await db.select().from(exercisePrefs).orderBy(asc(exercisePrefs.id)),
    conditions: await db.select().from(userConditions).orderBy(asc(userConditions.id)),
    preferences: await db.select().from(userPreferences),
    slots: await db.select().from(plannedWorkouts),
  };
}

const sessionByRef = async (ref: string) => {
  const [s] = await db.select().from(performedSessions).where(eq(performedSessions.sourceRef, ref));
  return s!;
};

describe("version-2 sessions", () => {
  it("land as performed sessions, sets, checks and activities — source import, weights as typed plus kg, no match", async () => {
    const s = v2Session("2026-09-28", {
      mode: "build",
      theme: "steady",
      done: [{ id: "chinTuck", secs: 60 }],
      entries: [
        entry("gobletSquat", [{ w: lb(25), reps: 8 }, { w: kg(12), reps: 6 }], { implement: "kettlebell", clenched: true }),
        entry("supportedRow", [{ w: lb(20), reps: 10 }], { implement: "kettlebell", perSide: true }),
        entry("sidePlankKnees", [{ secs: 30 }], { format: "holds", log: "time", metric: "time" }),
      ],
      note: "felt fine",
    });
    const summary = await run(backup([s]));
    expect(summary.sessions).toMatchObject({ total: 1, added: 1, alreadyImported: 0, invalid: [] });

    const row = await sessionByRef(s.id);
    expect(row).toMatchObject({
      userId, source: "import", sourceRef: s.id, workoutId: null, buildId: null, localDate: "2026-09-28",
      startedAt: "2026-09-28T18:00:00Z", endedAt: "2026-09-28T18:30:00Z", seconds: 1800, mode: "build", minutes: 30,
      blockNumber: 1, completed: true, note: "felt fine", movesDone: [{ exerciseId: "chinTuck", seconds: 60 }],
    });
    expect(row.payloadHash).toMatch(/^[0-9a-f]{64}$/);

    const sets = await db.select().from(performedSets).where(eq(performedSets.performedSessionId, row.id)).orderBy(asc(performedSets.entryIndex), asc(performedSets.setIndex));
    expect(sets.map((r) => [r.exerciseId, r.implement, r.format, r.perSide, r.reps, r.seconds, r.loadValue, r.loadUnit, r.flags])).toEqual([
      ["gobletSquat", "kettlebell", "straight", false, 8, null, 25, "lb", ["clenched"]],
      ["gobletSquat", "kettlebell", "straight", false, 6, null, 12, "kg", ["clenched"]],
      ["supportedRow", "kettlebell", "straight", true, 10, null, 20, "lb", []],
      ["sidePlankKnees", null, "holds", false, null, 30, null, null, []],
    ]);
    expect(sets[0]!.loadKg).toBeCloseTo(25 * 0.45359237, 9);
    expect(sets[1]!.loadKg).toBe(12);

    const checks = await db.select().from(conditionChecks).where(eq(conditionChecks.performedSessionId, row.id)).orderBy(asc(conditionChecks.kind));
    expect(checks.map((c) => [c.profileId, c.kind, c.value, c.feelingOff, c.localDate, c.at, c.workoutId])).toEqual([
      ["tmj", "post", 1, false, "2026-09-28", "2026-09-28T18:30:00Z", null],
      ["tmj", "pre", 2, false, "2026-09-28", "2026-09-28T18:00:00Z", null],
    ]);

    const [act] = await db.select().from(activities).where(eq(activities.id, row.activityId!));
    expect(act).toMatchObject({
      userId, source: "import", sport: "strength", startTime: "2026-09-28T18:00:00Z", startTimeLocal: "2026-09-28T11:00:00",
      timezone: prefs.timezone, durationSeconds: 1800, corosActivityId: null, completionMatchId: null,
    });
    expect(act!.title).toMatch(new RegExp(`^${TMJ.care!.block.label}`));
    expect(await db.select().from(workoutCompletionMatches)).toEqual([]);
  });

  it("a session with no core lift is yoga; a start with no zone is the athlete's clock", async () => {
    const s = v2Session("2026-09-28", { startedAt: "2026-09-28T07:15:00", endedAt: null, entries: [entry("catCow", [{ secs: 45 }], { log: "time", metric: "time" })] });
    await run(backup([s]));
    const row = await sessionByRef(s.id);
    expect(row.startedAt).toBe("2026-09-28T14:15:00Z");
    const [act] = await db.select().from(activities).where(eq(activities.id, row.activityId!));
    expect(act!.sport).toBe("yoga");
    // The post check is at the end: the start plus the seconds when no end was kept.
    const [post] = await db.select().from(conditionChecks).where(eq(conditionChecks.kind, "post"));
    expect(post!.at).toBe("2026-09-28T14:45:00Z");
  });
});

describe("Review Focus 2: a pass-1 session", () => {
  // A library in which a renamed move still answers to its old id (the real library has none yet).
  const renamed = EXERCISES.map((e) => (e.id === "gobletSquat" ? { ...e, legacyIds: ["kbGoblet"] } : e));

  it("resolves legacy ids, reads bilateral as per side and clenched as the flag, and a flare day as recovery", async () => {
    const s = v1Session("2026-09-29", {
      plan: { phase: "flare", setup: "kettlebell" },
      pre: 4,
      post: 3,
      entries: [{ id: "kbGoblet", log: "load", metric: "reps", bilateral: true, implement: "Kettlebell", clenched: true, sets: [{ w: lb(25), reps: 8 }, null, {}] }],
      done: [{ id: "kbGoblet", secs: 300 }],
    });
    const summary = await run(backup([s], { block: null }), { exercises: renamed });
    expect(summary.sessions.invalid).toEqual([]);
    const row = await sessionByRef(s.id);
    expect(row.mode).toBe("recovery");
    expect(row.movesDone).toEqual([{ exerciseId: "gobletSquat", seconds: 300 }]);
    expect(row.startedAt).toBe("2026-09-29T17:00:00Z");
    const sets = await db.select().from(performedSets).where(eq(performedSets.performedSessionId, row.id));
    expect(sets.map((r) => [r.exerciseId, r.implement, r.perSide, r.flags, r.loadValue, r.loadUnit, r.reps])).toEqual([
      ["gobletSquat", "kettlebell", true, ["clenched"], 25, "lb", 8],
    ]);
    // Per-side volume counts both sides: 25 lb × 8 × 2, in whole kilos, and in pounds as the tool's Progress shows it.
    const week = summary.oracle.weeklyVolume.find((w) => w.week === "2026-09-28")!;
    expect(week).toEqual({ week: "2026-09-28", kg: 181, inUnit: 399 });
    // The engine reads it back as one move, per side, flagged.
    expect(historyFromPerformed(normalized(s, renamed)).entries).toEqual([
      { id: "gobletSquat", implement: "kettlebell", perSide: true, format: null, flags: ["clenched"], sets: [{ w: lb(25), reps: 8, secs: null }] },
    ]);
  });

  it("another pass-1 phase has no mode, and a phase-less one too", async () => {
    await run(backup([v1Session("2026-09-01"), v1Session("2026-09-02", { plan: null })], { block: null }));
    expect((await sessionByRef("s1-2026-09-01")).mode).toBeNull();
    expect((await sessionByRef("s1-2026-09-02")).mode).toBeNull();
  });

  function normalized(raw: unknown, exercises: typeof EXERCISES) {
    const out = normalizeStandaloneSession(raw, "p", standaloneContext({ exercises, timezone: prefs.timezone, unit: "lb" }));
    if (!out.ok) throw new Error(out.reason);
    return out.session;
  }
});

describe("invalid sessions", () => {
  it("are reported and skipped, never half-imported; the rest import", async () => {
    const good = v2Session("2026-09-28");
    const raw = [
      good,
      { ...v2Session("2026-09-29"), date: "29/09/2026" },
      { ...v2Session("2026-09-30"), pre: 14 },
      { ...v2Session("2026-10-01"), entries: [entry("gobletSquat", Array.from({ length: 60 }, () => ({ w: lb(20), reps: 5 })))] },
      { ...good, note: "the same id again" },
      "not a session",
      // Fine by the tool's own shape, more than one session can hold here (300 sets): refused whole, not cut short.
      { ...v2Session("2026-10-02"), entries: Array.from({ length: 7 }, (_, k) => entry(k % 2 ? "deadlift" : "gobletSquat", Array.from({ length: 45 }, () => ({ w: lb(20), reps: 5 })))) },
    ];
    const summary = await run(backup(raw));
    expect(summary.sessions.total).toBe(7);
    expect(summary.sessions.added).toBe(1);
    expect(summary.sessions.invalid.map((i) => [i.index, i.id])).toEqual([
      [1, "s2-2026-09-29"],
      [2, "s2-2026-09-30"],
      [3, "s2-2026-10-01"],
      [4, good.id],
      [5, null],
      [6, "s2-2026-10-02"],
    ]);
    expect(summary.sessions.invalid[5]!.reason).toMatch(/300/);
    for (const i of summary.sessions.invalid) expect(i.reason).toMatch(/\S/);
    // The report never repeats what the athlete wrote.
    expect(JSON.stringify(summary)).not.toContain("the same id again");
    expect((await db.select().from(performedSessions)).map((s) => s.sourceRef)).toEqual([good.id]);
    expect(await db.select().from(activities)).toHaveLength(1);
  });

  it("a file that is not a backup is refused whole, writing nothing", async () => {
    statements.length = 0;
    for (const raw of [null, "nope", { hello: 1 }, { app: "other", version: 2, sessions: [] }, { app: "tmj_tool", version: 1, sessions: [] }, { app: "tmj_tool", version: 2 }]) {
      await expect(run(raw)).rejects.toBeInstanceOf(InvalidBackupError);
    }
    expect(statements.filter(isWrite)).toEqual([]);
  });
});

describe("the first import", () => {
  it("brings the program, its block, the places, the preferences, the condition, the weight unit and the wishlist", async () => {
    const summary = await run(backup(history()));
    expect(summary.firstImport).toBe(true);

    const [program] = await db.select().from(programs);
    expect(program).toMatchObject({ userId, kind: "adaptive", name: TMJ.care!.block.label, status: "active", disciplines: ["yoga", "strength"] });
    expect(program!.source).toMatchObject({ app: "tmj_tool" });
    const places = await db.select().from(locations).orderBy(asc(locations.createdAt), asc(locations.name));
    const byName = new Map(places.map((p) => [p.name, p]));
    expect(program!.config).toMatchObject({ weeklyGoal: 3, blockWeeks: 5, defaultMinutes: 40, careProfiles: ["tmj"], defaultLocationId: byName.get("Apartment")!.id });

    expect([...byName.keys()].sort()).toEqual(["Apartment", "Gym", "Mat only"]);
    expect(byName.get("Apartment")).toMatchObject({ isDefault: true, implements: { kettlebell: "10, 15, 20, 25, 30, 35 lb" } });
    expect(byName.get("Gym")).toMatchObject({ isDefault: false, implements: { kettlebell: "8, 12, 16 kg", dumbbells: "10, 15, 20 lb, 12kg" } });
    // Gear outside the vocabulary is dropped, and said.
    expect(byName.get("Mat only")!.equipment).toEqual(["mat", "wall", "towel", "chair"]);
    expect(summary.dropped).toContain("trampoline");

    const [block] = await db.select().from(programBlocks);
    expect(block).toMatchObject({ programId: program!.id, number: 2, kind: "core_block", startDate: "2026-09-21", weeks: 5 });
    expect(block!.intent).toEqual({
      core: { squat: "gobletSquat", hinge: "deadlift", row: "supportedRow", press: "floorPress", carry: "suitcaseCarry" },
      rotations: [{ family: "row", from: "proneYTW", to: "supportedRow", date: "2026-09-24", why: "no progress in 3 sessions" }],
    });

    const rows = await db.select().from(exercisePrefs);
    const pref = Object.fromEntries(rows.map((r) => [r.exerciseId, [r.rating, r.excluded, r.pinned, r.introducedOn]]));
    expect(pref).toEqual({
      chinTuck: [1, false, false, null],
      tempoSquat: [-1, false, false, null],
      bandRow: [null, true, false, null],
      gobletSquat: [null, false, true, null],
      // The session that introduced it.
      sidePlankKnees: [null, false, false, "2026-08-24"],
    });
    for (const r of rows) expect(r.id).toBe(`${userId}:${r.exerciseId}`);

    expect(await db.select().from(userConditions)).toEqual([
      { id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-08-03", settings: {} },
    ]);
    const stored = await loadPreferences(db, userId);
    expect(stored.weightUnit).toBe("lb");
    expect(stored.equipmentWishlist).toEqual(["band", "massage-ball"]);
    expect(stored.timezone).toBe(prefs.timezone);
  });

  it("a file naming one place twice keeps the first, and the import still lands", async () => {
    const twice = backup([v2Session("2026-09-28")], {
      locations: [
        { id: "home", name: "Apartment", equipment: ["mat"] },
        { id: "home", name: "Apartment again", equipment: ["mat", "kettlebell"] },
      ],
    });
    const summary = await run(twice);
    expect(summary.places).toEqual(["Apartment"]);
    expect(summary.dropped).toContain("place");
    expect((await db.select().from(locations)).map((p) => [p.name, p.isDefault])).toEqual([["Apartment", true]]);
    expect(await db.$count(performedSessions)).toBe(1);
  });

  it("never overwrites what the account already has: its own places, preferences and condition stay", async () => {
    const mine = newId();
    await db.insert(locations).values({ id: mine, userId, name: "My flat", equipment: ["mat"], implements: {}, isDefault: true, createdAt: NOW, updatedAt: NOW });
    await db.insert(exercisePrefs).values({ id: `${userId}:chinTuck`, userId, exerciseId: "chinTuck", rating: -1, excluded: false, pinned: false, introducedOn: null, updatedAt: NOW });
    await db.insert(userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: false, since: "2026-01-01", settings: {} });
    const summary = await run(backup(history()));
    expect(summary.written).toMatchObject({ places: 0, prefs: 4, condition: 0 });
    expect((await db.select().from(locations)).map((p) => p.name)).toEqual(["My flat"]);
    expect((await db.select().from(programs))[0]!.config).toMatchObject({ defaultLocationId: null });
    expect((await db.select().from(exercisePrefs).where(eq(exercisePrefs.exerciseId, "chinTuck")))[0]!.rating).toBe(-1);
    expect(await db.select().from(userConditions)).toEqual([{ id: `${userId}:tmj`, userId, profileId: "tmj", active: false, since: "2026-01-01", settings: {} }]);
  });
});

describe("Review Focus 1: a backup exported twice, a week apart", () => {
  it("the second import adds only the new sessions and changes nothing else — even what the athlete changed since", async () => {
    const week1 = history();
    await run(backup(week1));

    // The athlete changes things here in between.
    const [home] = await db.select().from(locations).where(eq(locations.name, "Apartment"));
    await db.update(locations).set({ name: "Flat", implements: { kettlebell: "12, 16 kg" } }).where(eq(locations.id, home!.id));
    await db.update(userConditions).set({ active: false });
    await db.update(exercisePrefs).set({ rating: -1 }).where(eq(exercisePrefs.exerciseId, "chinTuck"));
    await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), weightUnit: "kg", equipmentWishlist: [] });
    const [program] = await db.select().from(programs);
    await db.update(programs).set({ name: "Mornings" }).where(eq(programs.id, program!.id));

    // Re-importing the same file changes nothing at all.
    const before = await snapshot();
    statements.length = 0;
    const again = await run(backup(week1), { now: LATER });
    expect(again.sessions).toMatchObject({ total: week1.length, added: 0, alreadyImported: week1.length });
    expect(again.firstImport).toBe(false);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await snapshot()).toEqual(before);

    // A week later: two more sessions, and the tool's own settings, places, ratings and block moved on.
    const fresh = [v2Session("2026-10-05", { entries: [entry("gobletSquat", [{ w: lb(35), reps: 8 }], { implement: "kettlebell" })] }), v2Session("2026-10-07")];
    const week2 = backup([...week1, ...fresh], {
      settings: { unit: "kg", weeklyGoal: 5, blockWeeks: 4, defaultMinutes: 20, location: "gym" },
      prefs: { ratings: { chinTuck: 1, catCow: 1 }, excluded: [], pinned: [] },
      wishlist: ["foam-roller"],
      block: { number: 3, startedAt: "2026-10-05", weeks: 4, core: { squat: "boxSquat" }, rotations: [] },
      locations: [{ id: "garage", name: "Garage", equipment: ["mat"] }],
    });
    const second = await run(week2, { now: LATER });
    expect(second.sessions).toMatchObject({ total: week1.length + 2, added: 2, alreadyImported: week1.length });
    const after = await snapshot();
    const isNew = (ref: string | null) => fresh.some((f) => f.id === ref);
    const newIds = new Set(after.sessions.filter((s) => isNew(s.sourceRef)).map((s) => s.id));
    expect(newIds.size).toBe(2);
    expect({
      ...after,
      sessions: after.sessions.filter((s) => !newIds.has(s.id)),
      sets: after.sets.filter((s) => !newIds.has(s.performedSessionId)),
      checks: after.checks.filter((c) => !newIds.has(c.performedSessionId!)),
      activities: after.activities.filter((a) => !newIds.has(a.id)),
    }).toEqual(before);
    expect(after.sets.filter((s) => newIds.has(s.performedSessionId))).toHaveLength(1);
    expect(after.activities.filter((a) => newIds.has(a.id))).toHaveLength(2);
  });

  it("two imports at once: the second waits its turn (busy), never doubling a session", async () => {
    const token = await claimUserLock(db, userId, "standalone_import");
    expect(token).toBeTruthy();
    await expect(run(backup(history()))).rejects.toBeInstanceOf(ImportBusyError);
    expect(await db.select().from(performedSessions)).toEqual([]);
  });
});

describe("the dry run", () => {
  it("writes nothing and returns the summary the import then returns", async () => {
    const file = backup(history());
    statements.length = 0;
    const dry = await run(file, { dryRun: true });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await db.select().from(performedSessions)).toEqual([]);
    const real = await run(file);
    expect({ ...dry, dryRun: false }).toEqual(real);
    expect(dry).toMatchObject({
      dryRun: true,
      firstImport: true,
      sessions: { total: 18, added: 18, alreadyImported: 0, firstDate: "2026-08-03", lastDate: "2026-09-30", invalid: [] },
      program: { name: TMJ.care!.block.label },
      places: ["Apartment", "Gym", "Mat only"],
      ratings: 2,
      block: { number: 2, week: 3, weeks: 5 },
    });
    expect(real.written).toMatchObject({ sessions: 18, activities: 18, program: 1, block: 1, places: 3, prefs: 5, condition: 1, preferences: 1 });
    expect(real.written.sets).toBe(await db.$count(performedSets));
    expect(real.written.checks).toBe(await db.$count(conditionChecks));
  });
});

describe("the oracle numbers (Audit 2c-A MINOR-1)", () => {
  it("are the standalone tool's own outputs over a synthetic backup — copied from the tool, not recomputed", async () => {
    const { oracle } = await run(oracleCaseBackup(), { dryRun: true, today: ORACLE_CASE_TODAY });
    expect(oracle.unit).toBe("kg");
    expect(oracle.sessionCount).toBe(oracleCaseSessions.length);
    expect(oracle.sessionsPerWeek).toEqual(toolOutputs.weekly.map((w) => ({ week: w.week, sessions: w.sessions })));
    // Whole kilos as the tool keeps them, and as its Progress tab shows them in its unit (kg here: the same).
    expect(oracle.weeklyVolume).toEqual(toolOutputs.weekly.map((w) => ({ week: w.week, kg: w.volumeKg, inUnit: w.volumeKg })));
    expect(oracle.prePostPairs).toBe(toolOutputs.pairs);
    // Records as the Progress tab lists them: new bests and milestones, never a first time.
    expect(oracle.records).toBe(toolOutputs.progressRecords);
    expect(oracle.block).toEqual({ number: 1, week: 2 });
    // The lift tile's number: the last session's top set, as typed.
    expect(Object.fromEntries(oracle.bestByCoreLift.map((b) => [b.exerciseId, b.latest]))).toEqual({
      gobletSquat: { date: "2026-09-28", w: toolOutputs.latest.gobletSquat!.top, reps: 7, secs: null },
      deadlift: { date: "2026-09-24", w: toolOutputs.latest.deadlift!.top, reps: 5, secs: null },
      supportedRow: { date: "2026-09-28", w: toolOutputs.latest.supportedRow!.top, reps: 5, secs: null },
      floorPress: null,
      suitcaseCarry: { date: "2026-09-28", w: toolOutputs.latest.suitcaseCarry!.top, reps: 3, secs: null },
    });
  });

  it("over a history in pounds: whole kilos, and pounds as the Progress tab rounds them from those kilos", async () => {
    const { oracle } = await run(backup(history()), { dryRun: true });
    expect(oracle.unit).toBe("lb");
    expect(oracle.sessionCount).toBe(18);
    expect(oracle.sessionsPerWeek.map((w) => w.sessions)).toEqual([2, 2, 2, 2, 2, 2, 2, 0]);
    expect(oracle.sessionsPerWeek[0]!.week).toBe("2026-08-17");
    // Week of Aug 17 by hand: goblet 20 lb × (8+8) and × (8+7), row 20 lb × 10 per side twice, deadlift 16 kg × 6.
    const aug17 = (320 + 400 + 300 + 400) * 0.45359237 + 96;
    expect(oracle.weeklyVolume[0]).toEqual({ week: "2026-08-17", kg: Math.round(aug17), inUnit: Math.round(Math.round(aug17) * KG_TO_LB) });
    for (const w of oracle.weeklyVolume) {
      expect(Number.isInteger(w.kg)).toBe(true);
      expect(w.inUnit).toBe(Math.round(w.kg * KG_TO_LB));
    }
    // Every set the tool logs as load × reps, both sides of a per-side lift, whole kilos per week.
    const tool = (backup(history()).sessions as Array<{ date: string; entries: Array<{ log?: string; metric?: string; perSide?: boolean; bilateral?: boolean; sets: Array<{ w: { v: number; u: string } | null; reps: number | null }> }> }>);
    const byWeek = new Map<string, number>();
    for (const s of tool) {
      for (const e of s.entries) {
        if (e.log !== "load" || e.metric !== "reps") continue;
        for (const set of e.sets) {
          if (!set.w || !set.reps) continue;
          const k = startOfIsoWeek(s.date);
          byWeek.set(k, (byWeek.get(k) ?? 0) + (set.w.u === "kg" ? set.w.v : set.w.v * 0.45359237) * set.reps * ((e.perSide ?? e.bilateral) ? 2 : 1));
        }
      }
    }
    expect(oracle.weeklyVolume.map((w) => w.kg)).toEqual(oracle.weeklyVolume.map((w) => Math.round(byWeek.get(w.week) ?? 0)));

    // Records as Progress counts them: the engine's records less the first times, plus its milestones.
    const ctx = standaloneContext({ exercises: EXERCISES, timezone: prefs.timezone, unit: "lb" });
    const hist = backup(history()).sessions.map((raw, i) => {
      const out = normalizeStandaloneSession(raw, `p${i}`, ctx);
      if (!out.ok) throw new Error(out.reason);
      return historyFromPerformed(out.session);
    });
    const all = Records.compute(makeEngineData({ activeProfiles: ["tmj"], careProfiles: [], exercises: EXERCISES }), hist, { weeklyGoal: 3 });
    expect(all.records.some((r) => r.kind === "first")).toBe(true);
    expect(oracle.records).toBe(all.records.filter((r) => r.kind !== "first").length + all.milestones.length);

    expect(oracle.prePostPairs).toBe(16);
    expect(oracle.block).toEqual({ number: 2, week: 3 });
    expect(oracle.bestByCoreLift.map(({ latest: _l, ...b }) => b)).toEqual([
      { family: "squat", exerciseId: "gobletSquat", name: "Goblet squat", best: { w: lb(35), reps: 8, secs: null } },
      { family: "hinge", exerciseId: "deadlift", name: expect.any(String), best: { w: kg(16), reps: 8, secs: null } },
      { family: "row", exerciseId: "supportedRow", name: expect.any(String), best: { w: lb(35), reps: 10, secs: null } },
      { family: "press", exerciseId: "floorPress", name: expect.any(String), best: null },
      { family: "carry", exerciseId: "suitcaseCarry", name: expect.any(String), best: null },
    ]);
    expect(oracle.bestByCoreLift[0]!.latest).toEqual({ date: "2026-09-30", w: lb(35), reps: 8, secs: null });
  });

  it("the unit is the tool's own setting, and the account's when the file has none", async () => {
    const noUnit = backup([v2Session("2026-09-28")], { settings: { weeklyGoal: 3 } });
    expect((await run(noUnit, { dryRun: true })).oracle.unit).toBe(prefs.weightUnit);
    expect((await run(backup([v2Session("2026-09-28")], { settings: { unit: "kg" } }), { dryRun: true })).oracle.unit).toBe("kg");
  });
});

describe("writes", () => {
  it("refuses while a restore is replacing the account, writing nothing", async () => {
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    statements.length = 0;
    await expect(run(backup(history()))).rejects.toBeInstanceOf(RestoreInProgressError);
    expect(statements.filter(isWrite)).toEqual([]);
    // A dry run is a read: it still answers.
    expect((await run(backup(history()), { dryRun: true })).sessions.added).toBe(18);
  });

  it("a long history stays under D1's bound-variable cap and lands as one transaction", async () => {
    const many = Array.from({ length: 64 }, (_, i) =>
      v2Session(addDays("2026-04-06", Math.floor(i * 2.6)), {
        idSuffix: `-${i}`,
        entries: [
          entry("gobletSquat", [{ w: lb(25), reps: 8 }, { w: lb(25), reps: 8 }, { w: lb(25), reps: 8 }], { implement: "kettlebell" }),
          entry("deadlift", [{ w: lb(35), reps: 8 }, { w: lb(35), reps: 8 }, { w: lb(35), reps: 8 }], { implement: "kettlebell" }),
          entry("supportedRow", [{ w: lb(25), reps: 10 }, { w: lb(25), reps: 10 }], { implement: "kettlebell", perSide: true }),
          entry("sidePlankKnees", [{ secs: 30 }, { secs: 30 }], { format: "holds" }),
        ],
      }),
    );
    statements.length = 0;
    const summary = await run(backup(many));
    expect(summary.sessions.added).toBe(64);
    const writes = statements.filter(isWrite).length;
    expect(writes).toBeLessThan(400);
  });
});

describe("POST /api/import/standalone", () => {
  function makeEnv(importEnabled = true): Env {
    return {
      DB: {} as Env["DB"],
      ASSETS: {} as Env["ASSETS"],
      APP_URL: "app.test",
      SESSION_SECRET: "s",
      ...(importEnabled ? { IMPORT_ENABLED: "1" } : {}),
    } as Env;
  }
  const call = async (path: string, body: unknown, cookie?: string, importEnabled = true) =>
    mountRoutes(db, "/api/import", importRoutes).request(
      path,
      { method: "POST", headers: { Cookie: cookie ?? `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) },
      makeEnv(importEnabled),
    );

  it("refuses to write until IMPORT_ENABLED is set (the 2d garden gate); the dry run still answers (Audit 2c-A I-1)", async () => {
    const refused = await call("/api/import/standalone", backup(history()), undefined, false);
    expect(refused.status).toBe(404);
    expect(await db.$count(performedSessions)).toBe(0);
    expect(await db.$count(schema.activities)).toBe(0);
    expect(await db.$count(schema.programs)).toBe(0);
    const dry = await call("/api/import/standalone?dryRun=1", backup(history()), undefined, false);
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as ImportSummary).dryRun).toBe(true);
  });

  it("?dryRun=1 answers the summary and writes nothing; without it, imports", async () => {
    const dry = await call("/api/import/standalone?dryRun=1", backup(history()));
    expect(dry.status).toBe(200);
    const body = (await dry.json()) as ImportSummary;
    expect(body).toMatchObject({ dryRun: true, sessions: { added: 18 } });
    expect(await db.select().from(performedSessions)).toEqual([]);
    const real = await call("/api/import/standalone", backup(history()));
    expect(real.status).toBe(200);
    expect(((await real.json()) as ImportSummary).dryRun).toBe(false);
    expect(await db.$count(performedSessions)).toBe(18);
  });

  it("422 for a file that is not a backup or not JSON; 401 signed out; 423 while restoring", async () => {
    expect((await call("/api/import/standalone", { hello: 1 })).status).toBe(422);
    expect((await call("/api/import/standalone", "{not json")).status).toBe(422);
    expect((await call("/api/import/standalone", backup([]), "")).status).toBe(401);
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    expect((await call("/api/import/standalone", backup([]))).status).toBe(423);
  });
});
