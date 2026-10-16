import { addDays } from "@rg/domain";
import { EXERCISES, isPlyometric, makeEngineData, type CheckReading, type HistorySession, type Mode } from "@rg/exercise-library";
import { describe, expect, test, vi } from "vitest";
import { Builder, Planner, Proposal, Rng, type DayState, type JumpTerms, type ProgramState, type TodayView } from "../src/index.js";
import { data, home } from "./builder-fixtures.js";

// The day's theme rotation. Every theme is in it (the owner, 2026-10-16: Ski prep, Athletic base and Jumps and landings
// joined the others). A jumping day (plyoIntro) is proposed only when today's jumps block has a jump to take
// (`Builder.jumpsAvailable`, the block's own rule): the jaw profile's gate — an answered check of 2 or less, not feeling
// off — the place's gear, the moves set aside, the next rung unlocked, no rung resting after a clench. What the proposal
// can't know (a session too short for the block) is caught after the build: a proposed jumping day that still holds no
// jump is proposed again without one. A hand pick stands. A theme marked `inRotation: false` is still never proposed,
// and can still be chosen by hand.

const calm: CheckReading = { pre: 1, post: null, feelingOff: false };
const program = (over: Partial<ProgramState> = {}): ProgramState => ({
  programId: "rotation", settings: { unit: "lb", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 30, location: "home" },
  locations: [home], prefs: { ratings: {}, excluded: [], pinned: [] }, savedIds: [], block: null, sessions: [], ...over,
});

interface Day {
  seed: number;
  today: string;
  mode: Mode;
  theme: string;
  check: CheckReading;
  feelingOff: boolean;
  /** How many of the year's sessions came before this day. */
  before: number;
  jumps: boolean;
}

/**
 * A year of days as the planner meets them (`Planner.planToday`, its block kept): about four sessions a week, each
 * day's jaw check drawn the way a year goes — mostly calm, now and then a 3 or a 4, a higher one, none answered, or
 * feeling off — and each proposal built and "done", so the coverage debt (and the next proposal) moves.
 */
function year(d: typeof data, seed: number): { days: Day[]; sessions: HistorySession[] } {
  const rng = Rng.create(`rotation-year|${seed}`);
  const days: Day[] = [];
  const sessions: HistorySession[] = [];
  let state = program({ programId: `rotation-${seed}` });
  for (let i = 0; i < 364; i++) {
    const today = addDays("2026-01-05", i);
    const train = rng() < 0.62;
    const r = rng();
    const pre = r < 0.1 ? null : r < 0.7 ? Math.floor(rng() * 3) : r < 0.85 ? 3 : r < 0.93 ? 4 : 5 + Math.floor(rng() * 2);
    const feelingOff = rng() < 0.03;
    if (!train) continue;
    const check: CheckReading = { pre, post: null, feelingOff: false };
    const day: DayState = { date: today, checks: { tmj: check }, feelingOff, override: {}, swaps: {} };
    const { view, blockUpdate } = Planner.planToday(d, { today, day }, { ...state, sessions });
    state = { ...state, block: blockUpdate ? blockUpdate.block : view.block };
    const jumps = view.plan.items.some(it => isPlyometric(it.exercise));
    days.push({ seed, today, mode: view.mode, theme: view.theme?.id ?? "none", check, feelingOff, before: sessions.length, jumps });
    sessions.push({
      id: `y${seed}-${i}`, date: today, startedAt: `${today}T18:00:00`, mode: view.mode, theme: view.theme?.id ?? null, blockNumber: view.block.number,
      checks: { tmj: { pre, post: pre, feelingOff } }, done: view.plan.items.map(it => ({ id: it.exercise.id, secs: 60 })), entries: [],
    } as HistorySession);
  }
  return { days, sessions };
}

const SEEDS = [0, 1, 2, 3];
const years = SEEDS.map(seed => year(data, seed));
const allDays = years.flatMap(y => y.days);

/** Days a year per mode and theme, the mean over the seeded years, rounded. */
function perYear(days: readonly Day[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const x of days) (out[x.mode] ??= {})[x.theme] = (out[x.mode]![x.theme] ?? 0) + 1;
  for (const m of Object.keys(out)) for (const t of Object.keys(out[m]!)) out[m]![t] = Math.round(out[m]![t]! / SEEDS.length);
  return out;
}

