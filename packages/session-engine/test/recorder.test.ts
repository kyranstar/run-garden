import { describe, expect, test } from "vitest";
import { Builder, historyFromPerformed, Lib, Planner, Records, Recorder, Review, Swapping, toPerformedSave, type BuildInput, type Live, type RecorderMeta, type Step, type Theme } from "../src/index.js";
import { block, checksFor, data, home, themed } from "./builder-fixtures.js";

// Ported from the standalone tests/recorder.test.js, plus the recorder regressions the handoff lists.

const baseInput = (o: Partial<BuildInput> = {}): BuildInput => ({
  today: "2026-09-29", mode: "build", theme: themed(["superset"]), minutes: 30, location: home, unit: "lb", sessions: [], prefs: {}, block, checks: checksFor(1), swaps: {}, ...o,
});
const planFor = (o: Partial<BuildInput> = {}) => Builder.build(data, baseInput(o));
const meta = (plan: { plannedSeconds: number; newMove: string | null }): RecorderMeta => ({
  id: "s1", startedAt: "2026-09-29T18:00:00.000Z", date: "2026-09-29", mode: "build", theme: "t", locationId: "home", minutes: 30,
  block, checks: checksFor(1), equipment: home.equipment, plannedSeconds: plan.plannedSeconds, newMove: plan.newMove,
});

test("entries exist for every logged exercise, pre-filled from the plan's targets", () => {
  const plan = planFor();
  const live = Recorder.create(data, plan, meta(plan));
  const logged = [...new Set(plan.steps.filter(s => s.log).map(s => s.exerciseId))];
  expect(live.order).toEqual(logged);
  for (const id of logged) {
    const e = live.entries[id!]!;
    const steps = plan.steps.filter(s => s.log && s.exerciseId === id);
    expect(e.sets.length, String(id)).toBe(Math.max(...steps.map(s => s.setIndex!)) + 1);
    const t = steps[0]!.target;
    if (t && t.w) expect(e.sets[0]!.w).toEqual(t.w);
    if (t && t.reps != null) expect(e.sets[0]!.reps).toBe(t.reps);
    expect(e.sets.every(s => !s.done)).toBe(true);
  }
});

test("reaching a step marks its set done; editing a set updates later untouched sets", () => {
  const plan = planFor();
  const live = Recorder.create(data, plan, meta(plan));
  const i = plan.steps.findIndex(s => s.kind === "set");
  const step = plan.steps[i]!;
  Recorder.reach(live, i);
  const e = live.entries[step.exerciseId!]!;
  expect(e.sets[step.setIndex!]!.done).toBe(true);
  if (e.sets.length > 2) {
    Recorder.update(live, e.id, 2, "reps", 3);
    Recorder.update(live, e.id, 0, "reps", 9);
    expect(e.sets[1]!.reps).toBe(9);
    expect(e.sets[2]!.reps, "a touched set keeps its own value").toBe(3);
  }
});

test("toSession keeps only done sets with the right fields, and lists the exercises done", () => {
  const plan = planFor();
  const live = Recorder.create(data, plan, meta(plan));
  plan.steps.forEach((_, i) => { if (i < plan.steps.length / 2) Recorder.reach(live, i); });
  live.runningMs = 600500;
  const firstLogged = live.order[0]!;
  Recorder.setFlag(live, firstLogged, "clenched", true);
  const s = Recorder.toSession(live, { endedAt: "2026-09-29T18:20:00.000Z", post: { tmj: 0 }, note: "fine", completed: false });
  expect(s.version).toBe(2);
  expect(s.seconds).toBe(601);
  expect(s.mode).toBe("build");
  expect(s.blockNumber).toBe(block.number);
  expect(s.checks.tmj).toEqual({ pre: 1, post: 0, feelingOff: false });
  const reached = [...new Set(plan.steps.filter((st, i) => i < plan.steps.length / 2 && st.exerciseId).map(st => st.exerciseId!))];
  const counted = reached.filter(id => !live.entries[id] || live.entries[id]!.sets.some(x => x.done));
  expect(counted.length).toBeGreaterThan(0);
  expect(s.done.map(d => d.id).sort()).toEqual(counted.sort());
  for (const e of s.entries) {
    const ex = Lib.get(data, e.id)!;
    expect(e.sets.length).toBeGreaterThanOrEqual(1);
    expect(e.perSide).toBe(ex.laterality === "unilateral");
    if (ex.load === "external") expect(e.log).toBe("load");
    for (const set of e.sets) {
      if (e.metric === "reps") expect(set.secs).toBe(null);
      if (e.log !== "load") expect(set.w).toBe(null);
    }
  }
  if (s.entries.some(e => e.id === firstLogged)) expect(s.entries.find(e => e.id === firstLogged)!.flags).toEqual(["clenched"]);
  expect(s.stepsDone).toBe(plan.steps.filter((st, i) => i < plan.steps.length / 2 && st.kind !== "rest").length);
});

test("the save counts every move the session held, done or skipped (ruling 2b-R17: what the review may rate)", () => {
  const plan = planFor();
  const live = Recorder.create(data, plan, meta(plan));
  const held = new Set(plan.steps.filter(st => st.kind !== "rest" && st.exerciseId).map(st => st.exerciseId!));
  expect(held.size).toBeGreaterThan(2);
  // Nothing reached: nothing done, every move still the session's.
  const none = Recorder.toSession(live, { endedAt: "x", note: "", completed: false });
  expect(none.done).toEqual([]);
  expect(none.movesPlanned).toBe(held.size);
  plan.steps.forEach((_, k) => Recorder.reach(live, k));
  expect(Recorder.toSession(live, { endedAt: "x", note: "", completed: true }).movesPlanned).toBe(held.size);
});

