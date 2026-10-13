/**
 * Key results measured honestly from logged data (programme spec §3.6, Amendment A; principles §5.2, §2.9):
 *
 *  - hold_max / best_set read performed sets (app and watch sessions), and a set shows CAPACITY only when its item was
 *    a test (`dose.max` in the session's document) or the logged value went past the prescription — the player stops
 *    a timed hold at its prescription, so a hold logged at exactly the prescription is a lower bound (`capped`);
 *  - run_best scales a run up to 10 % longer than the distance to exactly the distance, and labels each point race,
 *    test or training; pace_at_hr reads runs in a heart-rate band; threshold_pace and predicted_time read the watch's
 *    daily threshold pace; check-ins and tests are not measured yet.
 *
 * Synthetic data only: a wall-sit-like hold series, squat sets typed in lb and kg, synthetic runs. Fixed dates.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { EXERCISES, makeEngineData } from "@rg/exercise-library";
import { Recorder, Review, Swapping, toPerformedSave, type Live, type RecorderMeta, type Step } from "@rg/session-engine";
import {
  addDays,
  keyResultMeasureSchema,
  newId,
  racePrediction,
  type KeyResultMeasureInput,
  type KeyResultUnit,
  type WorkoutDoc,
  type WorkoutItem,
} from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { measureKeyResult, measureKeyResults } from "../src/services/key-result-measures.js";
import { updateProfile } from "../src/services/profile.js";
import { setRows } from "../src/services/session-save.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const { activities, dailyHealth, performedSessions, performedSets, plannedWorkouts, sessionBuilds, workoutCompletionMatches } = schema;

const TODAY = "2026-10-10";
const T0 = "2026-10-10T12:00:00.000Z";
const LB = 0.45359237;

let db: Db;
let statements: string[];
let userId: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId } = await makeTestUser(db));
});

/** A measure as a key result would hold it (parsed: defaults filled), measured on TODAY. */
const measure = (m: object, ctx: { unit?: KeyResultUnit; raceDate?: string | null } = {}) =>
  measureKeyResult(db, userId, keyResultMeasureSchema.parse(m), { today: TODAY, ...ctx });

// ── Seeding ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function doc(items: WorkoutItem[], purpose: "main" | "run" = "main"): WorkoutDoc {
  return {
    version: 1,
    title: "Synthetic session",
    intent: { summary: "A synthetic session for the tests", goals: [], focus: [], effort: "maintain" },
    parts: [{ purpose, format: purpose === "run" ? "steady" : "straight", items }],
    source: { kind: "engine" },
  };
}
const hold = (libraryId: string, holdSec: number, max = false): WorkoutItem => ({
  kind: "exercise", libraryId, dose: { sets: 3, holdSec, ...(max ? { max: true as const } : {}) },
});
const lift = (libraryId: string, reps: number, kg?: number): WorkoutItem => ({
  kind: "exercise", libraryId, dose: { sets: 3, reps, ...(kg !== undefined ? { load: { typed: `${kg} kg`, kg } } : {}) },
});
const runItem = (effort: "race" | "easy", distanceM: number): WorkoutItem => ({ kind: "run", target: { distanceM }, effort });

async function planned(date: string, workoutDoc: WorkoutDoc | null = null, owner = userId): Promise<string> {
  const id = newId();
  await db.insert(plannedWorkouts).values({
    id, userId: owner, planId: "plan", sourceWorkoutId: id, title: "Synthetic", category: "strength", sport: "strength",
    originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "12:00", sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 1800, createdAt: T0, updatedAt: T0,
    // The column is JSON text, as the writers store it.
    workoutDoc: workoutDoc ? JSON.stringify(workoutDoc) : null,
  });
  return id;
}

type StepSeed = { kind: "timed" | "set"; exerciseId: string; seconds?: number; reps?: number; w?: { v: number; u: "lb" | "kg" } };

/** A stored build: `{ build: { steps }, view }`, the way session_builds.payload holds one; its document optional. */
async function build(workoutId: string, opts: { doc?: WorkoutDoc; steps?: StepSeed[]; locked?: boolean; version?: number } = {}): Promise<string> {
  const id = newId();
  const steps = (opts.steps ?? []).map((s, i) => ({
    kind: s.kind, slotKey: `core:${i}`, block: "core", exerciseId: s.exerciseId, side: null, setIndex: 0, setCount: 3,
    seconds: s.seconds ?? 40, prepGap: 8, format: { id: "straight", group: null, round: null }, why: [], isNew: false, log: true,
    target: s.kind === "set" ? { lo: 5, hi: 8, type: "reps", w: s.w ?? null, reps: s.reps ?? null, secs: null } : null,
  }));
  await db.insert(sessionBuilds).values({
    id, userId, workoutId, version: opts.version ?? 1, engineVersion: "test", inputsHash: "h",
    payload: { build: { steps, items: [], mode: "build", theme: null, minutes: 30 }, view: {} },
    workoutDoc: opts.doc ? JSON.stringify(opts.doc) : null,
    lockedAt: opts.locked === false ? null : T0, createdAt: T0,
  });
  return id;
}

async function session(
  date: string,
  opts: { source?: string; buildId?: string | null; workoutId?: string | null; activityId?: string | null; hash?: string; owner?: string; createdAt?: string } = {},
): Promise<string> {
  const id = newId();
  await db.insert(performedSessions).values({
    id, userId: opts.owner ?? userId, source: opts.source ?? "app", localDate: date, payloadHash: opts.hash ?? "h",
    buildId: opts.buildId ?? null, workoutId: opts.workoutId ?? null, activityId: opts.activityId ?? null,
    sourceRef: opts.source === "watch" ? newId() : null, createdAt: opts.createdAt ?? T0, updatedAt: T0,
  });
  return id;
}

async function sets(
  sessionId: string,
  exerciseId: string,
  rows: Array<{ seconds?: number; reps?: number; value?: number; unit?: "lb" | "kg"; done?: boolean; side?: "left" | "right"; setIndex?: number }>,
  entryIndex = 0,
): Promise<void> {
  await db.insert(performedSets).values(
    rows.map((r, i) => ({
      id: newId(), performedSessionId: sessionId, entryIndex, exerciseId, setIndex: r.setIndex ?? i, side: r.side ?? null,
      seconds: r.seconds ?? null, reps: r.reps ?? null,
      loadValue: r.value ?? null, loadUnit: r.unit ?? null,
      loadKg: r.value === undefined ? null : r.unit === "lb" ? r.value * LB : r.value,
      done: r.done ?? true,
    })),
  );
}

