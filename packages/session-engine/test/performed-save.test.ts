import { describe, expect, test } from "vitest";
import { performedSessionSaveSchema, SESSION_FORMATS, SESSION_MODES, type PerformedSessionWire } from "@rg/domain";
import { FORMAT_IDS, MODE_IDS } from "@rg/exercise-library";
import {
  Builder, historyFromPerformed, Recorder, Review, toPerformedSave,
  type BuildInput, type HistorySession, type PendingChanges, type PerformedSessionSave, type RecorderMeta,
} from "../src/index.js";
import { block, checksFor, data, home } from "./builder-fixtures.js";

// Ruling P1-R3: the recorder's save maps to the domain's wire contract (`performedSessionSaveSchema`) through one
// function, and the history read back from the wire is the history the recorder's own save would have been.

const input = (o: Partial<BuildInput> = {}): BuildInput => ({
  today: "2026-09-29", mode: "build", theme: null, minutes: 40, location: home, unit: "lb", sessions: [], prefs: {},
  block, checks: checksFor(1), swaps: {}, ...o,
});

const meta = (plan: { plannedSeconds: number; newMove: string | null }, o: Partial<RecorderMeta> = {}): RecorderMeta => ({
  id: "perf-1", startedAt: "2026-09-29T18:00:00.000Z", date: "2026-09-29", mode: "build", theme: "t", locationId: "home",
  minutes: 40, block, checks: checksFor(1), equipment: home.equipment, plannedSeconds: plan.plannedSeconds, newMove: plan.newMove,
  ...o,
});

/** A whole session played through: every step reached, time spent on every move, a weight typed, a flag set. */
function playedSession(): { save: PerformedSessionSave; pending: PendingChanges } {
  const plan = Builder.build(data, input());
  const live = Recorder.create(data, plan, meta(plan));
  plan.steps.forEach((step, i) => {
    Recorder.reach(live, i);
    if (step.kind === "timed") Recorder.finishTimed(live, i, step.seconds);
    if (step.exerciseId && step.kind !== "rest") Recorder.addSeconds(live, step.exerciseId, step.seconds);
  });
  live.runningMs = 2_400_400;
  const loaded = live.order.find(id => live.entries[id]!.log === "load");
  if (loaded) Recorder.update(live, loaded, 0, "w", { v: 27.5, u: "lb" });
  Recorder.setFlag(live, live.order[0]!, "clenched", true);
  const save = Recorder.toSession(live, { endedAt: "2026-09-29T18:41:00.000Z", post: { tmj: 2 }, note: "felt strong", completed: true });

  let review = Review.start();
  review = Review.rate(review, { ratings: {}, excluded: [] }, save.entries[0]!.id, 1);
  review = Review.rate(review, { ratings: {}, excluded: [] }, save.done[save.done.length - 1]!.id, "never");
  review = Review.graduate(review, "squat", "front-squat", true);
  const pending = Review.pending(review, [{ family: "squat", to: "front-squat" }]);
  return { save, pending };
}

/** The HistorySession part of a recorder save — what the engine reads. */
const asHistory = (s: PerformedSessionSave): HistorySession => ({
  id: s.id, date: s.date, startedAt: s.startedAt, mode: s.mode, theme: s.theme, blockNumber: s.blockNumber, checks: s.checks,
  done: s.done.map(d => ({ id: d.id, secs: d.secs })),
  entries: s.entries.map(e => ({ id: e.id, implement: e.implement, perSide: e.perSide, format: e.format, flags: e.flags, sets: e.sets })),
});

/** Through the outbox and the network: JSON, then the server's parse. */
const overTheWire = (w: PerformedSessionWire): PerformedSessionWire => performedSessionSaveSchema.parse(JSON.parse(JSON.stringify(w)));