test("ladder rungs become sets with their own rep targets and the format is recorded", () => {
  const plan = planFor({ theme: themed(["ladder"]), minutes: 40 });
  const g = plan.groups.find(x => x.format === "ladder");
  expect(g, "no ladder").toBeTruthy();
  const live = Recorder.create(data, plan, meta(plan));
  const e = live.entries[g!.items[0]!.exercise.id]!;
  expect(e.format).toBe("ladder");
  expect(e.sets.map(s => s.reps)).toEqual([2, 4, 6, 8]);
});

test("added sets and time on each exercise are kept", () => {
  const plan = planFor();
  const live = Recorder.create(data, plan, meta(plan));
  const id = live.order[0]!;
  const before = live.entries[id]!.sets.length;
  Recorder.addSet(live, id);
  expect(live.entries[id]!.sets.length).toBe(before + 1);
  expect(live.entries[id]!.sets[before]!.done).toBe(true);
  Recorder.reach(live, plan.steps.findIndex(st => st.exerciseId === id));
  Recorder.addSeconds(live, id, 40);
  Recorder.addSeconds(live, id, 5);
  const s = Recorder.toSession(live, { endedAt: "x", note: "", completed: true });
  expect(s.done.find(d => d.id === id)!.secs).toBe(45);
});

test("a timed hold counts once you've held at least half of it, at the time you actually held", () => {
  const plan = planFor({ theme: themed(["straight"]), minutes: 40 });
  const i = plan.steps.findIndex(s => s.kind === "timed" && s.log);
  expect(i, "needs a logged timed step").toBeGreaterThanOrEqual(0);
  const step = plan.steps[i]!;
  const live = Recorder.create(data, plan, meta(plan));
  const e = live.entries[step.exerciseId!]!;
  Recorder.reach(live, i);
  expect(e.sets[step.setIndex!]!.done, "starting a hold isn't finishing it").toBe(false);
  Recorder.finishTimed(live, i, 3);
  expect(e.sets[step.setIndex!]!.done, "3 s of a hold doesn't count").toBe(false);
  Recorder.finishTimed(live, i, step.seconds - 4.4);
  expect(e.sets[step.setIndex!]!.done).toBe(true);
  expect(e.sets[step.setIndex!]!.secs).toBe(Math.round(step.seconds - 4.4));
  Recorder.update(live, e.id, step.setIndex!, "secs", 99);
  Recorder.finishTimed(live, i, step.seconds);
  expect(e.sets[step.setIndex!]!.secs, "a value you typed stays").toBe(99);
});

test("a hold to max ended with Done counts at the time held, however short or long: where you stopped is the result", () => {
  const plan = planFor({ theme: themed(["straight"]), minutes: 40 });
  const i = plan.steps.findIndex(s => s.kind === "timed" && s.log && s.side === null);
  expect(i, "needs a logged timed step").toBeGreaterThanOrEqual(0);
  const step = plan.steps[i]!;
  const short = Recorder.create(data, plan, meta(plan));
  Recorder.reach(short, i);
  Recorder.finishTimed(short, i, 3.4, { toMax: true, done: true });
  expect(short.entries[step.exerciseId!]!.sets[step.setIndex!]).toMatchObject({ done: true, secs: 3 });
  expect(Recorder.toSession(short, { endedAt: "x" }).stepsDone).toBe(1);
  const long = Recorder.create(data, plan, meta(plan));
  Recorder.reach(long, i);
  Recorder.finishTimed(long, i, step.seconds + 31.2, { toMax: true, done: true });
  expect(long.entries[step.exerciseId!]!.sets[step.setIndex!]!.secs, "never capped at the window").toBe(step.seconds + 31);
  // Under a second is no hold; and a hold left any other way keeps the half-time rule.
  const none = Recorder.create(data, plan, meta(plan));
  Recorder.reach(none, i);
  Recorder.finishTimed(none, i, 0.4, { toMax: true, done: true });
  expect(none.entries[step.exerciseId!]!.sets[step.setIndex!]!.done).toBe(false);
  Recorder.finishTimed(none, i, 3, { toMax: true });
  expect(none.entries[step.exerciseId!]!.sets[step.setIndex!]!.done).toBe(false);
});

