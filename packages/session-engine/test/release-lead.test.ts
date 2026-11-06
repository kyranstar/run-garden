import { addDays } from "@rg/domain";
import type { ExerciseRecord, Mode } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Blocks, Builder, Planner, Proposal, type Block, type BuildInput, type HistorySession, type Item, type Step } from "../src/index.js";
import { block, checksFor, data, gym, home, makeInput } from "./builder-fixtures.js";

// A block's `lead`: the cool-down opens with a release when the place has the gear, chosen by the athlete's focus areas.
// Found by measuring (2026-11-05): held to the cool-down's own share a two-sided release never fit, so the one move done
// on both sides at once won every time; and the weekly new move's swap took the longest item, which was the release.

const BALL = [...home.equipment, "massage-ball"];
const withBall = { ...home, equipment: BALL };
const HIP_FOCUS = ["hip-flexors", "deep-hip-rotators", "glute-min-tfl"];
const MODES: readonly Mode[] = ["recovery", "consistent", "build"];
const input = makeInput({ block });
const isRelease = (ex: ExerciseRecord) => ex.roles.includes("release");
const cooldown = (items: readonly Item[]) => items.filter((it) => it.block === "cooldown");
const lead = (items: readonly Item[]): ExerciseRecord | undefined => cooldown(items)[0]?.exercise;

/** A season of sessions, each recorded as done, so the next build reads it. */
function season(equipment: readonly string[], mode: Mode | null, minutes: number, focus: readonly string[], count = 24) {
  const location = { ...home, equipment };
  const sessions: HistorySession[] = [];
  const prefs = { ratings: {}, excluded: [], pinned: [] };
  let current: Block | null = null;
  const plans: { input: BuildInput; items: readonly Item[]; steps: readonly Step[]; mode: Mode; total: number; today: string }[] = [];
  for (let i = 0; i < count; i++) {
    const today = addDays("2026-06-01", i * 3);
    current = Blocks.ensure(data, current, { today, equipment, prefs, weeks: 5, sessions }).block;
    const checks = checksFor(1);
    const m = mode ?? Proposal.mode(data, { checks, sessions, today, weeklyGoal: 2 }).mode;
    const theme = Proposal.theme(data, { mode: m, sessions, today }).theme;
    const built: BuildInput = { today, mode: m, theme, minutes, location, unit: "lb", sessions: [...sessions], prefs, block: current, checks, swaps: {}, focus };
    const plan = Builder.build(data, built);
    plans.push({ input: built, items: plan.items, steps: plan.steps, mode: m, today, total: plan.steps.reduce((sum, s) => sum + s.seconds + (s.prepGap || 0), 0) });
    sessions.push({
      id: `s${i}`, date: today, startedAt: `${today}T18:00:00`, mode: m, theme: theme ? theme.id : null, blockNumber: null, checks,
      done: plan.items.map((it) => ({ id: it.exercise.id, secs: 0 })),
      entries: plan.items.filter((it) => it.target).map((it) => ({
        id: it.exercise.id, implement: null, perSide: false, format: it.format, flags: [],
        sets: Array.from({ length: Math.max(1, it.sets) }, () => ({ w: it.target!.w, reps: it.target!.reps, secs: it.target!.secs })),
      })),
    });
  }
  return plans;
}

