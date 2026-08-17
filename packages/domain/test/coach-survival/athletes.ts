/**
 * Athlete states the coach actually wakes into.
 *
 * Every fixture is anchored to `nextMonday()` — the Monday strictly ahead of
 * today — so the whole calendar sits in the future and the ISO week buckets the
 * guardrails count in line up with the fixture's own weeks. Anchoring to *today*
 * instead would make every week-bucketed rule (ramp, cold start, rest day) give
 * a different answer depending on which weekday the suite happens to run on,
 * which is the definition of a flaky measurement.
 *
 * Trailing minutes are set to what the calendar implies, not to whatever makes
 * a rule fire — a build week runs at ~1.0x its own average, a down week under
 * it. Rigging that number would rig the whole survival rate.
 */
import { addDays, todayInZone } from "../../src/time.js";
import type { GuardrailCtx, GuardrailWorkout } from "../../src/coach-guardrails.js";

export const TZ = "America/Los_Angeles";

export function today(): string {
  return todayInZone(TZ);
}

/** ISO weekday 1(Mon)..7(Sun). */
function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The Monday strictly after today (1..7 days out). */
export function nextMonday(from = today()): string {
  const plus7 = addDays(from, 7);
  return addDays(plus7, -(isoWeekday(plus7) - 1));
}

export interface SeedRow extends GuardrailWorkout {
  planId: string;
  title: string;
}

export interface AthleteState {
  key: string;
  label: string;
  /** Plans that exist in `coach_plans` (i.e. coach-authored). */
  coachPlans: Array<{ id: string; discipline: "run" | "lift" | "mobility"; raceDate?: string }>;
  /** Plan ids that exist only as `planned_workouts.plan_id` (imported COROS). */
  importedPlanIds: string[];
  rows: SeedRow[];
  ctx: GuardrailCtx;
  /** Anchor Monday, for generators. */
  A: string;
}

type Spec = {
  /** [dayOffsetFromA, category, discipline, minutes] */
  day: number;
  category: string;
  discipline: "run" | "strength" | "yoga";
  minutes: number;
  state?: string;
};

function build(opts: {
  key: string;
  label: string;
  planId: string;
  coachAuthored: boolean;
  discipline?: "run" | "lift" | "mobility";
  weeks: number[];
  pattern: Spec[];
  extra?: Spec[];
  weekly: Record<string, number[]>;
  raceDates?: number[];
  horizonDay: number;
  events?: Array<{ id: string; label: string; day: number }>;
  rules?: GuardrailCtx["rules"];
}): AthleteState {
  const A = nextMonday();
  const rows: SeedRow[] = [];
  let n = 0;
  const push = (s: Spec, weekBase: number) => {
    const date = addDays(A, weekBase + s.day);
    rows.push({
      id: `${opts.key}-w${n++}`,
      planId: opts.planId,
      date,
      category: s.category,
      completionState: s.state ?? "scheduled",
      durationMinutes: s.minutes,
      discipline: s.discipline,
      title: `${s.category} ${s.minutes}min`,
    });
  };
  for (const w of opts.weeks) for (const s of opts.pattern) push(s, w * 7);
  for (const s of opts.extra ?? []) push(s, 0);

  // Two sessions the athlete has already done. They are what the dossier's
  // LAST 14 DAYS section renders, and `dossierHandles` checks whether that
  // section still offers them as `[wo:...]` targets — the invitation register B
  // used to take up. They sit in the week before the anchor Monday, so no
  // week-bucketed rule can see them.
  for (const [back, cat, mins] of [[2, "easy", 40], [5, "quality", 55]] as const) {
    const date = addDays(today(), -back);
    rows.push({
      id: `${opts.key}-done${back}`,
      planId: opts.planId,
      date,
      category: cat,
      completionState: "completed",
      durationMinutes: mins,
      discipline: "run",
      title: `${cat} ${mins}min`,
    });
  }

  return {
    key: opts.key,
    label: opts.label,
    coachPlans: opts.coachAuthored
      ? [
          {
            id: opts.planId,
            discipline: opts.discipline ?? "run",
            ...(opts.raceDates?.length ? { raceDate: addDays(A, opts.raceDates[0]!) } : {}),
          },
        ]
      : [],
    importedPlanIds: opts.coachAuthored ? [] : [opts.planId],
    rows,
    A,
    ctx: {
      today: today(),
      workouts: rows.map((r) => ({
        id: r.id,
        date: r.date,
        category: r.category,
        completionState: r.completionState,
        durationMinutes: r.durationMinutes,
        discipline: r.discipline,
      })),
      weeklyMinutesByDiscipline: opts.weekly,
      raceDates: (opts.raceDates ?? []).map((d) => addDays(A, d)),
      firmHorizonEnd: addDays(A, opts.horizonDay),
      rules: opts.rules ?? [],
      coachPlanIds: opts.coachAuthored ? [opts.planId] : [],
      datedEvents: (opts.events ?? []).map((e) => ({ id: e.id, label: e.label, date: addDays(A, e.day) })),
    },
  };
}

/** A normal six-day running week: Tue quality, Sat long, easy around them. */
const buildWeek = (q: number, e1: number, e2: number, long: number, e3: number): Spec[] => [
  { day: 1, category: "quality", discipline: "run", minutes: q },
  { day: 2, category: "easy", discipline: "run", minutes: e1 },
  { day: 3, category: "easy", discipline: "run", minutes: e2 },
  { day: 5, category: "long", discipline: "run", minutes: long },
  { day: 6, category: "easy", discipline: "run", minutes: e3 },
];

