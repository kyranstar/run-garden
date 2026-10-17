/**
 * GROWTH'S BODY MAP (the new shape §7) — `GET /api/growth/body?period=month|season`: how much each area of the figure
 * was worked over the last 30 or 90 days, read from the coach's own exposure computation (`readExposure`, the one
 * `read_balance` speaks), what carried the period, the area gone quiet, and the period's longest holds.
 *
 *  - AN AREA gathers the library regions it draws (`BODY_AREA_REGIONS`), and a move counts once per area: a band row
 *    loads the upper back and the lats, three sets of the back, never six. A move played without a set is one.
 *  - RUNS LOAD THE HIPS AND THE LEGS (read_balance's RUN_REGIONS): an area that holds one of them counts the period's
 *    runs, each worth RUN_SETS working sets for its level, and a run is a day it was worked.
 *  - THE LEVEL is the work per week of the period (`areaLevel`): a little, steadily (STEADY_PER_WEEK), a lot
 *    (A_LOT_PER_WEEK) — never a share of the athlete's own busiest area, so a light month reads light.
 *  - WHAT CARRIED IT: the two most-worked areas (head to foot on a tie). THE QUIET AREA: of the areas worked in the
 *    period and those the athlete's focus areas name, the one longest without work, from QUIET_DAYS on; a focus area's
 *    area never worked in the period is quiet for all of it. An area neither worked nor focused on is not named: a map
 *    of what the athlete does, never a list of everything they don't.
 *  - A HOLD is an isometric strength move done for time; its longest done set in the period (the earliest of equals), a
 *    set held a side at a time at its shorter side, as the objectives' hold measure reads it.
 *
 * Two statements (`readExposure`'s): the athlete with the focus areas, then the period in one read.
 */
import {
  addDays,
  BODY_AREA_REGIONS,
  BODY_AREAS,
  daysBetween,
  GROWTH_PERIOD_DAYS,
  QUIET_DAYS,
  type BodyArea,
  type BodyAreaExposure,
  type BodyAreaLevel,
  type GrowthBodyDto,
  type GrowthHold,
  type GrowthPeriod,
} from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import type { Db } from "./db.js";
import { asLibrary, EXPOSURE_STATEMENTS, readExposure, regionOf, RUN_REGIONS } from "./body-exposure.js";
import { exerciseDisplayName } from "./logged-sets.js";

/** The statements one read makes (the route adds its session's). */
export const GROWTH_BODY_STATEMENTS = EXPOSURE_STATEMENTS;
/** A run, in working sets, for the level of an area it loads. */
export const RUN_SETS = 3;
/** Working sets a week from which an area was worked steadily, and a lot. */
export const STEADY_PER_WEEK = 4;
export const A_LOT_PER_WEEK = 10;
/** Holds shown, at most. */
export const HOLDS_SHOWN = 5;

const BY_ID = new Map(EXERCISES.map((e) => [e.id, e]));
/** The area a library region is drawn in, if any. */
const AREA_OF = new Map<string, BodyArea>(BODY_AREAS.flatMap((a) => BODY_AREA_REGIONS[a].map((r) => [r, a] as const)));
const RUN_AREAS = new Set<BodyArea>(RUN_REGIONS.flatMap((r) => (AREA_OF.has(r) ? [AREA_OF.get(r)!] : [])));
const HEAD_TO_FOOT = new Map(BODY_AREAS.map((a, i) => [a, i]));

/** The level of an area worked `work` working sets' worth over `days` days. */
export function areaLevel(work: number, days: number): BodyAreaLevel {
  if (!(work > 0)) return 0;
  const perWeek = (work * 7) / days;
  return perWeek >= A_LOT_PER_WEEK ? 3 : perWeek >= STEADY_PER_WEEK ? 2 : 1;
}

/** A move held for time: an isometric strength move dosed in seconds. */
function isHold(exerciseId: string): boolean {
  const rec = BY_ID.get(exerciseId);
  return !!rec && rec.dose.type === "time" && rec.contraction.includes("isometric") && rec.purposes.includes("strength");
}

