import { describe, expect, test } from "vitest";
import { Builder, Lib, Planner, Records, Recorder, Review, type BuildInput, type Live, type RecorderMeta, type Theme } from "../src/index.js";
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
    // Rating twice the same way within one review returns to the saved value.
    expect(Review.pending(Review.rate(Review.rate(Review.start(), prefs, "b", 1), prefs, "b", 1), []).ratings).toEqual({ b: null });
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
