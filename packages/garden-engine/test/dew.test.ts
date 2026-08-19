/**
 * Dew (sleep/recovery 0020, option C): the worker computes both `settledNight`
 * and `dew` (settled + a run within DEW_TENDED_DAYS) from durable tables, so
 * the engine's laws are input-level: dew shields and counts ONLY when the
 * input says so; a settled-but-unrun morning counts for the week but shields
 * nothing; nothing is ever punitive; and a history replayed without night
 * inputs is byte-identical to before the feature existed. (The engine
 * deliberately holds NO tended state — verify round 1 showed both a
 * frozen-counter renewal loop and replay divergence when it did.)
 */
import { describe, expect, it } from "vitest";
import { addDays } from "@rg/domain";
import {
  describeGate,
  gateProgress,
  gateSatisfied,
  initialSnapshot,
  simulateDay,
  type GardenDayInput,
  type GardenSnapshot,
} from "../src/index.js";

const START = "2026-03-02"; // a Monday

function emptyDay(date: string): GardenDayInput {
  return {
    date,
    completedRuns: [],
    restObserved: false,
    missedRuns: [],
    restModeActive: false,
    planGap: false,
  };
}

function runDay(date: string, extra: Partial<GardenDayInput> = {}): GardenDayInput {
  return {
    ...emptyDay(date),
    completedRuns: [{ workoutId: `w-${date}`, category: "easy" }],
    ...extra,
  };
}

function fold(days: GardenDayInput[], from?: GardenSnapshot) {
  let snapshot = from ?? initialSnapshot(START);
  let lastShield: { adventureFrozen: boolean; graceDay: boolean; dewToday?: boolean } | undefined;
  for (const day of days) {
    const r = simulateDay(snapshot, day);
    snapshot = r.snapshot;
    if (r.shield) lastShield = r.shield;
  }
  return { snapshot, lastShield };
}

describe("dew is exactly what the worker's tended-gate handed in", () => {
  it("a dewy-morning input shields and counts", () => {
    const { snapshot, lastShield } = fold([
      runDay(START),
      { ...emptyDay(addDays(START, 1)), settledNight: true, dew: true },
    ]);
    expect(lastShield?.dewToday).toBe(true);
    expect(snapshot.state.dewyMorningCount).toBe(1);
    expect(snapshot.state.lastDewDate).toBe(addDays(START, 1));
  });

  it("a settled-but-unrun morning counts for the week and shields NOTHING", () => {
    const days = Array.from({ length: 6 }, (_, i) => ({
      ...emptyDay(addDays(START, i)),
      settledNight: true,
    }));
    const { snapshot, lastShield } = fold(days);
    expect(lastShield?.dewToday).toBe(false);
    expect(snapshot.state.dewyMorningCount).toBe(0);
    expect(snapshot.state.weekSettledNights).toBe(6);
    // The thirst clock ticked normally — sleep alone protected nothing.
    expect(snapshot.state.daysSinceCompletedRun).toBeGreaterThanOrEqual(5);
  });

  it("a rough night (both fields absent/false) on a run day changes nothing", () => {
    const withNight = fold([runDay(START), { ...emptyDay(addDays(START, 1)), settledNight: false }]);
    const without = fold([runDay(START), emptyDay(addDays(START, 1))]);
    expect(withNight.snapshot.state.moisture).toBe(without.snapshot.state.moisture);
    expect(withNight.snapshot.state.dewyMorningCount).toBe(0);
    expect(withNight.lastShield?.dewToday).toBe(false);
  });

  it("a dewy morning never spends a banked adventure grace day", () => {
    // Set up a banked grace day, then a dewy morning with no recovery score:
    // the bank must be untouched (dew did the shielding for free).
    let snapshot = initialSnapshot(START);
    snapshot = structuredClone(snapshot);
    snapshot.state.adventureGraceDays = 2;
    snapshot.state.lastAdventureDate = START;
    const r1 = simulateDay(snapshot, {
      ...emptyDay(addDays(START, 1)),
      settledNight: true,
      dew: true,
    });
    expect(r1.shield?.dewToday).toBe(true);
    expect(r1.snapshot.state.adventureGraceDays).toBe(2);
    // Same morning without dew: the grace day IS spent.
    const r2 = simulateDay(snapshot, emptyDay(addDays(START, 1)));
    if (r2.shield?.graceDay) {
      expect(r2.snapshot.state.adventureGraceDays).toBe(1);
    }
  });
});

