import { addDays } from "@rg/domain";
import {
  EXERCISES, THEMES, isPlyometric, makeEngineData,
  type CheckReading, type EngineData, type ExerciseRecord, type Mode, type Theme,
} from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Builder, Hist, Planner, Prog, type BuildResult, type HistorySession, type ProgEntry, type ProgramState } from "../src/index.js";
import { PLACES, block, data, home } from "./builder-fixtures.js";

// Plyometric moves in the programme (Task 5, ruling b). Two layers keep them where they belong:
//  - the condition profile's gate (`allowRecord`): the jaw profile never allows one in recovery or when feeling off
//    (since 2026-10-23 it no longer asks for an answered, calm check);
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

/** One logged jump (or other move), with the profile's flags it carried. */
const entry = (id: string, flags: string[]): HistorySession["entries"][number] =>
  ({ id, implement: null, perSide: false, format: "straight", flags, sets: [{ w: null, reps: 6, secs: null }] });
/** A session on a jumping day (plyoIntro) that logged these entries. */
const jumpSession = (id: string, date: string, entries: HistorySession["entries"], done: string[] = entries.map(e => e.id), mode: Mode = "build"): HistorySession => ({
  id, date, startedAt: `${date}T18:00:00`, mode, theme: "plyoIntro", blockNumber: 1,
  checks: { tmj: { pre: 1, post: 1, feelingOff: false } }, done: done.map(x => ({ id: x, secs: 60 })), entries,
});

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

  test("no calm check any more (2026-10-23): a pre-check of 4, or none, lets a jumping day reach them in most of 200 builds", () => {
    for (const pre of [4, null]) {
      const plans = builds({ d: withTwins, mode: consistentOrBuild, check: () => ({ ...calm, pre }), themes: jumpingDay, stress: true });
      expect(plans.filter(p => p.items.some(i => GATED.has(i.exercise.id))).length, String(pre)).toBeGreaterThan(100);
    }
  });

  test("feeling off: none in 200 seeded builds, even with a calm check on a jumping day", () => {
    expect(builds({ d: withTwins, mode: consistentOrBuild, check: () => ({ ...calm, feelingOff: true }), themes: jumpingDay, stress: true }).flatMap(reach)).toEqual([]);
  });

  // A flare day proposes recovery, but the athlete may choose another mode (the session sheet's Mode picker) and a
  // planned Maintain or Develop day may land on one: the jumps sit it out whatever the mode (review M1).
  test("a flare day (an answered check of 5 or more): none in 200 seeded builds in consistent or build, on a jumping day", () => {
    for (const pre of [5, 7, 10]) {
      expect(builds({ d: withTwins, mode: consistentOrBuild, check: () => ({ ...calm, pre }), themes: jumpingDay, stress: true }).flatMap(reach), String(pre)).toEqual([]);
    }
  });
});

describe("overhead pressing sits out a flare day in every mode (review M1)", () => {
  const PRESSES = EXERCISES.filter(e => e.patterns.includes("push-v"));
  const isPress = (id: string) => byId.get(id)?.patterns.includes("push-v") ?? false;
  // Every press rated 👍 and saved, every other move done recently: ranking and the new-move guarantee reach for them.
  const pressPrefs = { ratings: Object.fromEntries(PRESSES.map(e => [e.id, 1])), excluded: [], pinned: [] as string[] };
  const doneButPresses = (today: string): HistorySession[] => [{
    id: "h1", date: addDays(today, -3), startedAt: null, mode: "consistent", theme: null, blockNumber: 1,
    checks: { tmj: { pre: 1, post: 1, feelingOff: false } },
    done: EXERCISES.filter(e => !isPress(e.id)).map(e => ({ id: e.id, secs: 60 })), entries: [],
  }];
  const presses = (pre: number | null): string[][] => Array.from({ length: 200 }, (_, i) => {
    const today = addDays("2026-10-05", i % 29);
    const mode = consistentOrBuild(i);
    const themes = everyTheme(data, mode);
    const plan = Builder.build(data, {
      today, mode, theme: themes[i % themes.length] ?? null, minutes: [15, 20, 30, 40, 60][i % 5]!, location: PLACES[i % PLACES.length]!,
      unit: "lb", sessions: doneButPresses(today), prefs: pressPrefs, savedIds: PRESSES.map(e => e.id), block,
      checks: { tmj: { ...calm, pre } }, swaps: {}, programId: `press-${i}`,
    });
    return [
      ...plan.items.map(it => it.exercise.id),
      ...plan.steps.flatMap(s => (s.exerciseId ? [s.exerciseId] : [])),
      ...Object.values(plan.alternatives).flatMap(alts => alts.map(a => a.id)),
      ...Object.values(plan.swapState.slots).flatMap(slot => [slot.original, ...slot.pool].map(c => c.id)),
    ].filter(isPress);
  });

  test("the library has overhead pressing, and a calm or unanswered day reaches it in consistent and build", () => {
    expect(PRESSES.length).toBeGreaterThan(0);
    for (const pre of [1, 4, null]) expect(presses(pre).filter(r => r.length > 0).length, String(pre)).toBeGreaterThan(20);
  });

  test("a check of 5 or more: none in 200 seeded builds in consistent or build — plan, steps, offered swaps or swap pools", () => {
    for (const pre of [5, 7, 10]) expect(presses(pre).flat(), String(pre)).toEqual([]);
  });
});