test("a hold to max played a side at a time logs each side, neither overwriting the other: one set, saved with each side", () => {
  const side = (s: "Left" | "Right", log: boolean): Step => ({
    kind: "timed", slotKey: "accessory:0", block: "accessory", exerciseId: "sidePlank", side: s, setIndex: 0, setCount: 1,
    seconds: 30, prepGap: 8, target: null, format: { id: "holds", group: null, round: null }, why: [], isNew: false, log,
  });
  const plan = { steps: [side("Left", false), side("Right", true)], plannedSeconds: 76, newMove: null };
  const live = Recorder.create(data, plan, meta(plan));
  Recorder.reach(live, 0);
  Recorder.finishTimed(live, 0, 45.2, { toMax: true, done: true });
  Recorder.reach(live, 1);
  Recorder.finishTimed(live, 1, 38.6, { toMax: true, done: true });
  expect(live.entries.sidePlank!.sets[0]).toMatchObject({ done: true, sides: { left: 45, right: 39 } });
  Recorder.setSide(live, "sidePlank", 0, "right", 41);
  // Never a side that was not held.
  const one = Recorder.create(data, plan, meta(plan));
  Recorder.reach(one, 0);
  Recorder.finishTimed(one, 0, 20, { toMax: true, done: true });
  Recorder.setSide(one, "sidePlank", 0, "right", 99);
  const sets = (l: Live) => Recorder.toSession(l, { endedAt: "x" }).entries.find(e => e.id === "sidePlank")!.sets;
  // One set: what it held on both sides (the shorter), and each side's.
  expect(sets(live)).toEqual([{ w: null, reps: null, secs: 41, sides: { left: 45, right: 41 } }]);
  // One side only: the side is kept, and the set measures nothing (whole-branch I-2).
  expect(sets(one)).toEqual([{ w: null, reps: null, secs: null, sides: { left: 20 } }]);
  // An engine build's sides (no max) are logged the same way (whole-branch M-1): one set at the shorter side.
  const engine = Recorder.create(data, plan, meta(plan));
  Recorder.reach(engine, 0);
  Recorder.finishTimed(engine, 0, 30);
  Recorder.reach(engine, 1);
  Recorder.finishTimed(engine, 1, 28);
  expect(sets(engine)).toEqual([{ w: null, reps: null, secs: 28, sides: { left: 30, right: 28 } }]);
});

test("done lists logged moves with a done set, and unlogged moves you reached", () => {
  const plan = planFor();
  const live = Recorder.create(data, plan, meta(plan));
  const loggedId = live.order[0]!;
  const unloggedIndex = plan.steps.findIndex(s => s.kind === "timed" && !s.log);
  plan.steps.forEach((s, k) => { if (s.exerciseId === loggedId) Recorder.reach(live, k); });
  Recorder.reach(live, unloggedIndex);
  live.entries[loggedId]!.sets.forEach((_, k) => Recorder.setDone(live, loggedId, k, false));
  const s = Recorder.toSession(live, { endedAt: "x", note: "", completed: false });
  const ids = s.done.map(d => d.id);
  expect(ids.includes(loggedId), "every set unticked: not done").toBe(false);
  expect(ids.includes(plan.steps[unloggedIndex]!.exerciseId!)).toBe(true);
});

describe("an unlogged hold counts only when at least half of it ran (ruling 2b-R15)", () => {
  const setUp = () => {
    const plan = planFor();
    const live = Recorder.create(data, plan, meta(plan));
    const i = plan.steps.findIndex(s => s.kind === "timed" && !s.log);
    expect(i, "needs an unlogged hold").toBeGreaterThanOrEqual(0);
    const step = plan.steps[i]!;
    // The only step of that move: what it says is what the hold says.
    const only = plan.steps.filter(s => s.exerciseId === step.exerciseId).length === 1;
    return { plan, live, i, step, only };
  };
  const save = (live: Live) => Recorder.toSession(live, { endedAt: "x", note: "", completed: false });

  test("left before half its time: not done, and not a step done", () => {
    const { live, i, step, only } = setUp();
    Recorder.reach(live, i);
    Recorder.finishTimed(live, i, step.seconds / 2 - 1);
    const s = save(live);
    expect(s.stepsDone).toBe(0);
    if (only) expect(s.done.map(d => d.id)).not.toContain(step.exerciseId);
    expect(Recorder.movesDone(live)).not.toContain(step.exerciseId);
  });

  test("held half its time or more: done, and a step done", () => {
    const { live, i, step } = setUp();
    Recorder.reach(live, i);
    Recorder.finishTimed(live, i, step.seconds / 2);
    const s = save(live);
    expect(s.stepsDone).toBe(1);
    expect(s.done.map(d => d.id)).toContain(step.exerciseId);
    expect(Recorder.movesDone(live)).toContain(step.exerciseId);
  });

  test("held once, then gone back to and skipped: it was held — it stays done", () => {
    const { live, i, step } = setUp();
    Recorder.reach(live, i);
    Recorder.finishTimed(live, i, step.seconds);
    Recorder.reach(live, i);
    Recorder.finishTimed(live, i, 0);
    expect(save(live).stepsDone).toBe(1);
  });

  test("a logged hold left before half is not a step done either (its set was never done)", () => {
    const plan = planFor({ theme: themed(["straight"]), minutes: 40 });
    const i = plan.steps.findIndex(s => s.kind === "timed" && s.log);
    expect(i, "needs a logged timed step").toBeGreaterThanOrEqual(0);
    const live = Recorder.create(data, plan, meta(plan));
    Recorder.reach(live, i);
    Recorder.finishTimed(live, i, 1);
    expect(save(live).stepsDone).toBe(0);
  });

  test("a swap mid-session keeps which holds were held and which were skipped", () => {
    const { plan, live, i, step } = setUp();
    for (let k = 0; k <= i; k++) Recorder.reach(live, k);
    Recorder.finishTimed(live, i, 0);
    const slot = plan.steps.findIndex((s, k) => k > i && s.kind === "set" && s.log);
    expect(slot).toBeGreaterThan(i);
    const slotKey = plan.steps[slot]!.slotKey;
    const input = baseInput();
    const to = Builder.alternatives(data, { ...input, swaps: {} }, slotKey, 3)[0]!.id;
    const fresh = Builder.build(data, { ...input, swaps: { [slotKey]: { from: plan.steps[slot]!.exerciseId, to } } });
    const next = Recorder.rebase(data, live, fresh, slot, slotKey);
    expect(next.steps[i]!.exerciseId).toBe(step.exerciseId);
    expect(save(next).stepsDone).toBe(save(live).stepsDone);
    expect(Recorder.movesDone(next)).toEqual(Recorder.movesDone(live));
  });
});