export function athletes(): AthleteState[] {
  return [
    build({
      key: "offseason",
      label: "off-season, near-empty calendar, no plan, no race",
      planId: "imported-1",
      coachAuthored: false,
      weeks: [0, 1],
      pattern: [
        { day: 1, category: "easy", discipline: "run", minutes: 30 },
        { day: 4, category: "easy", discipline: "run", minutes: 30 },
      ],
      // 2×30 a week, which is what the calendar holds.
      weekly: { run: [60, 60, 55, 65] },
      horizonDay: 13,
    }),
    build({
      key: "build-imported",
      label: "mid-build on an imported COROS plan, race in five weeks, a work trip in memory",
      planId: "imported-2",
      coachAuthored: false,
      weeks: [0, 1, 2, 3],
      pattern: buildWeek(60, 45, 50, 100, 40),
      extra: [{ day: 27, category: "race", discipline: "run", minutes: 200 }],
      weekly: { run: [280, 300, 290, 310] },
      raceDates: [27],
      horizonDay: 27,
      events: [{ id: "mem-trip", label: "work trip", day: 12 }],
    }),
    build({
      key: "build-coached",
      label: "mid-build on a coach-authored plan, down week, no race",
      planId: "cp1",
      coachAuthored: true,
      weeks: [0, 1, 2, 3],
      pattern: buildWeek(55, 45, 45, 85, 30),
      weekly: { run: [270, 290, 300, 280] },
      horizonDay: 27,
    }),
    build({
      key: "ski-prep",
      label: "moderate runner, zero strength history, ski trip in 16 days (tonight's scenario)",
      planId: "cp1",
      coachAuthored: true,
      weeks: [0, 1, 2, 3],
      pattern: [
        { day: 1, category: "quality", discipline: "run", minutes: 55 },
        { day: 3, category: "easy", discipline: "run", minutes: 45 },
        { day: 5, category: "long", discipline: "run", minutes: 80 },
        { day: 6, category: "easy", discipline: "run", minutes: 35 },
      ],
      weekly: { run: [210, 220, 200, 230], strength: [0, 0, 0, 0] },
      horizonDay: 27,
      events: [{ id: "mem-ski", label: "ski trip", day: 16 }],
    }),
    build({
      key: "missed-week",
      label: "back from a week off — trailing average depressed, calendar unchanged",
      planId: "cp1",
      coachAuthored: true,
      weeks: [0, 1, 2],
      pattern: buildWeek(60, 45, 50, 100, 40),
      extra: [
        { day: -1, category: "quality", discipline: "run", minutes: 60, state: "missed" },
        { day: -3, category: "long", discipline: "run", minutes: 95, state: "skipped" },
      ],
      weekly: { run: [300, 280, 290, 0] },
      horizonDay: 20,
    }),
    build({
      key: "seven-day",
      label: "every day of the first week already carries work (inherited, not the coach's doing)",
      planId: "cp1",
      coachAuthored: true,
      weeks: [0, 1, 2],
      pattern: [
        { day: 0, category: "strength", discipline: "strength", minutes: 30 },
        { day: 1, category: "quality", discipline: "run", minutes: 60 },
        { day: 2, category: "easy", discipline: "run", minutes: 45 },
        { day: 3, category: "easy", discipline: "run", minutes: 40 },
        { day: 4, category: "strength", discipline: "strength", minutes: 30 },
        { day: 5, category: "long", discipline: "run", minutes: 95 },
        { day: 6, category: "easy", discipline: "run", minutes: 40 },
      ],
      weekly: { run: [280, 300, 280, 300], strength: [55, 60, 60, 55] },
      horizonDay: 20,
    }),
    build({
      key: "race-soon",
      label: "sparse calendar, race in nine days, imported plan",
      planId: "imported-3",
      coachAuthored: false,
      weeks: [0],
      pattern: [
        { day: 1, category: "easy", discipline: "run", minutes: 40 },
        { day: 3, category: "quality", discipline: "run", minutes: 40 },
        { day: 5, category: "long", discipline: "run", minutes: 70 },
      ],
      extra: [
        { day: 8, category: "easy", discipline: "run", minutes: 30 },
        { day: 9, category: "race", discipline: "run", minutes: 180 },
      ],
      weekly: { run: [200, 190, 210, 180] },
      raceDates: [9],
      horizonDay: 20,
    }),
    build({
      key: "lifter",
      label: "regular lifter who also runs — real strength history, so nothing is a cold start",
      planId: "cp1",
      coachAuthored: true,
      weeks: [0, 1, 2],
      pattern: [
        { day: 0, category: "strength", discipline: "strength", minutes: 55 },
        { day: 1, category: "easy", discipline: "run", minutes: 40 },
        { day: 2, category: "strength", discipline: "strength", minutes: 50 },
        { day: 3, category: "easy", discipline: "run", minutes: 35 },
        { day: 5, category: "long", discipline: "run", minutes: 70 },
      ],
      weekly: { run: [160, 150, 170, 150], strength: [170, 190, 160, 180] },
      horizonDay: 20,
      rules: [{ id: "mem-rule-long-sat", kind: "anchor_day", category: "long", weekday: 6 }],
    }),
  ];
}
