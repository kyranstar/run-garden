import { describe, expect, test } from "vitest";
import { Lib, Planner, type DayState, type ExerciseRecord, type HistorySession, type ProgramState, type TodayView } from "../src/index.js";
import { PLACES, data } from "./builder-fixtures.js";
import { normalise, type LegacySession } from "./fixtures.js";

// Ported from the standalone tests/engine-planner.test.js. The standalone planner read and returned the whole
// saved document; here the stored program state and the day's state go in, and the view plus a block update
// come out (the worker persists). `today()` below plays the standalone round trip so the tests read the same.

const T = "2026-09-29";
interface State { program: ProgramState; day: DayState | null }
const fresh = (): State => ({
  program: {
    settings: { unit: "lb", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 30, location: "home" },
    locations: PLACES, prefs: { ratings: {}, excluded: [], pinned: [] }, savedIds: [], block: null, sessions: [],
  },
  day: null,
});

/** The standalone Planner.today(data, todayKey): the view, and the state with the block update and today applied. */
function today(state: State, todayKey: string): { data: State; view: TodayView } {
  const { view, blockUpdate } = Planner.planToday(data, { today: todayKey, day: state.day }, state.program);
  return { data: { program: { ...state.program, block: blockUpdate ? blockUpdate.block : state.program.block }, day: view.today }, view };
}
const withDay = (state: State, day: DayState): State => ({ ...state, day });

test("the first call starts block 1 and a fresh today; the same day keeps your choices", () => {
  const first = Planner.planToday(data, { today: T, day: null }, fresh().program);
  expect(first.blockUpdate?.events).toEqual(["Block 1 started."]);
  const { data: s, view } = today(fresh(), T);
  expect(s.program.block!.number).toBe(1);
  expect(s.day!.date).toBe(T);
  expect(view.mode).toBe("consistent");
  expect(view.modeReasons[0]).toBe("First session — start steady.");
  expect(view.plan.items.length).toBeGreaterThan(5);
  const withPre = withDay(s, Planner.setCheck(s.day, T, "tmj", { pre: 1 }));
  const again = today(withPre, T);
  expect(again.data.program.block!.id).toBe(s.program.block!.id);
  expect(again.view.today.checks.tmj!.pre).toBe(1);
  expect(Planner.planToday(data, { today: T, day: withPre.day }, withPre.program).blockUpdate).toBe(null);
});

test("a new day starts clean: yesterday's check, overrides, and swaps don't carry over", () => {
  let s = today(fresh(), "2026-09-28").data;
  s = withDay(s, Planner.setCheck(s.day, "2026-09-28", "tmj", { pre: 6 }));
  s = withDay(s, Planner.setOverride(s.day, "2026-09-28", "minutes", 15));
  const { view } = today(s, T);
  expect(view.today.checks.tmj?.pre ?? null).toBe(null);
  expect(view.minutes).toBe(30);
});

test("feeling off means recovery", () => {
  const s = today(fresh(), T).data;
  const off = withDay(s, Planner.setCheck(s.day, T, "tmj", { feelingOff: true }));
  expect(today(off, T).view.mode).toBe("recovery");
});

test("overrides for mode, theme, minutes, and location apply, and the proposal is still shown", () => {
  let s = today(fresh(), T).data;
  s = withDay(s, Planner.setOverride(s.day, T, "mode", "build"));
  s = withDay(s, Planner.setOverride(s.day, T, "theme", "carryDay"));
  s = withDay(s, Planner.setOverride(s.day, T, "minutes", 40));
  s = withDay(s, Planner.setOverride(s.day, T, "location", "gym"));
  const { view } = today(s, T);
  expect(view.mode).toBe("build");
  expect(view.proposedMode).toBe("consistent");
  expect(view.modeOverridden).toBe(true);
  expect(view.theme!.id).toBe("carryDay");
  expect(view.themeOverridden).toBe(true);
  expect(view.minutes).toBe(40);
  expect(view.location.id).toBe("gym");
  expect(view.plan.plannedSeconds).toBeLessThanOrEqual(2400);
  // A theme that doesn't suit the mode falls back to the proposal.
  const recovery = withDay(s, Planner.setOverride(s.day, T, "mode", "recovery"));
  const r = today(withDay(recovery, Planner.setOverride(recovery.day, T, "theme", "carryDay")), T).view;
  expect(r.theme!.modes).toContain("recovery");
  expect(r.themeOverridden).toBe(false);
  // Clearing an override goes back to the suggestion.
  expect(today(withDay(s, Planner.setOverride(s.day, T, "mode", null)), T).view.mode).toBe("consistent");
});

test("swaps apply and are cleared when the session shape changes", () => {
  const first = today(fresh(), T);
  const item = first.view.plan.items.find(i => i.block === "prep")!;
  const alt = Planner.alternatives(data, { today: T, day: first.data.day }, first.data.program, item.slotKey)[0]!;
  let s = withDay(first.data, Planner.swap(first.data.day, T, item.slotKey, item.exercise.id, alt.id));
  const swapped = today(s, T).view.plan;
  expect(swapped.items.find(i => i.slotKey === item.slotKey)!.exercise.id).toBe(alt.id);
  s = withDay(s, Planner.setOverride(s.day, T, "minutes", 15));
  expect(Object.keys(today(s, T).view.today.swaps)).toEqual([]);
});