describe("every theme is in the rotation", () => {
  test("no theme of the library is held out of the day's proposal", () => {
    expect(data.themes.filter(t => t.inRotation === false).map(t => t.id)).toEqual([]);
  });

  /**
   * Days a year each theme is proposed, per mode: the mean of the four seeded years (about 225 sessions each: some 145
   * consistent, 58 build, 22 recovery), pinned within 7 days a year per theme (R10's line: a library change moves a
   * theme by less than that). Before the three joined (2026-10-16) the same years ran: consistent — carryDay 46,
   * hipsPosture 34, upperBackNeck 30, posteriorChain 20, deskUnwind 14; build — carryDay 17, hipsPosture 12,
   * upperBackNeck 11, fullBody 8, posteriorChain 5, deskUnwind 5; recovery — jawReset 12, gentleMobility 5,
   * deskUnwind 4. Every theme that was there comes up less often, hipsPosture most (Ski prep and Athletic base share its
   * lunges, squats and hips).
   */
  const PINNED: Record<string, Record<string, number>> = {
    consistent: { carryDay: 41, upperBackNeck: 25, skiPrep: 21, hipsPosture: 17, posteriorChain: 14, athleticBase: 13, deskUnwind: 10, plyoIntro: 4 },
    build: { carryDay: 15, skiPrep: 7, upperBackNeck: 6, athleticBase: 6, hipsPosture: 6, fullBody: 6, deskUnwind: 6, posteriorChain: 3, plyoIntro: 3 },
    recovery: { jawReset: 12, deskUnwind: 6, gentleMobility: 4 },
  };

  test("each theme comes up about as often a year as pinned, per mode", () => {
    const got = perYear(allDays);
    const off: string[] = [];
    for (const m of new Set([...Object.keys(PINNED), ...Object.keys(got)])) {
      for (const t of new Set([...Object.keys(PINNED[m] ?? {}), ...Object.keys(got[m] ?? {})])) {
        const want = PINNED[m]?.[t] ?? 0;
        const have = got[m]?.[t] ?? 0;
        if (Math.abs(have - want) > 7) off.push(`${m} ${t}: ${have} a year, pinned ${want}`);
      }
    }
    expect(off, JSON.stringify(got)).toEqual([]);
    for (const id of ["skiPrep", "athleticBase", "plyoIntro"]) expect(got.consistent?.[id] ?? 0, id).toBeGreaterThan(0);
  });

  test("every jumping day the year proposed had a calm, answered check and no \"feeling off\", and its plan holds a jump", () => {
    const jumping = allDays.filter(x => x.theme === "plyoIntro");
    expect(jumping.length).toBeGreaterThan(10);
    const bad = jumping.filter(x => x.feelingOff || x.check.pre == null || x.check.pre > 2 || !x.jumps).map(x => `${x.seed} ${x.today}`);
    expect(bad).toEqual([]);
  });
});

// Every day of the seeded years, proposed again with the same history and mode under another reading (and, below,
// other terms of the jumps block: the moves set aside).
const historyOf = (x: Day): HistorySession[] => years[x.seed]!.sessions.slice(0, x.before);
const theme = (x: Day, checks?: Readonly<Record<string, CheckReading>>, over: Partial<JumpTerms> = {}) =>
  Proposal.theme(data, { mode: x.mode, sessions: historyOf(x), today: x.today, ...(checks ? { jumps: { location: home, checks, ...over } } : {}) }).theme?.id;
const jumpable = allDays.filter(x => x.mode !== "recovery");
/** The days a calm check proposes a jumping day. */
const calmPicks = jumpable.filter(x => theme(x, { tmj: calm }) === "plyoIntro");