// A superset's first round is done; the A move is swapped at the start of round 2.
function midSupersetSwap(format: Theme["formats"][number]) {
  const plan = planFor({ theme: themed([format]) });
  const first = plan.steps.findIndex(s => s.block === "accessory" && s.kind !== "rest");
  const slotKey = plan.steps[first]!.slotKey;
  const i = plan.steps.findIndex((s, k) => k > first && s.slotKey === slotKey && s.kind !== "rest");
  const input = baseInput({ theme: themed([format]) });
  const to = Builder.alternatives(data, { ...input, swaps: {} }, slotKey, 3)[0]!.id;
  const fresh = Builder.build(data, { ...input, swaps: { [slotKey]: { from: plan.steps[first]!.exerciseId, to } } });
  const live = Recorder.create(data, plan, meta(plan));
  for (let k = 0; k < i; k++) Recorder.reach(live, k);
  return { plan, live, i, slotKey, from: plan.steps[first]!.exerciseId!, to, fresh };
}

for (const format of ["superset", "circuit"] as const) {
  test(`a mid-workout swap in a ${format} replaces only that move's remaining sets`, () => {
    const { plan, live, i, slotKey, from, to, fresh } = midSupersetSwap(format);
    const partners = [...new Set(plan.steps.slice(i).filter(s => s.kind !== "rest" && s.slotKey !== slotKey).map(s => `${s.exerciseId}#${s.setIndex}${s.side || ""}`))];
    Recorder.update(live, live.order.find(id => id !== from) || from, 0, "reps", 7);
    const next = Recorder.rebase(data, live, fresh, i, slotKey);
    const steps = next.steps;
    expect(steps.slice(0, i), "finished steps stay put").toEqual(plan.steps.slice(0, i));
    const after = steps.slice(i);
    expect(after.some(s => s.exerciseId === from), "the old move is gone from here on").toBe(false);
    expect(after.some(s => s.exerciseId === to), "the new move takes its place").toBe(true);
    const kept = [...new Set(after.filter(s => s.kind !== "rest" && s.slotKey !== slotKey).map(s => `${s.exerciseId}#${s.setIndex}${s.side || ""}`))];
    expect(kept, "partners keep every remaining set").toEqual(partners);
    for (let k = 1; k < steps.length; k++) expect(!(steps[k]!.kind === "rest" && steps[k - 1]!.kind === "rest"), `back-to-back rests at ${k}`).toBe(true);
    expect([...next.reached].sort((a, b) => a - b)).toEqual([...live.reached].sort((a, b) => a - b));
    for (const id of live.order) if (next.entries[id]) expect(next.entries[id], "logged values carry over").toBe(live.entries[id]);
    expect(next.runningMs).toBe(live.runningMs);
  });
}

