import { EXERCISES, LOCATION_PRESETS, TMJ, makeEngineData, type ConditionProfile, type EngineData, type ExerciseRecord, type Mode } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import {
  Blocks, Builder, Planner, Recorder, Review, Swapping,
  type Block, type BuildInput, type BuildResult, type DayState, type EngineLocation, type HistorySession, type ProgramState,
} from "../src/index.js";

// The `never` rule at build level (spec §7, audit I3): the real library plus a clench-3 twin of every record.
// Each twin is rated 👍, saved and never done, so ranking, the new-move guarantee and every swap path would pick
// it first if anything let it through. No twin may reach a plan item, a step, an offered alternative, a block
// lift, a graduation or a saved block.

const twinId = (id: string) => `never${id[0]!.toUpperCase()}${id.slice(1)}`;
const twins: ExerciseRecord[] = EXERCISES.map(e => ({
  ...e, id: twinId(e.id), legacyIds: [], family: `never-${e.family}`, name: `Never ${e.name}`, harder: [], easier: [],
  conditions: { ...e.conditions, tmj: { ...e.conditions.tmj!, clench: 3 } },
}));
const TWINS = new Set(twins.map(t => t.id));
const library = [...EXERCISES, ...twins];
const tmjData = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: library });
// TMJ stops clench 3 in several places (mode and format caps, core candidates) besides `never`. This variant keeps
// only `never`, so these tests fail if any path stops consulting it.
const neverOnly: ConditionProfile = {
  ...TMJ,
  fitsMode: () => true, fitsFormat: () => true, coreCandidate: () => true, blockAssignable: () => true, flareSafe: () => true,
};
const neverOnlyData: EngineData = { ...tmjData, profiles: { active: [neverOnly], care: [neverOnly] } };
const noProfile = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: library });

const place = (id: string): EngineLocation => {
  const p = LOCATION_PRESETS.find(l => l.id === id)!;
  return { id: p.id, name: p.name, equipment: p.equipment, implements: {} };
};
const prefs = { ratings: Object.fromEntries([...TWINS].map(id => [id, 1])), excluded: [], pinned: [] as string[] };
const savedIds = [...TWINS];
// Every real move was done last week, so the twins are the only never-done moves (the new-move path).
const history: HistorySession[] = [{
  id: "h1", date: "2026-09-20", startedAt: "2026-09-20T18:00:00", mode: "build", theme: null, blockNumber: 1,
  checks: { tmj: { pre: 1, post: 1, feelingOff: false } }, done: EXERCISES.map(e => ({ id: e.id, secs: 60 })), entries: [],
}];
const realBlock = Blocks.ensure(tmjData, null, { today: "2026-09-15", equipment: place("home").equipment, prefs: {}, sessions: [] }).block;
// A block whose lifts are all twins, as if assigned while no profile was active.
const twinBlock: Block = { ...realBlock, core: Object.fromEntries(Object.entries(realBlock.core).map(([f, id]) => [f, id ? twinId(id) : null])) };

const leaks = (plan: BuildResult): string[] => [
  ...plan.items.filter(i => TWINS.has(i.exercise.id)).map(i => `item ${i.slotKey}=${i.exercise.id}`),
  ...plan.steps.filter(s => s.exerciseId && TWINS.has(s.exerciseId)).map(s => `step ${s.slotKey}=${s.exerciseId}`),
  ...Object.entries(plan.alternatives).flatMap(([k, alts]) => alts.flatMap(a => [
    ...(TWINS.has(a.id) ? [`alternative ${k}=${a.id}`] : []),
    ...a.steps.filter(s => s.exerciseId && TWINS.has(s.exerciseId)).map(() => `alternative step ${k}`),
  ])),
  // The swap state's pools are what the player offers offline (re-review m2).
  ...Object.values(plan.swapState.slots).flatMap(slot => [slot.original, ...slot.pool].flatMap(c => [
    ...(TWINS.has(c.id) ? [`pool ${slot.slotKey}=${c.id}`] : []),
    ...c.steps.filter(s => s.exerciseId && TWINS.has(s.exerciseId)).map(() => `pool step ${slot.slotKey}`),
  ])),
];

const input = (o: Partial<BuildInput>): BuildInput => ({
  today: "2026-09-29", mode: "build", theme: null, minutes: 40, location: place("home"), unit: "lb", sessions: history,
  prefs, savedIds, block: realBlock, checks: { tmj: { pre: 0, post: null, feelingOff: false } }, swaps: {}, ...o,
});
const MODES: Mode[] = ["recovery", "consistent", "build"];
const themeFor = (mode: Mode, i: number) => { const t = tmjData.themes.filter(x => x.modes.includes(mode)); return t[i % t.length]!; };