/** The body map of the period ending on the athlete's today. */
export async function growthBody(db: Db, userId: string, now: Date, period: GrowthPeriod): Promise<GrowthBodyDto> {
  const days = GROWTH_PERIOD_DAYS[period];
  const x = await readExposure(db, userId, now, (today) => ({ from: addDays(today, -(days - 1)), to: today }));
  const today = x.athlete.today;
  const from = addDays(today, -(days - 1));

  // Each area's working sets, a move once per area, and the last day a session worked it.
  const sets = new Map<BodyArea, number>();
  const last = new Map<BodyArea, string>();
  for (const m of x.byMove) {
    const rec = BY_ID.get(m.exerciseId);
    if (!rec) continue;
    const areas = new Set(rec.regions.flatMap((r) => (AREA_OF.has(r) ? [AREA_OF.get(r)!] : [])));
    for (const a of areas) {
      sets.set(a, (sets.get(a) ?? 0) + m.sets);
      if ((last.get(a) ?? "") < m.date) last.set(a, m.date);
    }
  }
  const runs = x.ranDays.length;
  const areas: BodyAreaExposure[] = BODY_AREAS.map((area) => {
    const ran = RUN_AREAS.has(area) ? runs : 0;
    const s = sets.get(area) ?? 0;
    const lastDay = [last.get(area) ?? null, ran > 0 ? x.lastRun : null].reduce<string | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);
    return { area, sets: s, runs: ran, level: areaLevel(s + RUN_SETS * ran, days), last: lastDay, daysAgo: lastDay ? daysBetween(lastDay, today) : null };
  });

  const work = (a: BodyAreaExposure) => a.sets + RUN_SETS * a.runs;
  const carried = areas
    .filter((a) => work(a) > 0)
    .sort((a, b) => work(b) - work(a) || HEAD_TO_FOOT.get(a.area)! - HEAD_TO_FOOT.get(b.area)!)
    .slice(0, 2)
    .map((a) => a.area);

  // The areas the athlete's focus areas name (a muscle by the region it sits under).
  const focused = new Set<BodyArea>(
    x.focus.flatMap((f) => f.refs.flatMap((ref) => {
      const area = AREA_OF.get(regionOf(ref) ?? "");
      return area ? [area] : [];
    })),
  );
  const quietness = (a: BodyAreaExposure): number => (a.daysAgo === null ? Number.POSITIVE_INFINITY : a.daysAgo);
  const quietest = areas
    .filter((a) => a.last !== null || focused.has(a.area))
    .filter((a) => quietness(a) >= QUIET_DAYS)
    .sort((a, b) => quietness(b) - quietness(a) || HEAD_TO_FOOT.get(a.area)! - HEAD_TO_FOOT.get(b.area)!)[0];

  return {
    period,
    today,
    from,
    sessions: x.sessions.length,
    runs: x.runs,
    other: x.other,
    areas,
    carried,
    quiet: quietest ? { area: quietest.area, daysAgo: quietest.daysAgo } : null,
    holds: longestHolds(x),
  };
}

/** The period's longest holds, longest first (the earliest of equals): a side-at-a-time set at its shorter side. */
function longestHolds(x: Awaited<ReturnType<typeof readExposure>>): GrowthHold[] {
  const dayOf = new Map(x.sessions.map((s) => [s.id, s.date]));
  /** One set: its session, entry and number — the rows of its sides share them. */
  const perSet = new Map<string, { exerciseId: string; seconds: number; date: string }>();
  for (const s of x.sets) {
    const date = dayOf.get(s.session);
    const exerciseId = asLibrary(s.exerciseId);
    if (date === undefined || s.seconds === null || !(s.seconds > 0) || !isHold(exerciseId)) continue;
    const key = `${s.session}:${s.entry}:${s.index}:${exerciseId}`;
    const seen = perSet.get(key);
    if (!seen || s.seconds < seen.seconds) perSet.set(key, { exerciseId, seconds: s.seconds, date });
  }
  const best = new Map<string, GrowthHold>();
  for (const h of perSet.values()) {
    const b = best.get(h.exerciseId);
    if (!b || h.seconds > b.seconds || (h.seconds === b.seconds && h.date < b.date)) {
      best.set(h.exerciseId, { exerciseId: h.exerciseId, name: exerciseDisplayName(h.exerciseId), seconds: h.seconds, date: h.date });
    }
  }
  return [...best.values()].sort((a, b) => b.seconds - a.seconds || a.date.localeCompare(b.date) || a.exerciseId.localeCompare(b.exerciseId)).slice(0, HOLDS_SHOWN);
}