describe("recorder regressions and the save shape", () => {
  test("typing during a rest edits the set just finished and is kept when the next set starts", () => {
    const plan = planFor({ theme: themed(["straight"]), minutes: 40 });
    const i = plan.steps.findIndex((s, k) => s.kind === "set" && plan.steps[k + 1]?.kind === "rest");
    expect(i).toBeGreaterThanOrEqual(0);
    const live = Recorder.create(data, plan, meta(plan));
    Recorder.reach(live, i);
    Recorder.reach(live, i + 1);   // the rest
    expect(Recorder.logStepIndex(live, i + 1), "during a rest the log card shows the set just finished").toBe(i);
    const step = plan.steps[i]!;
    Recorder.update(live, step.exerciseId!, step.setIndex!, "reps", 9);   // typed during the rest
    Recorder.reach(live, i + 2);                                          // the rest ends, the next set starts
    const set = live.entries[step.exerciseId!]!.sets[step.setIndex!]!;
    expect(set.reps).toBe(9);
    expect(set.done).toBe(true);
    expect(Recorder.logStepIndex(live, i)).toBe(i);
  });

  test("a plan step for an exercise that's no longer in the library is tolerated", () => {
    const plan = planFor();
    const ghostStep = { ...plan.steps.find(s => s.kind === "timed" && !s.log)!, exerciseId: "retiredMove", log: true };
    const steps = [...plan.steps, ghostStep];
    const live = Recorder.create(data, { ...plan, steps }, meta(plan));
    expect(live.entries.retiredMove).toBeUndefined();
    Recorder.reach(live, steps.length - 1);
    Recorder.update(live, "retiredMove", 0, "reps", 5);
    Recorder.setFlag(live, "retiredMove", "clenched", true);
    const s = Recorder.toSession(live, { endedAt: "x", note: "", completed: false });
    expect(s.done.map(d => d.id)).toContain("retiredMove");
  });

  test("a plan stored before an exercise was renamed keeps every logged set under the new id", () => {
    const plan = planFor();
    const liftId = plan.steps.find(s => s.kind === "set" && s.log)!.exerciseId!;
    // The library renames the lift after the plan was built; the old id stays as a legacy id.
    const renamed = { ...data, exercises: data.exercises.map(ex => (ex.id === liftId ? { ...ex, id: "renamedLift", legacyIds: [liftId] } : ex)) };
    const live = Recorder.create(renamed, plan, meta(plan));
    expect(Object.keys(live.entries)).toContain("renamedLift");
    const indices = live.steps.map((s, k) => (s.exerciseId === "renamedLift" ? k : -1)).filter(k => k >= 0);
    expect(indices.length).toBeGreaterThan(0);
    indices.forEach(k => Recorder.reach(live, k));
    Recorder.update(live, "renamedLift", 0, "reps", 11);
    Recorder.setFlag(live, "renamedLift", "clenched", true);
    const entry = live.entries.renamedLift!;
    expect(entry.sets.every(x => x.done)).toBe(true);
    expect(entry.sets[0]!.reps).toBe(11);
    const s = Recorder.toSession(live, { endedAt: "x", note: "", completed: false });
    const saved = s.entries.find(e => e.id === "renamedLift");
    expect(saved?.sets.length).toBe(entry.sets.length);
    expect(saved?.flags).toEqual(["clenched"]);
    expect(s.done.map(d => d.id)).toContain("renamedLift");
    expect(s.done.map(d => d.id)).not.toContain(liftId);
  });

  test("the saved session carries checks per profile and feeds records and graduation offers directly", () => {
    const plan = planFor();
    const live = Recorder.create(data, plan, meta(plan));
    plan.steps.forEach((_, k) => Recorder.reach(live, k));
    const s = Recorder.toSession(live, { endedAt: "2026-09-29T18:40:00.000Z", post: { tmj: 2 }, note: "", completed: true });
    expect(s).toMatchObject({ id: "s1", date: "2026-09-29", locationId: "home", blockId: block.id, blockNumber: block.number, completed: true, checks: { tmj: { pre: 1, post: 2, feelingOff: false } } });
    expect(s.entries.every(e => Array.isArray(e.flags))).toBe(true);
    expect(Records.forSession(data, [s], s.id).records.length).toBeGreaterThan(0);
    const program = { settings: { unit: "lb" as const, weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 30, location: "home" }, locations: [home], prefs: { ratings: {}, excluded: [], pinned: [] }, savedIds: [], block, sessions: [] };
    expect(() => Planner.graduationOffers(data, program, s)).not.toThrow();
  });
});

// Each move done says the slot it was played in (`done[].slotKey`, on the wire `movesDone[].slotKey`): a reader never
// has to guess it from the entry's index, which drifts from the build's order of first play — an entry with no done
// set is dropped at save (later entries shift down), and a swap after a slot's first set keeps the old move's entry
// and adds the new one after it (later entries shift up).
describe("the slot each move was played in (Stage 2 minors)", () => {
  const hold = (slotKey: string, exerciseId: string, seconds: number, setIndex = 0, setCount = 1): Step => ({
    kind: "timed", slotKey, block: "core", exerciseId, side: null, setIndex, setCount, seconds, prepGap: 8, target: null,
    format: { id: "holds", group: null, round: null }, why: [], isNew: false, log: true,
  });
  const rest = (slotKey: string): Step => ({ ...hold(slotKey, "", 30), kind: "rest", exerciseId: null, setIndex: null, setCount: null, log: false });
  const meta0 = meta({ plannedSeconds: 0, newMove: null });
  /** ⇄ at step `i`: the slot plays `fresh` from here on (the player's `swapSlot`). */
  const swap = (live: Live, i: number, slotKey: string, fresh: Step[]): Live => {
    const steps = Swapping.splice(live.plan.steps, slotKey, fresh);
    return Recorder.rebase(data, live, { steps, plannedSeconds: Swapping.costOf(steps) }, i, slotKey);
  };
  const end = (live: Live) => Recorder.toSession(live, { endedAt: "2026-09-29T18:40:00.000Z" });
  const ctx = { source: "app" as const, workoutId: "w1", buildId: "b1" };

  test("a move whose entry shifted down (the one before it, never done, is dropped at save) still says its slot", () => {
    // core:0 a side plank, core:1 a wall sit; the plank skipped, the wall sit's slot swapped and held.
    const plan = { steps: [hold("core:0", "sidePlank", 40), hold("core:1", "wallSit", 60)], plannedSeconds: 0 };
    let live = Recorder.create(data, plan, meta0);
    Recorder.reach(live, 0);
    Recorder.finishTimed(live, 0, 5);
    Recorder.reach(live, 1);
    live = swap(live, 1, "core:1", [hold("core:1", "splitSquatHold", 60)]);
    Recorder.reach(live, 1);
    Recorder.finishTimed(live, 1, 41, { toMax: true, done: true });
    const s = end(live);
    // Saved as the first entry, though its slot is the second move the build plays.
    expect(s.entries.map(e => e.id)).toEqual(["splitSquatHold"]);
    expect(s.done).toEqual([{ id: "splitSquatHold", secs: 0, slotKey: "core:1" }]);
    expect(toPerformedSave(s, Review.pending(Review.start(), []), ctx).movesDone).toEqual([{ exerciseId: "splitSquatHold", seconds: 0, slotKey: "core:1" }]);
  });

  test("a move whose entry shifted up (swapped in after its slot's first set) still says its slot; the move it replaced says the same slot", () => {
    // core:0 two sets of a side plank, core:1 a wall sit; the plank's second set swapped for the split squat hold.
    const plan = { steps: [hold("core:0", "sidePlank", 40, 0, 2), rest("core:0"), hold("core:0", "sidePlank", 40, 1, 2), hold("core:1", "wallSit", 60)], plannedSeconds: 0 };
    let live = Recorder.create(data, plan, meta0);
    Recorder.reach(live, 0);
    Recorder.finishTimed(live, 0, 40);
    Recorder.reach(live, 1);
    Recorder.reach(live, 2);
    live = swap(live, 2, "core:0", [hold("core:0", "splitSquatHold", 40, 0, 2), rest("core:0"), hold("core:0", "splitSquatHold", 40, 1, 2)]);
    Recorder.reach(live, 2);
    Recorder.finishTimed(live, 2, 40);
    Recorder.reach(live, 3);
    Recorder.finishTimed(live, 3, 55);
    const s = end(live);
    // The second entry, though its slot is the first move the build plays.
    expect(s.entries.map(e => e.id)).toEqual(["sidePlank", "splitSquatHold", "wallSit"]);
    expect(s.done.map(d => [d.id, d.slotKey])).toEqual([["sidePlank", "core:0"], ["splitSquatHold", "core:0"], ["wallSit", "core:1"]]);
  });

  test("a move played in more than one slot names none (the reader falls back to its own rule)", () => {
    const plan = { steps: [hold("core:0", "wallSit", 40), hold("core:1", "wallSit", 40, 1, 2)], plannedSeconds: 0 };
    const live = Recorder.create(data, plan, meta0);
    for (const k of [0, 1]) {
      Recorder.reach(live, k);
      Recorder.finishTimed(live, k, 40);
    }
    expect(end(live).done).toEqual([{ id: "wallSit", secs: 0 }]);
  });
});

