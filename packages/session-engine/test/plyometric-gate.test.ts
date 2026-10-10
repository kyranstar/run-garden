import { addDays } from "@rg/domain";
import {
  EXERCISES, THEMES, isPlyometric, makeEngineData,
  type CheckReading, type EngineData, type ExerciseRecord, type Mode, type Theme,
} from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Builder, Planner, Prog, type BuildResult, type HistorySession, type ProgEntry, type ProgramState } from "../src/index.js";
import { PLACES, block, data, home } from "./builder-fixtures.js";

// Plyometric moves in the programme (Task 5, ruling b). Two layers keep them where they belong:
//  - the condition profile's gate (`allowRecord`): the jaw profile never allows one in recovery, when feeling off, or
//    without an answered, calm check;
//  - the engine: a plyometric move is placed only on a jumping day (a theme that emphasises plyometric work), only
//    from the athlete's frontier (no easier variant, or one already done), the next rung first, in one straight-set or
//    superset block that plays after the warm-up and before the core lifts.
// Each case runs 200 seeded builds (date, minutes, place, theme and seed vary) and looks everywhere a move can reach
// the athlete: plan items, steps, offered alternatives and the offline swap pools.

const PLYOMETRIC = EXERCISES.filter(isPlyometric);
const byId = new Map(EXERCISES.map(e => [e.id, e]));
const moveKey = (e: ExerciseRecord) => `${e.family}|${[...e.regions].sort().join(",")}`;
const softId = (id: string) => `soft${id[0]!.toUpperCase()}${id.slice(1)}`;
// A gentle twin of every plyometric move: rated 0 for the jaw, difficulty 1, unloaded, no easier variant, and allowed
// in every block. Only the gate and the engine's jumping-day rules can keep a twin out.
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

const plyoIntro = THEMES.find(t => t.id === "plyoIntro")!;
/** A made-up jumping day that prefers circuits and ladders: the plyometric block must still be straight sets or supersets. */
const circuitJumps: Theme = { ...plyoIntro, id: "circuitJumps", formats: ["circuit", "ladder"] };
const nonJumping = (d: EngineData, mode: Mode): Array<Theme | null> => [...d.themes.filter(t => t.modes.includes(mode) && t.id !== "plyoIntro"), null];

interface Case {
  d: EngineData;
  mode: (i: number) => Mode;
  check: (i: number) => CheckReading;
  themes: (d: EngineData, mode: Mode) => Array<Theme | null>;
  stress: boolean;
  sessions?: (today: string, i: number) => HistorySession[];
}

const calm: CheckReading = { pre: 1, post: null, feelingOff: false };

