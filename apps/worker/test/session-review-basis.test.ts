/**
 * WHAT THE REVIEW NEEDS OF THE HISTORY, AT START (Phase 2b Task 7; services/session-review-basis.ts).
 *
 * The review runs offline on the phone; at Start the player fetches the records baseline and the graduation basis.
 * These say the review's answers from them are the engine's answers from the whole history.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId, performedSessionSaveSchema, type PerformedSessionWireInput, type UserPreferences } from "@rg/domain";
import { Graduation, Hist, historyFromPerformed, Records, type HistorySession } from "@rg/session-engine";
import { LOCATIONS, WORLDS, seededHistory } from "../../../packages/session-engine/test/seeded-history.js";
import type { Db } from "../src/services/db.js";
import { buildSession, engineDataFor, startSession } from "../src/services/session-build.js";
import { loadHistory } from "../src/services/engine-inputs.js";
import { slotId } from "../src/services/program-slots.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { graduationSessions, reviewBasis } from "../src/services/session-review-basis.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { exercisePrefs, plannedWorkouts, programs, userConditions } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

describe("graduation: the basis's trimmed history gives the offers the whole history gives", () => {
  for (const world of WORLDS) {
    it(`${world.name}: every session of three seeded histories, as the one played`, () => {
      let compared = 0;
      let offered = 0;
      // Three histories at least; past three, more until one has offered something (in the TMJ world a lift tops out
      // its range on clean sessions rarely, and which histories it does in shifts whenever the library grows).
      const seeds = Array.from({ length: 16 }, (_, k) => `g${k + 1}`);
      for (const [k, seed] of seeds.entries()) {
        if (k >= 3 && offered > 0) break;
        const { sessions, blocks } = seededHistory(world.data, world.renamed, seed, 120);
        sessions.forEach((played, i) => {
          const block = blocks[i] ?? null;
          if (!block) return;
          const history = sessions.slice(0, i);
          const lifts = Object.values(block.core).filter((x): x is string => !!x);
          const program = (h: readonly HistorySession[]) => ({ block, sessions: h, locations: [LOCATIONS[0]!], settings: { unit: "lb" as const } });
          const whole = Graduation.offers(world.data, program(history), played);
          const trimmed = Graduation.offers(world.data, program(graduationSessions(world.data, history, lifts, Hist.TRIM.progressionEntries)), played);
          expect(trimmed).toEqual(whole);
          compared++;
          if (whole.length) offered++;
        });
      }
      expect(compared).toBeGreaterThan(200);
      expect(offered).toBeGreaterThan(0);
    });
  }

  it("keeps only the lifts' entries, under their canonical ids", () => {
    const { data, renamed } = WORLDS[0]!;
    const { sessions, blocks } = seededHistory(data, renamed, "g1", 120);
    const block = blocks[blocks.length - 1]!;
    const lifts = Object.values(block.core).filter((x): x is string => !!x);
    const kept = graduationSessions(data, sessions, lifts, 2);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(sessions.length);
    for (const s of kept) for (const e of s.entries) expect(lifts).toContain(e.id);
  });
});

// ── DB-backed ─────────────────────────────────────────────────────────────────────────────────────────────────

const DAY1 = "2026-10-05";
const DAY2 = "2026-10-06";
const NOON = (d: string) => `${d}T19:00:00.000Z`;

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  programId = newId();
  await db.insert(programs).values({
    id: programId, userId, kind: "adaptive", name: "Program one", status: "active", disciplines: ["yoga", "strength"],
    startDate: null, endDate: null, raceDate: null, source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30, weeklyGoal: 3 }), createdAt: NOON(DAY1), updatedAt: NOON(DAY1), archivedAt: null,
  });
  await db.insert(userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
});

async function startedOn(date: string) {
  const id = slotId(programId, date);
  await db.insert(plannedWorkouts).values({
    id, userId, planId: programId, sourceWorkoutId: id, title: "Program one", category: "yoga", sport: "yoga",
    originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
    completionState: "scheduled", origin: "program", contentState: "outline", createdAt: NOON(DAY1), updatedAt: NOON(DAY1),
  });
  const built = await buildSession(db, userId, id, { overrides: { mode: "build" }, checks: { tmj: { pre: 1, feelingOff: false } } }, { today: date, now: NOON(date), prefs });
  const locked = await startSession(db, userId, id, built.build!.buildId, NOON(date));
  return { workoutId: id, build: locked.build! };
}

/** The session played on a slot: every planned move logged once (weights as the targets say, or 25 lb). */
function played(s: Awaited<ReturnType<typeof startedOn>>, date: string, id: string): PerformedSessionWireInput {
  return {
    id, source: "app", sourceRef: null, workoutId: s.workoutId, buildId: s.build.buildId, localDate: date,
    startedAt: `${date}T19:05:00.000Z`, endedAt: `${date}T19:35:00.000Z`, seconds: 1800, plannedSeconds: s.build.plannedSeconds,
    minutes: s.build.minutes, mode: s.build.mode, theme: s.build.theme, locationId: s.build.locationId, blockRef: s.build.blockRef,
    blockNumber: 1, completed: true, stepsTotal: 10, stepsDone: 10,
    movesDone: s.build.items.map((i) => ({ exerciseId: i.exerciseId, seconds: 60 })), note: null, newMove: null,
    entries: s.build.items
      .filter((i) => s.build.exercises[i.exerciseId]?.load === "external")
      .map((i) => ({
        exerciseId: i.exerciseId, implement: "kettlebell", format: "straight" as const, perSide: false,
        sets: [{ setIndex: 0, reps: 8, seconds: null, load: { v: date === DAY1 ? 25 : 35, u: "lb" as const } }],
      })),
    checks: [{ profileId: "tmj", kind: "post", value: 0, feelingOff: false, at: `${date}T19:35:00.000Z` }],
    review: {},
  };
}