// A move's sets are numbered per (slot, set) in play order (Stage 2 whole-branch review I-1): the same move in two items
// never shares a set, and an engine build — one slot a move, its sets numbered from 0 — keeps its numbers.
describe("a move's sets, one per slot and set number, in play order (Stage 2 whole-branch I-1)", () => {
  const timed = (slotKey: string, exerciseId: string, seconds: number, setIndex = 0, setCount = 1, log = true): Step => ({
    kind: "timed", slotKey, block: "core", exerciseId, side: null, setIndex, setCount, seconds, prepGap: 8, target: null,
    format: { id: "holds", group: null, round: null }, why: [], isNew: false, log,
  });
  const meta0 = meta({ plannedSeconds: 0, newMove: null });
  const end = (live: Live) => Recorder.toSession(live, { endedAt: "2026-09-29T18:40:00.000Z" });

  test("the same move in a warm-up and the main part keeps a set for each: the warm-up's is never the main's", () => {
    const plan = { steps: [timed("prep:0", "wallSit", 20), timed("core:0", "wallSit", 45, 0, 2), timed("core:0", "wallSit", 45, 1, 2)], plannedSeconds: 0 };
    const live = Recorder.create(data, plan, meta0);
    expect(live.entries.wallSit!.sets.map(s => s.secs)).toEqual([20, 45, 45]);
    expect(plan.steps.map(s => Recorder.placeOf(live, s))).toEqual([0, 1, 2]);
    Recorder.reach(live, 0);
    Recorder.finishTimed(live, 0, 20);
    // The main's first set skipped, its second held 50 s.
    Recorder.reach(live, 1);
    Recorder.finishTimed(live, 1, 0, { toMax: true });
    Recorder.reach(live, 2);
    Recorder.finishTimed(live, 2, 50, { toMax: true, done: true });
    expect(end(live).entries.find(e => e.id === "wallSit")!.sets.map(s => s.secs)).toEqual([20, 50]);
    expect(live.entries.wallSit!.sets.map(s => s.done)).toEqual([true, false, true]);
  });

  test("an edit fills the later sets of its own slot only", () => {
    const plan = { steps: [timed("prep:0", "wallSit", 20), timed("core:0", "wallSit", 45, 0, 2), timed("core:0", "wallSit", 45, 1, 2)], plannedSeconds: 0 };
    const live = Recorder.create(data, plan, meta0);
    Recorder.update(live, "wallSit", 0, "secs", 25);
    expect(live.entries.wallSit!.sets.map(s => s.secs)).toEqual([25, 45, 45]);
    Recorder.update(live, "wallSit", 1, "secs", 50);
    expect(live.entries.wallSit!.sets.map(s => s.secs)).toEqual([25, 50, 50]);
  });

  test("a step of the move that is not logged writes no set (a warm-up window of a move logged elsewhere)", () => {
    const plan = { steps: [timed("prep:0", "wallSit", 20, 0, 1, false), timed("core:0", "wallSit", 45)], plannedSeconds: 0 };
    const live = Recorder.create(data, plan, meta0);
    expect(live.entries.wallSit!.sets).toHaveLength(1);
    Recorder.reach(live, 0);
    Recorder.finishTimed(live, 0, 20);
    expect(live.entries.wallSit!.sets[0]!.done).toBe(false);
    expect(Recorder.placeOf(live, plan.steps[0]!)).toBe(-1);
  });

  test("an engine build keeps its numbers: every logged step's set is its own set number", () => {
    for (const format of ["straight", "superset", "circuit", "ladder"] as const) {
      for (const minutes of [20, 40]) {
        const plan = planFor({ theme: themed([format]), minutes });
        const live = Recorder.create(data, plan, meta(plan));
        for (const step of plan.steps.filter(s => s.log && s.exerciseId && live.entries[s.exerciseId])) {
          expect(Recorder.placeOf(live, step), `${format} ${minutes} ${step.slotKey} ${step.setIndex}`).toBe(step.setIndex ?? 0);
        }
      }
    }
  });

  test("a session kept before sets were numbered this way plays on by the steps' own set numbers", () => {
    const plan = { steps: [timed("core:0", "wallSit", 45, 0, 2), timed("core:0", "wallSit", 45, 1, 2)], plannedSeconds: 0 };
    const live = Recorder.create(data, plan, meta0);
    const { keys: _gone, ...kept } = live;
    const old = kept as Live;
    expect(plan.steps.map(s => Recorder.placeOf(old, s))).toEqual([0, 1]);
    Recorder.reach(old, 1);
    Recorder.finishTimed(old, 1, 45);
    expect(old.entries.wallSit!.sets.map(s => s.done)).toEqual([false, true]);
  });

  test("a swap and a swap back keep every set where it was", () => {
    const plan = { steps: [timed("core:0", "wallSit", 45, 0, 3), timed("core:0", "wallSit", 45, 1, 3), timed("core:0", "wallSit", 45, 2, 3)], plannedSeconds: 0 };
    let live = Recorder.create(data, plan, meta0);
    const swap = (l: Live, i: number, to: string) => {
      const fresh = [0, 1, 2].map(k => timed("core:0", to, 45, k, 3));
      const steps = Swapping.splice(l.plan.steps, "core:0", fresh);
      return Recorder.rebase(data, l, { steps, plannedSeconds: 0 }, i, "core:0");
    };
    Recorder.reach(live, 0);
    Recorder.finishTimed(live, 0, 45);
    live = swap(live, 1, "splitSquatHold");
    Recorder.reach(live, 1);
    Recorder.finishTimed(live, 1, 40);
    live = swap(live, 2, "wallSit");
    Recorder.reach(live, 2);
    Recorder.finishTimed(live, 2, 44);
    const s = end(live);
    expect(s.entries.map(e => [e.id, e.sets.map(x => x.secs)])).toEqual([["wallSit", [45, 44]], ["splitSquatHold", [40]]]);
  });
});

