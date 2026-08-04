import { describe, expect, it } from "vitest";
import {
  BALANCE_TUNING,
  DAMAGE_NOTCH,
  disciplineBalance,
  initialSnapshot,
  projectedBalance,
  type EngineGardenState,
} from "../src/index.js";

function stateWith(over: Partial<EngineGardenState>): EngineGardenState {
  return { ...initialSnapshot("2026-03-02").state, ...over };
}

describe("disciplineBalance", () => {
  it("holds full health through the grace window, then decays linearly to zero", () => {
    expect(disciplineBalance(stateWith({ daysSinceCompletedRun: 2 })).run.health).toBe(1);
    expect(disciplineBalance(stateWith({ daysSinceCompletedRun: 9 })).run.health).toBeCloseTo(0.5, 5);
    expect(disciplineBalance(stateWith({ daysSinceCompletedRun: 16 })).run.health).toBe(0);
  });

  it("overall ignores disciplines that were never practiced", () => {
    const b = disciplineBalance(
      stateWith({
        daysSinceCompletedRun: 0,
        daysSinceStrength: 200,
        daysSinceYoga: 200,
        hasStrength: false,
        hasYoga: false,
      }),
    );
    expect(b.strength.days).toBeNull();
    expect(b.yoga.days).toBeNull();
    expect(b.overall).toBe(b.run.health);
    expect(b.overall).toBe(1);
  });

  it("overall still tracks the weakest practiced discipline", () => {
    const b = disciplineBalance(
      stateWith({
        daysSinceCompletedRun: 0,
        daysSinceStrength: 17,
        hasStrength: true,
        hasYoga: false,
      }),
    );
    expect(b.overall).toBe(0);
  });
});

describe("projectedBalance", () => {
  it("adds fractional elapsed days for smooth decay", () => {
    const state = stateWith({ daysSinceCompletedRun: 1, hasStrength: false, hasYoga: false });
    const b = projectedBalance(state, { daysSinceSimulated: 1.5 });
    // Effective run clock 2.5: 0.5 days past grace.
    expect(b.run.health).toBeCloseTo(1 - 0.5 / 14, 5);
    // Displayed day count stays a whole number.
    expect(b.run.days).toBe(2);
  });

  it("freezeRun holds the run clock while other clocks advance", () => {
    const state = stateWith({
      daysSinceCompletedRun: 1,
      daysSinceStrength: 3,
      hasStrength: true,
      hasYoga: false,
    });
    const b = projectedBalance(state, { daysSinceSimulated: 2, freezeRun: true });
    expect(b.run.health).toBe(1);
    expect(b.run.days).toBe(1);
    expect(b.strength.days).toBe(5);
    expect(b.strength.health).toBeCloseTo(1 - 2 / 14, 5);
  });

  it("freezeAll returns the unprojected balance", () => {
    const state = stateWith({
      daysSinceCompletedRun: 5,
      daysSinceStrength: 4,
      hasStrength: true,
      hasYoga: false,
    });
    expect(projectedBalance(state, { daysSinceSimulated: 3, freezeAll: true })).toEqual(
      disciplineBalance(state),
    );
  });

  it("never projects backwards", () => {
    const state = stateWith({ daysSinceCompletedRun: 5 });
    expect(projectedBalance(state, { daysSinceSimulated: -2 }).run.days).toBe(5);
  });
});

describe("DAMAGE_NOTCH", () => {
  it("marks the bar fraction where visible damage begins", () => {
    // Run damage (dryness) starts day 4: health 1 − (4−2)/14 = 6/7.
    expect(DAMAGE_NOTCH.run).toBeCloseTo(6 / 7, 5);
    // Soil/life decay starts past day 7: health 1 − (7−3)/14 = 5/7.
    expect(DAMAGE_NOTCH.strength).toBeCloseTo(5 / 7, 5);
    expect(DAMAGE_NOTCH.yoga).toBeCloseTo(5 / 7, 5);
  });
});

describe("BALANCE_TUNING", () => {
  it("exposes the day math the notches derive from", () => {
    expect(BALANCE_TUNING.run).toEqual({ graceDays: 2, decayWindowDays: 14, damageStartDay: 4 });
    expect(BALANCE_TUNING.strength).toEqual({ graceDays: 3, decayWindowDays: 14, damageStartDay: 7 });
    expect(BALANCE_TUNING.yoga).toEqual({ graceDays: 3, decayWindowDays: 14, damageStartDay: 7 });
    // The two exports must agree forever.
    for (const key of ["run", "strength", "yoga"] as const) {
      const t = BALANCE_TUNING[key];
      expect(DAMAGE_NOTCH[key]).toBeCloseTo(
        1 - Math.max(0, t.damageStartDay - t.graceDays) / t.decayWindowDays,
        8,
      );
    }
  });
});