describe("a jumping day only when today's gate lets a jump through", () => {

  test("a calm check can pick plyoIntro", () => {
    expect(calmPicks.length).toBeGreaterThan(10);
  });

  test("on those same days, a check of 3 or 4, no check, or feeling off never picks it", () => {
    const readings: Array<[string, Readonly<Record<string, CheckReading>> | undefined]> = [
      ["a check of 3", { tmj: { ...calm, pre: 3 } }],
      ["a check of 4", { tmj: { ...calm, pre: 4 } }],
      ["no check", { tmj: { ...calm, pre: null } }],
      ["no reading at all", {}],
      ["nothing of the jumps block passed", undefined],
      ["feeling off", { tmj: { ...calm, feelingOff: true } }],
    ];
    const bad: string[] = [];
    for (const x of calmPicks) for (const [what, checks] of readings) if (theme(x, checks) === "plyoIntro") bad.push(`${x.seed} ${x.today}: ${what}`);
    expect(bad).toEqual([]);
  });

  test("the planner reads the day as the build does: a calm check with the day's own \"feeling off\" proposes no jumping day", () => {
    const bad: string[] = [];
    for (const x of calmPicks) {
      const at = (feelingOff: boolean) => Planner.planToday(data, {
        today: x.today, day: { date: x.today, checks: { tmj: calm }, feelingOff, override: { mode: x.mode }, swaps: {} },
      }, program({ programId: `rotation-${x.seed}`, sessions: years[x.seed]!.sessions.slice(0, x.before) })).view;
      if (at(false).proposedTheme?.id !== "plyoIntro") bad.push(`${x.seed} ${x.today}: calm, not proposed`);
      if (at(true).proposedTheme?.id === "plyoIntro") bad.push(`${x.seed} ${x.today}: feeling off, proposed`);
    }
    expect(bad).toEqual([]);
  });

  test("with no profile active the gate lets jumps through: plyoIntro is an option without any check", () => {
    const open = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: EXERCISES });
    const picked = jumpable.some(x => Proposal.theme(open, { mode: x.mode, sessions: years[x.seed]!.sessions.slice(0, x.before), today: x.today, jumps: { location: home, checks: {} } }).theme?.id === "plyoIntro");
    expect(picked).toBe(true);
  });

  test("a manual pick of plyoIntro stands as before: jumps on a calm day; otherwise none, and the reason line says why", () => {
    const view = (check: CheckReading) => Planner.planToday(data, {
      today: "2026-11-02", day: { date: "2026-11-02", checks: { tmj: check }, override: { mode: "build", theme: "plyoIntro" }, swaps: {} },
    }, program()).view;
    const calmDay = view(calm);
    expect([calmDay.theme?.id, calmDay.themeOverridden, calmDay.themeReasons]).toEqual(["plyoIntro", true, []]);
    expect(calmDay.plan.items.some(i => isPlyometric(i.exercise))).toBe(true);
    for (const [check, why] of [
      [{ ...calm, pre: 4 }, "Jumps need a calm jaw (2 or less) — you're at 4."],
      [{ ...calm, pre: null }, "Jumps need a jaw check first."],
      [{ ...calm, feelingOff: true }, "No jumps while you're feeling off."],
    ] as const) {
      const v = view(check);
      expect([v.theme?.id, v.themeOverridden, v.themeReasons]).toEqual(["plyoIntro", true, [why]]);
      expect(v.plan.items.some(i => isPlyometric(i.exercise))).toBe(false);
      // The proposal beside the pick still never offers a jumping day the gate shuts.
      expect(v.proposedTheme?.id).not.toBe("plyoIntro");
    }
  });
});

describe("a theme marked out of the rotation", () => {
  // The flag stays for a theme the owner holds back: skiPrep marked out, as a stand-in.
  const held = { ...data, themes: data.themes.map(t => (t.id === "skiPrep" ? { ...t, inRotation: false } : t)) } as typeof data;

  test("is never proposed", () => {
    for (const x of allDays.filter(d => d.mode !== "recovery").slice(0, 200)) {
      const t = Proposal.theme(held, { mode: x.mode, sessions: years[x.seed]!.sessions.slice(0, x.before), today: x.today, jumps: { location: home, checks: { tmj: calm } } }).theme?.id;
      expect(t, `${x.seed} ${x.today}`).not.toBe("skiPrep");
    }
    expect(allDays.some(x => x.theme === "skiPrep")).toBe(true);
  });

  test("can still be chosen by hand: the day's override builds a plan with it", () => {
    const day: DayState = { date: "2026-03-02", checks: { tmj: calm }, override: { mode: "build", theme: "skiPrep" }, swaps: {} };
    const { view } = Planner.planToday(held, { today: "2026-03-02", day }, program());
    expect(view.theme?.id).toBe("skiPrep");
    expect(view.plan.theme?.id).toBe("skiPrep");
    expect(view.plan.items.length).toBeGreaterThan(0);
    expect(Planner.planToday(held, { today: "2026-03-02", day: { ...day, override: { mode: "build" } } }, program()).view.proposedTheme?.id).not.toBe("skiPrep");
  });
});

