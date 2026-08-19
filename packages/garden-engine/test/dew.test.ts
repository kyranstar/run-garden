/**
 * Dew (sleep/recovery 0020, option C): a settled night leaves dew only on a
 * TENDED garden. The four laws under test: dew needs BOTH the night and the
 * training; it is never punitive; its counters feed the night-bloomer gates;
 * and a history replayed without dew inputs is byte-identical to before the
 * feature existed.
 */
import { describe, expect, it } from "vitest";
import { addDays } from "@rg/domain";
import {
  DEW_TENDED_DAYS,
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

describe("dew needs both the night and the training", () => {
  it("a settled night on a tended garden is a dewy morning", () => {
    const { snapshot, lastShield } = fold([
      runDay(START),
      { ...emptyDay(addDays(START, 1)), dew: true },
    ]);
    expect(lastShield?.dewToday).toBe(true);
    expect(snapshot.state.dewyMorningCount).toBe(1);
    expect(snapshot.state.lastDewDate).toBe(addDays(START, 1));
  });

  it("a settled night on an UNTENDED garden leaves no dew — sleep cannot replace running", () => {
    // No training at all: every counter grows past DEW_TENDED_DAYS.
    const days = Array.from({ length: DEW_TENDED_DAYS + 3 }, (_, i) => ({
      ...emptyDay(addDays(START, i)),
      dew: true,
    }));
    const { snapshot, lastShield } = fold(days);
    expect(lastShield?.dewToday).toBe(false);
    expect(snapshot.state.dewyMorningCount).toBe(0);
  });

  it("training today counts as tended even after a long gap", () => {
    const gap = Array.from({ length: 10 }, (_, i) => emptyDay(addDays(START, i)));
    const { snapshot, lastShield } = fold([
      ...gap,
      runDay(addDays(START, 10), { dew: true }),
    ]);
    expect(lastShield?.dewToday).toBe(true);
    expect(snapshot.state.dewyMorningCount).toBe(1);
  });

  it("a rough night (dew absent/false) on a tended garden changes nothing", () => {
    const withNight = fold([runDay(START), { ...emptyDay(addDays(START, 1)), dew: false }]);
    const without = fold([runDay(START), emptyDay(addDays(START, 1))]);
    expect(withNight.snapshot.state.moisture).toBe(without.snapshot.state.moisture);
    expect(withNight.snapshot.state.dewyMorningCount).toBe(0);
    expect(withNight.lastShield?.dewToday).toBe(false);
  });
});

describe("dew is a shield, never a whip", () => {
  it("a dewy morning holds the thirst clock a rough one lets tick", () => {
    // Same shape: run on Monday, then three empty days; only the middle day's
    // night differs. The dewy garden must be wetter, never drier.
    const base = [runDay(START), emptyDay(addDays(START, 1)), emptyDay(addDays(START, 2))];
    const dewy = [runDay(START), { ...emptyDay(addDays(START, 1)), dew: true }, emptyDay(addDays(START, 2))];
    const dry = fold(base).snapshot.state;
    const held = fold(dewy).snapshot.state;
    expect(held.moisture).toBeGreaterThan(dry.moisture);
    expect(held.daysSinceCompletedRun).toBeLessThan(dry.daysSinceCompletedRun);
  });

  it("dew never makes any state WORSE than the same days without it", () => {
    const plain = fold([runDay(START), emptyDay(addDays(START, 1))]).snapshot.state;
    const dewed = fold([runDay(START), { ...emptyDay(addDays(START, 1)), dew: true }]).snapshot.state;
    expect(dewed.moisture).toBeGreaterThanOrEqual(plain.moisture);
    expect(dewed.soilHealth).toBeGreaterThanOrEqual(plain.soilHealth);
  });
});

describe("night counters feed the gates", () => {
  it("dewy_mornings gate counts and describes", () => {
    const gate = { kind: "dewy_mornings", count: 2 } as const;
    const one = fold([runDay(START), { ...emptyDay(addDays(START, 1)), dew: true }]).snapshot;
    expect(gateSatisfied(gate, one)).toBe(false);
    expect(gateProgress(gate, one)).toEqual({ current: 1, target: 2 });
    const two = fold(
      [runDay(addDays(START, 2), { dew: true })],
      one,
    ).snapshot;
    expect(gateSatisfied(gate, two)).toBe(true);
    expect(describeGate(gate)).toContain("dewy morning");
  });

  it("a steady week needs BOTH ≥5 settled nights and a trained week", () => {
    // Week 1: run Mon/Wed/Fri, dew on 6 nights. Week 2's Monday carries the
    // closing adherence.
    const week = (mon: string, dew: boolean, adherence?: number): GardenDayInput[] => [
      { ...runDay(mon), weekAdherence: adherence },
      { ...emptyDay(addDays(mon, 1)), dew },
      { ...runDay(addDays(mon, 2)), dew },
      { ...emptyDay(addDays(mon, 3)), dew },
      { ...runDay(addDays(mon, 4)), dew },
      { ...emptyDay(addDays(mon, 5)), dew },
      { ...emptyDay(addDays(mon, 6)), dew },
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

  it("weekSettledNights counts settled nights even when untended (the week is about sleep)", () => {
    const days = Array.from({ length: 6 }, (_, i) => ({
      ...emptyDay(addDays(START, i)),
      dew: true,
    }));
    const { snapshot } = fold(days);
    expect(snapshot.state.weekSettledNights).toBe(6);
    expect(snapshot.state.dewyMorningCount).toBeLessThanOrEqual(DEW_TENDED_DAYS + 1);
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
});