/** One app session on `date` played from a build whose document (or steps) prescribed it. */
async function appSession(date: string, prescription: { doc?: WorkoutDoc; steps?: StepSeed[] } | null): Promise<string> {
  if (!prescription) return session(date);
  const workoutId = await planned(date);
  const buildId = await build(workoutId, prescription);
  return session(date, { buildId, workoutId });
}

async function run(date: string, distanceM: number, durationSec: number, opts: { hr?: number; pace?: number | null; sport?: string; owner?: string; time?: string } = {}): Promise<string> {
  const id = newId();
  await db.insert(activities).values({
    id, userId: opts.owner ?? userId, sport: opts.sport ?? "run", startTime: `${date}T${opts.time ?? "14:00"}:00.000Z`, startTimeLocal: `${date}T${opts.time ?? "07:00"}:00`,
    durationSeconds: durationSec, distanceMeters: distanceM, avgHeartRate: opts.hr ?? null,
    avgPaceSecPerKm: opts.pace === undefined ? durationSec / (distanceM / 1000) : opts.pace, createdAt: T0, updatedAt: T0,
  });
  return id;
}

async function matchRun(activityId: string, workoutId: string): Promise<void> {
  await db.insert(workoutCompletionMatches).values({ id: newId(), workoutId, activityId, confidence: 1, method: "manual", matchedAt: T0 });
}

async function threshold(date: string, secPerKm: number | null, owner = userId): Promise<void> {
  await db.insert(dailyHealth).values({ id: `${owner}:${date}`, userId: owner, date, thresholdPaceSecPerKm: secPerKm, contentFingerprint: "fp", updatedAt: T0 });
}

const day = (n: number) => addDays(TODAY, -n);