// A set played a side at a time measures both sides at the shorter, and only with both (Stage 2 whole-branch I-2, M-1).
describe("a set played a side at a time (Stage 2 whole-branch I-2, M-1)", () => {
  const side = (s: "Left" | "Right" | null, seconds: number, log = true): Step => ({
    kind: "timed", slotKey: "core:0", block: "core", exerciseId: "splitSquatHold", side: s, setIndex: 0, setCount: 1, seconds, prepGap: 8,
    target: null, format: { id: "holds", group: null, round: null }, why: [], isNew: false, log,
  });
  const meta0 = meta({ plannedSeconds: 0, newMove: null });
  const end = (live: Live) => Recorder.toSession(live, { endedAt: "2026-09-29T18:40:00.000Z" });
  const ctx = { source: "app" as const, workoutId: "w1", buildId: "b1" };
  const wire = (live: Live) => toPerformedSave(end(live), Review.pending(Review.start(), []), ctx);

  test("to max, one side done and the other skipped: the set keeps its side and measures nothing", () => {
    const live = Recorder.create(data, { steps: [side("Left", 40, false), side("Right", 40)], plannedSeconds: 0 }, meta0);
    Recorder.reach(live, 0);
    Recorder.finishTimed(live, 0, 60, { toMax: true, done: true });
    Recorder.reach(live, 1);
    Recorder.finishTimed(live, 1, 0, { toMax: true });
    const saved = end(live).entries.find(e => e.id === "splitSquatHold")!;
    expect(saved.sets).toEqual([{ w: null, reps: null, secs: null, sides: { left: 60 } }]);
    const sent = wire(live).entries.find(e => e.exerciseId === "splitSquatHold")!;
    expect(sent.sets.map(s => [s.setIndex, s.side, s.seconds])).toEqual([[0, "left", 60]]);
    // History reads it as a set that measures nothing, never a 60 s hold.
    expect(historyFromPerformed(wire(live)).entries.find(e => e.id === "splitSquatHold")!.sets).toEqual([{ w: null, reps: null, secs: null }]);
  });

  test("a hold played a side at a time that is not to max (an engine build's) logs both sides too: one set at the shorter", () => {
    const live = Recorder.create(data, { steps: [side("Left", 30, false), side("Right", 30)], plannedSeconds: 0 }, meta0);
    Recorder.reach(live, 0);
    Recorder.finishTimed(live, 0, 30);
    Recorder.reach(live, 1);
    Recorder.finishTimed(live, 1, 22);
    expect(end(live).entries.find(e => e.id === "splitSquatHold")!.sets).toEqual([{ w: null, reps: null, secs: 22, sides: { left: 30, right: 22 } }]);
    const sent = wire(live).entries.find(e => e.exerciseId === "splitSquatHold")!;
    expect(sent.sets.map(s => [s.setIndex, s.side, s.seconds])).toEqual([[0, "left", 30], [0, "right", 22]]);
    expect(historyFromPerformed(wire(live)).entries.find(e => e.id === "splitSquatHold")!.sets).toEqual([{ w: null, reps: null, secs: 22 }]);
  });

  test("a hold on one fixed side (one window, no pair) is a plain set of that side's seconds", () => {
    const live = Recorder.create(data, { steps: [side("Left", 30)], plannedSeconds: 0 }, meta0);
    Recorder.reach(live, 0);
    Recorder.finishTimed(live, 0, 28);
    expect(end(live).entries.find(e => e.id === "splitSquatHold")!.sets).toEqual([{ w: null, reps: null, secs: 28 }]);
  });

  test("an edit of a two-sided set's seconds (the review's) is each side's", () => {
    const live = Recorder.create(data, { steps: [side("Left", 30, false), side("Right", 30)], plannedSeconds: 0 }, meta0);
    for (const k of [0, 1]) {
      Recorder.reach(live, k);
      Recorder.finishTimed(live, k, 30);
    }
    Recorder.update(live, "splitSquatHold", 0, "secs", 25);
    expect(end(live).entries.find(e => e.id === "splitSquatHold")!.sets).toEqual([{ w: null, reps: null, secs: 25, sides: { left: 25, right: 25 } }]);
  });
});