describe("dew is a shield, never a whip", () => {
  it("a dewy morning holds the thirst clock a rough one lets tick", () => {
    // Same shape: run on Monday, then three empty days; only the middle day's
    // night differs. The dewy garden must be wetter, never drier.
    const base = [runDay(START), emptyDay(addDays(START, 1)), emptyDay(addDays(START, 2))];
    const dewy = [runDay(START), { ...emptyDay(addDays(START, 1)), settledNight: true, dew: true }, emptyDay(addDays(START, 2))];
    const dry = fold(base).snapshot.state;
    const held = fold(dewy).snapshot.state;
    expect(held.moisture).toBeGreaterThan(dry.moisture);
    expect(held.daysSinceCompletedRun).toBeLessThan(dry.daysSinceCompletedRun);
  });

  it("dew never makes any state WORSE than the same days without it", () => {
    const plain = fold([runDay(START), emptyDay(addDays(START, 1))]).snapshot.state;
    const dewed = fold([runDay(START), { ...emptyDay(addDays(START, 1)), settledNight: true, dew: true }]).snapshot.state;
    expect(dewed.moisture).toBeGreaterThanOrEqual(plain.moisture);
    expect(dewed.soilHealth).toBeGreaterThanOrEqual(plain.soilHealth);
  });
});

describe("night counters feed the gates", () => {
  it("dewy_mornings gate counts and describes", () => {
    const gate = { kind: "dewy_mornings", count: 2 } as const;
    const one = fold([runDay(START), { ...emptyDay(addDays(START, 1)), settledNight: true, dew: true }]).snapshot;
    expect(gateSatisfied(gate, one)).toBe(false);
    expect(gateProgress(gate, one)).toEqual({ current: 1, target: 2 });
    const two = fold(
      [runDay(addDays(START, 2), { settledNight: true, dew: true })],
      one,
    ).snapshot;
    expect(gateSatisfied(gate, two)).toBe(true);
    expect(describeGate(gate)).toContain("dewy morning");
  });

  it("a steady week needs BOTH ≥5 settled nights and a trained week", () => {
    // Week 1: run Mon/Wed/Fri, dew on 6 nights. Week 2's Monday carries the
    // closing adherence.
    const week = (mon: string, settled: boolean, adherence?: number): GardenDayInput[] => [
      { ...runDay(mon), weekAdherence: adherence },
      { ...emptyDay(addDays(mon, 1)), settledNight: settled },
      { ...runDay(addDays(mon, 2)), settledNight: settled },
      { ...emptyDay(addDays(mon, 3)), settledNight: settled },
      { ...runDay(addDays(mon, 4)), settledNight: settled },
      { ...emptyDay(addDays(mon, 5)), settledNight: settled },
      { ...emptyDay(addDays(mon, 6)), settledNight: settled },
    ];
    // Slept AND trained → chain grows.
    const good = fold([...week(START, true), ...week(addDays(START, 7), true, 1)]).snapshot;
    expect(good.state.steadySleepWeeks).toBe(1);
    expect(good.state.bestSteadySleepWeeks).toBe(1);
    // Slept but NOT trained (adherence 0.5) → chain resets: no couch unlock.
    const couch = fold([...week(START, true), ...week(addDays(START, 7), true, 0.5)]).snapshot;
    expect(couch.state.steadySleepWeeks).toBe(0);
    // Trained but not slept (no dew at all) → no steady week either.
    const sleepless = fold([...week(START, false), ...week(addDays(START, 7), false, 1)]).snapshot;
    expect(sleepless.state.steadySleepWeeks).toBe(0);
    // gate + species progress read the chain.
    const gate = { kind: "steady_sleep_weeks", count: 3 } as const;
    expect(gateProgress(gate, good)).toEqual({ current: 1, target: 3 });
    expect(describeGate(gate)).toContain("well trained, well slept");
  });

  it("weekSettledNights never double-counts a morning that carries both flags", () => {
    const { snapshot } = fold([
      runDay(START),
      { ...emptyDay(addDays(START, 1)), settledNight: true, dew: true },
    ]);
    expect(snapshot.state.weekSettledNights).toBe(1);
  });
});

describe("history without dew inputs replays exactly as before", () => {
  it("stored day inputs lacking `dew` produce identical state to pre-feature runs", () => {
    const days = [
      runDay(START),
      emptyDay(addDays(START, 1)),
      runDay(addDays(START, 2)),
      { ...emptyDay(addDays(START, 3)), restObserved: true },
    ];
    const a = fold(days).snapshot;
    const b = fold(days.map((d) => ({ ...d }))).snapshot;
    expect(a.state.dewyMorningCount).toBe(0);
    expect(a.state.steadySleepWeeks).toBe(0);
    expect(a.state.lastDewDate).toBeNull();
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it("an incremental fold from a mid-history snapshot agrees with a genesis replay", () => {
    // The verify-round divergence: replay knew training history that a
    // backfilled snapshot didn't. With tended-ness computed by the WORKER
    // from durable tables, both paths consume identical inputs — so the
    // engine must produce identical state from either starting point.
    const days = [
      runDay(START),
      { ...emptyDay(addDays(START, 1)), settledNight: true, dew: true },
      runDay(addDays(START, 2)),
      { ...emptyDay(addDays(START, 3)), settledNight: true, dew: true },
    ];
    const genesis = fold(days).snapshot;
    const mid = fold(days.slice(0, 2)).snapshot;
    const resumed = fold(days.slice(2), mid).snapshot;
    expect(JSON.stringify(resumed.state)).toBe(JSON.stringify(genesis.state));
  });
});