describe("only on a jumping day", () => {
  test("any other theme (or none): no plyometric move anywhere in 200 seeded builds, even calm, rated 👍, saved, new and allowed in every block", () => {
    expect(builds({ d: withTwins, mode: consistentOrBuild, check: () => calm, themes: nonJumping, stress: true }).flatMap(reach)).toEqual([]);
    // Nor with the check high or unanswered: the jumping day, not the check, is what places them.
    for (const pre of [4, null]) {
      expect(builds({ d: withTwins, mode: consistentOrBuild, check: () => ({ ...calm, pre }), themes: nonJumping, stress: true }).flatMap(reach), String(pre)).toEqual([]);
    }
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

  /**
   * The rotation's floor, as the engine works it out once before the block's first slot: the top two difficulty tiers
   * of the moves last done cleanly, widened a tier at a time while they hold no more moves than the block's two slots,
   * never down to the lowest tier.
   */
  const rotationFloor = (clean: readonly ExerciseRecord[], slots = 2): number => {
    const levels = [...new Set(clean.map(x => x.difficulty))].sort((a, b) => b - a);
    if (!levels.length) return Infinity;
    let k = Math.min(1, levels.length - 1);
    while (k + 2 < levels.length && clean.filter(x => x.difficulty >= levels[k]!).length <= slots) k += 1;
    return levels[k]!;
  };

  interface SeasonDay {
    day: number;
    today: string;
    jumps: ExerciseRecord[];
    /** As the day starts: the moves done, and each move whose last exposure was clenched, with the jumping days since. */
    done: Set<string>;
    restedFor: Map<string, number>;
  }

  /**
   * Forty jumping days two days apart, every jump logged; `clench(id, n)` says whether a move's n-th exposure (from 0)
   * is logged with the profile's flag. Nothing is ever done by hand: every exposure is one the engine placed. Each day
   * is also planned from the trimmed history and its summary (what the worker reads), which must plan the same.
   */
  function season(mode: Mode, { d = data, clench = () => false }: { d?: EngineData; clench?: (id: string, n: number) => boolean } = {}): SeasonDay[] {
    const sessions: HistorySession[] = [];
    const done = new Set<string>();
    const exposures = new Map<string, number>();
    const clenchedOn = new Map<string, number>();   // a move whose last exposure was clenched → the day of that exposure
    const days: SeasonDay[] = [];
    for (let day = 0; day < 40; day++) {
      const today = addDays("2026-11-02", day * 2);
      const input = {
        today, mode, theme: plyoIntro, minutes: 40, location: home, unit: "lb" as const, prefs: {}, savedIds: [], block,
        checks: { tmj: calm }, swaps: {}, programId: "season",
      };
      const plan = Builder.build(d, { ...input, sessions });
      const trimmed = Builder.build(d, { ...input, sessions: Hist.trim(sessions, today, block), summary: Hist.summarize(sessions, today) });
      expect(trimmed.items.map(i => i.exercise.id), `${today}: the trimmed history plans the same`).toEqual(plan.items.map(i => i.exercise.id));
      const jumps = plan.items.filter(i => isPlyometric(i.exercise)).map(i => i.exercise);
      days.push({ day, today, jumps, done: new Set(done), restedFor: new Map([...clenchedOn].map(([id, on]) => [id, day - on - 1])) });
      const clenched = new Set(jumps.filter(e => clench(e.id, exposures.get(e.id) ?? 0)).map(e => e.id));
      sessions.push(jumpSession(`j${day}`, today, jumps.map(e => entry(e.id, clenched.has(e.id) ? ["clenched"] : [])), plan.items.map(i => i.exercise.id), mode));
      for (const i of plan.items) done.add(i.exercise.id);
      for (const e of jumps) {
        exposures.set(e.id, (exposures.get(e.id) ?? 0) + 1);
        if (clenched.has(e.id)) clenchedOn.set(e.id, day);
        else clenchedOn.delete(e.id);
      }
    }
    return days;
  }

  /** A jump new to the athlete, or one retried after a clench: at most one a session. */
  const freshIn = (d: SeasonDay): ExerciseRecord[] => d.jumps.filter(e => !d.done.has(e.id) || d.restedFor.has(e.id));

  /**
   * After each clenched exposure, the move sits out the next two jumping days and is back on the third, every time.
   * (Every season day is a jumping day, so "jumping days since" counts jumping sessions.)
   */
  function restAndRetry(days: readonly SeasonDay[], id: string): string[] {
    const bad: string[] = [];
    for (const d of days) {
      const rested = d.restedFor.get(id);
      if (rested === undefined) continue;   // its last exposure was clean, or it was never done
      const placed = d.jumps.some(e => e.id === id);
      if (rested < 2 && placed) bad.push(`${d.today}: ${id} back after ${rested} jumping day(s) of rest`);
      const cleanDone = (e: ExerciseRecord) => d.done.has(e.id) && !d.restedFor.has(e.id);
      if (rested < 2 && PLYOMETRIC.some(cleanDone) && !d.jumps.some(cleanDone)) {
        bad.push(`${d.today}: no rung last done cleanly took ${id}'s place: ${d.jumps.map(e => e.id).join(", ") || "no jumps"}`);
      }
      if (rested >= 2 && !placed) bad.push(`${d.today}: ${id} still resting after ${rested} jumping days`);
    }
    return bad;
  }

  /** The moves a season placed for the first time, in order. */
  const introducedIn = (days: readonly SeasonDay[]): string[] => days.flatMap(d => d.jumps.filter(e => !d.done.has(e.id)).map(e => e.id));
  /** Rungs whose only way up is through this one. */
  const behind = (id: string): string[] => {
    const out = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const e of PLYOMETRIC) {
        if (!out.has(e.id) && e.easier.length > 0 && e.easier.every(x => x === id || out.has(x))) { out.add(e.id); grew = true; }
      }
    }
    return [...out];
  };

  test("a season of jumping days walks the ladder: the next rung is the gentlest unlocked one, never before an easier variant was done, and the rest of the block rotates through the top rungs", () => {
    for (const mode of ["consistent", "build"] as const) {
      const cap = data.modes[mode].maxDifficulty;
      const bad: string[] = [];
      const introduced: string[] = [];
      const topRotation = new Set<string>();
      let topDays = 0;
      for (const day of season(mode)) {
        const { today, jumps, done } = day;
        const fresh = freshIn(day);
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
        // Beside the new rung, the block's done rungs come from the rotation: the top tiers of every rung last done
        // cleanly, worked out once before the first slot. One below it only when no rung of the rotation could take the slot.
        const clean = PLYOMETRIC.filter(x => done.has(x.id) && !day.restedFor.has(x.id) && x.difficulty <= cap);
        const floor = rotationFloor(clean);
        const keys = jumps.map(moveKey);
        for (const e of jumps.filter(x => done.has(x.id) && !day.restedFor.has(x.id) && x.difficulty < floor)) {
          const satOut = clean.filter(x => x.difficulty >= floor && !keys.includes(moveKey(x)));
          if (satOut.length) bad.push(`${today}: ${e.id} (${e.difficulty}) below the rotation (from ${floor}) while ${satOut.map(x => x.id).join(", ")} sat out`);
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

  test("a rung clenched on its first exposure rests two jumping days, retries on the third as that day's one new-or-retry rung (before a new one), and done cleanly unlocks the branch above it", () => {
    for (const mode of ["consistent", "build"] as const) {
      const cap = data.modes[mode].maxDifficulty;
      const days = season(mode, { clench: (id, n) => id === "pogoHop" && n === 0 });
      const first = days.findIndex(d => d.jumps.some(e => e.id === "pogoHop"));
      expect(first, `${mode}: pogo hops are reached`).toBeGreaterThanOrEqual(0);
      expect(restAndRetry(days, "pogoHop"), mode).toEqual([]);
      const retry = days[first + 3]!;
      expect(retry.jumps.map(e => e.id), `${mode}: back on the third jumping day`).toContain("pogoHop");
      // A new rung was open that day (the landing stick's branch), yet the retry took the day's one new-or-retry slot.
      const open = PLYOMETRIC.filter(x => !retry.done.has(x.id) && x.difficulty <= cap && (x.easier.length === 0 || x.easier.some(id => retry.done.has(id) && !retry.restedFor.has(id))));
      expect(open.length, `${mode}: a new rung was open on the retry day`).toBeGreaterThan(0);
      expect(freshIn(retry).map(e => e.id), mode).toEqual(["pogoHop"]);
      expect(days.filter(d => freshIn(d).length > 1).map(d => d.today), mode).toEqual([]);
      // Done cleanly on the retry, it unlocks the lateral branch, which is walked within the season.
      expect(behind("pogoHop")).toEqual(expect.arrayContaining(["lineHopForwardBack", "lineHopLateral", "skaterBoundLow", "skaterBoundStick", "lateralHopStick"]));
      expect(introducedIn(days), mode).toEqual(expect.arrayContaining(behind("pogoHop").filter(id => byId.get(id)!.difficulty <= cap)));
    }
  });

  test("a rung clenched every time keeps resting and retrying (two jumping days off, back on the third) and never holds back the rest of the ladder", () => {
    for (const mode of ["consistent", "build"] as const) {
      const cap = data.modes[mode].maxDifficulty;
      const days = season(mode, { clench: id => id === "pogoHop" });
      expect(restAndRetry(days, "pogoHop"), mode).toEqual([]);
      expect(days.filter(d => d.jumps.some(e => e.id === "pogoHop")).length, `${mode}: retried again and again`).toBeGreaterThanOrEqual(8);
      expect(days.filter(d => freshIn(d).length > 1).map(d => d.today), mode).toEqual([]);
      // A clenched rung unlocks nothing; every other rung within the cap is still introduced.
      const placed = new Set(days.flatMap(d => d.jumps.map(e => e.id)));
      for (const id of behind("pogoHop")) expect(placed.has(id), `${mode}: ${id} behind a rung only ever clenched`).toBe(false);
      const others = PLYOMETRIC.filter(e => e.id !== "pogoHop" && !behind("pogoHop").includes(e.id) && e.difficulty <= cap).map(e => e.id);
      expect(introducedIn(days), mode).toEqual(expect.arrayContaining(others));
    }
  });

  test("the rule alone rests a clenched rung: with no flag penalty in the score (same flag), the drop landing still sits out two jumping days after every clenched exposure", () => {
    const profiles = data.profiles.active.map(p => ({ ...p, flagPenaltyWeight: 0 }));
    const noPenalty: EngineData = { ...data, profiles: { active: profiles, care: data.profiles.care.map(c => profiles.find(p => p.id === c.id) ?? c) } };
    expect(noPenalty.profiles.active.map(p => [p.setFlag?.id, p.flagPenaltyWeight])).toEqual([["clenched", 0]]);
    const days = season("consistent", { d: noPenalty, clench: id => id === "dropLanding" });
    expect(restAndRetry(days, "dropLanding")).toEqual([]);
    expect(days.filter(d => d.restedFor.get("dropLanding")! < 2).length, "rest days to check").toBeGreaterThanOrEqual(10);
  });

  test("when every rung the block could hold is resting, the jumping day holds no jump, and it still counts: each rung retries on its third jumping day", () => {
    const days = season("consistent", { clench: () => true });
    const placed = [...new Set(days.flatMap(d => d.jumps.map(e => e.id)))].sort();
    expect(placed, "a clenched rung unlocks nothing").toEqual(["landingStick", "snapDown"]);
    for (const id of placed) expect(restAndRetry(days, id)).toEqual([]);
    const empty = days.filter(d => d.jumps.length === 0);
    expect(empty.length, "jumping days with every rung resting").toBeGreaterThanOrEqual(10);
    expect(days.every(d => d.jumps.length <= 1)).toBe(true);
  });

  test("a rest counts jumping sessions: other days don't end it; jumping days (even empty) and sessions that logged a jump do; a rest older than 14 days is over", () => {
    const T = "2026-11-30";
    const clenchedBoth = (date: string) => jumpSession(`c-${date}`, date, [entry("landingStick", ["clenched"]), entry("snapDown", ["clenched"])]);
    const other = (date: string) => ({ ...jumpSession(`o-${date}`, date, [], ["wallSit"]), theme: "skiPrep" });
    const emptyJumpingDay = (date: string) => jumpSession(`e-${date}`, date, [], ["wallSit"]);
    const jumpsWith = (sessions: HistorySession[]): string[] => {
      const input = { today: T, mode: "build" as const, theme: plyoIntro, minutes: 40, location: home, unit: "lb" as const, prefs: {}, savedIds: [], block, checks: { tmj: calm }, swaps: {}, programId: "rest" };
      const ids = (p: BuildResult) => p.items.filter(i => isPlyometric(i.exercise)).map(i => i.exercise.id);
      const whole = ids(Builder.build(data, { ...input, sessions }));
      expect(ids(Builder.build(data, { ...input, sessions: Hist.trim(sessions, T, block), summary: Hist.summarize(sessions, T) })), "trimmed").toEqual(whole);
      return whole;
    };
    // Both bottom rungs clenched ten days ago, nothing since: both rest, nothing else is unlocked, so no jump today.
    expect(jumpsWith([clenchedBoth(addDays(T, -10))])).toEqual([]);
    // Two sessions since on other days (no jump, not a jumping day): still resting.
    expect(jumpsWith([clenchedBoth(addDays(T, -10)), other(addDays(T, -6)), other(addDays(T, -3))])).toEqual([]);
    // Two jumping days since that held no jump (everything was resting): they count, so one rung retries.
    expect(jumpsWith([clenchedBoth(addDays(T, -10)), emptyJumpingDay(addDays(T, -6)), emptyJumpingDay(addDays(T, -3))])).toHaveLength(1);
    // Clenched twenty days ago and no jumping day since: the rest is over, one rung retries.
    expect(jumpsWith([clenchedBoth(addDays(T, -20)), other(addDays(T, -6)), other(addDays(T, -3))])).toHaveLength(1);
    // Two sessions on other days that logged a jump (the snap-down, cleanly): they are jumping sessions too.
    const landingClenched = jumpSession("lc", addDays(T, -10), [entry("landingStick", ["clenched"])]);
    const snapOn = (date: string) => ({ ...jumpSession(`s-${date}`, date, [entry("snapDown", [])]), theme: null });
    expect(jumpsWith([landingClenched, snapOn(addDays(T, -6))])).not.toContain("landingStick");
    expect(jumpsWith([landingClenched, snapOn(addDays(T, -6)), snapOn(addDays(T, -3))])).toContain("landingStick");
    // A jumping day dated before the last 14 days counts for nothing, even started after the rest began (a start may be
    // a day off its date): a trimmed history no longer holds it, and both plan alike.
    const atWindow = { ...clenchedBoth(addDays(T, -14)), startedAt: `${addDays(T, -14)}T06:00:00` };
    const lateStart = (n: number) => ({ ...emptyJumpingDay(addDays(T, -15)), id: `late${n}`, startedAt: `${addDays(T, -14)}T1${n}:00:00` });
    expect(jumpsWith([lateStart(1), lateStart(2), atWindow, other(addDays(T, -6)), other(addDays(T, -3)), other(addDays(T, -1))])).toEqual([]);
  });

  test("the rotation's floor is worked out once, before the first slot: with clean rungs at 4, 3 and 1 (none at 2), the second slot never falls to a bottom rung", () => {
    const T = "2026-11-30";
    // The bottom rungs done long ago (novel); the drop landing and the broad jump done in the last sessions (repeated),
    // so the usual ranking alone would reach for a bottom rung. Pogo hops and the box jump (the other rungs the
    // snap-down unlocks) are excluded and the tuck jump is over consistent's cap: no new rung is open.
    const sessions = [
      jumpSession("old", addDays(T, -30), [entry("landingStick", []), entry("snapDown", [])]),
      { ...jumpSession("mid", addDays(T, -10), [], ["wallSit"]), theme: null },
      jumpSession("r1", addDays(T, -4), [entry("broadJumpStick", [])]),
      jumpSession("r2", addDays(T, -2), [entry("dropLanding", [])]),
    ];
    for (let i = 0; i < 12; i++) {
      const plan = Builder.build(data, {
        today: addDays(T, i % 3), mode: "consistent", theme: plyoIntro, minutes: [30, 40, 60][i % 3]!, location: home, unit: "lb", sessions,
        prefs: { ratings: {}, excluded: ["pogoHop", "boxJumpStepDown"], pinned: [] }, savedIds: [], block, checks: { tmj: calm }, swaps: {}, programId: `floor-${i}`,
      });
      const jumps = plan.items.filter(it => isPlyometric(it.exercise)).map(it => it.exercise.id).sort();
      expect(jumps, `${plan.seed}`).toEqual(["broadJumpStick", "dropLanding"]);
    }
  });

  test("a rung done with the profile's flag on it (clenched) doesn't unlock the next; done cleanly, it does", () => {
    const session = (id: string, date: string, entries: HistorySession["entries"]): HistorySession => jumpSession(id, date, entries);
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

  test("feeling off: no jumps, and the theme's reason line says why", () => {
    const v = view({ ...calm, feelingOff: true });
    expect(v.theme?.id).toBe("plyoIntro");
    expect(v.plan.items.some(i => isPlyometric(i.exercise))).toBe(false);
    expect(v.themeReasons).toEqual(["Jumps sit out while you're feeling off."]);
  });

  test("a flare day with the mode chosen above recovery: no jumps, no overhead pressing, and the theme's reason line says why (review M1)", () => {
    for (const pre of [5, 7]) {
      const v = view({ ...calm, pre });
      expect(v.mode, String(pre)).toBe("build");
      expect(v.plan.items.some(i => isPlyometric(i.exercise)), String(pre)).toBe(false);
      expect(v.plan.items.some(i => i.exercise.patterns.includes("push-v")), String(pre)).toBe(false);
      expect(v.themeReasons, String(pre)).toEqual(["Jumps sit out a flare day."]);
    }
  });

  test("a calm check, a check of 4, or none: the jumps are there and no reason line is added; another theme never gets one", () => {
    for (const check of [calm, { ...calm, pre: 4 }, { ...calm, pre: null }]) {
      const v = view(check);
      expect(v.plan.items.some(i => isPlyometric(i.exercise)), String(check.pre)).toBe(true);
      expect(v.themeReasons, String(check.pre)).toEqual([]);
    }
    expect(view({ ...calm, feelingOff: true }, "skiPrep").themeReasons).toEqual([]);
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

  test("feeling off: the gate refuses the tuck jump, so it isn't offered; a check of 4 no longer does", () => {
    expect(suggest("build", { ...calm, feelingOff: true })).toMatchObject({ action: "tempo", graduate: null });
    expect(suggest("build", { ...calm, pre: 4 }, 3)).toMatchObject({ action: "graduate", graduate: "tuckJump" });
  });

  test("the harder variant is on the frontier from the move just topped out: a one-way link never skips the ladder", () => {
    const toppedOut = (ex: ExerciseRecord): ProgEntry[] => [{
      date: "2026-10-01", startedAt: "2026-10-01T18:00:00", sets: [{ w: null, reps: ex.dose.range[1], secs: null }],
      flags: [], checks: { tmj: { pre: 1, post: 1, feelingOff: false } }, mode: "build",
    }];
    const at = (d: EngineData) => Prog.suggest(d, d.exercises.find(e => e.id === "boxJumpStepDown")!, toppedOut(byId.get("boxJumpStepDown")!), {
      mode: "build", checks: { tmj: calm }, implement: null, kbWeights: [], unit: "lb", equipment: home.equipment,
    });
    // The library's ladder mirrors: the box jump is one of the tuck jump's easier rungs, so it graduates to it.
    expect(at(data)).toMatchObject({ action: "graduate", graduate: "tuckJump" });
    // Had the tuck jump not named the box jump (the asymmetry the final review found), it is no graduation from it.
    const oneWay = makeEngineData({
      activeProfiles: ["tmj"], careProfiles: ["tmj"],
      exercises: EXERCISES.map(e => (e.id === "tuckJump" ? { ...e, easier: e.easier.filter(id => id !== "boxJumpStepDown") } : e)),
    });
    expect(at(oneWay)).toMatchObject({ action: "tempo", graduate: null });
  });

  test("the snap-down graduates to the gentlest rung above it: pogo hops (difficulty 2), never the broad jump (3) first", () => {
    const snap = byId.get("snapDown")!;
    const toppedOut: ProgEntry[] = [{
      date: "2026-10-01", startedAt: "2026-10-01T18:00:00", sets: [{ w: null, reps: snap.dose.range[1], secs: null }],
      flags: [], checks: { tmj: { pre: 1, post: 1, feelingOff: false } }, mode: "build",
    }];
    const next = (mode: Mode) => Prog.suggest(data, snap, toppedOut, { mode, checks: { tmj: calm }, implement: null, kbWeights: [], unit: "lb", equipment: home.equipment });
    expect(next("build")).toMatchObject({ action: "graduate", graduate: "pogoHop" });
    expect(next("consistent")).toMatchObject({ action: "graduate", graduate: "pogoHop" });
  });
});

describe("final review: rest and retry read every logged jump, swaps keep the session's one new-or-retry rung, and a day's feeling off reaches the build", () => {
  const T = "2026-11-30";
  /** A logged jump in a format the athlete chose: circuits and ladders log what was done too. */
  const logged = (id: string, flags: string[], format: HistorySession["entries"][number]["format"]): HistorySession["entries"][number] =>
    ({ id, implement: null, perSide: false, format, flags, sets: [{ w: null, reps: 6, secs: null }] });
  const input = (sessions: HistorySession[], over: Partial<Parameters<typeof Builder.build>[1]> = {}) => ({
    today: T, mode: "build" as const, theme: plyoIntro, minutes: 40, location: home, unit: "lb" as const, prefs: {}, savedIds: [], block,
    checks: { tmj: calm }, swaps: {}, programId: "final", sessions, ...over,
  });
  const jumpIds = (p: BuildResult) => p.items.filter(i => isPlyometric(i.exercise)).map(i => i.exercise.id);
  /** Whole and trimmed histories plan alike (what the worker reads is the trimmed one). */
  const jumpsWith = (sessions: HistorySession[]): string[] => {
    const whole = jumpIds(Builder.build(data, input(sessions)));
    const trimmed = jumpIds(Builder.build(data, input(Hist.trim(sessions, T, block), { summary: Hist.summarize(sessions, T) })));
    expect(trimmed, "trimmed").toEqual(whole);
    return whole;
  };
  const other = (date: string) => ({ ...jumpSession(`o-${date}`, date, [], ["wallSit"]), theme: "skiPrep" });

  test("a clench logged in a circuit or a ladder rests the rung like one in straight sets", () => {
    for (const format of ["circuit", "ladder"] as const) {
      const clenched = jumpSession(`c-${format}`, addDays(T, -10), [logged("landingStick", ["clenched"], format), logged("snapDown", ["clenched"], format)]);
      expect(jumpsWith([clenched]), format).toEqual([]);
      expect(jumpsWith([clenched, other(addDays(T, -6)), other(addDays(T, -3))]), format).toEqual([]);
    }
  });

  test("a session that logged a jump in a circuit is a jumping session: two of them end a rest", () => {
    const landingClenched = jumpSession("lc", addDays(T, -10), [entry("landingStick", ["clenched"])]);
    const circuitSnap = (date: string) => ({ ...jumpSession(`cs-${date}`, date, [logged("snapDown", [], "circuit")]), theme: null });
    expect(jumpsWith([landingClenched, circuitSnap(addDays(T, -6))])).not.toContain("landingStick");
    expect(jumpsWith([landingClenched, circuitSnap(addDays(T, -6)), circuitSnap(addDays(T, -3))])).toContain("landingStick");
  });

  /** Whether a move is new to the athlete or retried after a clench, as of these sessions (the engine's own rule). */
  const freshBy = (sessions: HistorySession[]) => (id: string): boolean => {
    const mine = sessions.flatMap(s => s.entries.filter(e => e.id === id).map(e => ({ at: String(s.startedAt), flags: e.flags })));
    const done = sessions.some(s => s.done.some(d => d.id === id) || s.entries.some(e => e.id === id));
    const last = mine.sort((a, b) => b.at.localeCompare(a.at))[0];
    return !done || Boolean(last?.flags.includes("clenched"));
  };

  test("a slot's offered swaps never hold a resting rung", () => {
    // The landing stick clenched four days ago, no jumping day since: it rests. The snap-down was done cleanly.
    const sessions = [
      jumpSession("old", addDays(T, -30), [entry("snapDown", []), entry("landingStick", [])]),
      jumpSession("cl", addDays(T, -4), [entry("landingStick", ["clenched"])]),
    ];
    let checked = 0;
    for (let i = 0; i < 12; i++) {
      const plan = Builder.build(data, input(sessions, { today: addDays(T, i % 2), minutes: [30, 40, 60][i % 3]!, programId: `rest-${i}`, location: PLACES[i % PLACES.length]! }));
      for (const item of plan.items.filter(it => isPlyometric(it.exercise))) {
        const slot = plan.swapState.slots[item.slotKey]!;
        const reach = [...(plan.alternatives[item.slotKey] ?? []), ...slot.pool].map(c => c.id);
        expect(reach, `${plan.seed} ${item.slotKey}`).not.toContain("landingStick");
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("a slot beside the day's new rung is never offered a second new or retried rung, and a stored swap to one is left out", () => {
    // Both bottom rungs done cleanly long ago: the rungs above them are new, and the block holds one of them.
    const sessions = [jumpSession("old", addDays(T, -30), [entry("snapDown", []), entry("landingStick", [])])];
    const fresh = freshBy(sessions);
    let pairs = 0;
    for (let i = 0; i < 12; i++) {
      const base = input(sessions, { today: addDays(T, i % 3), minutes: [30, 40, 60][i % 3]!, programId: `fresh-${i}` });
      const plan = Builder.build(data, base);
      const jumps = plan.items.filter(it => isPlyometric(it.exercise));
      const holder = jumps.find(it => fresh(it.exercise.id));
      const beside = jumps.find(it => !fresh(it.exercise.id));
      if (!holder || !beside) continue;
      pairs += 1;
      const offered = plan.alternatives[beside.slotKey] ?? [];
      expect(offered.filter(c => fresh(c.id)).map(c => c.id), `${plan.seed}: offered beside ${holder.exercise.id}`).toEqual([]);
      // The new rung's own slot may still trade it for another new rung: the session keeps one.
      const swapTo = plan.swapState.slots[beside.slotKey]!.pool.find(c => fresh(c.id));
      if (!swapTo) continue;
      const swapped = Builder.build(data, { ...base, swaps: { [beside.slotKey]: { from: beside.exercise.id, to: swapTo.id } } });
      expect(swapped.items.filter(it => isPlyometric(it.exercise) && fresh(it.exercise.id)).length, `${plan.seed}: after a stored swap`).toBe(1);
    }
    expect(pairs, "plans holding a new rung beside a clean one").toBeGreaterThan(3);
  });

  test("a day's own \"feeling off\" joins every profile's reading: no jumps on a calm check, and the build reads it", () => {
    const program: ProgramState = {
      settings: { unit: "lb", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 40, location: "home" },
      locations: [home], prefs: { ratings: {}, excluded: [], pinned: [] }, savedIds: [], block: null, sessions: [],
    };
    const plan = (checks: Record<string, CheckReading>, feelingOff: boolean) => Planner.planToday(data, {
      today: T, day: { date: T, checks, feelingOff, override: { mode: "build", theme: "plyoIntro" }, swaps: {} },
    }, program).view;
    expect(plan({ tmj: calm }, false).plan.items.some(i => isPlyometric(i.exercise))).toBe(true);
    const off = plan({ tmj: calm }, true);
    expect(off.plan.items.some(i => isPlyometric(i.exercise))).toBe(false);
    expect(off.input.checks).toEqual({ tmj: { ...calm, feelingOff: true } });
    expect(off.themeReasons).toEqual(["Jumps sit out while you're feeling off."]);
    // A profile with no check yet reads as unanswered and feeling off.
    expect(plan({}, true).input.checks).toEqual({ tmj: { pre: null, post: null, feelingOff: true } });
    // The day's own record is the day as the athlete left it.
    expect(off.today.checks).toEqual({ tmj: calm });
  });
});