describe("review: decisions are a pending change set, applied on save (spec §5 change 4)", () => {
  const prefs = { ratings: { a: 1 }, excluded: ["x"], pinned: [] };

  test("rating during review changes nothing until the change set is applied", () => {
    let review = Review.start();
    review = Review.rate(review, prefs, "a", 1);       // same as saved: clears it
    review = Review.rate(review, prefs, "b", -1);
    review = Review.rate(review, prefs, "x", "never"); // toggles the saved exclusion off
    review = Review.rate(review, prefs, "y", "never");
    expect(prefs).toEqual({ ratings: { a: 1 }, excluded: ["x"], pinned: [] });
    expect(Review.effectivePrefs(prefs, review)).toEqual({ ratings: { b: -1 }, excluded: ["y"], pinned: [] });
    const changes = Review.pending(review, []);
    expect(changes).toEqual({ ratings: { a: null, b: -1 }, excluded: { x: false, y: true }, graduations: [] });
    const applied = Review.apply(data, { prefs, block, today: "2026-09-29", equipment: home.equipment }, changes);
    expect(applied.prefs).toEqual({ ratings: { b: -1 }, excluded: ["y"], pinned: [] });
    expect(applied.block).toBe(block);
    // Rating twice the same way within one review returns to the saved value: no decision is left (ruling 2b-R17), so
    // the save names no move for it.
    expect(Review.pending(Review.rate(Review.rate(Review.start(), prefs, "b", 1), prefs, "b", 1), []).ratings).toEqual({});
    expect(Review.pending(Review.rate(Review.rate(Review.start(), prefs, "y", "never"), prefs, "y", "never"), []).excluded).toEqual({});
    // Taking a SAVED rating or exclusion back off is a decision: it stays, to clear what was saved.
    const cleared = Review.rate(Review.rate(Review.rate(Review.start(), prefs, "a", -1), prefs, "a", -1), prefs, "x", "never");
    expect(Review.pending(cleared, [])).toMatchObject({ ratings: { a: null }, excluded: { x: false } });
    // And back to what was saved again: nothing pending.
    expect(Review.pending(Review.rate(Review.rate(Review.start(), prefs, "a", 1), prefs, "a", 1), []).ratings).toEqual({});
  });

  test("a graduation accepted in review applies on save, and a withdrawn offer is pruned", () => {
    const squat = block.core.squat!;
    const harder = data.exercises.find(ex => Lib.coreFamilyOf(data, ex) === "squat" && ex.id !== squat && Lib.hasEquipment(ex, home.equipment))!;
    const offers = [{ family: "squat", from: squat, to: harder.id }];
    let review = Review.graduate(Review.start(), "squat", harder.id, true);
    review = Review.graduate(review, "row", "someRow", true);          // offered once, then withdrawn by an edit
    expect(Review.pending(review, offers).graduations).toEqual([{ family: "squat", to: harder.id }]);
    const applied = Review.apply(data, { prefs, block, today: "2026-09-29", equipment: home.equipment }, Review.pending(review, offers));
    expect(applied.block!.core.squat).toBe(harder.id);
    expect(Review.pending(review, []).graduations).toEqual([]);
    expect(Review.pending(Review.graduate(review, "squat", harder.id, false), offers).graduations).toEqual([]);
  });

  test("an offer withdrawn by an edit and then offered again comes back unaccepted (audit library #13)", () => {
    const squat = block.core.squat!;
    const harder = data.exercises.find(ex => Lib.coreFamilyOf(data, ex) === "squat" && ex.id !== squat && Lib.hasEquipment(ex, home.equipment))!;
    const offers = [{ family: "squat", from: squat, to: harder.id }];
    let review = Review.prune(Review.graduate(Review.start(), "squat", harder.id, true), offers);
    expect(Review.pending(review, offers).graduations).toEqual([{ family: "squat", to: harder.id }]);
    review = Review.prune(review, []);        // an edit withdraws the offer (the review re-renders)
    review = Review.prune(review, offers);    // another edit brings it back
    expect(review.graduate).toEqual({});
    expect(Review.pending(review, offers).graduations).toEqual([]);
  });

  test("the live session is untouched by review decisions", () => {
    const plan = planFor();
    const live: Live = Recorder.create(data, plan, meta(plan));
    const before = JSON.stringify(live.entries);
    Review.rate(Review.start(), prefs, live.order[0]!, 1);
    expect(JSON.stringify(live.entries)).toBe(before);
  });
});