describe("the cool-down's lead", () => {
  test("is only ever in the skeleton as data: the cool-down names it and no other block does", () => {
    const blocks = data.skeleton.blocks;
    expect(blocks.cooldown?.lead).toEqual(["release"]);
    for (const id of ["arrive", "prep", "core", "accessory", "care"] as const) expect(blocks[id]?.lead, id).toBeUndefined();
  });

  for (const mode of MODES) {
    test(`with the ball, a ${mode} session of 30 minutes opens its cool-down with a release`, () => {
      for (const plan of season(BALL, mode, 30, HIP_FOCUS)) expect(isRelease(lead(plan.items)!), plan.today).toBe(true);
    });
  }

  test("a place without the gear has no lead at all, and the focus areas change nothing there", () => {
    for (const place of [home, gym]) {
      for (const mode of MODES) {
        const plain = Builder.build(data, input({ mode, location: place })).items;
        const focused = Builder.build(data, input({ mode, location: place, focus: HIP_FOCUS })).items;
        expect(focused.map((it) => it.exercise.id), `${place.id} ${mode}`).toEqual(plain.map((it) => it.exercise.id));
        expect(plain.some((it) => isRelease(it.exercise)), `${place.id} ${mode}`).toBe(false);
      }
    }
  });

  test("the focus areas decide it, and the reason says so", () => {
    const hips = Builder.build(data, input({ location: withBall, focus: ["hip-flexors"] })).items;
    expect(lead(hips)!.id).toBe("massageBallFrontHip");
    expect(cooldown(hips)[0]!.why[0]).toBe("Eases your hip flexors, a focus area");
    const back = Builder.build(data, input({ location: withBall, focus: ["thoracic-extensors"] })).items;
    expect(lead(back)!.id).toBe("massageBallUpperBack");
  });

  test("the planner hands the focus areas on to the lead", () => {
    const state = (focus?: readonly string[]) => ({
      settings: { unit: "lb" as const, weeklyGoal: 2, blockWeeks: 5, defaultMinutes: 30, location: withBall.id },
      locations: [withBall], prefs: { ratings: {}, excluded: [], pinned: [] }, savedIds: [], block, sessions: [],
      ...(focus ? { focus } : {}),
    });
    const leadFor = (focus: readonly string[]) =>
      lead(Planner.planToday(data, { today: "2026-09-29", day: null }, state(focus)).view.plan!.items)!.id;
    expect(leadFor(["hip-flexors"])).toBe("massageBallFrontHip");
    expect(leadFor(["hamstrings"])).toBe("massageBallHamstring");
  });

  test("a lead comes on top of the block: the cool-down keeps its own moves beside it, and no second release", () => {
    for (const [mode, minutes] of [["consistent", 30], ["build", 30], ["recovery", 30], ["consistent", 45]] as const) {
      const plans = season(BALL, mode, minutes, HIP_FOCUS);
      for (const p of plans) {
        expect(cooldown(p.items).length, `${mode} ${minutes} ${p.today}`).toBeGreaterThanOrEqual(2);
        for (const it of cooldown(p.items).slice(1)) expect(it.exercise.patterns, `${mode} ${minutes} ${p.today}`).not.toContain("release");
      }
    }
  });

  test("a release before the work plays a minute at most; the same move after the work plays its full dose", () => {
    let seen = 0;
    for (const mode of MODES) {
      for (const minutes of [30, 45]) {
        for (const plan of season(BALL, mode, minutes, HIP_FOCUS, 12)) {
          for (const step of plan.steps) {
            const ex = data.exercises.find((e) => e.id === step.exerciseId);
            if (step.kind !== "timed" || !ex?.patterns.includes("release") || !ex.equipment.all.includes("massage-ball")) continue;
            if (step.block === "prep") {
              seen += 1;
              expect(step.seconds, `${mode} ${plan.today} ${ex.id}`).toBeLessThanOrEqual(60);
            } else if (step.block === "cooldown" && ex.dose.range[1] === 120) {
              expect(step.seconds, `${mode} ${plan.today} ${ex.id}`).toBe(90);
            }
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("it rotates, so a tight area gets its turns and no site repeats within three sessions", () => {
    const leads = season(BALL, "consistent", 30, HIP_FOCUS).map((p) => lead(p.items)!.id);
    expect(new Set(leads).size).toBeGreaterThanOrEqual(4);
    leads.forEach((id, i) => {
      if (i > 0) expect(leads.slice(Math.max(0, i - 3), i), `${i}: ${leads.join(" ")}`).not.toContain(id);
    });
    const onFocus = leads.filter((id) => ["massageBallFrontHip", "massageBallDeepHip", "massageBallOuterHip"].includes(id));
    expect(onFocus.length, leads.join(" ")).toBeGreaterThanOrEqual(leads.length / 2);
  });

  test("a move done on one side at a time gets to lead: the block's small share doesn't shut it out", () => {
    const leads = season(BALL, "build", 30, HIP_FOCUS).map((p) => lead(p.items)!);
    expect(leads.some((ex) => ex.laterality === "unilateral")).toBe(true);
  });

  test("a short session keeps its time for the work: a two-sided release doesn't fit in 15 minutes", () => {
    for (const plan of season(BALL, "consistent", 15, HIP_FOCUS)) {
      const first = lead(plan.items);
      if (first && isRelease(first)) expect(first.laterality, plan.today).toBe("bilateral");
    }
  });

  test("a sole candidate doesn't repeat in every session", () => {
    const leads = season(BALL, "consistent", 15, HIP_FOCUS).map((p) => lead(p.items));
    expect(leads.filter((ex) => ex && isRelease(ex)).length).toBeLessThan(leads.length / 2);
  });

  test("the session stays within its minutes, and a release costs warm-up moves and not lifting", () => {
    // The same days from the same history: a season each would drift onto different themes and lifts, and compare those.
    for (const [mode, minutes] of [["consistent", 30], ["build", 30], ["consistent", 45], ["build", 45]] as const) {
      const days = season(home.equipment, mode, minutes, HIP_FOCUS).map((p) => p.input);
      const coreSets = (items: readonly Item[]) => items.filter((it) => it.block === "core").reduce((s, it) => s + it.sets, 0);
      let setsWithout = 0;
      let setsWith = 0;
      for (const day of days) {
        const without = Builder.build(data, day);
        const withIt = Builder.build(data, { ...day, location: withBall });
        const seconds = withIt.steps.reduce((sum, s) => sum + s.seconds + (s.prepGap || 0), 0);
        expect(seconds, `${mode} ${minutes} ${day.today}`).toBeLessThanOrEqual(minutes * 60 + 60);
        // A single day can differ by a set or two either way, as a shorter warm-up leaves a different remainder. The mean
        // below is the promise.
        expect(coreSets(withIt.items), `${mode} ${minutes} ${day.today}`).toBeGreaterThanOrEqual(coreSets(without.items) - 2);
        setsWithout += coreSets(without.items);
        setsWith += coreSets(withIt.items);
      }
      expect(setsWith / days.length, `${mode} ${minutes}`).toBeGreaterThanOrEqual(setsWithout / days.length - 0.1);
    }
  });

});
