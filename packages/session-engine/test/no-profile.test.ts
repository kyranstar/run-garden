import { addDays } from "@rg/domain";
import { EXERCISES, MODE_IDS, SKELETON, makeEngineData, type EngineData } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Lib, Planner, Prog, Records, Recorder, type HistorySession, type ProgramState, type TodayView } from "../src/index.js";
import { PLACES } from "./builder-fixtures.js";

// Review Focus 2: an engine with no condition profile active never reads a rating, has no care block, splits
// the minutes over the remaining blocks, and says nothing about any condition — for a week of real use.

const CONDITION_WORDS = /tmj|jaw|clench/i;

function week(data: EngineData, days = 7, start = "2026-09-21") {
  let program: ProgramState = {
    settings: { unit: "lb", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 30, location: "home" },
    locations: PLACES, prefs: { ratings: {}, excluded: [], pinned: [] }, savedIds: [], block: null, sessions: [],
  };
  const views: TodayView[] = [];
  const sessions: HistorySession[] = [];
  for (let d = 0; d < days; d++) {
    const today = addDays(start, d);
    const minutes = [15, 30, 40][d % 3]!;
    const day = Planner.setOverride(null, today, "minutes", minutes);
    const { view, blockUpdate } = Planner.planToday(data, { today, day }, program);
    views.push(view);
    if (blockUpdate) program = { ...program, block: blockUpdate.block };
    const live = Recorder.create(data, view.plan, {
      id: `np-${d}`, startedAt: `${today}T18:00:00.000Z`, date: today, mode: view.mode, theme: view.theme ? view.theme.id : null,
      locationId: view.location.id, minutes: view.minutes, block: view.block, checks: {}, equipment: view.location.equipment,
      plannedSeconds: view.plan.plannedSeconds, newMove: view.plan.newMove,
    });
    view.plan.steps.forEach((_, k) => Recorder.reach(live, k));
    const saved = Recorder.toSession(live, { endedAt: `${today}T18:40:00.000Z`, note: "", completed: true });
    sessions.push(saved);
    program = { ...program, sessions: [...program.sessions, saved] };
  }
  return { views, sessions, program };
}

/** Every sentence the engine produced for a day: reasons, notes, events, alternatives' reasons. */
const sentences = (v: TodayView): string[] => [
  ...v.modeReasons, ...v.themeReasons, ...v.blockEvents,
  ...v.plan.items.flatMap(i => [...i.why, i.target?.note ?? "", i.target?.last ?? ""]),
  ...Object.values(v.plan.alternatives).flatMap(alts => alts.flatMap(a => a.reasons)),
];

describe("no condition profile active (Review Focus 2)", () => {
  const none = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: EXERCISES });

  test("a week of sessions builds without throwing, with no care block and renormalised shares", () => {
    const { views, sessions } = week(none);
    expect(views.length).toBe(7);
    expect(none.skeleton.order).not.toContain("care");
    for (const mode of MODE_IDS) {
      const shares = Object.values(none.skeleton.shares[mode]) as number[];
      expect(Math.abs(shares.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9);
      const original = SKELETON.shares[mode];
      const scale = 1 - (original.care ?? 0);
      for (const [block, share] of Object.entries(none.skeleton.shares[mode])) expect(share).toBeCloseTo((original[block as "prep"] ?? 0) / scale, 12);
    }
    for (const v of views) {
      expect(v.plan.items.some(i => i.block === "care")).toBe(false);
      expect(v.plan.steps.some(s => s.block === "care")).toBe(false);
      expect(v.plan.plannedSeconds).toBeLessThanOrEqual(v.minutes * 60);
      expect(v.plan.items.length).toBeGreaterThan(3);
    }
    expect(() => Records.compute(none, sessions)).not.toThrow();
    expect(Records.compute(none, sessions).milestones.some(m => m.id.startsWith("calm-"))).toBe(false);
  });

  test("the proposal uses the general rules only, and no reason or note names a condition", () => {
    const { views } = week(none);
    expect(views[0]!.modeReasons).toEqual(["First session — start steady."]);
    for (const v of views) {
      for (const s of sentences(v)) expect(s, s).not.toMatch(CONDITION_WORDS);
      // Only the general reasons can appear.
      for (const r of v.modeReasons) {
        expect(r).toMatch(/^(First session — start steady\.|\d+ days since your last session — rebuild the habit before pushing\.|You built strength (yesterday|earlier today) — give it 48 hours\.|\d+ of \d+ sessions in the last 7 days — consistency first\.|\d+ sessions in the last 7 days\.)$/);
      }
    }
    expect(views.some(v => v.mode === "build"), "general rules alone reach build within the week").toBe(true);
    expect(views.every(v => v.mode !== "recovery"), "nothing but a profile proposes recovery").toBe(true);
  });

  test("history logged with a profile's flags, and the themes on offer, show no condition words (audit M7)", () => {
    // Flags logged while TMJ was active, then the profile switched off.
    const { sessions } = week(makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES }), 3);
    const flagged = sessions.map(s => ({ ...s, entries: s.entries.map(e => ({ ...e, flags: ["clenched"] })) }));
    const lift = EXERCISES.find(e => flagged.some(s => s.entries.some(x => x.id === e.id)) && e.load === "external")!;
    const target = Prog.suggest(none, lift, Prog.historyFor(none, flagged, lift.id), { mode: "build", checks: {}, implement: "kettlebell", kbWeights: [], unit: "lb", equipment: ["kettlebell"] });
    expect(target.last, String(target.last)).not.toMatch(CONDITION_WORDS);
    for (const t of none.themes) expect(`${t.name} ${t.blurb}`, t.id).not.toMatch(CONDITION_WORDS);
    // With TMJ active the summary reads as before.
    const tmjData = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });
    const withTmj = Prog.suggest(tmjData, lift, Prog.historyFor(tmjData, flagged, lift.id), { mode: "build", checks: {}, implement: "kettlebell", kbWeights: [], unit: "lb", equipment: ["kettlebell"] });
    expect(withTmj.last).toMatch(/ · clenched$/);
  });

  test("no rating is read: records with no ratings at all are eligible and never throw", () => {
    const unrated = EXERCISES.map(ex => ({ ...ex, conditions: {} }));
    const bare = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: unrated });
    expect(() => week(bare, 3)).not.toThrow();
    expect(unrated.every(ex => Lib.fitsMode(bare, ex, "build") === Lib.fitsMode(none, EXERCISES.find(x => x.id === ex.id)!, "build"))).toBe(true);
  });
});

describe("a profile active but not cared for (a general program with TMJ rules)", () => {
  const rulesOnly = makeEngineData({ activeProfiles: ["tmj"], careProfiles: [], exercises: EXERCISES });

  test("the rules apply everywhere but there is no care block, care target or care theme", () => {
    const { views } = week(rulesOnly);
    expect(rulesOnly.targets.regions.jaw).toBeUndefined();
    for (const v of views) {
      expect(v.plan.items.some(i => i.block === "care")).toBe(false);
      expect(v.theme?.profile).toBeUndefined();
      for (const it of v.plan.items) expect(Lib.fitsMode(rulesOnly, it.exercise, v.mode)).toBe(true);
    }
  });
});