describe.each([["TMJ", tmjData], ["a profile whose only exercise rule is never", neverOnlyData]] as const)("the never rule holds in every plan (audit I3): %s", (_name, data) => {
  test("plain builds: ranking, the new-move guarantee, core resolution at every place, extend and trim", () => {
    let n = 0;
    for (const today of ["2026-09-28", "2026-09-29"]) for (const mode of MODES) for (const loc of ["home", "gym", "mat"]) {
      for (const minutes of [15, 90]) for (const block of [realBlock, twinBlock]) {
        const plan = Builder.build(data, input({ today, mode, theme: themeFor(mode, n++), minutes, location: place(loc), block }));
        expect(plan.items.length).toBeGreaterThan(0);
        expect(leaks(plan), `${today} ${mode} ${loc} ${minutes}`).toEqual([]);
      }
    }
  });

  test("a swap to a twin at every slot, and k = 20 alternatives, never bring one in", () => {
    for (const mode of MODES) for (const loc of ["home", "gym", "mat"]) {
      const i = input({ mode, theme: themeFor(mode, 0), location: place(loc), block: twinBlock });
      // build = finish(prepare(input), swaps): one prepared plan serves every swap below.
      const prepared = Builder.prepare(data, i);
      const plan = Builder.finish(prepared, {});
      expect(Builder.build(data, i)).toEqual(plan);
      for (const it of plan.items) {
        const swapped = Builder.finish(prepared, { [it.slotKey]: { from: it.exercise.id, to: twinId(it.exercise.id) } });
        expect(leaks(swapped), `${mode} ${loc} ${it.slotKey}`).toEqual([]);
        // The pools hold every move a slot may take, so k = 20 lists and the offline pools carry no twin either.
        expect(Swapping.offered(plan.swapState, plan.steps, it.slotKey, 20).filter(a => TWINS.has(a.id))).toEqual([]);
        expect(plan.swapState.slots[it.slotKey]!.pool.filter(c => TWINS.has(c.id))).toEqual([]);
      }
      expect(Builder.alternatives(data, i, plan.items[0]!.slotKey, 20).filter(a => TWINS.has(a.id))).toEqual([]);
    }
  });

  test("swaps chosen while no profile was active are refused once the profile is active", () => {
    for (const mode of MODES) {
      const i = input({ mode, theme: themeFor(mode, 1), minutes: 40 });
      const loose = Builder.build(noProfile, { ...i, checks: {} });
      const stored: Record<string, { from: string; to: string }> = {};
      for (const it of loose.items) {
        const a = (loose.alternatives[it.slotKey] || []).find(x => TWINS.has(x.id));
        if (a) stored[it.slotKey] = { from: it.exercise.id, to: a.id };
      }
      expect(Object.keys(stored).length, "the loose engine should offer twins").toBeGreaterThan(0);
      expect(leaks(Builder.build(data, { ...i, swaps: stored }))).toEqual([]);
    }
  });

  test("blocks never take a twin: a fresh block with every twin rated 👍, graduation, and a review's forged graduation", () => {
    const fresh = Blocks.ensure(data, null, { today: "2026-09-29", equipment: place("gym").equipment, prefs, sessions: history }).block;
    expect(Object.values(fresh.core).filter(id => id && TWINS.has(id))).toEqual([]);
    for (const [family, id] of Object.entries(realBlock.core)) {
      if (!id) continue;
      expect(Blocks.graduate(data, realBlock, family, twinId(id), "2026-09-29", place("gym").equipment)).toBe(realBlock);
      const applied = Review.apply(data, { prefs, block: realBlock, today: "2026-09-29", equipment: place("gym").equipment }, { ratings: {}, excluded: {}, graduations: [{ family, to: twinId(id) }] });
      expect(applied.block).toBe(realBlock);
    }
  });

  test("the planner end to end: a twin block with a pinned twin, and a stored twin swap at every slot", () => {
    const program: ProgramState = {
      settings: { unit: "lb", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 40, location: "gym" },
      locations: [place("home"), place("gym"), place("mat")], prefs: { ...prefs, pinned: [twinBlock.core.squat!] }, savedIds, block: twinBlock, sessions: history,
    };
    const first = Planner.planToday(data, { today: "2026-09-29", day: null }, program);
    let day: DayState = { date: "2026-09-29", checks: { tmj: { pre: 0, post: null, feelingOff: false } }, override: { mode: "build" }, swaps: {} };
    for (const it of first.view.plan.items) day = Planner.swap(day, "2026-09-29", it.slotKey, it.exercise.id, twinId(it.exercise.id));
    const { view } = Planner.planToday(data, { today: "2026-09-29", day }, program);
    expect(leaks(view.plan)).toEqual([]);
    // A mid-session rebase onto a plan asked to hold a twin still plays none.
    const live = Recorder.create(data, view.plan, {
      id: "x", startedAt: "2026-09-29T18:00:00Z", date: "2026-09-29", mode: view.mode, theme: null, locationId: view.location.id,
      minutes: 40, block: view.block, checks: {}, equipment: view.location.equipment, plannedSeconds: view.plan.plannedSeconds, newMove: null,
    });
    const slot = view.plan.items[2]!;
    const fresh = Builder.build(data, { ...view.input, swaps: { ...view.input.swaps, [slot.slotKey]: { from: slot.exercise.id, to: twinId(slot.exercise.id) } } });
    const rebased = Recorder.rebase(data, live, fresh, 1, slot.slotKey);
    expect(rebased.steps.filter(s => s.exerciseId && TWINS.has(s.exerciseId))).toEqual([]);
  });
});