// ── hold_max ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("hold_max", () => {
  const WALL_SIT = { kind: "hold_max", libraryIds: ["wallSit"] } as const;

  it("a hold logged at exactly its prescription is capped: current is a lower bound, every point flagged", async () => {
    for (const [n, secs] of [[20, 45], [13, 50], [6, 60]] as const) {
      await sets(await appSession(day(n), { doc: doc([hold("wallSit", secs)]) }), "wallSit", [{ seconds: secs }, { seconds: secs }]);
    }
    const p = await measure(WALL_SIT);
    expect(p).toMatchObject({ unit: "s", current: 60, evidence: "capped", sampleSize: 3, lastMeasuredAt: day(6) });
    expect(p.series.map((s) => [s.date, s.value, s.capped])).toEqual([[day(20), 45, true], [day(13), 50, true], [day(6), 60, true]]);
  });

  it("a test hold (dose.max in the session's document) is capacity even short of its target; three of them are measured", async () => {
    for (const [n, secs] of [[30, 70], [16, 80], [2, 95]] as const) {
      await sets(await appSession(day(n), { doc: doc([hold("wallSit", 120, true)]) }), "wallSit", [{ seconds: secs }]);
    }
    const p = await measure(WALL_SIT);
    expect(p).toMatchObject({ current: 95, evidence: "measured", sampleSize: 3, lastMeasuredAt: day(2) });
    expect(p.series.every((s) => s.capped === undefined)).toBe(true);
  });

  it("a hold past its prescription is capacity; one point is sparse", async () => {
    await sets(await appSession(day(5), { doc: doc([hold("wallSit", 45)]) }), "wallSit", [{ seconds: 45 }, { seconds: 52 }]);
    const p = await measure(WALL_SIT);
    expect(p).toMatchObject({ current: 52, evidence: "sparse", sampleSize: 1 });
    expect(p.series).toEqual([{ date: day(5), value: 52, display: 52 }]);
  });

  it("a hold one second past its prescription is still capped (watch laps round); two seconds past is capacity", async () => {
    await sets(await appSession(day(6), { doc: doc([hold("wallSit", 45)]) }), "wallSit", [{ seconds: 46 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 46, evidence: "capped" });
    await sets(await appSession(day(5), { doc: doc([hold("wallSit", 45)]) }), "wallSit", [{ seconds: 47 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 47, evidence: "sparse" });
  });

  it("a test hold logged at its window (within a second) stays capped — the timer stopped it; shorter is a true max, two seconds longer beat it", async () => {
    for (const [n, secs] of [[9, 60], [8, 61], [7, 59]] as const) {
      await sets(await appSession(day(n), { doc: doc([hold("wallSit", 60, true)]) }), "wallSit", [{ seconds: secs }]);
    }
    const capped = await measure(WALL_SIT);
    expect(capped).toMatchObject({ current: 61, evidence: "capped" });
    expect(capped.series.every((s) => s.capped === true)).toBe(true);

    await sets(await appSession(day(6), { doc: doc([hold("wallSit", 60, true)]) }), "wallSit", [{ seconds: 45 }]);
    await sets(await appSession(day(5), { doc: doc([hold("wallSit", 60, true)]) }), "wallSit", [{ seconds: 62 }]);
    const p = await measure(WALL_SIT);
    expect(p).toMatchObject({ current: 62, evidence: "sparse" });
    expect(p.series.map((s) => [s.value, s.capped ?? false])).toEqual([[60, true], [61, true], [59, true], [45, false], [62, false]]);
  });

  it("an item marked as a key-result test counts as a test, as dose.max does", async () => {
    const marked: WorkoutItem = { kind: "exercise", libraryId: "wallSit", dose: { sets: 1, holdSec: 90 }, test: { keyResultId: "kr-1" } };
    await sets(await appSession(day(4), { doc: doc([marked]) }), "wallSit", [{ seconds: 75 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 75, evidence: "sparse" });
  });

  it("a later capped hold longer than every tested one is the current, and says capped", async () => {
    await sets(await appSession(day(40), { doc: doc([hold("wallSit", 30, true)]) }), "wallSit", [{ seconds: 45 }]);
    await sets(await appSession(day(3), { doc: doc([hold("wallSit", 60)]) }), "wallSit", [{ seconds: 60 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 60, evidence: "capped", sampleSize: 2 });
  });

  it("with no document, the build's own timed steps are the prescription", async () => {
    await sets(await appSession(day(9), { steps: [{ kind: "timed", exerciseId: "wallSit", seconds: 40 }] }), "wallSit", [{ seconds: 40 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 40, evidence: "capped" });
    await sets(await appSession(day(8), { steps: [{ kind: "timed", exerciseId: "wallSit", seconds: 40 }] }), "wallSit", [{ seconds: 55 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 55, evidence: "sparse" });
  });

  it("a move swapped into a slot mid-session (a planned alternate, a library offer) is judged by its slot: a max there is a max", async () => {
    const SPLIT = { kind: "hold_max", libraryIds: ["splitSquatHold"] } as const;
    /** A document build whose wall-sit slot (to max, or not) offers the split squat hold, its window 60 s. */
    const swapped = async (n: number, max: boolean, list: "alternates" | "offers") => {
      const workoutId = await planned(day(n));
      const option = {
        id: "splitSquatHold", name: "Split squat hold", reasons: [], moveKey: "k", pairing: {},
        steps: [{ kind: "timed", slotKey: "core:0", exerciseId: "splitSquatHold", seconds: 60 }],
      };
      const buildId = newId();
      await db.insert(sessionBuilds).values({
        id: buildId, userId, workoutId, version: 1, engineVersion: "doc-build-3", inputsHash: "h",
        payload: {
          build: {
            steps: [{ kind: "timed", slotKey: "core:0", exerciseId: "wallSit", seconds: 60 }],
            fromDoc: { rev: 1, swaps: [], blocked: [], slots: { "core:0": { ...(max ? { max: true } : {}), [list]: [option] } } },
          },
          view: {},
        },
        workoutDoc: JSON.stringify(doc([hold("wallSit", 60, max)])),
        lockedAt: T0, createdAt: T0,
      });
      return session(day(n), { buildId, workoutId });
    };
    // Held 45 s of a 60 s target to max: where the athlete stopped is the result.
    await sets(await swapped(6, true, "alternates"), "splitSquatHold", [{ seconds: 45 }]);
    expect(await measure(SPLIT)).toMatchObject({ current: 45, evidence: "sparse" });
    // An offer swapped in, to max, held at its window: the timer stopped it — capped.
    await sets(await swapped(5, true, "offers"), "splitSquatHold", [{ seconds: 60 }]);
    expect((await measure(SPLIT)).series.map((s) => [s.value, s.capped ?? false])).toEqual([[45, false], [60, true]]);
    // Not to max: past the slot's window by two seconds or more is capacity; at it, capped.
    await sets(await swapped(4, false, "alternates"), "splitSquatHold", [{ seconds: 63 }]);
    expect((await measure(SPLIT)).series.map((s) => [s.value, s.capped ?? false])).toEqual([[45, false], [60, true], [63, false]]);
  });

  it("a set held a side at a time (a row per side under one number) is one set at its shorter side, as history reads it", async () => {
    const s = await appSession(day(3), { doc: doc([hold("wallSit", 40, true)]) });
    await sets(s, "wallSit", [
      { seconds: 70, side: "left", setIndex: 0 }, { seconds: 50, side: "right", setIndex: 0 }, { seconds: 30, setIndex: 1 },
      // One side only (the other skipped): it measures nothing (whole-branch I-2), never a 90 s hold.
      { seconds: 90, side: "left", setIndex: 2 },
    ]);
    const p = await measure(WALL_SIT);
    expect(p).toMatchObject({ current: 50, sampleSize: 1 });
    expect(p.series).toEqual([{ date: day(3), value: 50, display: 50 }]);
  });

  it("a move offered in two slots is judged by the slot at the set's place among the session's moves; with none there, a slot to max wins", async () => {
    const SPLIT = { kind: "hold_max", libraryIds: ["splitSquatHold"] } as const;
    const option = (slotKey: string, seconds: number) => ({
      id: "splitSquatHold", name: "Split squat hold", reasons: [], moveKey: "k", pairing: {},
      steps: [{ kind: "timed", slotKey, exerciseId: "splitSquatHold", seconds }],
    });
    /** core:0 (the wall sit, to max, 60 s) and core:1 (the plank, 40 s) both offer the split squat hold. */
    const twoSlots = async (n: number) => {
      const workoutId = await planned(day(n));
      const buildId = newId();
      await db.insert(sessionBuilds).values({
        id: buildId, userId, workoutId, version: 1, engineVersion: "doc-build-3", inputsHash: "h",
        payload: {
          build: {
            // Two sets of the wall sit, then the plank: the moves' places are 0 and 1 (a move counts once, where it is
            // first played).
            steps: [
              { kind: "timed", slotKey: "core:0", exerciseId: "wallSit", seconds: 60, log: true },
              { kind: "rest", slotKey: "core:0", exerciseId: null, seconds: 30, log: false },
              { kind: "timed", slotKey: "core:0", exerciseId: "wallSit", seconds: 60, log: true },
              { kind: "timed", slotKey: "core:1", exerciseId: "sidePlank", seconds: 40, log: true },
            ],
            fromDoc: { rev: 1, swaps: [], blocked: [], slots: { "core:0": { max: true, offers: [option("core:0", 60)] }, "core:1": { offers: [option("core:1", 40)] } } },
          },
          view: {},
        },
        workoutDoc: JSON.stringify(doc([hold("wallSit", 60, true), hold("sidePlank", 40)])),
        lockedAt: T0, createdAt: T0,
      });
      return session(day(n), { buildId, workoutId });
    };
    const capped = async () => (await measure(SPLIT)).series.map((s) => s.capped ?? false);
    // Saved under the second move's entry: played in core:1 (not to max, 40 s) — 41 s is at its window, capped.
    await sets(await twoSlots(6), "splitSquatHold", [{ seconds: 41 }], 1);
    expect(await capped()).toEqual([true]);
    // Under the first's: core:0, to max at 60 s — 41 s is where the athlete stopped, capacity.
    await sets(await twoSlots(5), "splitSquatHold", [{ seconds: 41 }], 0);
    expect(await capped()).toEqual([true, false]);
    // At no slot's place: every slot offering it, the one to max winning — capacity.
    await sets(await twoSlots(4), "splitSquatHold", [{ seconds: 41 }], 7);
    expect(await capped()).toEqual([true, false, false]);
  });

  describe("a swapped-in move is judged by the slot its session saved it in, however its entry's index drifted (Stage 2 minors)", () => {
    const SPLIT = { kind: "hold_max", libraryIds: ["splitSquatHold"] } as const;
    const engine = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: [...EXERCISES] });
    const timed = (slotKey: string, exerciseId: string, seconds: number, setIndex = 0, setCount = 1): Step => ({
      kind: "timed", slotKey, block: "core", exerciseId, side: null, setIndex, setCount, seconds, prepGap: 8, target: null,
      format: { id: "holds", group: null, round: null }, why: [], isNew: false, log: true,
    });
    const rest = (slotKey: string): Step => ({ ...timed(slotKey, "", 30), kind: "rest", exerciseId: null, setIndex: null, setCount: null, log: false });
    /** The split squat hold's steps in a slot: `sets` of them at the slot's window, rests between. */
    const splitSteps = (slotKey: string, seconds: number, sets: number): Step[] =>
      Array.from({ length: sets }, (_, i) => timed(slotKey, "splitSquatHold", seconds, i, sets)).flatMap((s, i) => (i === 0 ? [s] : [rest(slotKey), s]));
    /**
     * A document build — core:0 a side plank (40 s, `planks` sets), core:1 a wall sit to max (60 s), each slot offering
     * the split squat hold at its own window — played through the recorder by `play` (with ⇄ as the player's
     * `swapSlot` does it), and saved as the server saves a session (`toPerformedSave`, then `setRows`).
     */
    const played = async (n: number, planks: 1 | 2, play: (live: Live, swap: (live: Live, i: number, slotKey: string) => Live) => Live) => {
      const workoutId = await planned(day(n));
      const steps = [...splitSteps("core:0", 40, planks).map((s) => ({ ...s, exerciseId: s.exerciseId && "sidePlank" })), timed("core:1", "wallSit", 60)];
      const offers = { "core:0": splitSteps("core:0", 40, planks), "core:1": splitSteps("core:1", 60, 1) };
      const option = (slotKey: keyof typeof offers) => ({ id: "splitSquatHold", name: "Split squat hold", reasons: [], moveKey: "k", pairing: {}, steps: offers[slotKey] });
      const buildId = newId();
      await db.insert(sessionBuilds).values({
        id: buildId, userId, workoutId, version: 1, engineVersion: "doc-build-3", inputsHash: "h",
        payload: {
          build: { steps, fromDoc: { rev: 1, swaps: [], blocked: [], slots: { "core:0": { offers: [option("core:0")] }, "core:1": { max: true, offers: [option("core:1")] } } } },
          view: {},
        },
        workoutDoc: JSON.stringify(doc([{ kind: "exercise", libraryId: "sidePlank", dose: { sets: planks, holdSec: 40 } }, hold("wallSit", 60, true)])),
        lockedAt: T0, createdAt: T0,
      });
      const id = newId();
      const meta: RecorderMeta = {
        id, startedAt: T0, date: day(n), mode: "build", theme: null, locationId: "home", minutes: 30, block: null, checks: {},
        equipment: [], plannedSeconds: 0, newMove: null,
      };
      const swap = (live: Live, i: number, slotKey: string): Live => {
        const spliced = Swapping.splice(live.plan.steps, slotKey, offers[slotKey as keyof typeof offers]);
        return Recorder.rebase(engine, live, { steps: spliced, plannedSeconds: Swapping.costOf(spliced) }, i, slotKey);
      };
      const live = play(Recorder.create(engine, { steps, plannedSeconds: 0 }, meta), swap);
      const wire = toPerformedSave(Recorder.toSession(live, { endedAt: T0 }), Review.pending(Review.start(), []), { source: "app", workoutId, buildId });
      await db.insert(performedSessions).values({
        id, userId, source: "app", localDate: day(n), payloadHash: "h", buildId, workoutId, movesDone: wire.movesDone, createdAt: T0, updatedAt: T0,
      });
      await db.insert(performedSets).values(setRows(id, wire));
      return wire;
    };
    const capped = async () => (await measure(SPLIT)).series.map((s) => s.capped ?? false);

    it("shifted down: the move before it, never done, is dropped at save", async () => {
      // The side plank skipped, the wall sit's slot swapped and held to max 41 s. Saved as the first entry — the side
      // plank's place — it was played in core:1, to max at 60 s: a true max.
      const down = await played(6, 1, (live, swap) => {
        Recorder.reach(live, 0);
        Recorder.finishTimed(live, 0, 5);
        Recorder.reach(live, 1);
        const swapped = swap(live, 1, "core:1");
        Recorder.reach(swapped, 1);
        Recorder.finishTimed(swapped, 1, 41, { toMax: true, done: true });
        return swapped;
      });
      expect(down.entries.map((e) => e.exerciseId)).toEqual(["splitSquatHold"]);
      expect(await capped()).toEqual([false]);
    });

    it("shifted up: swapped in after its slot's first set, its entry after the move it replaced", async () => {
      // The side plank's first set held, its second swapped for the split squat hold and held to its 40 s window, then
      // the wall sit. Saved as the second entry — the wall sit's place — it was played in core:0, at its window: capped.
      const up = await played(5, 2, (live, swap) => {
        Recorder.reach(live, 0);
        Recorder.finishTimed(live, 0, 40);
        Recorder.reach(live, 1);
        Recorder.reach(live, 2);
        const swapped = swap(live, 2, "core:0");
        Recorder.reach(swapped, 2);
        Recorder.finishTimed(swapped, 2, 40);
        Recorder.reach(swapped, 3);
        Recorder.finishTimed(swapped, 3, 70, { toMax: true, done: true });
        return swapped;
      });
      expect(up.entries.map((e) => e.exerciseId)).toEqual(["sidePlank", "splitSquatHold", "wallSit"]);
      expect(await capped()).toEqual([true]);
    });
  });

  it("a set with no known prescription (no build, no document) is capped — nothing says it was a max", async () => {
    await sets(await appSession(day(4), null), "wallSit", [{ seconds: 90 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 90, evidence: "capped" });
  });

  it("a watch session is judged by its workout's locked build, or the planned row's document", async () => {
    const sentId = await planned(day(12));
    await build(sentId, { steps: [{ kind: "timed", exerciseId: "wallSit", seconds: 30 }], version: 1 });
    await build(sentId, { steps: [{ kind: "timed", exerciseId: "wallSit", seconds: 90 }], version: 2, locked: false });
    await sets(await session(day(12), { source: "watch", workoutId: sentId }), "wallSit", [{ seconds: 45 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 45, evidence: "sparse" });

    const plannedId = await planned(day(11), doc([hold("wallSit", 60, true)]));
    await sets(await session(day(11), { source: "watch", workoutId: plannedId }), "wallSit", [{ seconds: 70 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 70, evidence: "sparse", sampleSize: 2 });
  });

  it("reads only the window, this account's done sets, and sessions that are written", async () => {
    const tested = () => ({ doc: doc([hold("wallSit", 30, true)]) });
    await sets(await appSession(day(89), tested()), "wallSit", [{ seconds: 40 }]);
    await sets(await appSession(day(90), tested()), "wallSit", [{ seconds: 200 }]);
    await sets(await appSession(day(-1), tested()), "wallSit", [{ seconds: 201 }]);
    await sets(await appSession(day(3), tested()), "wallSit", [{ seconds: 202, done: false }]);
    await sets(await appSession(day(3), tested()), "wallSitSingleLegShift", [{ seconds: 203 }]);
    await sets(await session(day(3), { source: "watch", hash: "pending", workoutId: await planned(day(3), doc([hold("wallSit", 30, true)])) }), "wallSit", [{ seconds: 204 }]);
    const { userId: other } = await makeTestUser(db);
    await sets(await session(day(3), { owner: other }), "wallSit", [{ seconds: 205 }]);

    expect(await measure(WALL_SIT)).toMatchObject({ current: 40, sampleSize: 1, lastMeasuredAt: day(89) });
    expect(await measure({ ...WALL_SIT, windowDays: 7 })).toMatchObject({ current: null, evidence: "none", sampleSize: 0, missing: expect.any(String) });
  });

  it("measured together, each measure keeps its own window", async () => {
    const tested = () => ({ doc: doc([hold("wallSit", 30, true)]) });
    await sets(await appSession(day(40), tested()), "wallSit", [{ seconds: 80 }]);
    await sets(await appSession(day(3), tested()), "wallSit", [{ seconds: 50 }]);
    const [week, quarter] = await measureKeyResults(
      db,
      userId,
      [{ measure: keyResultMeasureSchema.parse({ ...WALL_SIT, windowDays: 7 }) }, { measure: keyResultMeasureSchema.parse(WALL_SIT) }],
      { today: TODAY },
    );
    expect(week).toMatchObject({ current: 50, sampleSize: 1 });
    expect(quarter).toMatchObject({ current: 80, sampleSize: 2 });
  });

  it("one physical session counts once: the app's own record over the watch's copy of the same activity", async () => {
    const workoutId = await planned(day(5), doc([hold("wallSit", 30, true)]));
    const appId = await session(day(5), { source: "app", workoutId, activityId: "act-1", createdAt: "2026-10-05T13:00:00.000Z" });
    const watchId = await session(day(5), { source: "watch", workoutId, activityId: "act-1", createdAt: "2026-10-05T12:00:00.000Z" });
    await sets(appId, "wallSit", [{ seconds: 61 }]);
    await sets(watchId, "wallSit", [{ seconds: 75 }]);
    expect(await measure(WALL_SIT)).toMatchObject({ current: 61, sampleSize: 1 });
  });

  it("answers in the key result's unit too", async () => {
    await sets(await appSession(day(5), { doc: doc([hold("wallSit", 60, true)]) }), "wallSit", [{ seconds: 90 }]);
    const p = await measure(WALL_SIT, { unit: "min" });
    expect(p.display).toEqual({ unit: "min", current: 1.5 });
    expect(p.series[0]).toMatchObject({ value: 90, display: 1.5 });
  });
});

// ── best_set ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("best_set", () => {
  const SQUAT = { kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm" } as const;

  it("Epley e1RM from sets typed in lb and kg, compared in kg; a single is its own load; unloaded sets ignored", async () => {
    const s1 = await appSession(day(10), { doc: doc([lift("gobletSquat", 5, 61)]) });
    await sets(s1, "gobletSquat", [{ reps: 7, value: 135, unit: "lb" }]); // 61.23 kg × (1 + 7/30) = 75.55
    const s2 = await appSession(day(4), { doc: doc([lift("gobletSquat", 3, 70)]) });
    await sets(s2, "gobletSquat", [{ reps: 4, value: 70, unit: "kg" }, { reps: 20 }]); // 70 × (1 + 4/30) = 79.33
    const s3 = await appSession(day(2), { doc: doc([lift("gobletSquat", 1, 75)]) });
    await sets(s3, "gobletSquat", [{ reps: 1, value: 80, unit: "kg" }]); // a single: 80

    const p = await measure(SQUAT);
    expect(p).toMatchObject({ unit: "kg", current: 80, evidence: "measured", sampleSize: 3 });
    expect(p.series.map((s) => s.value)).toEqual([75.5, 79.3, 80]);
    expect((await measure(SQUAT, { unit: "lb" })).display).toEqual({ unit: "lb", current: 176.4 });
  });

  it("a set done exactly as prescribed is capped; more reps or more load than prescribed is capacity", async () => {
    await sets(await appSession(day(9), { doc: doc([lift("gobletSquat", 5, 60)]) }), "gobletSquat", [{ reps: 5, value: 60, unit: "kg" }]);
    expect(await measure(SQUAT)).toMatchObject({ current: 70, evidence: "capped" });

    await sets(await appSession(day(8), { doc: doc([lift("gobletSquat", 5, 50)]) }), "gobletSquat", [{ reps: 5, value: 55, unit: "kg" }]);
    // 55 × (1 + 5/30) = 64.17: capacity, but below the capped 70 — the current stays the capped lower bound.
    expect(await measure(SQUAT)).toMatchObject({ current: 70, evidence: "capped" });

    await sets(await appSession(day(7), { doc: doc([lift("gobletSquat", 5, 60)]) }), "gobletSquat", [{ reps: 8, value: 60, unit: "kg" }]);
    expect(await measure(SQUAT)).toMatchObject({ current: 76, evidence: "sparse" });
  });

  it("the build's set steps are the prescription when there is no document; a test (reps to max) is capacity", async () => {
    await sets(
      await appSession(day(6), { steps: [{ kind: "set", exerciseId: "gobletSquat", reps: 8, w: { v: 100, u: "lb" } }] }),
      "gobletSquat",
      [{ reps: 8, value: 100, unit: "lb" }],
    );
    expect(await measure(SQUAT)).toMatchObject({ evidence: "capped" });
    const maxReps: WorkoutItem = { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1, reps: 5, max: true, load: { typed: "100 lb", kg: 45.36 } } };
    await sets(await appSession(day(5), { doc: doc([maxReps]) }), "gobletSquat", [{ reps: 10, value: 100, unit: "lb" }]);
    // The test: 45.36 kg × (1 + 10/30) = 60.5, above the capped set's 45.36 × (1 + 8/30) = 57.5.
    expect(await measure(SQUAT)).toMatchObject({ evidence: "sparse", current: 60.5 });
  });

  it("load at reps: the heaviest load lifted for at least that many reps", async () => {
    const tested = { doc: doc([{ kind: "exercise", libraryId: "gobletSquat", dose: { reps: 5, max: true } } as WorkoutItem]) };
    await sets(await appSession(day(6), tested), "gobletSquat", [{ reps: 5, value: 135, unit: "lb" }, { reps: 4, value: 155, unit: "lb" }, { reps: 6, value: 62, unit: "kg" }]);
    const p = await measure({ kind: "best_set", libraryIds: ["gobletSquat"], metric: "load_at_reps", reps: 5 });
    expect(p).toMatchObject({ unit: "kg", current: 62, evidence: "sparse" });
  });

  it("reps at load: the most reps at that load or heavier", async () => {
    const tested = { doc: doc([{ kind: "exercise", libraryId: "gobletSquat", dose: { reps: 5, max: true } } as WorkoutItem]) };
    await sets(await appSession(day(6), tested), "gobletSquat", [{ reps: 12, value: 39, unit: "kg" }, { reps: 9, value: 40, unit: "kg" }, { reps: 7, value: 100, unit: "lb" }]);
    const p = await measure({ kind: "best_set", libraryIds: ["gobletSquat"], metric: "reps_at_load", loadKg: 40 });
    expect(p).toMatchObject({ unit: "reps", current: 9, evidence: "sparse" });
  });

  it("e1RM leaves out sets of more than 12 reps (Epley is no estimate there)", async () => {
    const tested = { doc: doc([{ kind: "exercise", libraryId: "gobletSquat", dose: { reps: 5, max: true } } as WorkoutItem]) };
    await sets(await appSession(day(6), tested), "gobletSquat", [{ reps: 20, value: 40, unit: "kg" }, { reps: 12, value: 45, unit: "kg" }]);
    // 20 × 40 kg would read 66.7; 12 × 45 kg is 63.
    expect(await measure(SQUAT)).toMatchObject({ current: 63 });
  });

  describe("past the prescription on the measure's own dimension", () => {
    const PRESCRIBED = () => ({ doc: doc([lift("gobletSquat", 5, 100)]) }); // 5 @ 100 kg

    it("reps at load: more load than prescribed is no more reps — capped; more reps is capacity", async () => {
      for (const n of [7, 5, 3]) await sets(await appSession(day(n), PRESCRIBED()), "gobletSquat", [{ reps: 5, value: 105, unit: "kg" }]);
      const REPS_AT_100 = { kind: "best_set", libraryIds: ["gobletSquat"], metric: "reps_at_load", loadKg: 100 };
      expect(await measure(REPS_AT_100)).toMatchObject({ current: 5, evidence: "capped" });
      await sets(await appSession(day(2), PRESCRIBED()), "gobletSquat", [{ reps: 7, value: 100, unit: "kg" }]);
      expect(await measure(REPS_AT_100)).toMatchObject({ current: 7, evidence: "sparse" });
    });

    it("load at reps: more reps than prescribed is no more load — capped; more load is capacity", async () => {
      for (const n of [7, 5, 3]) await sets(await appSession(day(n), PRESCRIBED()), "gobletSquat", [{ reps: 8, value: 100, unit: "kg" }]);
      const LOAD_FOR_5 = { kind: "best_set", libraryIds: ["gobletSquat"], metric: "load_at_reps", reps: 5 };
      expect(await measure(LOAD_FOR_5)).toMatchObject({ current: 100, evidence: "capped" });
      await sets(await appSession(day(2), PRESCRIBED()), "gobletSquat", [{ reps: 5, value: 110, unit: "kg" }]);
      expect(await measure(LOAD_FOR_5)).toMatchObject({ current: 110, evidence: "sparse" });
    });

    it("e1RM: past the prescription on either dimension is capacity", async () => {
      await sets(await appSession(day(7), PRESCRIBED()), "gobletSquat", [{ reps: 5, value: 105, unit: "kg" }]);
      await sets(await appSession(day(5), PRESCRIBED()), "gobletSquat", [{ reps: 7, value: 100, unit: "kg" }]);
      await sets(await appSession(day(3), PRESCRIBED()), "gobletSquat", [{ reps: 6, value: 102.5, unit: "kg" }]);
      expect(await measure(SQUAT)).toMatchObject({ evidence: "measured", sampleSize: 3, current: 123.3 });
    });
  });

  it("several moves count together", async () => {
    await sets(await appSession(day(6), null), "gobletSquat", [{ reps: 5, value: 60, unit: "kg" }]);
    await sets(await appSession(day(5), null), "boxSquat", [{ reps: 5, value: 66, unit: "kg" }]);
    expect(await measure({ kind: "best_set", libraryIds: ["gobletSquat", "boxSquat"], metric: "load_at_reps", reps: 5 })).toMatchObject({ current: 66, sampleSize: 2 });
  });
});

// ── run_best ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("run_best", () => {
  const TEN_K = { kind: "run_best", distanceM: 10000 } as const;

  it("the fastest run at least the distance and at most 10 % longer, its time scaled to exactly the distance", async () => {
    await run(day(30), 10000, 3000);
    await run(day(20), 10800, 3120); // 3120 × 10000 / 10800 = 2888.9
    await run(day(10), 11500, 3105); // 15 % over: skipped
    await run(day(5), 9500, 2500); // short: skipped
    await run(day(4), 10500, 3100, { sport: "bike" });
    const { userId: other } = await makeTestUser(db);
    await run(day(3), 10000, 2000, { owner: other });
    await run(day(181), 10000, 2100); // outside the 180-day window

    const p = await measure(TEN_K);
    expect(p).toMatchObject({ unit: "s", current: 2889, sampleSize: 2, evidence: "sparse", lastMeasuredAt: day(20) });
    expect(p.series.map((s) => [s.date, s.value])).toEqual([[day(30), 3000], [day(20), 2889]]);
  });

  it("labels each point from the matched document: race effort on a race day is a race, elsewhere a test; the rest training", async () => {
    await updateProfile(db, userId, { events: [{ label: "Autumn 10K", kind: "race", start: day(14), priority: "A", taper: true }] }, T0);
    const raceDay = await run(day(14), 10050, 2950);
    await matchRun(raceDay, await planned(day(14), doc([runItem("race", 10000)], "run")));
    const timeTrial = await run(day(40), 10000, 3010);
    await matchRun(timeTrial, await planned(day(40), doc([runItem("race", 10000)], "run")));
    const easy = await run(day(60), 10000, 3500);
    await matchRun(easy, await planned(day(60), doc([runItem("easy", 10000)], "run")));
    await run(day(70), 10000, 3600); // no match

    const p = await measure(TEN_K);
    expect(p.series.map((s) => [s.date, s.label])).toEqual([[day(70), "training"], [day(60), "training"], [day(40), "test"], [day(14), "race"]]);
    expect(p).toMatchObject({ current: 2935, evidence: "measured" }); // 2950 × 10000 / 10050
  });

  it("a race-effort stretch shorter than the distance makes no time trial of the run", async () => {
    const tempo = await run(day(30), 10000, 3100);
    await matchRun(tempo, await planned(day(30), doc([runItem("easy", 5000), runItem("race", 5000)], "run")));
    const trial = await run(day(20), 10000, 3050);
    await matchRun(trial, await planned(day(20), doc([runItem("easy", 2000), runItem("race", 10000)], "run")));
    const p = await measure(TEN_K);
    expect(p.series.map((s) => [s.date, s.label])).toEqual([[day(30), "training"], [day(20), "test"]]);
  });

  it("a run on the race hub's race day (passed in, never re-read) with no document is the race", async () => {
    await run(day(8), 10000, 2990);
    statements.length = 0;
    expect((await measure(TEN_K, { raceDate: day(8) })).series[0]).toMatchObject({ label: "race" });
    expect(statements.some((s) => /user_preferences/.test(s))).toBe(false);
  });

  it("none, saying so, when no run qualifies", async () => {
    await run(day(8), 5000, 1500);
    expect(await measure(TEN_K)).toMatchObject({ current: null, evidence: "none", sampleSize: 0, series: [], lastMeasuredAt: null, missing: expect.any(String) });
  });
});

// ── pace_at_hr ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("pace_at_hr", () => {
  const BAND = { kind: "pace_at_hr", hrLow: 140, hrHigh: 150 } as const;

  it("a pace per run long enough with its average heart rate in the band; the current is the median of the latest three", async () => {
    await run(day(40), 8000, 3200, { hr: 145 }); // 400 s/km
    await run(day(30), 8000, 3040, { hr: 150 }); // 380
    await run(day(20), 6000, 2040, { hr: 140, pace: null }); // computed: 340
    await run(day(10), 7000, 2450, { hr: 148 }); // 350
    await run(day(9), 3000, 1000, { hr: 145 }); // too short (1000 s)
    await run(day(8), 8000, 2600, { hr: 155 }); // out of band
    await run(day(7), 8000, 2600, { hr: 139 }); // out of band
    await run(day(6), 8000, 2600); // no heart rate

    const p = await measure(BAND);
    expect(p.series.map((s) => [s.date, s.value])).toEqual([[day(40), 400], [day(30), 380], [day(20), 340], [day(10), 350]]);
    // The latest three (380, 340, 350): 350 — every run's median would be 365.
    expect(p).toMatchObject({ unit: "s/km", current: 350, sampleSize: 4, evidence: "measured", lastMeasuredAt: day(10) });
    expect((await measure(BAND, { unit: "s/mi" })).display).toEqual({ unit: "s/mi", current: 563 });
  });

  it("honours the minimum duration", async () => {
    await run(day(10), 4000, 1400, { hr: 145 });
    expect(await measure({ ...BAND, minDurationSec: 1500 })).toMatchObject({ evidence: "none" });
    expect(await measure({ ...BAND, minDurationSec: 1200 })).toMatchObject({ evidence: "sparse", current: 350 });
  });
});

