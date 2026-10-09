/**
 * THE QUICK REVIEW AFTER A WATCH SESSION — the server (Phase 3 Task 9; spec §5; rulings 3-R7, 3-R8; audit 3-A W-1).
 *
 *  - `pairWatchSets`: the watch's logged sets paired with the build's entries — by library id first, then by order only
 *    when both sides have the same number left; one watch lap per side; targets where nothing was logged.
 *  - `watchReviewBasis` / `GET /api/sessions/:workoutId/watch-review`: offered only for a program slot a COROS activity
 *    completed (an active `coros_plan_link` or `scored_auto` match), with a locked build, no app and no review session,
 *    on the session's day or the next.
 *  - `saveWatchReview` through `PUT /api/sessions/performed/:id` (`source: "watch_review"`): one session on the watch's
 *    activity, saved once; the slot done; one activity, one match; the garden counts it once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  adaptiveConfigSchema,
  canonicalJson,
  type PerformedSessionWireInput,
  type PerformedSet,
  type SourceActivity,
  type UserPreferences,
} from "@rg/domain";
import type { RawCorosLapItem } from "@rg/providers";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sha256Hex } from "../src/auth/crypto.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { planRoutes } from "../src/routes/plan.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { ingestActivities } from "../src/services/completion.js";
import { corosKeyOf } from "../src/services/coros-exercise-map.js";
import { buildDayInput } from "../src/services/garden-sync.js";
import { pushJobId, startSession, type BuildPayload } from "../src/services/session-build.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { pairWatchSets, watchReviewBasis } from "../src/services/session-watch-review.js";
import { upsertWatchSession } from "../src/services/watch-sets.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { slotId } from "../src/services/program-slots.js";
import { connectTestCoros, D1_BIND_LIMIT, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { buildToday, DAY, makeEnv, NOON, seedCatalog, seedTmj, switchOn, TOMORROW } from "./watch-push-fixture.js";
import { detailOf, item } from "./watch-sets-fixture.js";

const { accountState, activities, performedSessions, performedSets, plannedWorkouts, programs, sessionBuilds, workoutCompletionMatches } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

/** The ceiling: D1 statements + COROS fetches in one invocation (ruling 3-R11). */
const BUDGET = 45;
/** A fixed program id: the engine seeds its choices from it, so every run builds the same session. */
const PROGRAM = "prog-watch-review-0001";
const PROGRAM_NAME = "Strength program";
/** The watch session: 19:05–19:37 UTC on DAY (noon in Los Angeles, the test user's zone). */
const STARTED = `${DAY}T19:05:00.000Z`;
const AFTER = `${DAY}T20:30:00.000Z`;
const COROS_ID = "lbl-review-7001";