test("an unknown saved location falls back to Home", () => {
  const s = today(fresh(), T).data;
  const moon: State = { ...s, program: { ...s.program, settings: { ...s.program.settings, location: "moon" } } };
  expect(today(moon, T).view.location.id).toBe("home");
});

test("accepting a graduation changes the block's lift", () => {
  const s = today(fresh(), T).data;
  const squat = s.program.block!.core.squat;
  const harder = data.exercises.find(ex => Lib.coreFamilyOf(data, ex) === "squat" && ex.id !== squat && Lib.hasEquipment(ex, s.program.locations[0]!.equipment))!;
  const next = Planner.acceptGraduate(data, s.program, T, "squat", harder.id);
  expect(next!.core.squat).toBe(harder.id);
});

test("swapping a swapped slot again keeps the newest choice; swapping back to the original clears it", () => {
  const first = today(fresh(), T);
  const item = first.view.plan.items.find(i => i.block === "prep")!;
  const original = item.exercise.id;
  const alts = (s: State, k = 3) => Planner.alternatives(data, { today: T, day: s.day }, s.program, item.slotKey, k);
  const [a] = alts(first.data);
  let s = withDay(first.data, Planner.swap(first.data.day, T, item.slotKey, original, a!.id));
  // A swap is validated against the unswapped plan, so the second choice must not already be in it. (The
  // standalone test picked the first other alternative, which with the standalone library's saves bonus
  // happened to be one; without that bonus the first is a move the unswapped plan holds elsewhere.)
  const unswapped = new Set(first.view.plan.items.map(i => i.exercise.id));
  const b = alts(s, 20).find(x => x.id !== original && x.id !== a!.id && !unswapped.has(x.id));
  expect(b, "needs a second alternative").toBeTruthy();
  s = withDay(s, Planner.swap(s.day, T, item.slotKey, a!.id, b!.id));
  expect(s.day!.swaps[item.slotKey]).toEqual({ from: original, to: b!.id });
  expect(today(s, T).view.plan.items.find(i => i.slotKey === item.slotKey)!.exercise.id).toBe(b!.id);
  s = withDay(s, Planner.swap(s.day, T, item.slotKey, b!.id, original));
  expect(today(s, T).view.plan.items.find(i => i.slotKey === item.slotKey)!.exercise.id).toBe(original);
  expect(Object.keys(today(s, T).view.today.swaps)).toEqual([]);
});

// A bodyweight core lift with a harder move in the same family that Home can do; the block uses it.
function blockWithBodyweightLift(): { state: State; family: string; ex: ExerciseRecord } {
  const state = today(fresh(), T).data;
  const home = state.program.locations.find(l => l.id === "home")!;
  for (const f of data.coreFamilies) {
    const ex = data.exercises.find(x => Lib.coreFamilyOf(data, x) === f.id && x.load === "bodyweight" && x.dose.type === "reps" &&
      Lib.hasEquipment(x, home.equipment) && (x.harder || []).some(h => Lib.get(data, h) && Lib.coreFamilyOf(data, Lib.get(data, h)) === f.id && Lib.hasEquipment(Lib.get(data, h)!, home.equipment)));
    if (ex) {
      const block = { ...state.program.block!, core: { ...state.program.block!.core, [f.id]: ex.id } };
      return { state: { ...state, program: { ...state.program, block } }, family: f.id, ex };
    }
  }
  throw new Error("no bodyweight core lift with a harder move");
}
const toppedOut = (ex: ExerciseRecord, o: LegacySession = {}): HistorySession => normalise({
  id: "s_new", date: T, startedAt: `${T}T18:00:00.000Z`, mode: "build", pre: 1, post: 1,
  entries: [{ id: ex.id, log: "reps", metric: "reps", format: "straight", clenched: false, sets: [{ w: null, reps: ex.dose.range[1], secs: null }, { w: null, reps: ex.dose.range[1], secs: null }] }],
  ...o,
});

test("graduation offers come from this session's topped-out core lifts, and vanish if symptoms rose", () => {
  const { state, family, ex } = blockWithBodyweightLift();
  const offers = Planner.graduationOffers(data, state.program, toppedOut(ex));
  const offer = offers.find(o => o.family === family);
  expect(offer, "topped-out lift should be offered").toBeTruthy();
  expect(offer!.from).toBe(ex.id);
  expect(Planner.acceptGraduate(data, state.program, T, family, offer!.to)!.core[family]).not.toBe(ex.id);
  expect(Planner.graduationOffers(data, state.program, toppedOut(ex, { pre: 1, post: 4 })).some(o => o.family === family)).toBe(false);
  expect(Planner.graduationOffers(data, state.program, toppedOut(ex, { entries: [] })).some(o => o.family === family)).toBe(false);
});

describe("beyond the standalone suite", () => {
  test("a swap of a swap keeps the slot's original move as `from`", () => {
    let day = Planner.swap(null, T, "prep:1", "a", "b");
    day = Planner.swap(day, T, "prep:1", "b", "c");
    expect(day.swaps["prep:1"]).toEqual({ from: "a", to: "c" });
    expect(Planner.swap(day, T, "prep:1", "c", "a").swaps["prep:1"]).toBeUndefined();
  });

  test("planToday is pure: it never changes the state it was given", () => {
    const s = fresh();
    const before = JSON.stringify(s);
    Planner.planToday(data, { today: T, day: s.day }, s.program);
    expect(JSON.stringify(s)).toBe(before);
  });
});
