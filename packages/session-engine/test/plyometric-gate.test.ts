import { addDays } from "@rg/domain";
import {
  EXERCISES, THEMES, isPlyometric, makeEngineData,
  type CheckReading, type EngineData, type ExerciseRecord, type Mode, type Theme,
} from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Builder, Hist, Planner, Prog, type BuildResult, type HistorySession, type ProgEntry, type ProgramState } from "../src/index.js";
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