let db: Db;
let userId: string;
let prefs: UserPreferences;
let statements = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(AFTER));
  statements = 0;
  db = makeTestDb({ boundVariableCap: D1_BIND_LIMIT, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await seedTmj(db, userId);
  await seedCatalog(db);
  await db.insert(programs).values({
    id: PROGRAM, userId, kind: "adaptive", name: PROGRAM_NAME, status: "active", disciplines: ["strength", "yoga"],
    startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
    createdAt: NOON, updatedAt: NOON, archivedAt: null,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Set-up ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function seedSlot(date: string): Promise<string> {
  const id = slotId(PROGRAM, date);
  await db.insert(plannedWorkouts).values({
    id, userId, planId: PROGRAM, sourceWorkoutId: id, title: PROGRAM_NAME, category: "strength", sport: "strength",
    originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "program",
    calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
    completionState: "scheduled", origin: "program", contentState: "outline", createdAt: NOON, updatedAt: NOON,
  });
  return id;
}

/** Today's slot, built (strength: a core lift) and sent to the watch — its build locked. */
async function sentSlot(): Promise<{ workoutId: string; build: BuildPayload }> {
  const workoutId = await seedSlot(DAY);
  const built = await buildToday(db, userId, prefs, workoutId);
  await sendToWatch(db, switchOn(), userId, workoutId, built.build!.buildId, { today: DAY, now: NOON, prefs });
  const [b] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, built.build!.buildId));
  return { workoutId, build: { ...(b!.payload as { build: BuildPayload }).build, buildId: b!.id } };
}

/** The build's moves the watch knows by T-code, in build order, with their key. */
function mappedItems(build: BuildPayload): Array<{ exerciseId: string; key: string; perSide: boolean }> {
  return build.items.flatMap((i) => {
    const key = corosKeyOf(i.exerciseId);
    return key ? [{ exerciseId: i.exerciseId, key, perSide: build.exercises[i.exerciseId]?.laterality === "unilateral" }] : [];
  });
}

/**
 * The watch's lap items for a session that did the build's mapped moves: per set one data item (two for a one-sided
 * move: one per side) then its rest — the derivation's R3 layout. `lb` sends the weights as pounds typed on the watch.
 */
function lapsFor(build: BuildPayload, opts: { sets?: number; extra?: RawCorosLapItem[] } = {}): RawCorosLapItem[] {
  const out: RawCorosLapItem[] = [];
  mappedItems(build).forEach((m, exerciseIndex) => {
    for (let setIndex = 0; setIndex < (opts.sets ?? 3); setIndex++) {
      const data = { exerciseIndex, setIndex, exerciseNameKey: m.key, reps: 8, weight: 11_340, time: 4_000 };
      out.push(item(data));
      if (m.perSide) out.push(item({ ...data, reps: 7 }));
      out.push(item({ exerciseIndex, setIndex, exerciseNameKey: m.key, time: 6_000 }));
    }
  });
  out.push(...(opts.extra ?? []));
  return out.map((i, n) => ({ ...i, lapIndex: n + 1 }));
}

const watchSource = (over: Partial<SourceActivity> = {}): SourceActivity => ({
  provider: "coros",
  providerActivityId: COROS_ID,
  startTime: `${DAY}T19:05:00Z`,
  startTimeLocal: `${DAY}T12:05:00`,
  sport: "strength",
  durationSeconds: 1920,
  avgHeartRate: 104,
  title: "Strength",
  contentFingerprint: "fp-1",
  ...over,
});

/** The watch session imported, and its activity matched to the slot by `method` (the slot completed). */
async function watchDone(
  s: { workoutId: string; build: BuildPayload },
  opts: { method?: string; laps?: RawCorosLapItem[]; source?: Partial<SourceActivity> } = {},
): Promise<{ activityId: string }> {
  const laps = opts.laps ?? lapsFor(s.build);
  await ingestActivities(db, { userId, sources: [watchSource(opts.source)], strengthDetailsByProviderId: { [COROS_ID]: detailOf(laps) } });
  const [act] = await db.select().from(activities).where(eq(activities.corosActivityId, opts.source?.providerActivityId ?? COROS_ID));
  // The match the ingest's matcher (or the plan link) makes — made here explicitly, so each case says which.
  await db.delete(workoutCompletionMatches).where(eq(workoutCompletionMatches.workoutId, s.workoutId));
  const matchId = `m-${s.workoutId}`;
  await db.insert(workoutCompletionMatches).values({
    id: matchId, workoutId: s.workoutId, activityId: act!.id, confidence: 0.9, method: opts.method ?? "scored_auto", matchedAt: AFTER,
  });
  await db.update(activities).set({ completionMatchId: matchId }).where(eq(activities.id, act!.id));
  await db
    .update(plannedWorkouts)
    .set({ completionState: "completed", resolutionDate: DAY })
    .where(eq(plannedWorkouts.id, s.workoutId));
  return { activityId: act!.id };
}

const ctx = (today = DAY) => ({ today });

async function call(method: "GET" | "PUT", path: string, opts: { body?: unknown; env?: Env } = {}) {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  statements = 0;
  const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(
    `/api/sessions/${path}`,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) },
    opts.env ?? switchOn(),
  );
  return { res, d1: statements };
}

/** What the sheet saves from a basis: its entries as shown (the athlete changed nothing), a post-check, a note. */
async function reviewBody(workoutId: string, over: Partial<PerformedSessionWireInput> = {}): Promise<PerformedSessionWireInput> {
  const basis = await watchReviewBasis(db, userId, workoutId, ctx());
  return {
    id: "9d0c3b7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    source: "watch_review",
    sourceRef: basis.sourceRef,
    workoutId,
    buildId: basis.buildId,
    localDate: basis.localDate,
    startedAt: basis.startedAt,
    endedAt: basis.endedAt,
    seconds: basis.seconds,
    plannedSeconds: null,
    minutes: null,
    mode: null,
    theme: null,
    locationId: null,
    blockRef: null,
    blockNumber: null,
    completed: true,
    stepsTotal: null,
    stepsDone: null,
    movesDone: [],
    note: "felt strong",
    newMove: null,
    entries: basis.entries.map((e) => ({
      exerciseId: e.exerciseId,
      implement: e.implement,
      format: e.format,
      perSide: e.perSide,
      sets: e.sets.map(({ from: _from, ...set }) => set),
    })),
    checks: [{ profileId: "tmj", kind: "post", value: 1, feelingOff: false, at: AFTER }],
    review: {},
    ...over,
  };
}