// ── threshold_pace, predicted_time ───────────────────────────────────────────────────────────────────────────────────

describe("threshold_pace and predicted_time", () => {
  it("the watch's threshold pace, day by day; the current is the latest", async () => {
    await threshold(day(50), 290);
    await threshold(day(20), 285);
    await threshold(day(10), null);
    await threshold(day(2), 281);
    await threshold(day(95), 300);
    const { userId: other } = await makeTestUser(db);
    await threshold(day(1), 250, other);
    const p = await measure({ kind: "threshold_pace" });
    expect(p.series.map((s) => [s.date, s.value])).toEqual([[day(50), 290], [day(20), 285], [day(2), 281]]);
    expect(p).toMatchObject({ unit: "s/km", current: 281, evidence: "measured", lastMeasuredAt: day(2) });
  });

  it("the race hub's prediction for the distance from each day's threshold pace", async () => {
    await threshold(day(20), 290);
    await threshold(day(2), 281);
    const p = await measure({ kind: "predicted_time", distanceM: 21097.5 });
    const expected = (ltsp: number) => racePrediction(ltsp, 21.0975)!.fastSeconds;
    expect(p.series.map((s) => s.value)).toEqual([expected(290), expected(281)]);
    expect(p).toMatchObject({ unit: "s", current: expected(281), evidence: "sparse" });
  });

  it("none with a plain note when the watch has sent no threshold pace", async () => {
    for (const m of [{ kind: "threshold_pace" }, { kind: "predicted_time", distanceM: 5000 }] as const) {
      expect(await measure(m)).toMatchObject({ current: null, evidence: "none", missing: expect.stringMatching(/threshold pace/i) });
    }
  });
});