describe("toPerformedSave → historyFromPerformed", () => {
  test("a played session's history survives the wire exactly", () => {
    const { save, pending } = playedSession();
    // The session covers what the mapping has to carry.
    expect(save.entries.length).toBeGreaterThan(1);
    expect(save.entries.some(e => e.flags.length > 0)).toBe(true);
    expect(save.entries.some(e => e.sets.some(s => s.w !== null))).toBe(true);
    expect(save.done.some(d => !save.entries.some(e => e.id === d.id)), "a move played but never logged").toBe(true);

    const wire = toPerformedSave(save, pending, { source: "app", workoutId: "pw-1", buildId: "sb-1" });
    const received = overTheWire(wire);
    expect(received).toEqual(wire);
    expect(historyFromPerformed(received, { blockNumber: block.number })).toEqual(asHistory(save));
  });

  test("the engine plans the next day identically from the wire's history and from the recorder's save", () => {
    const { save, pending } = playedSession();
    const fromWire = historyFromPerformed(overTheWire(toPerformedSave(save, pending, { source: "app", workoutId: null, buildId: null })), {
      blockNumber: block.number,
    });
    const next = (sessions: HistorySession[]) => Builder.build(data, input({ today: "2026-09-30", mode: "consistent", sessions }));
    expect(next([fromWire])).toEqual(next([save]));
  });

  test("the session's own fields land where the rows want them", () => {
    const { save, pending } = playedSession();
    const wire = toPerformedSave(save, pending, { source: "app", workoutId: "pw-1", buildId: "sb-1" });
    expect(wire).toMatchObject({
      id: "perf-1", source: "app", sourceRef: null, workoutId: "pw-1", buildId: "sb-1", localDate: "2026-09-29",
      startedAt: "2026-09-29T18:00:00.000Z", endedAt: "2026-09-29T18:41:00.000Z", seconds: 2400, plannedSeconds: save.plannedSeconds,
      mode: "build", theme: "t", locationId: "home", blockRef: block.id, completed: true, stepsTotal: save.stepsTotal,
      stepsDone: save.stepsDone, note: "felt strong", newMove: save.newMove,
    });
    expect(wire.movesDone).toEqual(save.done.map(d => ({ exerciseId: d.id, seconds: d.secs })));
    expect(wire.checks).toEqual([
      { profileId: "tmj", kind: "pre", value: 1, feelingOff: false, at: "2026-09-29T18:00:00.000Z" },
      { profileId: "tmj", kind: "post", value: 2, feelingOff: false, at: "2026-09-29T18:41:00.000Z" },
    ]);
    // Every set of a flagged entry carries the flag (performed_sets.flags is per set); sets count among the done ones.
    const flagged = wire.entries.find(e => e.exerciseId === save.entries.find(x => x.flags.length)!.id)!;
    expect(flagged.sets.every(s => s.flags.includes("clenched"))).toBe(true);
    for (const e of wire.entries) expect(e.sets.map(s => s.setIndex)).toEqual(e.sets.map((_, i) => i));
    expect(wire.review).toEqual({
      ratings: pending.ratings, excluded: pending.excluded, graduations: [{ family: "squat", to: "front-squat" }],
    });
  });

  test("an import names its source session; without one it is refused at Save", () => {
    const { save, pending } = playedSession();
    expect(toPerformedSave(save, pending, { source: "import", sourceRef: "standalone-7", workoutId: null, buildId: null }).sourceRef)
      .toBe("standalone-7");
    expect(() => toPerformedSave(save, pending, { source: "import", workoutId: null, buildId: null })).toThrow(/source session/);
  });
});

describe("toPerformedSave — what the recorder holds that the rows normalise", () => {
  const base = (): PerformedSessionSave => {
    const { save } = playedSession();
    return { ...save, entries: save.entries.slice(0, 1), checks: {} };
  };
  const none: PendingChanges = { ratings: {}, excluded: {}, graduations: [] };
  const ctx = { source: "app" as const, workoutId: null, buildId: null };

  test("a reading with nothing answered writes no check, and reads back as no reading", () => {
    const wire = toPerformedSave({ ...base(), checks: { tmj: { pre: null, post: null, feelingOff: false } } }, none, ctx);
    expect(wire.checks).toEqual([]);
    expect(historyFromPerformed(wire, { blockNumber: null }).checks).toEqual({});
  });

  test("feeling off with no number is a pre check with a null value", () => {
    const wire = toPerformedSave({ ...base(), checks: { tmj: { pre: null, post: 3, feelingOff: true } } }, none, ctx);
    expect(wire.checks.map(c => [c.kind, c.value, c.feelingOff])).toEqual([["pre", null, true], ["post", 3, false]]);
    expect(historyFromPerformed(wire, { blockNumber: null }).checks).toEqual({ tmj: { pre: null, post: 3, feelingOff: true } });
  });

  test("counts are whole, ratings are signs, an empty note or place is null", () => {
    const s = base();
    const entry = { ...s.entries[0]!, sets: [{ w: null, reps: 7.6, secs: 29.4 }] };
    const wire = toPerformedSave({ ...s, entries: [entry], note: "", locationId: "" }, { ...none, ratings: { a: 1, b: -1, c: null } }, ctx);
    expect(wire.entries[0]!.sets[0]).toMatchObject({ reps: 8, seconds: 29 });
    expect(wire.review.ratings).toEqual({ a: 1, b: -1, c: null });
    expect(wire.note).toBeNull();
    expect(wire.locationId).toBeNull();
  });
});

describe("historyFromPerformed — rows from other sources", () => {
  test("only done sets are history; an entry with none is dropped; flags are the union of its sets'", () => {
    const { save, pending } = playedSession();
    const wire = toPerformedSave(save, pending, { source: "watch_review", sourceRef: "watch-1", workoutId: null, buildId: null });
    const [first, second] = wire.entries;
    const edited: PerformedSessionWire = {
      ...wire,
      entries: [
        { ...first!, sets: [{ ...first!.sets[0]!, flags: ["b"] }, { ...first!.sets[0]!, setIndex: 1, done: false, flags: ["a", "b"] }] },
        { ...second!, sets: second!.sets.map(s => ({ ...s, done: false })) },
      ],
    };
    const history = historyFromPerformed(edited, { blockNumber: 2 });
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]!.sets).toHaveLength(1);
    expect(history.entries[0]!.flags).toEqual(["b", "a"]);
    expect(history.blockNumber).toBe(2);
  });

  test("a daily check is not a session reading", () => {
    const { save, pending } = playedSession();
    const wire = toPerformedSave({ ...save, checks: {} }, pending, { source: "app", workoutId: null, buildId: null });
    const withDaily = { ...wire, checks: [{ profileId: "tmj", kind: "daily" as const, value: 4, feelingOff: false, at: "2026-09-29T08:00:00.000Z" }] };
    expect(historyFromPerformed(withDaily, { blockNumber: null }).checks).toEqual({});
  });
});

test("the domain's mode and format lists are the library's", () => {
  expect([...SESSION_MODES]).toEqual([...MODE_IDS]);
  expect([...SESSION_FORMATS]).toEqual([...FORMAT_IDS]);
});