const save = (body: PerformedSessionWireInput, now = AFTER) => savePerformedSession(db, userId, body.id, body, { now, prefs });

// ── 1. Pairing (Review Focus 4; ruling 3-R7) ──────────────────────────────────────────────────────────────────────

/** A minimal build: per move its sets (a number: that many rep sets of 8 at 20 lb), or holds for a timed move. */
function miniBuild(moves: Array<{ id: string; sets: number; unilateral?: boolean; timed?: number; sides?: boolean }>): BuildPayload {
  const steps: unknown[] = [];
  const items: unknown[] = [];
  const exercises: Record<string, unknown> = {};
  for (const m of moves) {
    const slotKey = `core:${m.id}`;
    items.push({ slotKey, block: "core", exerciseId: m.id, format: "straight", sets: m.sets, group: null, coreFamily: null, isNew: false, why: [] });
    exercises[m.id] = { id: m.id, name: m.id, laterality: m.unilateral ? "unilateral" : "bilateral" };
    for (let i = 0; i < m.sets; i++) {
      const base = { slotKey, block: "core", exerciseId: m.id, setIndex: i, setCount: m.sets, prepGap: 0, format: { id: "straight", group: null, round: null }, why: [], isNew: false, log: true };
      if (m.timed) {
        for (const side of m.sides ? (["Left", "Right"] as const) : [null]) steps.push({ ...base, kind: "timed", side, seconds: m.timed, target: null });
      } else {
        steps.push({ ...base, kind: "set", side: null, seconds: 50, target: { reps: 8, w: { v: 20, u: "lb" }, secs: null } });
      }
      steps.push({ kind: "rest", slotKey, block: "core", exerciseId: null, side: null, setIndex: i, setCount: m.sets, seconds: 60, prepGap: 0, target: null, format: { id: "straight", group: null, round: null }, why: [], isNew: false, log: false });
    }
  }
  return { buildId: "b-mini", steps, items, exercises, targets: {}, newMove: null } as unknown as BuildPayload;
}

const set = (over: Partial<PerformedSet> & { setIndex: number }): PerformedSet => ({
  side: null, reps: 8, seconds: null, load: null, done: true, flags: [], ...over,
});
const watchSets = (n: number, over: Partial<PerformedSet> = {}) => Array.from({ length: n }, (_, i) => set({ setIndex: i, ...over }));

