import { DEFAULT_GARDEN_CONFIG, type EngineGardenState } from "./types.js";

/** Grace days before each discipline's clock starts costing health. */
const GRACE_DAYS: { run: number; strength: number; yoga: number } = {
  run: 2,
  strength: 3,
  yoga: 3,
};

/** Each axis fades to zero health over 14 days once its grace period ends. */
const DECAY_WINDOW_DAYS = 14;

/**
 * The day each axis's neglect starts visibly damaging the garden — dryness for
 * runs (`drynessStartDays`), soil/life decay past day 7 for strength and yoga
 * (see simulate.ts `applyNeglect`). These are display anchors, not sim inputs.
 */
const DAMAGE_START_DAYS = {
  run: DEFAULT_GARDEN_CONFIG.drynessStartDays,
  strength: 7,
  yoga: 7,
} as const;

/**
 * Bar-fraction where each discipline's track crosses from "fading" into
 * "the garden is visibly paying for this" — where the UI draws its notch.
 */
export const DAMAGE_NOTCH: { run: number; strength: number; yoga: number } = {
  run: healthFor(DAMAGE_START_DAYS.run, GRACE_DAYS.run),
  strength: healthFor(DAMAGE_START_DAYS.strength, GRACE_DAYS.strength),
  yoga: healthFor(DAMAGE_START_DAYS.yoga, GRACE_DAYS.yoga),
};

export interface DisciplineBalance {
  run: { days: number; health: number };
  /** `days: null` means no session of this discipline has ever been recorded
   * — the UI must say "not yet", never a fabricated recency. */
  strength: { days: number | null; health: number };
  yoga: { days: number | null; health: number };
  /** How balanced the garden is overall: the weakest discipline sets the pace. */
  overall: number;
}

export interface BalanceProjectionInputs {
  /** Days elapsed since `state.lastSimulatedDate` in the user's timezone —
   * may be fractional so bars visibly shrink between visits. Display-only;
   * the durable simulation never sees this. */
  daysSinceSimulated: number;
  /** Freeze the run clock (plan gap — run decay pauses on gap days). */
  freezeRun?: boolean;
  /** Freeze every clock (rest mode). */
  freezeAll?: boolean;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function healthFor(days: number, graceDays: number): number {
  return clamp01(1 - Math.max(0, days - graceDays) / DECAY_WINDOW_DAYS);
}

/** Shared core: clocks (possibly fractional) → balance. */
function balanceFrom(
  state: EngineGardenState,
  runDays: number,
  strengthDays: number,
  yogaDays: number,
): DisciplineBalance {
  const run = { days: Math.floor(runDays), health: healthFor(runDays, GRACE_DAYS.run) };
  const strength = {
    days: state.hasStrength ? Math.floor(strengthDays) : null,
    health: healthFor(strengthDays, GRACE_DAYS.strength),
  };
  const yoga = {
    days: state.hasYoga ? Math.floor(yogaDays) : null,
    health: healthFor(yogaDays, GRACE_DAYS.yoga),
  };
  // A discipline that was never practiced can't drag the garden down — its
  // clock has been growing since genesis and means nothing yet.
  const practiced = [
    run.health,
    ...(strength.days !== null ? [strength.health] : []),
    ...(yoga.days !== null ? [yoga.health] : []),
  ];
  return { run, strength, yoga, overall: Math.min(...practiced) };
}

/**
 * Pure summary of how balanced the three disciplines are, derived from each
 * axis's "days since" clock. A discipline within its grace period is at full
 * health; beyond it, health fades linearly to zero over fourteen days.
 * `overall` is the minimum across the practiced disciplines, so neglecting
 * any one of them is what the garden shows first.
 */
export function disciplineBalance(state: EngineGardenState): DisciplineBalance {
  return balanceFrom(
    state,
    state.daysSinceCompletedRun,
    state.daysSinceStrength ?? 0,
    state.daysSinceYoga ?? 0,
  );
}

/**
 * `disciplineBalance` projected forward from `lastSimulatedDate` by wall-clock
 * elapsed days, so the bars keep shrinking between app opens. Pure display —
 * never persisted, never fed back into the simulation.
 */
export function projectedBalance(
  state: EngineGardenState,
  inp: BalanceProjectionInputs,
): DisciplineBalance {
  const extra = Math.max(0, inp.daysSinceSimulated);
  const runExtra = inp.freezeAll || inp.freezeRun ? 0 : extra;
  const otherExtra = inp.freezeAll ? 0 : extra;
  return balanceFrom(
    state,
    state.daysSinceCompletedRun + runExtra,
    (state.daysSinceStrength ?? 0) + otherExtra,
    (state.daysSinceYoga ?? 0) + otherExtra,
  );
}
