import type { EngineGardenState } from "./types.js";

/** Grace days before each discipline's clock starts costing health. */
const GRACE_DAYS: { run: number; strength: number; yoga: number } = {
  run: 2,
  strength: 3,
  yoga: 3,
};

/** Each axis fades to zero health over 14 days once its grace period ends. */
const DECAY_WINDOW_DAYS = 14;

export interface DisciplineBalance {
  run: { days: number; health: number };
  strength: { days: number; health: number };
  yoga: { days: number; health: number };
  /** How balanced the garden is overall: the weakest discipline sets the pace. */
  overall: number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function healthFor(days: number, graceDays: number): number {
  return clamp01(1 - Math.max(0, days - graceDays) / DECAY_WINDOW_DAYS);
}

/**
 * Pure summary of how balanced the three disciplines are, derived from each
 * axis's "days since" clock. A discipline within its grace period is at full
 * health; beyond it, health fades linearly to zero over fourteen days.
 * `overall` is the minimum of the three healths, so neglecting any one
 * discipline is what the garden shows first.
 */
export function disciplineBalance(state: EngineGardenState): DisciplineBalance {
  const run = {
    days: state.daysSinceCompletedRun,
    health: healthFor(state.daysSinceCompletedRun, GRACE_DAYS.run),
  };
  const strength = {
    days: state.daysSinceStrength ?? 0,
    health: healthFor(state.daysSinceStrength ?? 0, GRACE_DAYS.strength),
  };
  const yoga = {
    days: state.daysSinceYoga ?? 0,
    health: healthFor(state.daysSinceYoga ?? 0, GRACE_DAYS.yoga),
  };
  return {
    run,
    strength,
    yoga,
    overall: Math.min(run.health, strength.health, yoga.health),
  };
}