function builds({ d, mode, check, themes, stress, sessions }: Case): BuildResult[] {
  const out: BuildResult[] = [];
  for (let i = 0; i < 200; i++) {
    const today = addDays("2026-10-05", i % 29);
    const m = mode(i);
    const options = themes(d, m);
    out.push(Builder.build(d, {
      today, mode: m, theme: options[i % options.length] ?? null, minutes: [15, 20, 30, 40, 60][i % 5]!, location: PLACES[i % PLACES.length]!,
      unit: "lb", sessions: sessions ? sessions(today, i) : stress && i % 2 ? doneEverythingElse(today) : [], prefs: stress ? stressPrefs : {},
      savedIds: stress ? [...GATED] : [], block, checks: { tmj: check(i) }, swaps: {}, programId: `seed-${i}`,
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

const jumpingDay = (_d: EngineData, _m: Mode): Array<Theme | null> => [plyoIntro, circuitJumps];
const everyTheme = (d: EngineData, m: Mode): Array<Theme | null> => [...nonJumping(d, m), plyoIntro, circuitJumps];
const consistentOrBuild = (i: number): Mode => (i % 2 ? "build" : "consistent");

describe("the gate holds in every plan, jumping day or not", () => {
  test("recovery: none in 200 seeded builds, even on a calm, answered day, asked for a jumping day, with every gated move rated 👍 and new", () => {
    const plans = builds({ d: withTwins, mode: () => "recovery", check: i => ({ ...calm, pre: [0, 1, 2, null][i % 4]! }), themes: everyTheme, stress: true });
    expect(plans.every(p => p.items.length > 0)).toBe(true);
    expect(plans.flatMap(reach)).toEqual([]);
  });

  test("a pre-check of 4: none in 200 seeded builds in consistent or build", () => {
    expect(builds({ d: withTwins, mode: consistentOrBuild, check: () => ({ ...calm, pre: 4 }), themes: everyTheme, stress: true }).flatMap(reach)).toEqual([]);
  });

  test("an unanswered check: none in 200 seeded builds in consistent or build", () => {
    expect(builds({ d: withTwins, mode: consistentOrBuild, check: () => ({ ...calm, pre: null }), themes: everyTheme, stress: true }).flatMap(reach)).toEqual([]);
  });

  test("feeling off: none in 200 seeded builds, even with a calm check on a jumping day", () => {
    expect(builds({ d: withTwins, mode: consistentOrBuild, check: () => ({ ...calm, feelingOff: true }), themes: jumpingDay, stress: true }).flatMap(reach)).toEqual([]);
  });
});

describe("only on a jumping day", () => {
  test("any other theme (or none): no plyometric move anywhere in 200 seeded builds, even calm, rated 👍, saved, new and allowed in every block", () => {
    expect(builds({ d: withTwins, mode: consistentOrBuild, check: () => calm, themes: nonJumping, stress: true }).flatMap(reach)).toEqual([]);
  });

  test("the jumping day reaches them: a calm check on plyoIntro places plyometric moves in most builds", () => {
    const plans = builds({ d: withTwins, mode: consistentOrBuild, check: () => calm, themes: jumpingDay, stress: true });
    expect(plans.filter(p => p.items.some(i => GATED.has(i.exercise.id))).length).toBeGreaterThan(100);
  });
});

/** The plan's groups that hold plyometric moves. */
const plyoGroups = (plan: BuildResult) => plan.groups.filter(g => g.items.some(i => GATED.has(i.exercise.id)));

describe("the plyometric block on a jumping day", () => {
  const plans = builds({ d: withTwins, mode: consistentOrBuild, check: () => calm, themes: jumpingDay, stress: true });

  test("at most one block, holding only plyometric moves, as straight sets or a superset (even when the theme prefers circuits)", () => {
    const bad: string[] = [];
    for (const plan of plans) {
      const groups = plyoGroups(plan);
      if (groups.length > 1) bad.push(`${plan.seed}: ${groups.length} plyometric blocks`);
      for (const g of groups) {
        if (g.format !== "straight" && g.format !== "superset") bad.push(`${plan.seed}: ${g.format}`);
        if (!g.items.every(i => GATED.has(i.exercise.id))) bad.push(`${plan.seed}: mixed block`);
      }
    }
    expect(plans.some(p => p.theme?.id === "circuitJumps" && plyoGroups(p).length === 1)).toBe(true);
    expect(bad).toEqual([]);
  });

  test("it plays after the warm-up and before the first core lift, so the landings are fresh", () => {
    const bad: string[] = [];
    let withCore = 0;
    for (const plan of plans) {
      const steps = plan.steps.filter(s => s.kind !== "rest");
      const firstPlyo = steps.findIndex(s => s.exerciseId && GATED.has(s.exerciseId));
      if (firstPlyo < 0) continue;
      const lastPrep = steps.map(s => s.block).lastIndexOf("prep");
      const firstCore = steps.findIndex(s => s.block === "core");
      const lastPlyo = steps.map(s => Boolean(s.exerciseId && GATED.has(s.exerciseId))).lastIndexOf(true);
      if (lastPrep > firstPlyo) bad.push(`${plan.seed}: warm-up after the jumps`);
      if (firstCore >= 0) {
        withCore++;
        if (firstCore < lastPlyo) bad.push(`${plan.seed}: a core lift before the jumps`);
      }
    }
    expect(withCore).toBeGreaterThan(50);
    expect(bad).toEqual([]);
  });

  test("swaps keep to the rules: the plyometric slot offers only plyometric moves, every other slot none", () => {
    const bad: string[] = [];
    for (const plan of plans) {
      for (const item of plan.items) {
        const slot = plan.swapState.slots[item.slotKey]!;
        const offered = [...(plan.alternatives[item.slotKey] ?? []), ...slot.pool];
        const plyoSlot = GATED.has(item.exercise.id);
        for (const c of offered) if (GATED.has(c.id) !== plyoSlot) bad.push(`${plan.seed} ${item.slotKey}: ${c.id}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("the frontier: gentlest first, and the ladder unlocks as moves are done", () => {
  test("with no jumping history, only the bottom rungs (no easier variant, difficulty 1), never the tuck jump", () => {
    const plans = builds({ d: data, mode: consistentOrBuild, check: () => calm, themes: jumpingDay, stress: false });
    const chosen = plans.flatMap(p => p.items.filter(i => isPlyometric(i.exercise)).map(i => i.exercise));
    expect(chosen.length).toBeGreaterThan(100);
    expect([...new Set(chosen.filter(e => e.easier.length > 0 || e.difficulty > 1).map(e => e.id))]).toEqual([]);
  });

  /** The floor of the rotation: the top two difficulty tiers of these moves. */
  const rotationFloor = (moves: readonly ExerciseRecord[]): number => {
    const levels = [...new Set(moves.map(x => x.difficulty))].sort((a, b) => b - a);
    return levels[1] ?? levels[0] ?? Infinity;
  };

  interface SeasonDay { day: number; today: string; jumps: ExerciseRecord[]; done: Set<string>; lastFlagged: Set<string>; injected: boolean }

  /**
   * Forty jumping days, every jump logged; `flagged` is logged with the profile's flag every time it is placed, and
   * `cleanAfter` jumping days after its first flagged exposure the athlete does it once cleanly (swapped in by hand).
   */
  function season(mode: Mode, { flagged = null, cleanAfter = null, liked = [] }: { flagged?: string | null; cleanAfter?: number | null; liked?: string[] } = {}): SeasonDay[] {
    const prefs = { ratings: Object.fromEntries(liked.map(id => [id, 1])), excluded: [], pinned: [] as string[] };
    const sessions: HistorySession[] = [];
    const done = new Set<string>();
    const lastFlagged = new Set<string>();
    const days: SeasonDay[] = [];
    let injectOn: number | null = null;
    let injected = false;
    const log = (e: ExerciseRecord, flags: string[]) =>
      ({ id: e.id, implement: null, perSide: false, format: "straight" as const, flags, sets: [{ w: null, reps: e.dose.range[0], secs: null }] });
    for (let day = 0; day < 40; day++) {
      const today = addDays("2026-11-02", day * 2);
      if (flagged && injectOn === day) {
        const date = addDays(today, -1);
        sessions.push({
          id: `clean${day}`, date, startedAt: `${date}T18:00:00`, mode, theme: "plyoIntro", blockNumber: 1,
          checks: { tmj: { pre: 1, post: 1, feelingOff: false } }, done: [{ id: flagged, secs: 60 }], entries: [log(byId.get(flagged)!, [])],
        });
        lastFlagged.delete(flagged);
        injected = true;
      }
      const plan = Builder.build(data, {
        today, mode, theme: plyoIntro, minutes: 40, location: home, unit: "lb", sessions, prefs, savedIds: [], block,
        checks: { tmj: calm }, swaps: {}, programId: "season",
      });
      const jumps = plan.items.filter(i => isPlyometric(i.exercise)).map(i => i.exercise);
      days.push({ day, today, jumps, done: new Set(done), lastFlagged: new Set(lastFlagged), injected });
      sessions.push({
        id: `j${day}`, date: today, startedAt: `${today}T18:00:00`, mode, theme: "plyoIntro", blockNumber: 1,
        checks: { tmj: { pre: 1, post: 1, feelingOff: false } }, done: plan.items.map(i => ({ id: i.exercise.id, secs: 60 })),
        entries: jumps.map(e => log(e, e.id === flagged ? ["clenched"] : [])),
      });
      for (const i of plan.items) done.add(i.exercise.id);
      for (const e of jumps) (e.id === flagged ? lastFlagged.add(e.id) : lastFlagged.delete(e.id));
      if (flagged && cleanAfter != null && injectOn === null && jumps.some(e => e.id === flagged)) injectOn = day + cleanAfter;
    }
    return days;
  }

  test("a season of jumping days walks the ladder: the next rung is the gentlest unlocked one, never before an easier variant was done, and the rest of the block rotates through the top rungs", () => {
    for (const mode of ["consistent", "build"] as const) {
      const cap = data.modes[mode].maxDifficulty;
      const bad: string[] = [];
      const introduced: string[] = [];
      const topRotation = new Set<string>();
      let topDays = 0;
      for (const { today, jumps, done, lastFlagged } of season(mode)) {
        const fresh = jumps.filter(e => !done.has(e.id));
        if (fresh.length > 1) bad.push(`${today}: ${fresh.length} new jumps in one session`);
        for (const e of jumps) {
          if (e.easier.length && !e.easier.some(id => done.has(id))) bad.push(`${today}: ${e.id} before any easier variant`);
        }
        const unlocked = PLYOMETRIC.filter(x => !done.has(x.id) && x.difficulty <= cap && (x.easier.length === 0 || x.easier.some(id => done.has(id))));
        for (const e of fresh) {
          const gentlest = Math.min(...unlocked.map(x => x.difficulty));
          if (e.difficulty !== gentlest) bad.push(`${today}: introduced ${e.id} (${e.difficulty}) while a difficulty ${gentlest} move was unlocked`);
          introduced.push(e.id);
        }
        // Beside the new rung, the block's done rungs come from the rotation: the top two tiers of the rungs last done
        // cleanly (of what the other slot leaves), never one below it.
        for (const e of jumps.filter(x => done.has(x.id))) {
          const others = jumps.filter(x => x !== e).map(moveKey);
          const clean = PLYOMETRIC.filter(x => x === e || (done.has(x.id) && !lastFlagged.has(x.id) && x.difficulty <= cap && !others.includes(moveKey(x))));
          const floor = rotationFloor(clean);
          if (e.difficulty < floor) bad.push(`${today}: ${e.id} (${e.difficulty}) below the rotation (from ${floor})`);
        }
        if (unlocked.length === 0 && done.size > 0) {
          topDays++;
          if (jumps.some(x => x.difficulty === 1)) bad.push(`${today}: the top reached, but a bottom rung is back: ${jumps.map(x => x.id).join(", ")}`);
          for (const e of jumps) topRotation.add(e.id);
        }
      }
      expect(bad, mode).toEqual([]);
      expect(topDays, `${mode}: days after the top was reached`).toBeGreaterThan(10);
      // At the top the block rotates (by novelty) rather than repeating the same two hardest landings every day.
      expect(topRotation.size, `${mode}: ${[...topRotation].join(", ")}`).toBeGreaterThanOrEqual(3);
      expect(introduced, mode).toEqual(expect.arrayContaining(["pogoHop", "lineHopForwardBack", "lineHopLateral", "skaterBoundLow"]));
      if (mode === "build") expect(introduced).toContain("tuckJump");
      else expect(introduced).not.toContain("tuckJump");
    }
  });

  test("a rung the athlete clenches on rests after a flagged exposure, the rung below takes its place, and a clean exposure brings it back", () => {
    // Rated 👍, so the usual ranking alone would keep bringing it back: only the rule rests it.
    const flagged = "dropLanding";
    const days = season("consistent", { flagged, cleanAfter: 8, liked: [flagged] });
    const first = days.findIndex(d => d.jumps.some(e => e.id === flagged));
    expect(first, "the drop landing is reached").toBeGreaterThanOrEqual(0);
    const cleanDay = days.findIndex(d => d.injected);
    expect(cleanDay).toBe(first + 8);
    for (const d of days.slice(first + 1, cleanDay)) {
      expect(d.jumps.map(e => e.id), `${d.today}: rests after a clenched exposure`).not.toContain(flagged);
      expect(d.jumps.some(e => d.done.has(e.id)), `${d.today}: another done rung takes its place`).toBe(true);
    }
    const back = days.slice(cleanDay).findIndex(d => d.jumps.some(e => e.id === flagged));
    expect(back, "back after a clean exposure").toBeGreaterThanOrEqual(0);
    expect(back, "back within a few jumping days").toBeLessThan(6);
  });

  test("a rung done with the profile's flag on it (clenched) doesn't unlock the next; done cleanly, it does", () => {
    const session = (id: string, date: string, entries: HistorySession["entries"], done: string[] = entries.map(e => e.id)): HistorySession => ({
      id, date, startedAt: `${date}T18:00:00`, mode: "build", theme: "plyoIntro", blockNumber: 1,
      checks: { tmj: { pre: 1, post: 1, feelingOff: false } }, done: done.map(x => ({ id: x, secs: 60 })), entries,
    });
    const entry = (id: string, flags: string[]) => ({ id, implement: null, perSide: false, format: "straight" as const, flags, sets: [{ w: null, reps: 6, secs: null }] });
    // snapDown only ever done clenched; landingStick done cleanly.
    const flagged = [session("f1", "2026-11-02", [entry("snapDown", ["clenched"]), entry("landingStick", [])]), session("f2", "2026-11-04", [entry("snapDown", ["clenched"])])];
    const chosenWith = (sessions: HistorySession[]) => new Set(Array.from({ length: 30 }, (_, i) => Builder.build(data, {
      today: addDays("2026-11-06", i % 10), mode: "build", theme: plyoIntro, minutes: [30, 40, 60][i % 3]!, location: home, unit: "lb", sessions,
      prefs: {}, savedIds: [], block, checks: { tmj: calm }, swaps: {}, programId: `flag-${i}`,
    })).flatMap(p => p.items.filter(it => isPlyometric(it.exercise)).map(it => it.exercise.id)));
    const behindSnapDown = PLYOMETRIC.filter(e => e.easier.length > 0 && e.easier.every(id => id === "snapDown")).map(e => e.id);
    expect(behindSnapDown).toEqual(expect.arrayContaining(["pogoHop", "broadJumpStick", "boxJumpStepDown"]));
    const locked = chosenWith(flagged);
    for (const id of behindSnapDown) expect(locked.has(id), `${id} unlocked by a clenched snap-down`).toBe(false);
    expect(locked.has("dropLanding"), "the clean landing stick unlocks the drop landing").toBe(true);
    // One clean snap-down unlocks the moves behind it: pogo hops, the gentlest, come next.
    const unlocked = chosenWith([...flagged, session("c1", "2026-11-05", [entry("snapDown", [])])]);
    expect(unlocked.has("pogoHop")).toBe(true);
  });
});

describe("a jumping day the gate empties says why, in the profile's words", () => {
  const program: ProgramState = {
    settings: { unit: "lb", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 40, location: "home" },
    locations: [home], prefs: { ratings: {}, excluded: [], pinned: [] }, savedIds: [], block: null, sessions: [],
  };
  const view = (check: CheckReading, theme = "plyoIntro") => Planner.planToday(data, {
    today: "2026-11-02", day: { date: "2026-11-02", checks: { tmj: check }, override: { mode: "build", theme }, swaps: {} },
  }, program).view;

  test("a check of 4, no check, feeling off: no jumps, and the theme's reason line says why", () => {
    for (const [check, why] of [
      [{ ...calm, pre: 4 }, "Jumps need a calm jaw (2 or less) — you're at 4."],
      [{ ...calm, pre: null }, "Jumps need a jaw check first."],
      [{ ...calm, feelingOff: true }, "No jumps while you're feeling off."],
    ] as const) {
      const v = view(check);
      expect(v.theme?.id).toBe("plyoIntro");
      expect(v.plan.items.some(i => isPlyometric(i.exercise))).toBe(false);
      expect(v.themeReasons).toEqual([why]);
    }
  });

  test("a calm check: the jumps are there and no reason line is added; another theme never gets one", () => {
    const calmDay = view(calm);
    expect(calmDay.plan.items.some(i => isPlyometric(i.exercise))).toBe(true);
    expect(calmDay.themeReasons).toEqual([]);
    expect(view({ ...calm, pre: 4 }, "skiPrep").themeReasons).toEqual([]);
  });
});

describe("ready for the next: the harder variant only when today's gate and the mode's cap allow it", () => {
  const broad = byId.get("broadJumpStick")!;
  // Clean at the top of the range (5 contacts), last time on a calm day.
  const topped = (pre: number): ProgEntry[] => [{
    date: "2026-10-01", startedAt: "2026-10-01T18:00:00", sets: [{ w: null, reps: 5, secs: null }, { w: null, reps: 5, secs: null }],
    flags: [], checks: { tmj: { pre, post: pre, feelingOff: false } }, mode: "build",
  }];
  const suggest = (mode: Mode, today: CheckReading, lastPre = 1) =>
    Prog.suggest(data, broad, topped(lastPre), { mode, checks: { tmj: today }, implement: null, kbWeights: [], unit: "lb", equipment: home.equipment });

  test("build with a calm check: the tuck jump is offered", () => {
    expect(suggest("build", calm)).toMatchObject({ action: "graduate", graduate: "tuckJump" });
  });

  test("consistent caps difficulty at 4: no tuck jump (difficulty 5); a slower tempo instead", () => {
    expect(suggest("consistent", calm)).toMatchObject({ action: "tempo", graduate: null });
  });

  test("a check of 4 or feeling off: the gate refuses the tuck jump, so it isn't offered", () => {
    expect(suggest("build", { ...calm, pre: 4 }, 3)).toMatchObject({ action: "tempo", graduate: null });
    expect(suggest("build", { ...calm, feelingOff: true })).toMatchObject({ action: "tempo", graduate: null });
  });
});