describe("a proposed jumping day has a jump: the proposal and the jumps block read one rule (`Builder.jumpsAvailable`)", () => {
  const PLYO = data.exercises.filter(isPlyometric).map(e => e.id);
  const BOTTOM = ["landingStick", "snapDown"];
  const hasJump = (v: TodayView) => v.plan.items.some(i => isPlyometric(i.exercise));
  /** The day through the planner, as the year met it, on other terms. */
  const view = (x: Day, o: { excluded?: string[]; minutes?: number; sessions?: HistorySession[]; theme?: string; check?: CheckReading } = {}) =>
    Planner.planToday(data, {
      today: x.today, day: { date: x.today, checks: { tmj: o.check ?? calm }, override: { mode: x.mode, ...(o.theme ? { theme: o.theme } : {}) }, swaps: {} },
    }, program({
      programId: `rotation-${x.seed}`, sessions: o.sessions ?? historyOf(x), prefs: { ratings: {}, excluded: o.excluded ?? [], pinned: [] },
      settings: { unit: "lb", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: o.minutes ?? 30, location: "home" },
    })).view;
  /** How many plans the planner built for the day: one, unless a proposed jumping day ended with no jump. */
  const builds = (f: () => TodayView): { v: TodayView; n: number } => {
    const spy = vi.spyOn(Builder, "build");
    try {
      const v = f();
      return { v, n: spy.mock.calls.length };
    } finally {
      spy.mockRestore();
    }
  };
  const available = (x: Day, o: { excluded?: string[]; sessions?: HistorySession[] } = {}) => Builder.jumpsAvailable(data, {
    today: x.today, mode: x.mode, location: home, sessions: o.sessions ?? historyOf(x), prefs: { excluded: o.excluded ?? [] }, checks: { tmj: calm },
  });

  test("on every calm day the year proposed a jumping day, the block has a jump to take", () => {
    expect(calmPicks.length).toBeGreaterThan(10);
    expect(calmPicks.filter(x => !available(x)).map(x => `${x.seed} ${x.today}`)).toEqual([]);
  });

  test("every jump set aside: the proposal never offers a jumping day, and the planner's day has none — in one plan", () => {
    const bad: string[] = [];
    for (const x of calmPicks) {
      if (available(x, { excluded: PLYO })) bad.push(`${x.seed} ${x.today}: available`);
      if (theme(x, { tmj: calm }, { prefs: { excluded: PLYO } }) === "plyoIntro") bad.push(`${x.seed} ${x.today}: proposed`);
      // The planner's own gate keeps it out (one plan): not the second look after a jumpless build.
      const { v, n } = builds(() => view(x, { excluded: PLYO }));
      if (v.theme?.id === "plyoIntro" || v.proposedTheme?.id === "plyoIntro") bad.push(`${x.seed} ${x.today}: planned`);
      if (n !== 1) bad.push(`${x.seed} ${x.today}: ${n} plans`);
    }
    expect(bad).toEqual([]);
  });

  test("the bottom rungs set aside: a jumping day only where a harder rung is unlocked — and then it has a jump", () => {
    let refused = 0;
    let kept = 0;
    const bad: string[] = [];
    for (const x of calmPicks) {
      const open = available(x, { excluded: BOTTOM });
      const proposed = theme(x, { tmj: calm }, { prefs: { excluded: BOTTOM } }) === "plyoIntro";
      if (proposed && !open) bad.push(`${x.seed} ${x.today}: proposed with nothing to take`);
      if (!open) refused += 1;
      const { v, n } = builds(() => view(x, { excluded: BOTTOM }));
      if (n !== 1) bad.push(`${x.seed} ${x.today}: ${n} plans`);
      if (v.theme?.id === "plyoIntro") {
        kept += 1;
        if (!hasJump(v)) bad.push(`${x.seed} ${x.today}: a jumping day without a jump`);
      }
    }
    expect(bad).toEqual([]);
    // Both happen in the year: days with no harder rung unlocked yet, and days with one.
    expect([refused > 0, kept > 0]).toEqual([true, true]);
  });

  test("the bottom rungs clenched last time and resting: no jumping day until they have rested", () => {
    // The year's history with no jump in it, its last session then logging both bottom rungs — cleanly, or clenched.
    const withRungs = (x: Day, flags: string[]): HistorySession[] => {
      const past = historyOf(x).map(s => ({ ...s, done: s.done.filter(d => !PLYO.includes(d.id)) }));
      const last = past[past.length - 1]!;
      return [...past.slice(0, -1), {
        ...last, done: [...last.done, ...BOTTOM.map(id => ({ id, secs: 60 }))],
        entries: BOTTOM.map(id => ({ id, implement: null, perSide: false, format: "straight" as const, flags, sets: [{ w: null, reps: 5, secs: null }] })),
      }];
    };
    let cleanDays = 0;
    const bad: string[] = [];
    for (const x of calmPicks) {
      const clean = withRungs(x, []);
      const clenched = withRungs(x, ["clenched"]);
      if (!available(x, { sessions: clean })) bad.push(`${x.seed} ${x.today}: clean rungs, nothing to take`);
      if (available(x, { sessions: clenched })) bad.push(`${x.seed} ${x.today}: resting rungs, still available`);
      const { v, n } = builds(() => view(x, { sessions: clenched }));
      if (v.theme?.id === "plyoIntro" || v.proposedTheme?.id === "plyoIntro") bad.push(`${x.seed} ${x.today}: resting rungs, planned`);
      if (n !== 1) bad.push(`${x.seed} ${x.today}: ${n} plans`);
      if (view(x, { sessions: clean }).theme?.id === "plyoIntro") cleanDays += 1;
    }
    expect(bad).toEqual([]);
    // The clean history proposes the same jumping days, so the rest is what kept them out.
    expect(cleanDays).toBeGreaterThan(0);
  });

  test("a 10-minute session, too short for the jumps block: the proposed jumping day is proposed again without one", () => {
    let fellBack = 0;
    const bad: string[] = [];
    for (const x of calmPicks) {
      const { v, n } = builds(() => view(x, { minutes: 10 }));
      if (v.theme?.id === "plyoIntro") {
        if (!hasJump(v)) bad.push(`${x.seed} ${x.today}: a jumping day without a jump`);
        if (n !== 1) bad.push(`${x.seed} ${x.today}: ${n} plans`);
        continue;
      }
      fellBack += 1;
      // One plan more, only that day.
      if (n !== 2) bad.push(`${x.seed} ${x.today}: ${n} plans`);
      // The proposal again, with no jumping day; nothing was chosen by hand.
      const again = Proposal.theme(data, { mode: x.mode, sessions: historyOf(x), today: x.today });
      if (v.proposedTheme?.id !== again.theme?.id || v.themeOverridden || JSON.stringify(v.themeReasons) !== JSON.stringify(again.reasons)) {
        bad.push(`${x.seed} ${x.today}: ${v.proposedTheme?.id} ≠ ${again.theme?.id}`);
      }
      if (v.plan.theme?.id !== v.theme?.id) bad.push(`${x.seed} ${x.today}: built for another theme`);
    }
    expect(bad).toEqual([]);
    expect(fellBack).toBeGreaterThan(0);
  });

  test("a hand pick of plyoIntro on a day with every jump set aside stands, as before: no jump, and the reason line as before", () => {
    const x = calmPicks[0]!;
    const calmDay = view(x, { excluded: PLYO, theme: "plyoIntro" });
    expect([calmDay.theme?.id, calmDay.themeOverridden, hasJump(calmDay)]).toEqual(["plyoIntro", true, false]);
    // The jaw allows jumps today: no profile has a reason to give (what the line said before this change).
    expect(calmDay.themeReasons).toEqual([]);
    const four = view(x, { excluded: PLYO, theme: "plyoIntro", check: { ...calm, pre: 4 } });
    expect([four.theme?.id, four.themeOverridden, hasJump(four)]).toEqual(["plyoIntro", true, false]);
    expect(four.themeReasons).toEqual(["Jumps need a calm jaw (2 or less) — you're at 4."]);
  });
});
