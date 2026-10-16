import { addDays } from "@rg/domain";
import { EXERCISES, isPlyometric, makeEngineData, type CheckReading, type HistorySession, type Mode } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Planner, Proposal, Rng, type DayState, type ProgramState } from "../src/index.js";
import { data, home } from "./builder-fixtures.js";

// The day's theme rotation. Every theme is in it (the owner, 2026-10-16: Ski prep, Athletic base and Jumps and landings
// joined the others). A jumping day (plyoIntro) is proposed only on a day today's condition gate lets a jump through —
// the jaw profile's: an answered check of 2 or less, and not feeling off — so the day is never a jumping day without
// jumps. A theme marked `inRotation: false` is still never proposed, and can still be chosen by hand.

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

describe("a jumping day only when today's gate lets a jump through", () => {
  // Every day of the seeded years, proposed again with the same history and mode under another reading.
  const theme = (x: Day, checks?: Readonly<Record<string, CheckReading>>) =>
    Proposal.theme(data, { mode: x.mode, sessions: years[x.seed]!.sessions.slice(0, x.before), today: x.today, ...(checks ? { checks } : {}) }).theme?.id;
  const jumpable = allDays.filter(x => x.mode !== "recovery");
  const calmPicks = jumpable.filter(x => theme(x, { tmj: calm }) === "plyoIntro");

  test("a calm check can pick plyoIntro", () => {
    expect(calmPicks.length).toBeGreaterThan(10);
  });

  test("on those same days, a check of 3 or 4, no check, or feeling off never picks it", () => {
    const readings: Array<[string, Readonly<Record<string, CheckReading>> | undefined]> = [
      ["a check of 3", { tmj: { ...calm, pre: 3 } }],
      ["a check of 4", { tmj: { ...calm, pre: 4 } }],
      ["no check", { tmj: { ...calm, pre: null } }],
      ["no reading at all", {}],
      ["no readings passed", undefined],
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
    const picked = jumpable.some(x => Proposal.theme(open, { mode: x.mode, sessions: years[x.seed]!.sessions.slice(0, x.before), today: x.today, checks: {} }).theme?.id === "plyoIntro");
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
      const t = Proposal.theme(held, { mode: x.mode, sessions: years[x.seed]!.sessions.slice(0, x.before), today: x.today, checks: { tmj: calm } }).theme?.id;
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
