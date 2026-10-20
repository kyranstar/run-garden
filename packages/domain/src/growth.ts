/**
 * GROWTH'S BODY MAP (the new shape §7): what `GET /api/growth/body?period=month|season` answers — how much each area of
 * the body was worked over the period, the coach's own exposure computation (`read_balance`'s, served to the screen).
 *
 * The map is a figure of eleven calm areas, seen from the front and from the back. Each gathers the library's regions it
 * draws (`BODY_AREA_REGIONS`): the back is the upper back, the lats, the thoracic spine and the low back; the calves are
 * the lower leg (calves, ankles, feet). The jaw is no area of the figure (its care is a condition's, not training
 * exposure). A move counts once per area however many of the area's regions it loads, so an area's sets never count one
 * set twice.
 */

/** The period the map reads: the last 30 days, or the last 90 (today included). */
export const GROWTH_PERIODS = ["month", "season"] as const;
export type GrowthPeriod = (typeof GROWTH_PERIODS)[number];
export const GROWTH_PERIOD_DAYS: Record<GrowthPeriod, number> = { month: 30, season: 90 };

/** The figure's areas, head to foot. */
export const BODY_AREAS = ["neck", "shoulders", "chest", "arms", "back", "core", "hips", "glutes", "quads", "hamstrings", "calves"] as const;
export type BodyArea = (typeof BODY_AREAS)[number];

/** The library regions each area draws. */
export const BODY_AREA_REGIONS: Record<BodyArea, readonly string[]> = {
  neck: ["neck"],
  shoulders: ["shoulders"],
  chest: ["chest"],
  arms: ["arms"],
  back: ["upper-back", "lats", "thoracic", "low-back"],
  core: ["core"],
  hips: ["hips"],
  glutes: ["glutes"],
  quads: ["quads"],
  hamstrings: ["hamstrings"],
  calves: ["calves", "ankles", "feet"],
};

/** How much an area was worked, per week of the period: 0 not at all, 1 a little, 2 steadily, 3 a lot. */
export type BodyAreaLevel = 0 | 1 | 2 | 3;

export interface BodyAreaExposure {
  area: BodyArea;
  /** Working sets of the moves that load it (a move once per area), sessions only. */
  sets: number;
  /** The period's runs, when a run loads this area (the hips and the legs); else 0. */
  runs: number;
  level: BodyAreaLevel;
  /** The last day a session or a run worked it, in the period; null when nothing did. */
  last: string | null;
  /** Days from `last` to today; null with no `last`. */
  daysAgo: number | null;
}

/** A hold: a move held for time (an isometric strength move), its longest done set in the period. */
export interface GrowthHold {
  exerciseId: string;
  name: string;
  seconds: number;
  date: string;
}

/** Exact shape of `GET /api/growth/body`. */
export interface GrowthBodyDto {
  period: GrowthPeriod;
  /** The athlete's today, and the period's first day. */
  today: string;
  from: string;
  /** Physical sessions logged, runs and other activities no session logged, in the period. */
  sessions: number;
  runs: number;
  other: number;
  /** Every area of the figure, head to foot. Nothing logged: every level 0. */
  areas: BodyAreaExposure[];
  /** What carried the period: the most-worked areas, up to two, most first. Empty when nothing was logged. */
  carried: BodyArea[];
  /**
   * The quietest area: of those worked in the period (and the athlete's focus areas), the one longest without work —
   * only when that is QUIET_DAYS or more. `daysAgo` null: not worked at all in the period. Null when none is quiet.
   */
  quiet: { area: BodyArea; daysAgo: number | null } | null;
  /** The period's longest holds, longest first. */
  holds: GrowthHold[];
}

/** An area is quiet after this many days without work. */
export const QUIET_DAYS = 5;
