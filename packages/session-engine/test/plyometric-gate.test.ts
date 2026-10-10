import { addDays } from "@rg/domain";
import { EXERCISES, THEMES, makeEngineData, type EngineData, type ExerciseRecord, type Mode, type Theme } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Builder, type BuildResult, type HistorySession } from "../src/index.js";
import { PLACES, block, data } from "./builder-fixtures.js";

// The plyometric gate at build level (Task 5). The jaw profile's `allowRecord` keeps every plyometric move (jumps,
// hops, bounds, landings) out of recovery, and out of every other mode unless today's check is answered and calm.
// Each case runs 200 seeded builds (date, minutes, place, theme and seed all vary) and looks everywhere a move can
// reach the athlete: plan items, steps, offered alternatives and the offline swap pools.

const PLYOMETRIC = EXERCISES.filter(e => e.contraction.includes("plyometric"));
const softId = (id: string) => `soft${id[0]!.toUpperCase()}${id.slice(1)}`;
// A gentle twin of every plyometric move: rated 0 for the jaw, difficulty 1, unloaded, and allowed in every block
// recovery fills. Nothing but the gate can keep a twin out of a recovery session.
const twins: ExerciseRecord[] = PLYOMETRIC.map(e => ({
  ...e, id: softId(e.id), legacyIds: [], name: `Soft ${e.name}`, family: `soft-${e.family}`, easier: [], harder: [],
  roles: ["warmup", "activation", "mobility", "accessory", "cooldown", "stretch"], difficulty: 1, load: "none",
  equipment: { all: [], oneOf: [] }, laterality: "bilateral", dose: { type: "time", range: [20, 30] },
  conditions: { ...e.conditions, tmj: { clench: 0, neckLoad: 0, faceDown: false } }, providers: undefined,
}));
const GATED = new Set([...PLYOMETRIC, ...twins].map(e => e.id));
const withTwins: EngineData = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: [...EXERCISES, ...twins] });

// Every gated move rated 👍 and saved; every other move done recently, so the gated moves are the only new ones and
// ranking and the weekly new-move guarantee would both reach for them first.
const stressPrefs = { ratings: Object.fromEntries([...GATED].map(id => [id, 1])), excluded: [], pinned: [] as string[] };
const doneEverythingElse = (today: string): HistorySession[] => [{
  id: "h1", date: addDays(today, -3), startedAt: null, mode: "consistent", theme: null, blockNumber: 1,
  checks: { tmj: { pre: 1, post: 1, feelingOff: false } },
  done: EXERCISES.filter(e => !GATED.has(e.id)).map(e => ({ id: e.id, secs: 60 })), entries: [],
}];

// The mode's themes, the jumping theme asked for outright (whatever the mode), and no theme at all.
const plyoIntro = THEMES.find(t => t.id === "plyoIntro") ?? null;
const themesFor = (d: EngineData, mode: Mode): Array<Theme | null> => [...d.themes.filter(t => t.modes.includes(mode)), plyoIntro, null];

interface Case { d: EngineData; mode: (i: number) => Mode; pre: (i: number) => number | null; stress: boolean }

function builds({ d, mode, pre, stress }: Case): BuildResult[] {
  const out: BuildResult[] = [];
  for (let i = 0; i < 200; i++) {
    const today = addDays("2026-10-05", i % 29);
    const m = mode(i);
    const themes = themesFor(d, m);
    out.push(Builder.build(d, {
      today, mode: m, theme: themes[i % themes.length] ?? null, minutes: [15, 20, 30, 40, 60][i % 5]!, location: PLACES[i % PLACES.length]!,
      unit: "lb", sessions: stress && i % 2 ? doneEverythingElse(today) : [], prefs: stress ? stressPrefs : {},
      savedIds: stress ? [...GATED] : [], block, checks: { tmj: { pre: pre(i), post: null, feelingOff: false } }, swaps: {}, programId: `seed-${i}`,
    }));
  }
  return out;
}

/** Every gated move a plan lets the athlete reach. */
const reach = (plan: BuildResult): string[] => [
  ...plan.items.map(i => i.exercise.id),
  ...plan.steps.flatMap(s => (s.exerciseId ? [s.exerciseId] : [])),
  ...Object.values(plan.alternatives).flatMap(alts => alts.map(a => a.id)),
  ...Object.values(plan.swapState.slots).flatMap(slot => [slot.original, ...slot.pool].map(c => c.id)),
].filter(id => GATED.has(id));

describe("the plyometric gate holds in every plan", () => {
  test("recovery: none in 200 seeded builds, even on a calm, answered day and with every gated move rated 👍 and new", () => {
    const plans = builds({ d: withTwins, mode: () => "recovery", pre: i => [0, 1, 2, null][i % 4]!, stress: true });
    expect(plans.every(p => p.items.length > 0)).toBe(true);
    expect(plans.flatMap(reach)).toEqual([]);
  });

  test("a pre-check of 4: none in 200 seeded builds in consistent or build", () => {
    const plans = builds({ d: withTwins, mode: i => (i % 2 ? "build" : "consistent"), pre: () => 4, stress: true });
    expect(plans.flatMap(reach)).toEqual([]);
  });

  test("an unanswered check: none in 200 seeded builds in consistent or build", () => {
    const plans = builds({ d: withTwins, mode: i => (i % 2 ? "build" : "consistent"), pre: () => null, stress: true });
    expect(plans.flatMap(reach)).toEqual([]);
  });

  test("the stress setup would reach them: a calm, answered check in build lets the gated moves through", () => {
    const plans = builds({ d: withTwins, mode: () => "build", pre: () => 1, stress: true });
    expect(plans.filter(p => p.items.some(i => GATED.has(i.exercise.id))).length).toBeGreaterThan(50);
  });
});

describe("a calm, answered check: plyometrics may appear", () => {
  const chosenIn = (mode: Mode) => builds({ d: data, mode: () => mode, pre: () => 1, stress: false })
    .flatMap(p => p.items.filter(i => GATED.has(i.exercise.id)).map(i => i.exercise));

  test("in build they appear, the tuck jump included", () => {
    const chosen = chosenIn("build");
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.some(e => e.id === "tuckJump")).toBe(true);
  });

  test("in consistent they appear, never above the mode's difficulty cap: the tuck jump is build only", () => {
    const chosen = chosenIn("consistent");
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.filter(e => e.difficulty > data.modes.consistent.maxDifficulty).map(e => e.id)).toEqual([]);
  });

  // Not yet true: the accessory and prep blocks rank moves with no regard to difficulty, so with no jumping history a
  // drop landing or a tuck jump can be the first plyometric move (measured in the Task 5 report). Holding a rung back
  // until the one below it has been done needs the history, which only the engine has.
  test.todo("with no jumping history, the first plyometric moves come from the low-difficulty end of the ladder");
});