describe("pairWatchSets (ruling 3-R7)", () => {
  it("mapped moves pair by library id, whatever order the watch logged them in", () => {
    const build = miniBuild([{ id: "goblet", sets: 3 }, { id: "deadlift", sets: 3 }]);
    const entries = pairWatchSets(build, [
      { exerciseId: "deadlift", sets: watchSets(3, { reps: 5 }) },
      { exerciseId: "goblet", sets: watchSets(3, { reps: 6 }) },
    ]);
    expect(entries.map((e) => [e.exerciseId, e.sets.map((s) => [s.reps, s.from])])).toEqual([
      ["goblet", [[6, "watch"], [6, "watch"], [6, "watch"]]],
      ["deadlift", [[5, "watch"], [5, "watch"], [5, "watch"]]],
    ]);
  });

  it("two free-text moves and two unmapped watch entries pair by order", () => {
    const build = miniBuild([{ id: "goblet", sets: 2 }, { id: "freeA", sets: 2 }, { id: "freeB", sets: 2 }]);
    const entries = pairWatchSets(build, [
      { exerciseId: "goblet", sets: watchSets(2) },
      { exerciseId: "coros:T9001", sets: watchSets(2, { reps: 11 }) },
      { exerciseId: "coros:T9002", sets: watchSets(2, { reps: 12 }) },
    ]);
    expect(entries.map((e) => [e.exerciseId, e.sets[0]!.reps, e.sets[0]!.from])).toEqual([
      ["goblet", 8, "watch"],
      ["freeA", 11, "watch"],
      ["freeB", 12, "watch"],
    ]);
  });

  it("three against two do not pair: the build's three show their targets, the watch's two are kept as they are", () => {
    const build = miniBuild([{ id: "freeA", sets: 2 }, { id: "freeB", sets: 2 }, { id: "freeC", sets: 2 }]);
    const entries = pairWatchSets(build, [
      { exerciseId: "coros:T9001", sets: watchSets(2, { reps: 11 }) },
      { exerciseId: "coros:T9002", sets: watchSets(2, { reps: 12 }) },
    ]);
    const byId = Object.fromEntries(entries.map((e) => [e.exerciseId, e]));
    for (const id of ["freeA", "freeB", "freeC"]) {
      expect(byId[id]!.sets.map((s) => [s.from, s.reps, s.load, s.done])).toEqual([
        ["target", 8, { v: 20, u: "lb" }, false],
        ["target", 8, { v: 20, u: "lb" }, false],
      ]);
    }
    expect(byId["coros:T9001"]!.sets.map((s) => [s.from, s.reps])).toEqual([["watch", 11], ["watch", 11]]);
    expect(byId["coros:T9002"]!.sets.map((s) => [s.from, s.reps])).toEqual([["watch", 12], ["watch", 12]]);
  });

  it("a move added on the watch is kept as its own entry — a mapped one never pairs by order with a build move", () => {
    const build = miniBuild([{ id: "goblet", sets: 2 }, { id: "freeA", sets: 2 }]);
    const entries = pairWatchSets(build, [
      { exerciseId: "goblet", sets: watchSets(2) },
      { exerciseId: "pushup", sets: watchSets(1, { reps: 10, load: null }) },
    ]);
    expect(entries.map((e) => [e.exerciseId, e.sets.map((s) => s.from)])).toEqual([
      ["goblet", ["watch", "watch"]],
      ["pushup", ["watch"]],
      ["freeA", ["target", "target"]],
    ]);
  });

  it("a weight typed in pounds on the watch stays pounds", () => {
    const build = miniBuild([{ id: "goblet", sets: 1 }]);
    const [goblet] = pairWatchSets(build, [{ exerciseId: "goblet", sets: watchSets(1, { load: { v: 25, u: "lb" } }) }]);
    expect(goblet!.sets[0]!.load).toEqual({ v: 25, u: "lb" });
  });

  it("one watch lap per side (audit W-1): 3 one-sided sets come back as 6 laps → 6 sets left, right, …, never 6 unsided or 6 build sets", () => {
    const build = miniBuild([{ id: "row", sets: 3, unilateral: true }]);
    const [row] = pairWatchSets(build, [{ exerciseId: "row", sets: watchSets(6, { reps: 10 }) }]);
    expect(row!.perSide).toBe(true);
    expect(row!.sets.map((s) => [s.side, s.reps, s.from])).toEqual([
      ["left", 10, "watch"], ["right", 10, "watch"], ["left", 10, "watch"],
      ["right", 10, "watch"], ["left", 10, "watch"], ["right", 10, "watch"],
    ]);
    expect(row!.sets.map((s) => s.setIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a per-side timed move: its Left and Right windows are its laps; short of laps, the rest are the targets, sides kept", () => {
    const build = miniBuild([{ id: "plank", sets: 2, timed: 30, sides: true, unilateral: true }]);
    const [plank] = pairWatchSets(build, [{ exerciseId: "plank", sets: watchSets(3, { reps: null, seconds: 28 }) }]);
    expect(plank!.sets.map((s) => [s.side, s.seconds, s.from, s.done])).toEqual([
      ["left", 28, "watch", true],
      ["right", 28, "watch", true],
      ["left", 28, "watch", true],
      ["right", 30, "target", false],
    ]);
  });

  it("a skipped move (no watch sets) shows its targets, not done; fewer laps than sets: the rest from targets", () => {
    const build = miniBuild([{ id: "goblet", sets: 3 }, { id: "deadlift", sets: 2 }]);
    const entries = pairWatchSets(build, [{ exerciseId: "goblet", sets: watchSets(2, { reps: 6 }) }]);
    expect(entries.map((e) => [e.exerciseId, e.sets.map((s) => [s.from, s.reps, s.done])])).toEqual([
      ["goblet", [["watch", 6, true], ["watch", 6, true], ["target", 8, false]]],
      ["deadlift", [["target", 8, false], ["target", 8, false]]],
    ]);
  });

  it("an extra set on the watch is kept", () => {
    const build = miniBuild([{ id: "goblet", sets: 2 }]);
    const [goblet] = pairWatchSets(build, [{ exerciseId: "goblet", sets: watchSets(3) }]);
    expect(goblet!.sets.map((s) => s.from)).toEqual(["watch", "watch", "watch"]);
  });

  it("a MAPPED move skipped on the watch leaves the free-text moves pairing by order (audit 3-B S-7)", () => {
    // `goblet` reaches the watch by its T-code: it only ever comes back under its own id, never as a `coros:` entry.
    const build = miniBuild([{ id: "goblet", sets: 2 }, { id: "freeA", sets: 2 }, { id: "freeB", sets: 2 }]);
    const entries = pairWatchSets(
      build,
      [
        { exerciseId: "coros:T9001", sets: watchSets(2, { reps: 11 }) },
        { exerciseId: "coros:T9002", sets: watchSets(2, { reps: 12 }) },
      ],
      (id) => id === "goblet",
    );
    expect(entries.map((e) => [e.exerciseId, e.sets.map((s) => [s.from, s.reps])])).toEqual([
      ["freeA", [["watch", 11], ["watch", 11]]],
      ["freeB", [["watch", 12], ["watch", 12]]],
      ["goblet", [["target", 8], ["target", 8]]],
    ]);
  });

  it("the real sent build: its one mapped move skipped, every free-text move still prefills from the watch (audit 3-B S-7)", async () => {
    const s = await sentSlot();
    const mapped = mappedItems(s.build);
    const free = s.build.items.filter((i) => !corosKeyOf(i.exerciseId));
    expect(mapped.length).toBeGreaterThan(0);
    expect(free.length).toBeGreaterThan(1);
    const sets3 = (reps: number) => watchSets(3, { reps });
    const entries = pairWatchSets(s.build, [
      ...mapped.slice(1).map((m) => ({ exerciseId: m.exerciseId, sets: sets3(8) })),
      ...free.map((_, k) => ({ exerciseId: `coros:T90${10 + k}`, sets: sets3(11) })),
    ]);
    expect(entries.filter((e) => e.exerciseId.startsWith("coros:"))).toEqual([]);
    const freeIds = new Set(free.map((f) => f.exerciseId));
    expect(entries.filter((e) => freeIds.has(e.exerciseId) && e.sets[0]!.from === "watch")).toHaveLength(free.length);
  });
});

// ── 2. When the review is offered ─────────────────────────────────────────────────────────────────────────────────

describe("watchReviewBasis — when the review is offered", () => {
  it("a sent session the watch did, matched by the scorer: the basis — the watch's sets paired with the build", async () => {
    const s = await sentSlot();
    const { activityId } = await watchDone(s);
    const basis = await watchReviewBasis(db, userId, s.workoutId, ctx());
    expect(basis).toMatchObject({ workoutId: s.workoutId, buildId: s.build.buildId, activityId, sourceRef: COROS_ID, localDate: DAY, seconds: 1920 });
    expect(basis.startedAt).toBe(STARTED);
    expect(basis.profiles.map((p) => p.profileId)).toEqual(["tmj"]);
    expect(basis.before).toEqual({ tmj: { pre: 2, feelingOff: false } });
    expect(basis.unit).toBe("lb");
    // Each move by the name the athlete reads: the build's own.
    for (const e of basis.entries) expect(e.name).toBe(s.build.exercises[e.exerciseId]?.name ?? e.name);
    expect(basis.entries.every((e) => e.name.length > 0 && !e.name.startsWith("coros:"))).toBe(true);
    const mapped = mappedItems(s.build);
    expect(mapped.length).toBeGreaterThan(0);
    for (const m of mapped) {
      const entry = basis.entries.find((e) => e.exerciseId === m.exerciseId)!;
      expect(entry.sets.filter((x) => x.from === "watch")).toHaveLength(m.perSide ? 6 : 3);
      expect(entry.sets.find((x) => x.from === "watch")!.load).toEqual({ v: 25, u: "lb" });
    }
    // Every move of the build is there, logged or not.
    for (const i of s.build.items) expect(basis.entries.some((e) => e.exerciseId === i.exerciseId)).toBe(true);
  });

  it("matched by the plan link too; and the next day still", async () => {
    const s = await sentSlot();
    await watchDone(s, { method: "coros_plan_link" });
    expect((await watchReviewBasis(db, userId, s.workoutId, ctx(TOMORROW))).buildId).toBe(s.build.buildId);
  });

  it("a started (not sent) build the watch did counts the same: its build is locked", async () => {
    const workoutId = await seedSlot(DAY);
    const built = await buildToday(db, userId, prefs, workoutId);
    const started = await startSession(db, userId, workoutId, built.build!.buildId, NOON);
    await watchDone({ workoutId, build: started.build! });
    expect((await watchReviewBasis(db, userId, workoutId, ctx())).buildId).toBe(started.build!.buildId);
  });

  it("a sent build COROS moved: the session's day is the slot's new one", async () => {
    const s = await sentSlot();
    await watchDone(s);
    const moved = "2026-10-11";
    await db.update(plannedWorkouts).set({ effectiveDate: moved }).where(eq(plannedWorkouts.id, s.workoutId));
    expect((await watchReviewBasis(db, userId, s.workoutId, ctx(moved))).buildId).toBe(s.build.buildId);
    expect((await watchReviewBasis(db, userId, s.workoutId, ctx("2026-10-12"))).buildId).toBe(s.build.buildId);
  });

  const refused = async (workoutId: string, today = DAY) => {
    await expect(watchReviewBasis(db, userId, workoutId, ctx(today))).rejects.toThrow();
    const { res } = await call("GET", `${workoutId}/watch-review`);
    return res.status;
  };

  it("not offered — 404 — two days on", async () => {
    const s = await sentSlot();
    await watchDone(s);
    await expect(watchReviewBasis(db, userId, s.workoutId, ctx("2026-10-11"))).rejects.toThrow();
  });

  it("not offered for a manual match, an app session's match, an undone match, or no match at all", async () => {
    for (const method of ["manual", "app_session"]) {
      const s = await sentSlot();
      await watchDone(s, { method });
      expect(await refused(s.workoutId)).toBe(404);
      await db.delete(workoutCompletionMatches);
      await db.delete(schema.corosWriteJobs);
      await db.delete(sessionBuilds);
      await db.delete(performedSets);
      await db.delete(performedSessions);
      await db.delete(schema.activitySourceLinks);
      await db.delete(activities);
      await db.delete(plannedWorkouts);
    }
    const s = await sentSlot();
    await watchDone(s);
    await db.update(workoutCompletionMatches).set({ undoneAt: AFTER });
    expect(await refused(s.workoutId)).toBe(404);
    await db.delete(workoutCompletionMatches);
    expect(await refused(s.workoutId)).toBe(404);
  });

  it("not offered for an activity with no COROS id", async () => {
    const s = await sentSlot();
    await watchDone(s);
    await db.update(activities).set({ corosActivityId: null });
    expect(await refused(s.workoutId)).toBe(404);
  });

  it("not offered without a locked build", async () => {
    const s = await sentSlot();
    await watchDone(s);
    await db.update(sessionBuilds).set({ lockedAt: null });
    expect(await refused(s.workoutId)).toBe(404);
  });

  it("not offered once an app session or a review is saved", async () => {
    const s = await sentSlot();
    await watchDone(s);
    expect((await save(await reviewBody(s.workoutId))).status).toBe("saved");
    expect(await refused(s.workoutId)).toBe(404);
  });

  it("not offered for a run, another user's slot, or a slot gone", async () => {
    const s = await sentSlot();
    await watchDone(s);
    const other = await makeTestUser(db);
    await expect(watchReviewBasis(db, other.userId, s.workoutId, ctx())).rejects.toThrow();
    await db.update(plannedWorkouts).set({ archivedAt: AFTER }).where(eq(plannedWorkouts.id, s.workoutId));
    expect(await refused(s.workoutId)).toBe(404);
  });

  it("the route: 404 while the switch is off; within the budget on", async () => {
    const s = await sentSlot();
    await watchDone(s);
    expect((await call("GET", `${s.workoutId}/watch-review`, { env: makeEnv() })).res.status).toBe(404);
    const { res, d1 } = await call("GET", `${s.workoutId}/watch-review`);
    expect(res.status).toBe(200);
    console.info(`[budget] GET watch-review: ${d1} D1 + 0 COROS = ${d1}`);
    expect(d1).toBeLessThanOrEqual(BUDGET);
  });
});

// ── 2b. Today lists it ────────────────────────────────────────────────────────────────────────────────────────────

describe("Today's watchReviews", () => {
  async function today(env: Env = switchOn(), at = AFTER) {
    vi.setSystemTime(new Date(at));
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    statements = 0;
    const res = await mountRoutes(db, "/api/plan", planRoutes).request("/api/plan/today", { headers: { Cookie: cookie } }, env);
    const d1 = statements;
    return {
      body: (await res.json()) as { watchReviews: Array<{ workoutId: string; title: string; date: string; seconds: number; category: string }> },
      d1,
    };
  }

  it("today's offered slot, and yesterday's the next morning; not two days on; within the budget", async () => {
    const s = await sentSlot();
    await watchDone(s);
    const now = await today();
    expect(now.body.watchReviews).toEqual([{ workoutId: s.workoutId, title: PROGRAM_NAME, date: DAY, seconds: 1920, category: "strength" }]);
    console.info(`[budget] GET /today with a review offered: ${now.d1} D1 + 0 COROS = ${now.d1}`);
    expect(now.d1).toBeLessThanOrEqual(BUDGET);
    expect((await today(switchOn(), `${TOMORROW}T16:00:00.000Z`)).body.watchReviews.map((r) => r.workoutId)).toEqual([s.workoutId]);
    expect((await today(switchOn(), "2026-10-11T16:00:00.000Z")).body.watchReviews).toEqual([]);
  });

  it("none once saved, none while the switch is off", async () => {
    const s = await sentSlot();
    await watchDone(s);
    expect((await today(makeEnv())).body.watchReviews).toEqual([]);
    await save(await reviewBody(s.workoutId));
    expect((await today()).body.watchReviews).toEqual([]);
  });
});

// ── 3. The save ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("saveWatchReview — one session on the watch's activity, saved once", () => {
  it("writes the review on the watch's activity, deletes the watch copy, names the activity — and leaves one activity and one match", async () => {
    const s = await sentSlot();
    const { activityId } = await watchDone(s);
    const [matchBefore] = await db.select().from(workoutCompletionMatches);
    const body = await reviewBody(s.workoutId);
    const outcome = await save(body);
    expect(outcome).toMatchObject({ status: "saved", performedId: body.id, activityId, matched: true });

    const sessions = await db.select().from(performedSessions);
    expect(sessions.map((p) => [p.id, p.source, p.sourceRef, p.activityId, p.workoutId, p.buildId])).toEqual([
      [body.id, "watch_review", COROS_ID, activityId, s.workoutId, s.build.buildId],
    ]);
    const sets = await db.select().from(performedSets);
    expect(sets).toHaveLength(body.entries!.reduce((n, e) => n + e.sets.length, 0));
    expect(sets.every((x) => x.performedSessionId === body.id)).toBe(true);
    const posts = await db.select().from(schema.conditionChecks).where(eq(schema.conditionChecks.kind, "post"));
    expect(posts.map((c) => [c.profileId, c.value, c.performedSessionId, c.workoutId])).toEqual([["tmj", 1, body.id, s.workoutId]]);

    const acts = await db.select().from(activities);
    expect(acts).toHaveLength(1);
    const [slotRow] = await db.select().from(plannedWorkouts);
    expect(acts[0]).toMatchObject({ id: activityId, title: slotRow!.title, sport: "strength", corosActivityId: COROS_ID });
    expect(slotRow!.title).not.toBe("Strength");
    const matches = await db.select().from(workoutCompletionMatches).where(isNull(workoutCompletionMatches.undoneAt));
    expect(matches).toEqual([matchBefore]);
    expect(await db.select({ c: plannedWorkouts.contentState, s: plannedWorkouts.completionState }).from(plannedWorkouts)).toEqual([
      { c: "done", s: "completed" },
    ]);
    // The garden's replay went on record with the save.
    const [account] = await db.select().from(accountState).where(eq(accountState.userId, userId));
    expect(account!.gardenChangedFrom).toBe(DAY);
  });

  it("a strength session: the garden's day input is byte-identical before and after", async () => {
    const s = await sentSlot();
    await watchDone(s);
    const before = canonicalJson(await buildDayInput(db, userId, DAY, prefs));
    await save(await reviewBody(s.workoutId));
    expect(canonicalJson(await buildDayInput(db, userId, DAY, prefs))).toBe(before);
  });

  it("the same PUT again → same_payload; another payload for the same id → conflict", async () => {
    const s = await sentSlot();
    await watchDone(s);
    const body = await reviewBody(s.workoutId);
    expect((await save(body)).status).toBe("saved");
    expect(await save(body)).toEqual({ status: "same_payload" });
    expect(await save({ ...body, note: "changed my mind" })).toEqual({ status: "conflict" });
    expect(await db.select().from(performedSessions)).toHaveLength(1);
  });

  it("ruling 3-R8, one way: a review saved, then an app save for the slot → slot_done", async () => {
    const s = await sentSlot();
    await watchDone(s);
    expect((await save(await reviewBody(s.workoutId))).status).toBe("saved");
    const appBody: PerformedSessionWireInput = {
      id: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", source: "app", sourceRef: null, workoutId: s.workoutId, buildId: s.build.buildId,
      localDate: DAY, startedAt: STARTED, endedAt: `${DAY}T19:37:00.000Z`, seconds: 1900, plannedSeconds: null, minutes: null, mode: null,
      theme: null, locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [],
      note: null, newMove: null, entries: [], checks: [], review: {},
    };
    expect(await save(appBody)).toEqual({ status: "slot_done" });
  });

  it("ruling 3-R8, the other way: an app session saved, then a review → slot_done", async () => {
    const s = await sentSlot();
    await watchDone(s);
    const body = await reviewBody(s.workoutId);
    const appBody: PerformedSessionWireInput = { ...body, id: "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b", source: "app", sourceRef: null };
    expect((await save(appBody)).status).toBe("saved");
    expect(await save(body)).toEqual({ status: "slot_done" });
  });

  it("a later refresh of the activity: the watch copy stays gone, and the slot's title and the build's sport stay", async () => {
    const s = await sentSlot();
    const { activityId } = await watchDone(s);
    await save(await reviewBody(s.workoutId));
    const [act] = await db.select().from(activities);
    expect(
      await upsertWatchSession(db, {
        userId,
        activity: { activityId, providerActivityId: COROS_ID, startTime: act!.startTime, durationSeconds: 1920 },
        detail: detailOf(lapsFor(s.build)),
      }),
    ).toEqual({ status: "app_owned" });
    await ingestActivities(db, {
      userId,
      sources: [watchSource({ contentFingerprint: "fp-2", avgHeartRate: 111, title: "Strength" })],
      strengthDetailsByProviderId: { [COROS_ID]: detailOf(lapsFor(s.build)) },
    });
    const [slotRow] = await db.select().from(plannedWorkouts);
    expect((await db.select().from(activities))[0]).toMatchObject({ title: slotRow!.title, sport: "strength", avgHeartRate: 111 });
    expect((await db.select().from(performedSessions)).map((p) => p.source)).toEqual(["watch_review"]);
  });

  it("a 300-set review saves under D1's bound-variable cap", async () => {
    const s = await sentSlot();
    await watchDone(s);
    const body = await reviewBody(s.workoutId);
    const many = Array.from({ length: 6 }, (_, k) => ({
      exerciseId: `coros:T90${10 + k}`,
      implement: null,
      format: null,
      perSide: false,
      sets: Array.from({ length: 50 }, (_, i) => ({ setIndex: i, side: null, reps: 5, seconds: null, load: { v: 20, u: "kg" as const }, done: true, flags: [] })),
    }));
    expect((await save({ ...body, entries: many })).status).toBe("saved");
    expect(await db.select().from(performedSets)).toHaveLength(300);
  });

  it("422: a sourceRef that is not the slot's matched activity, or a build that is not the locked one", async () => {
    const s = await sentSlot();
    await watchDone(s);
    const body = await reviewBody(s.workoutId);
    await expect(save({ ...body, sourceRef: "lbl-someone-else" })).rejects.toThrow("invalid_save");
    await expect(save({ ...body, buildId: "not-the-build" })).rejects.toThrow("invalid_save");
    await expect(save({ ...body, sourceRef: null })).rejects.toThrow("invalid_save");
    expect(await db.select().from(performedSessions).where(and(eq(performedSessions.source, "watch_review")))).toEqual([]);
  });

  it("the route: PUT /api/sessions/performed/:id within the budget, with its statements on record", async () => {
    const s = await sentSlot();
    await watchDone(s);
    const body = await reviewBody(s.workoutId);
    const { res, d1 } = await call("PUT", `performed/${body.id}`, { body });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "saved" });
    console.info(`[budget] PUT performed (watch_review, ${body.entries!.reduce((n, e) => n + e.sets.length, 0)} sets): ${d1} D1 + 0 COROS = ${d1}`);
    expect(d1).toBeLessThanOrEqual(BUDGET);
    // The client's own hash is the one kept (the outbox keys by it).
    const [row] = await db.select().from(performedSessions);
    expect(row!.payloadHash).toBe(await sha256Hex(canonicalJson(body)));
  });

  it("a review whose push job never existed but whose build was sent then failed still pairs with the locked build", async () => {
    const s = await sentSlot();
    await db.update(schema.corosWriteJobs).set({ status: "failed" }).where(eq(schema.corosWriteJobs.id, pushJobId(s.build.buildId)));
    await watchDone(s);
    expect((await watchReviewBasis(db, userId, s.workoutId, ctx())).buildId).toBe(s.build.buildId);
  });
});