describe("the review basis for a started session", () => {
  it("the review's records from it equal the engine's over the whole history; the program's weekly goal is the one used", async () => {
    const first = await startedOn(DAY1);
    expect(await savePerformedSession(db, userId, "p-day1", played(first, DAY1, "p-day1"), { now: NOON(DAY1), prefs })).toMatchObject({ status: "saved" });
    const second = await startedOn(DAY2);
    const basis = await reviewBasis(db, userId, second.workoutId, { today: DAY2, unit: "lb" });
    expect(basis).toMatchObject({ workoutId: second.workoutId, buildId: second.build.buildId });
    expect(basis.records.weeklyGoal).toBe(3);

    const data = engineDataFor(["tmj"], []);
    const session = historyFromPerformed(performedSessionSaveSchema.parse(played(second, DAY2, "p-day2")));
    const whole = Records.forSession(data, [...(await loadHistory(db, userId)), session], "p-day2", { weeklyGoal: 3 });
    expect(Records.forSessionFrom(data, JSON.parse(JSON.stringify(basis.records)), session)).toEqual(whole);
    expect(whole.records.length).toBeGreaterThan(0);
  });

  it("carries the block when it is still the build's, and the saved 👍 / 👎 / not-for-me of the build's moves", async () => {
    const s = await startedOn(DAY2);
    const [move] = s.build.items;
    await db.insert(exercisePrefs).values({
      id: `${userId}:${move!.exerciseId}`, userId, exerciseId: move!.exerciseId, rating: -1, excluded: true, pinned: false,
      introducedOn: null, updatedAt: NOON(DAY2),
    });
    const basis = await reviewBasis(db, userId, s.workoutId, { today: DAY2, unit: "kg" });
    expect(basis.graduation.block?.id).toBe(s.build.blockRef);
    expect(basis.graduation.unit).toBe("kg");
    expect(basis.prefs).toEqual({ ratings: { [move!.exerciseId]: -1 }, excluded: [move!.exerciseId] });
    // The harder moves of the block's lifts are there when the build's own slice lacks them.
    for (const id of Object.keys(basis.exercises)) expect(s.build.exercises[id]).toBeUndefined();
  });

  it("a block that moved on since the build (a rotation, a new block) is not the build's: no graduation basis from it", async () => {
    const s = await startedOn(DAY2);
    const [current] = await db.select().from(schema.programBlocks).where(eq(schema.programBlocks.programId, programId));
    await db.insert(schema.programBlocks).values({ ...current!, id: "block-next", number: current!.number + 1 });
    const basis = await reviewBasis(db, userId, s.workoutId, { today: DAY2, unit: "lb" });
    expect(basis.graduation.block).toBeNull();
  });

  it("is a read: nothing is written", async () => {
    const s = await startedOn(DAY2);
    statements.length = 0;
    await reviewBasis(db, userId, s.workoutId, { today: DAY2, unit: "lb" });
    expect(statements.filter(isWrite)).toEqual([]);
  });
});

describe("GET /api/sessions/:workoutId/review-basis", () => {
  const get = async (workoutId: string, who = userId) => {
    const cookie = `${SESSION_COOKIE}=${await createSession(db, who, "test")}`;
    return mountRoutes(db, "/api/sessions", sessionRoutes).request(`/api/sessions/${workoutId}/review-basis`, { headers: { Cookie: cookie } });
  };

  it("answers the basis; 404 for a slot that is not the user's; 409 not_built before a build", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOON(DAY2)));
    try {
      const s = await startedOn(DAY2);
      const ok = await get(s.workoutId);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ workoutId: s.workoutId, buildId: s.build.buildId });

      const other = (await makeTestUser(db)).userId;
      expect((await get(s.workoutId, other)).status).toBe(404);

      const outline = slotId(programId, "2026-10-08");
      await db.insert(plannedWorkouts).values({
        id: outline, userId, planId: programId, sourceWorkoutId: outline, title: "Program one", category: "yoga", sport: "yoga",
        originalPlanDate: "2026-10-08", lastVerifiedCorosDate: "", effectiveDate: "2026-10-08", effectiveTime: "18:00",
        sourceContentFingerprint: "program", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
        corosSyncState: "calendar_only", completionState: "scheduled", origin: "program", contentState: "outline",
        createdAt: NOON(DAY1), updatedAt: NOON(DAY1),
      });
      const notBuilt = await get(outline);
      expect(notBuilt.status).toBe(409);
      expect(await notBuilt.json()).toEqual({ error: "not_built" });
    } finally {
      vi.useRealTimers();
    }
  });
});