// ── checkin, test ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("checkin and test", () => {
  it("are not measured yet (Stage 4) and read nothing", async () => {
    statements.length = 0;
    expect(await measure({ kind: "checkin", questionId: "energy" })).toMatchObject({ current: null, evidence: "none", missing: expect.any(String) });
    expect(await measure({ kind: "test", testId: "wall-sit-test" })).toMatchObject({ current: null, evidence: "none", missing: expect.any(String) });
    expect(statements).toEqual([]);
  });
});

// ── Budget ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("budget", () => {
  it("every kind at once over 150 sessions and 150 runs stays well within 45 statements, under D1's bind cap, never SELECT *", async () => {
    for (let n = 0; n < 150; n += 1) {
      const workoutId = await planned(day(n), doc([hold("wallSit", 30, true), lift("gobletSquat", 5, 60)]));
      const buildId = await build(workoutId, { steps: [{ kind: "timed", exerciseId: "wallSit", seconds: 30 }] });
      const id = await session(day(n), { buildId, workoutId });
      await sets(id, "wallSit", [{ seconds: 30 + (n % 7) }]);
      await sets(id, "gobletSquat", [{ reps: 5, value: 60, unit: "kg" }]);
      const act = await run(day(n), 10000 + n, 3000 + n, { hr: 145 });
      await matchRun(act, workoutId);
      await threshold(day(n), 280 + (n % 5));
    }
    const all = (
      [
        { kind: "hold_max", libraryIds: ["wallSit"], windowDays: 365 },
        { kind: "best_set", libraryIds: ["gobletSquat", "boxSquat"], metric: "e1rm", windowDays: 365 },
        { kind: "best_set", libraryIds: ["gobletSquat"], metric: "load_at_reps", reps: 5 },
        { kind: "run_best", distanceM: 10000, windowDays: 365 },
        { kind: "pace_at_hr", hrLow: 140, hrHigh: 150, windowDays: 365 },
        { kind: "threshold_pace", windowDays: 365 },
        { kind: "predicted_time", distanceM: 42195, windowDays: 365 },
        { kind: "checkin", questionId: "energy" },
      ] as KeyResultMeasureInput[]
    ).map((m) => ({ measure: keyResultMeasureSchema.parse(m) }));
    statements.length = 0;
    const out = await measureKeyResults(db, userId, all, { today: TODAY });
    expect(out).toHaveLength(8);
    expect(out[0]).toMatchObject({ current: 36, evidence: "measured", sampleSize: 150 });
    expect(out[3]).toMatchObject({ sampleSize: 150, evidence: "measured" });
    expect(statements.length).toBeLessThanOrEqual(20);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(statements.some((s) => /select \*/i.test(s))).toBe(false);
  });

  it("a year of 600 sessions reads in the same statements as a month of 30: prescriptions come through the window, not id lists", async () => {
    const seed = async (from: number, to: number): Promise<void> => {
      for (let i = from; i < to; i += 1) {
        const date = day(i % 365);
        const workoutId = await planned(date, i % 3 === 0 ? doc([hold("wallSit", 30, true), lift("gobletSquat", 5, 60)]) : null);
        if (i % 4 === 0) {
          // A watch session: no build of its own; its workout's locked build was sent.
          await build(workoutId, { steps: [{ kind: "timed", exerciseId: "wallSit", seconds: 30 }] });
          const id = await session(date, { source: "watch", workoutId });
          await sets(id, "wallSit", [{ seconds: 30 + (i % 9) }]);
          continue;
        }
        const buildId = await build(workoutId, i % 2 === 0 ? { doc: doc([lift("gobletSquat", 5, 60)]) } : { steps: [{ kind: "set", exerciseId: "gobletSquat", reps: 5, w: { v: 60, u: "kg" } }] });
        const id = await session(date, { buildId, workoutId });
        await sets(id, "gobletSquat", [{ reps: 5 + (i % 4), value: 60, unit: "kg" }]);
        await sets(id, "wallSit", [{ seconds: 40 }]);
      }
    };
    const year = () =>
      measureKeyResults(
        db,
        userId,
        [
          { measure: keyResultMeasureSchema.parse({ kind: "hold_max", libraryIds: ["wallSit"], windowDays: 365 }) },
          { measure: keyResultMeasureSchema.parse({ kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm", windowDays: 365 }) },
        ],
        { today: TODAY },
      );
    await seed(0, 30);
    statements.length = 0;
    await year();
    const month = statements.length;
    await seed(30, 600);
    statements.length = 0;
    const out = await year();
    expect(statements.length).toBe(month);
    expect(statements.length).toBeLessThanOrEqual(6);
    expect(out[0]).toMatchObject({ evidence: "measured", current: 40 });
    expect(out[1]).toMatchObject({ evidence: "measured", current: 76 });
  });

  it("ten measures of ten moves each (a hundred moves) read their sets under D1's bind cap", async () => {
    const moves = EXERCISES.slice(0, 100).map((e) => e.id);
    await sets(await appSession(day(2), null), moves[99]!, [{ seconds: 30, reps: 5, value: 20, unit: "kg" }]);
    const requests = Array.from({ length: 10 }, (_, i) => ({
      measure: keyResultMeasureSchema.parse({ kind: "hold_max", libraryIds: moves.slice(i * 10, i * 10 + 10) }),
    }));
    statements.length = 0;
    const out = await measureKeyResults(db, userId, requests, { today: TODAY });
    expect(out[9]).toMatchObject({ current: 30, sampleSize: 1 });
    expect(statements.length).toBeLessThanOrEqual(10);
  });
});
