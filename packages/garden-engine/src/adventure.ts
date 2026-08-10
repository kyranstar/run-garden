import type { LocalDate } from "@rg/domain";

/**
 * Adventures: sports the garden welcomes but never demands. A qualifying
 * adventure day freezes every decay clock (like rest mode); a big day earns
 * grace for the days after, sized by Coros's own recovery model when we have
 * it. Nothing here can ever hurt the garden — see the spec's "optional means
 * optional" constraint.
 */
export interface AdventureInput {
  sport: string;
  trainingLoad?: number;
  durationMin?: number;
}

export const ADVENTURE_TUNING = {
  /** A real session, not a stroll: load ≥ minLoad OR duration ≥ minDurationMin. */
  minLoad: 40,
  minDurationMin: 45,
  /** A big day (backpacking, a long tour) banks one grace day for after. */
  bigLoad: 80,
  bigDurationMin: 150,
  /** Max consecutive shielded days after the last adventure. */
  graceCap: 2,
  /** Grace continues while Coros recovery (0-100) sits below this. */
  recoveryThreshold: 60,
} as const;

export function qualifiesAsAdventure(a: AdventureInput): boolean {
  return (a.trainingLoad ?? 0) >= ADVENTURE_TUNING.minLoad ||
    (a.durationMin ?? 0) >= ADVENTURE_TUNING.minDurationMin;
}

export function isBigAdventure(a: AdventureInput): boolean {
  return (a.trainingLoad ?? 0) >= ADVENTURE_TUNING.bigLoad ||
    (a.durationMin ?? 0) >= ADVENTURE_TUNING.bigDurationMin;
}

/** Coros recovery % when synced; 100 - fatigue as the historical proxy; else unknown. */
export function recoveryScoreFrom(
  recoveryScore?: number | null,
  fatigueScore?: number | null,
): number | undefined {
  if (recoveryScore != null) return recoveryScore;
  if (fatigueScore != null) return Math.max(0, Math.min(100, 100 - fatigueScore));
  return undefined;
}

function wholeDaysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * Is this a shielded recovery day after an adventure? Only on days that would
 * otherwise decay — a discipline session, rest mode, or a plan gap already
 * explains the day. Recovery data decides when present; the banked heuristic
 * answers for dates without health data (old backfilled history).
 */
export function adventureGraceDay(
  s: { lastAdventureDate: LocalDate | null; adventureGraceDays: number },
  opts: {
    date: LocalDate;
    hasSession: boolean;
    adventureToday: boolean;
    restMode: boolean;
    planGap: boolean;
    recoveryScore?: number;
  },
): boolean {
  if (opts.adventureToday || opts.hasSession || opts.restMode || opts.planGap) return false;
  if (!s.lastAdventureDate) return false;
  const since = wholeDaysBetween(s.lastAdventureDate, opts.date);
  if (since < 1 || since > ADVENTURE_TUNING.graceCap) return false;
  if (opts.recoveryScore !== undefined) return opts.recoveryScore < ADVENTURE_TUNING.recoveryThreshold;
  return s.adventureGraceDays > 0;
}
