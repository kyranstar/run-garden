/**
 * A competent coach, as a generator.
 *
 * Everything here emits RAW JSON — the shape a model writes, before zod sees
 * it — because the parse boundary is stage one of the thing being measured. If
 * the generator emitted already-parsed `CoachOp`s it would score the schema a
 * free 100%.
 *
 * The coach modelled here is competent but not a solver. It reads the dossier,
 * so it: uses real `[wo:id]` handles, never touches the past, keeps non-exempt
 * ops inside the firm horizon, only rewrites the structure of plans it authored,
 * and sizes sessions the way a coach sizes them. It does NOT re-run the
 * guardrail validator in its head over the calendar its own ops leave behind —
 * no model does, and pretending otherwise would measure the generator instead
 * of the pipeline.
 *
 * Dialect variation (string numbers, `null` for absent, decorated ids, a date
 * with a timestamp suffix) is applied at high rates ON PURPOSE: every one of
 * those is a tolerance the schema documents, so a failure there is a real bug,
 * not a generator artifact. Genuinely-unknown keys are NOT generated here —
 * strictness is a design choice rather than a tolerance, so it belongs in the
 * probe matrix where it can be reported separately.
 */
import { addDays, daysBetween } from "../../src/time.js";
import type { AthleteState, SeedRow } from "./athletes.js";

/* ---------------------------------------------------------------- rng --- */

export type Rng = () => number;

/** mulberry32 — small, fast, and identical on every machine. */
export function rngFor(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const chance = (rng: Rng, p: number): boolean => rng() < p;
const shuffled = <T>(rng: Rng, xs: readonly T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

/* ------------------------------------------------------------ dialect --- */

/** A date as a model writes it: bare, or with the timestamp the prompt invites. */
const d = (rng: Rng, iso: string): string => (chance(rng, 0.12) ? `${iso}T23:59:59Z` : iso);

/** An id as a model echoes it back from the dossier's `[wo:abc]` handles. */
const id = (rng: Rng, raw: string): string => {
  const r = rng();
  return r < 0.12 ? `[wo:${raw}]` : r < 0.2 ? `wo:${raw}` : raw;
};
const planRef = (rng: Rng, raw: string): string => (chance(rng, 0.15) ? `[${raw}]` : raw);

/** An integer, sometimes quoted — models do this constantly. */
const n = (rng: Rng, v: number): number | string => (chance(rng, 0.12) ? String(v) : v);
const secs = (rng: Rng, v: number): number | string => {
  const r = rng();
  return r < 0.1 ? `${v}s` : r < 0.18 ? String(v) : v;
};

/* --------------------------------------------------------- vocabulary --- */

/** What a coach calls the movements, catalog or no catalog. */
const LIFTS = [
  "Goblet squat",
  "Back squat",
  "Front squat",
  "Split squat",
  "Bulgarian split squat",
  "Step up",
  "Reverse lunge",
  "Walking lunge",
  "Lateral lunge",
  "Romanian deadlift",
  "Deadlift",
  "Hip thrust",
  "Glute bridge",
  "Nordic hamstring curl",
  "Hamstring curl",
  "Leg press",
  "Standing calf raise",
  "Single-leg calf raise",
  "Box jump",
  "Jump squat",
  "Skater bound",
  "Skier hops",
  "Push up",
  "Pull up",
  "Bent over row",
  "Overhead press",
  "Bench press",
  "Face pull",
  "Farmer's carry",
  "Pallof press",
] as const;

const HOLDS = [
  "Wall sit",
  "Plank",
  "Side plank",
  "Copenhagen plank",
  "Dead bug",
  "Bird dog",
  "Single-leg balance",
  "Hollow hold",
  "Glute bridge hold",
] as const;

const MOBILITY = [
  "90/90 hip switch",
  "Couch stretch",
  "Hip flexor stretch",
  "Thoracic rotation",
  "Cat cow",
  "Downward dog",
  "Pigeon pose",
  "World's greatest stretch",
  "Ankle dorsiflexion drill",
  "Wall angels",
  "Calf stretch",
  "Hamstring sweep",
  "Monster walk",
  "Clamshell",
] as const;

const PER_SIDE = /single-leg|split|lunge|step up|side plank|copenhagen|bird dog|90\/90|pigeon|clamshell|skater/i;

/* ------------------------------------------------------------ bodies --- */

function rawExercise(rng: Rng, name: string, kind: "reps" | "hold"): Record<string, unknown> {
  const e: Record<string, unknown> = { name, sets: n(rng, int(rng, 2, 4)) };
  if (kind === "hold") e.holdSeconds = secs(rng, pick(rng, [20, 30, 40, 45, 60, 90]));
  else e.reps = n(rng, pick(rng, [6, 8, 10, 12, 15, 20]));
  if (PER_SIDE.test(name)) e.perSide = true;
  else if (chance(rng, 0.08)) e.perSide = false;
  // The eccentric IS the prescription in ski prep — a coach writes it often.
  if (kind === "reps" && chance(rng, 0.25)) e.eccentricSeconds = n(rng, pick(rng, [3, 4, 5]));

  const w = rng();
  if (w < 0.4) {
    /* omitted entirely — bodyweight */
  } else if (w < 0.55) e.weight = null;
  else if (w < 0.75) e.weight = pick(rng, [8, 10, 12, 16, 20, 24, 40, 60]);
  else if (w < 0.85) e.weight = pick(rng, ["20kg", "16 kg", "24 kilos"]);
  else if (w < 0.92) e.weight = pick(rng, ["45 lbs", "30 pounds"]);
  else e.weight = { type: "bodyweight" };

  const r = rng();
  if (r < 0.35) {
    /* omitted */
  } else if (r < 0.45) e.restSeconds = null;
  else e.restSeconds = n(rng, pick(rng, [30, 45, 60, 90, 120]));

  const nt = rng();
  if (nt < 0.55) {
    /* omitted */
  } else if (nt < 0.62) e.note = null;
  else e.note = pick(rng, [
    "control the lowering",
    "pause at the bottom",
    "heavy enough that the last set is hard",
    "stop two reps short of failure",
    "keep the knee tracking over the toe",
  ]);
  return e;
}

function liftBody(rng: Rng, count: number, circuit: boolean): Record<string, unknown> {
  const names = shuffled(rng, [...LIFTS, ...HOLDS]).slice(0, count);
  const exercises = names.map((nm) =>
    rawExercise(rng, nm, (HOLDS as readonly string[]).includes(nm) ? "hold" : chance(rng, 0.15) ? "hold" : "reps"),
  );
  return circuit ? { rounds: n(rng, int(rng, 1, 4)), exercises } : { exercises };
}

function mobilityBody(rng: Rng, count: number, circuit: boolean): Record<string, unknown> {
  const names = shuffled(rng, [...MOBILITY, ...HOLDS]).slice(0, count);
  const exercises = names.map((nm) => rawExercise(rng, nm, chance(rng, 0.7) ? "hold" : "reps"));
  return circuit ? { rounds: n(rng, int(rng, 1, 3)), exercises } : { exercises };
}

function runBlocks(rng: Rng, category: string, minutes: number): unknown[] {
  if (category === "quality") {
    return [
      { kind: "duration", value: 15, intensity: "easy" },
      { kind: "duration", value: Math.max(10, minutes - 25), intensity: pick(rng, ["threshold", "interval"]) },
      { kind: "duration", value: 10, intensity: "easy" },
    ];
  }
  if (chance(rng, 0.12)) return [{ kind: "distance", value: Math.round(minutes * 150), intensity: "easy" }];
  return [{ kind: "duration", value: minutes, intensity: category === "long" ? "steady" : "easy" }];
}

export function runSession(rng: Rng, category: string, minutes: number): Record<string, unknown> {
  return {
    category,
    title: pick(rng, ["Easy aerobic", "Steady miles", "Threshold session", "Long run", "Shakeout", "Recovery jog"]),
    durationMinutes: minutes,
    run: { blocks: runBlocks(rng, category, minutes) },
  };
}

export function liftSession(rng: Rng, minutes: number): Record<string, unknown> {
  const circuit = chance(rng, 0.35);
  return {
    category: "strength",
    title: pick(rng, ["Ski legs", "Lower body strength", "Posterior chain", "Full body strength", "Leg circuit"]),
    durationMinutes: minutes,
    lift: liftBody(rng, int(rng, 3, 6), circuit),
  };
}

export function mobilitySession(rng: Rng, minutes: number): Record<string, unknown> {
  const circuit = chance(rng, 0.5);
  return {
    category: chance(rng, 0.25) ? "recovery" : "yoga",
    title: pick(rng, ["Hips and ankles", "Daily mobility", "Evening flow", "Ten-minute reset", "Ankle + calf work"]),
    durationMinutes: minutes,
    mobility: mobilityBody(rng, int(rng, 3, 5), circuit),
  };
}

function easedVersion(rng: Rng, row: SeedRow): Record<string, unknown> {
  const shorter = Math.max(20, Math.round(row.durationMinutes * pick(rng, [0.5, 0.6, 0.7])));
  if (row.discipline === "strength") return liftSession(rng, shorter);
  if (row.discipline === "yoga") return mobilitySession(rng, shorter);
  return runSession(rng, chance(rng, 0.2) ? "recovery" : "easy", shorter);
}

/* -------------------------------------------------------------- state --- */

const liveRows = (s: AthleteState): SeedRow[] =>
  s.rows.filter((r) => r.completionState === "scheduled" && r.date > s.ctx.today);

/** Whole weeks from the anchor Monday that sit inside the firm horizon. */
function plannedWeeks(s: AthleteState): number {
  return Math.max(1, Math.floor((daysBetween(s.A, s.ctx.firmHorizonEnd) + 1) / 7));
}
const dayOf = (s: AthleteState, week: number, day: number): string => addDays(s.A, week * 7 + day);
const rowsInWeek = (s: AthleteState, week: number): SeedRow[] =>
  liveRows(s).filter((r) => r.date >= dayOf(s, week, 0) && r.date <= dayOf(s, week, 6));

/** Where a coach puts a lift. Three real policies, not one. */
function strengthDays(rng: Rng, s: AthleteState, week: number, count: number): string[] {
  const rows = rowsInWeek(s, week);
  const byDay = new Map<string, SeedRow[]>();
  for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  const all = Array.from({ length: 7 }, (_, i) => dayOf(s, week, i));
  const longDay = rows.find((r) => r.category === "long")?.date;
  const dayBeforeLong = longDay ? addDays(longDay, -1) : undefined;
  const qualityDays = rows.filter((r) => r.category === "quality").map((r) => r.date);
  const easyDays = rows.filter((r) => r.category === "easy").map((r) => r.date);
  const emptyDays = all.filter((x) => !byDay.has(x));

  const policy = pick(rng, ["hard-days-hard", "spread", "on-easy-days"] as const);
  let order: string[];
  if (policy === "hard-days-hard") order = [...qualityDays, ...emptyDays, ...easyDays];
  else if (policy === "spread") order = [dayOf(s, week, 0), dayOf(s, week, 2), dayOf(s, week, 4), ...emptyDays, ...easyDays];
  else order = [...easyDays, ...emptyDays, ...qualityDays];

  const seen = new Set<string>();
  return order
    .filter((x) => x !== longDay && x !== dayBeforeLong && !seen.has(x) && (seen.add(x), true))
    .slice(0, count);
}

/* ------------------------------------------------------------ intents --- */

export interface Intent {
  key: string;
  applies: (s: AthleteState) => boolean;
  ops: (rng: Rng, s: AthleteState) => unknown[];
}

const coached = (s: AthleteState): boolean => s.ctx.coachPlanIds.length > 0;
const planId = (s: AthleteState): string => s.ctx.coachPlanIds[0] ?? "cp1";

export const INTENTS: Intent[] = [
  {
    key: "add-strength-block",
    applies: () => true,
    ops: (rng, s) => {
      const week = int(rng, 0, Math.min(1, plannedWeeks(s) - 1));
      const count = int(rng, 2, 3);
      return strengthDays(rng, s, week, count).map((date) => ({
        kind: "add",
        date: d(rng, date),
        session: liftSession(rng, pick(rng, [25, 30, 35, 40, 45])),
      }));
    },
  },
  {
    key: "add-mobility-daily",
    applies: () => true,
    ops: (rng, s) => {
      const start = dayOf(s, 0, int(rng, 0, 2));
      const span = int(rng, 4, 13);
      const last = addDays(start, span);
      const capped = last > s.ctx.firmHorizonEnd ? daysBetween(start, s.ctx.firmHorizonEnd) : span;
      const dates = Array.from({ length: Math.max(1, capped) }, (_, i) => addDays(start, i + 1));
      return [
        {
          kind: "add",
          date: d(rng, start),
          ...(chance(rng, 0.9) ? { dates: dates.map((x) => d(rng, x)) } : {}),
          session: mobilitySession(rng, pick(rng, [8, 10, 12, 15])),
        },
      ];
    },
  },
  {
    key: "taper-into-event",
    applies: (s) => s.ctx.datedEvents.length > 0 || s.ctx.raceDates.length > 0,
    ops: (rng, s) => {
      const when = s.ctx.datedEvents[0]?.date ?? s.ctx.raceDates[0]!;
      const window = liveRows(s).filter((r) => r.date >= addDays(when, -4) && r.date <= when && r.category !== "race");
      const ops: unknown[] = [];
      for (const r of window.slice(0, 3)) {
        if (r.category === "quality" || r.category === "long") {
          ops.push({ kind: "ease", workoutId: id(rng, r.id), session: easedVersion(rng, r) });
        } else if (chance(rng, 0.4)) {
          ops.push({ kind: "skip", workoutId: id(rng, r.id), reason: "keeping the legs fresh for the trip" });
        }
      }
      if (ops.length === 0 && window[0]) {
        ops.push({ kind: "ease", workoutId: id(rng, window[0].id), session: easedVersion(rng, window[0]) });
      }
      return ops;
    },
  },
  {
    key: "recover-missed-week",
    applies: (s) => liveRows(s).length >= 3,
    ops: (rng, s) => {
      const rows = shuffled(rng, rowsInWeek(s, 0));
      const ops: unknown[] = [];
      for (const r of rows.filter((x) => x.category === "quality" || x.category === "long").slice(0, 2)) {
        ops.push({ kind: "ease", workoutId: id(rng, r.id), session: easedVersion(rng, r) });
      }
      const skippable = rows.find((r) => r.category === "easy");
      if (skippable) ops.push({ kind: "skip", workoutId: id(rng, skippable.id), reason: "rebuilding gently after the week off" });
      return ops.length ? ops : [{ kind: "skip", workoutId: id(rng, rows[0]!.id), reason: "easing back in" }];
    },
  },
  {
    key: "ease-one-session",
    applies: (s) => liveRows(s).length > 0,
    ops: (rng, s) => {
      const r = pick(rng, liveRows(s));
      return [{ kind: "ease", workoutId: id(rng, r.id), session: easedVersion(rng, r) }];
    },
  },
  {
    key: "skip-one-off",
    applies: (s) => liveRows(s).some((r) => r.category !== "race"),
    ops: (rng, s) => {
      const rows = shuffled(rng, liveRows(s).filter((r) => r.category !== "race")).slice(0, int(rng, 1, 2));
      return rows.map((r) => ({
        kind: "skip",
        workoutId: id(rng, r.id),
        reason: pick(rng, ["travelling that day", "calf still grumbling", "you asked for the morning back"]),
      }));
    },
  },
  {
    key: "swap-two-days",
    applies: (s) => rowsInWeek(s, 0).length >= 2,
    ops: (rng, s) => {
      const days = shuffled(rng, [...new Set(rowsInWeek(s, 0).map((r) => r.date))]).slice(0, 2);
      return [{ kind: "swap", dayA: d(rng, days[0]!), dayB: d(rng, days[1]!) }];
    },
  },
  {
    key: "move-a-session",
    applies: (s) => liveRows(s).length > 0,
    ops: (rng, s) => {
      const r = pick(rng, liveRows(s).filter((x) => x.category !== "race"));
      if (!r) return [];
      const to = addDays(r.date, pick(rng, [-1, 1, 2]));
      const clamped = to > s.ctx.firmHorizonEnd ? addDays(r.date, -1) : to < s.ctx.today ? addDays(r.date, 1) : to;
      return [{ kind: "move", workoutId: id(rng, r.id), toDate: d(rng, clamped) }];
    },
  },
  {
    key: "restructure-week",
    applies: coached,
    ops: (rng, s) => {
      const week = int(rng, 1, Math.max(1, plannedWeeks(s) - 1));
      const days = shuffled(rng, [0, 1, 2, 3, 4, 5, 6]).slice(0, int(rng, 4, 6)).sort((a, b) => a - b);
      return [
        {
          kind: "reshapeWeek",
          planId: planRef(rng, planId(s)),
          weekStart: d(rng, dayOf(s, week, 0)),
          sessions: days.map((day) => ({
            date: d(rng, dayOf(s, week, day)),
            session:
              day === 5
                ? runSession(rng, "long", pick(rng, [70, 80, 90]))
                : day === 1
                  ? runSession(rng, "quality", pick(rng, [45, 50, 55]))
                  : runSession(rng, "easy", pick(rng, [30, 35, 40, 45])),
          })),
        },
      ];
    },
  },
  {
    key: "firm-up-next-week",
    applies: coached,
    ops: (rng, s) => {
      const week = Math.max(1, plannedWeeks(s) - 1);
      const days = [1, 3, 5, 6].slice(0, int(rng, 3, 4));
      return [
        {
          kind: "firmUp",
          planId: planRef(rng, planId(s)),
          weekStart: d(rng, dayOf(s, week, 0)),
          sessions: days.map((day) => ({
            date: d(rng, dayOf(s, week, day)),
            session: runSession(rng, day === 5 ? "long" : day === 1 ? "quality" : "easy", pick(rng, [35, 45, 60, 80])),
          })),
        },
      ];
    },
  },
  {
    key: "extend-plan",
    applies: coached,
    ops: (rng, s) => {
      const first = addDays(s.ctx.firmHorizonEnd, 1);
      const count = int(rng, 2, 4);
      return [
        {
          kind: "extendPlan",
          planId: planRef(rng, planId(s)),
          shapeWeeks: Array.from({ length: count }, (_, i) => ({
            weekStart: d(rng, addDays(first, i * 7)),
            volumeTarget: pick(rng, ["about 4h", "4–5 hours easy", "hold ~250min", "build to 5h"]),
            keySessions: [pick(rng, ["Tue threshold", "Tue 4×6min"]), pick(rng, ["Sat long 90min", "Sat long 2h"])],
          })),
        },
      ];
    },
  },
  {
    key: "wind-down",
    applies: coached,
    ops: (rng, s) => {
      const week = Math.max(0, plannedWeeks(s) - 1);
      const days = [1, 3, 5].slice(0, int(rng, 2, 3));
      return [
        {
          kind: "windDown",
          planId: planRef(rng, planId(s)),
          sessions: days.map((day) => ({
            date: d(rng, dayOf(s, week, day)),
            session: runSession(rng, "easy", pick(rng, [25, 30, 35])),
          })),
        },
      ];
    },
  },
  {
    key: "create-plan",
    applies: (s) => !coached(s),
    ops: (rng, s) => {
      const weeks = plannedWeeks(s);
      const firm: unknown[] = [];
      for (let w = 0; w < Math.min(2, weeks); w++) {
        for (const day of [1, 3, 5]) {
          firm.push({
            date: d(rng, dayOf(s, w, day)),
            session: runSession(rng, day === 5 ? "long" : day === 1 ? "quality" : "easy", pick(rng, [35, 45, 70])),
          });
        }
      }
      return [
        {
          kind: "createPlan",
          discipline: pick(rng, ["run", "lift"]),
          name: pick(rng, ["Autumn base", "Back to it", "Eight weeks to the half"]),
          startDate: d(rng, s.A),
          endDate: d(rng, addDays(s.A, 7 * (weeks + 4) - 1)),
          ...(chance(rng, 0.5) ? { raceDate: chance(rng, 0.5) ? null : d(rng, addDays(s.A, 7 * (weeks + 4) - 1)) } : {}),
          firmSessions: firm,
          shapeWeeks: Array.from({ length: int(rng, 2, 4) }, (_, i) => ({
            weekStart: d(rng, addDays(s.A, (weeks + i) * 7)),
            volumeTarget: "about 3h",
            keySessions: ["Tue tempo"],
          })),
        },
      ];
    },
  },
  {
    key: "add-one-session",
    applies: () => true,
    ops: (rng, s) => {
      const week = int(rng, 0, Math.min(1, plannedWeeks(s) - 1));
      const date = dayOf(s, week, int(rng, 0, 6));
      const kindOf = rng();
      const session =
        kindOf < 0.4
          ? liftSession(rng, pick(rng, [20, 25, 30]))
          : kindOf < 0.7
            ? mobilitySession(rng, pick(rng, [10, 12, 15]))
            : runSession(rng, "easy", pick(rng, [30, 35, 40]));
      return [{ kind: "add", date: d(rng, date), session }];
    },
  },
  {
    key: "mixed-multi-op",
    applies: (s) => liveRows(s).length >= 3,
    ops: (rng, s) => {
      const ops: unknown[] = [];
      const target = int(rng, 4, 15);
      const rows = shuffled(rng, liveRows(s).filter((r) => r.category !== "race"));
      let ri = 0;
      while (ops.length < target) {
        const roll = rng();
        if (roll < 0.3 && rows[ri]) {
          const r = rows[ri++]!;
          ops.push({ kind: "ease", workoutId: id(rng, r.id), session: easedVersion(rng, r) });
        } else if (roll < 0.45 && rows[ri]) {
          const r = rows[ri++]!;
          ops.push({ kind: "skip", workoutId: id(rng, r.id), reason: "swapped out for the strength piece" });
        } else if (roll < 0.6 && rows[ri]) {
          const r = rows[ri++]!;
          const to = addDays(r.date, 1);
          if (to <= s.ctx.firmHorizonEnd) ops.push({ kind: "move", workoutId: id(rng, r.id), toDate: d(rng, to) });
        } else {
          const week = int(rng, 0, Math.min(1, plannedWeeks(s) - 1));
          const date = dayOf(s, week, int(rng, 0, 6));
          ops.push({
            kind: "add",
            date: d(rng, date),
            session: chance(rng, 0.5) ? mobilitySession(rng, 12) : liftSession(rng, pick(rng, [25, 30])),
          });
        }
        if (ri >= rows.length && ops.length >= 4) break;
      }
      return ops.slice(0, 15);
    },
  },
];

/* ---------------------------------------------------------- register B --- */

/**
 * ONE model-natural variation, applied to an otherwise clean plan.
 *
 * Every entry here is a plan a good coach would defend in a sentence and a
 * model emits without hesitating — a word the enum happens not to carry, a list
 * one longer than the cap, an empty array meaning "none", a stray key holding a
 * thought the schema has no slot for. None of them is a careless plan; each is
 * a *legitimate plan written in a shape the schema refuses*, which is precisely
 * the thing worth counting.
 *
 * They are applied to a stated fraction of samples so the reader can reweight:
 * the report gives the survival rate for register A and register B separately,
 * never only the blend.
 */
export interface VariationCtx {
  /**
   * Ids the RENDERED DOSSIER offers as `[wo:...]` handles and `validateOps`
   * will refuse — already resolved, or dated before today (see
   * `dossierHandles`). Scraped from the dossier rather than taken from the
   * fixture on purpose: a coach only names what it was shown, so a mistake the
   * context no longer invites is one the generator must no longer be able to
   * make. Empty list ⇒ the variation below cannot fire at all.
   */
  leakedIds: string[];
  /** The athlete's imported COROS plan id, if they have one. */
  importedPlanId?: string;
  weekStart: string;
  today: string;
}

export interface Variation {
  key: string;
  /** Why a coach would write it this way. */
  why: string;
  apply: (rng: Rng, ops: unknown[], env: Record<string, unknown>, c: VariationCtx) => boolean;
}

type Obj = Record<string, unknown>;
const sessionsIn = (ops: unknown[]): Obj[] => {
  const out: Obj[] = [];
  for (const op of ops as Obj[]) {
    if (op.session) out.push(op.session as Obj);
    for (const s of (op.sessions ?? op.firmSessions ?? []) as Obj[]) out.push(s.session as Obj);
  }
  return out;
};
const exercisesIn = (ops: unknown[]): Obj[] =>
  sessionsIn(ops).flatMap((s) => ((s.lift ?? s.mobility) as Obj | undefined)?.exercises as Obj[] ?? []);
const firstAdd = (ops: unknown[]): Obj | undefined => (ops as Obj[]).find((o) => o.kind === "add");

export const REGISTER_B: Variation[] = [
  {
    key: "category: mobility",
    why: `"mobility" is what the whole app calls this work; the enum carries "yoga" and "recovery" and not the word the coach uses`,
    apply: (_r, ops) => {
      const s = sessionsIn(ops).find((x) => x.mobility);
      if (!s) return false;
      s.category = "mobility";
      return true;
    },
  },
  {
    key: "intensity: tempo",
    why: `"tempo" is the most-used word in running for the effort the enum calls "threshold"`,
    apply: (_r, ops) => {
      const s = sessionsIn(ops).find((x) => x.run);
      if (!s) return false;
      const blocks = (s.run as Obj).blocks as Obj[];
      blocks[blocks.length - 1]!.intensity = "tempo";
      return true;
    },
  },
  {
    key: "session.notes",
    why: "a coaching cue that belongs to the session rather than one exercise, and there is nowhere else to put it",
    apply: (_r, ops) => {
      const s = sessionsIn(ops)[0];
      if (!s) return false;
      s.notes = "keep it conversational throughout";
      return true;
    },
  },
  {
    key: "exercise.tempo",
    why: "a tempo prescription written as a string, the way every strength coach writes it",
    apply: (_r, ops) => {
      const e = exercisesIn(ops)[0];
      if (!e) return false;
      e.tempo = "3-1-1";
      return true;
    },
  },
  {
    key: "op.rationale",
    why: "the reason for THIS op, where the schema only has one rationale for the whole proposal",
    apply: (_r, ops) => {
      const op = ops[0] as Obj | undefined;
      if (!op) return false;
      op.rationale = "this is the piece that protects the knee on the descents";
      return true;
    },
  },
  {
    key: "dates: []",
    why: `an empty list is how a model says "no extra dates" — the same thing as omitting the field`,
    apply: (_r, ops) => {
      const a = firstAdd(ops);
      if (!a) return false;
      a.dates = [];
      return true;
    },
  },
  {
    key: "exercises: []",
    why: `"strength session, we'll pick the movements on the day" — a real prescription, and the duration is the load`,
    apply: (_r, ops) => {
      const s = sessionsIn(ops).find((x) => x.lift);
      if (!s) return false;
      (s.lift as Obj).exercises = [];
      return true;
    },
  },
  {
    key: "exercise with no reps or hold",
    why: `"3 sets of ramping squats, stop when it gets heavy" — the set count is the prescription`,
    apply: (_r, ops) => {
      const e = exercisesIn(ops)[0];
      if (!e) return false;
      delete e.reps;
      delete e.holdSeconds;
      return true;
    },
  },
  {
    key: "dates longer than 14",
    why: "three weeks of a daily ten-minute piece — one session, twenty-one days, and MAX_ADD_DATES is 14",
    apply: (rng, ops) => {
      const a = firstAdd(ops);
      if (!a) return false;
      const start = String(a.date).slice(0, 10);
      a.dates = Array.from({ length: 20 }, (_, i) => addDays(start, i + 1));
      return true;
    },
  },
  {
    key: "run with more than 12 blocks",
    why: "12×400m off 60s, written honestly as its blocks — a session every intermediate runner does",
    apply: (_r, ops) => {
      const s = sessionsIn(ops).find((x) => x.run);
      if (!s) return false;
      (s.run as Obj).blocks = [
        { kind: "duration", value: 15, intensity: "easy" },
        ...Array.from({ length: 24 }, (_, i) => ({
          kind: "duration",
          value: i % 2 === 0 ? 2 : 1,
          intensity: i % 2 === 0 ? "interval" : "easy",
        })),
        { kind: "duration", value: 10, intensity: "easy" },
      ];
      return true;
    },
  },
  {
    key: "more than 12 exercises",
    why: "a full-body circuit is fourteen stations; the block caps at twelve",
    apply: (rng, ops) => {
      const s = sessionsIn(ops).find((x) => x.lift ?? x.mobility);
      if (!s) return false;
      const block = (s.lift ?? s.mobility) as Obj;
      const names = shuffled(rng, [...LIFTS, ...HOLDS, ...MOBILITY]).slice(0, 14);
      block.exercises = names.map((nm) => rawExercise(rng, nm, "reps"));
      return true;
    },
  },
  {
    key: "rest day with zero minutes",
    why: "a rest day is zero minutes long; the session schema's floor is five",
    apply: (rng, ops) => {
      const a = firstAdd(ops);
      if (!a) return false;
      a.session = { category: "rest", title: "Full rest", durationMinutes: 0 };
      return true;
    },
  },
  {
    key: "a 6-hour long run",
    why: "an ultra athlete's weekend long run, past the 360-minute session ceiling",
    apply: (rng, ops) => {
      const a = firstAdd(ops);
      if (!a) return false;
      a.session = runSession(rng, "long", 380);
      return true;
    },
  },
  {
    key: "12 sets",
    why: "EMOM twelve rounds of three; the set cap is ten",
    apply: (rng, ops) => {
      const e = exercisesIn(ops)[0];
      if (!e) return false;
      e.sets = 12;
      e.reps = 3;
      delete e.holdSeconds;
      return true;
    },
  },
  {
    key: "5 key sessions in a shape week",
    why: "naming the week's five sessions, where the shape carries four",
    apply: (_r, ops) => {
      const op = (ops as Obj[]).find((o) => o.kind === "extendPlan" || o.kind === "createPlan");
      if (!op) return false;
      const weeks = op.shapeWeeks as Obj[];
      if (!weeks?.length) return false;
      weeks[0]!.keySessions = ["Tue threshold", "Thu hills", "Sat long", "Sun easy", "Mon lift"];
      return true;
    },
  },
  {
    key: "expiresAt as a full timestamp",
    why: `the prompt asks for "end of the first affected day", which is a time, not a date`,
    apply: (_r, _ops, env) => {
      const p = (env.proposals as Obj[])[0]!;
      p.expiresAt = `${String(p.expiresAt).slice(0, 10)}T23:59:59.000Z`;
      return true;
    },
  },
  {
    key: "reps as a range",
    why: `"8–12 reps" is how every strength programme is written`,
    apply: (_r, ops) => {
      const e = exercisesIn(ops).find((x) => x.reps !== undefined);
      if (!e) return false;
      e.reps = "8-12";
      return true;
    },
  },
  {
    key: "weight in words",
    why: `"heavy" is a real prescription when the athlete's 5RM isn't known`,
    apply: (_r, ops) => {
      const e = exercisesIn(ops)[0];
      if (!e) return false;
      e.weight = "heavy";
      return true;
    },
  },
  // ── references the coach gets wrong ──────────────────────────────────
  // Not shapes: mistakes about WHICH row or WHICH plan. Each is fatal, and each
  // is here so the ranked list carries real counts for the fatal rules rather
  // than only the probe matrix's ones. They divide into two kinds, and the
  // division is the whole point of keeping them side by side:
  //
  //  · one the CONTEXT invited — the coach copied a handle the dossier printed
  //    beside a session it may not touch. Its target comes from the rendered
  //    dossier, so fixing the dossier removes the mistake at the source.
  //  · three the context did not — a mangled id, a plan id the dossier never
  //    printed at all, a date before the dossier's own header date. Nothing the
  //    dossier can say prevents these, so they stay, and they stay fatal.
  {
    key: "ref: ease a completed session",
    why: "the dossier printed a [wo:...] handle beside a session that is already resolved, so the coach cannot tell it from an upcoming one",
    apply: (rng, ops, _env, c) => {
      const done = c.leakedIds[0];
      if (!done) return false;
      ops.splice(0, ops.length, { kind: "ease", workoutId: done, session: runSession(rng, "recovery", 25) });
      return true;
    },
  },
  {
    key: "ref: a workout id that has gone",
    why: "the id was on the calendar when the athlete asked and the plan re-imported mid-wake",
    apply: (rng, ops) => {
      const target = (ops as Obj[]).find((o) => typeof o.workoutId === "string");
      if (!target) return false;
      target.workoutId = `${String(target.workoutId).replace(/[[\]]|^wo:/g, "")}x`;
      return true;
    },
  },
  {
    key: "ref: restructure the imported plan",
    why: "the athlete asked to restructure the week and the only plan they have came off the watch",
    apply: (rng, ops, _env, c) => {
      const imported = c.importedPlanId;
      if (!imported) return false;
      ops.splice(0, ops.length, {
        kind: "reshapeWeek",
        planId: imported,
        weekStart: c.weekStart,
        sessions: [1, 3, 5].map((day) => ({
          date: addDays(c.weekStart, day),
          session: runSession(rng, day === 5 ? "long" : "easy", pick(rng, [35, 45, 75])),
        })),
      });
      return true;
    },
  },
  {
    key: "ref: dated yesterday",
    why: "a wake that started before midnight and finished after it",
    apply: (_r, ops, _env, c) => {
      const a = firstAdd(ops);
      if (!a) return false;
      a.date = addDays(c.today, -1);
      delete a.dates;
      return true;
    },
  },
];

/** One whole wake output, the way the model emits it. */
export function wakeEnvelope(rng: Rng, ops: unknown[], expiresAt: string): unknown {
  return {
    briefing: "Here's the week as I'd shape it.",
    proposals: [
      {
        title: pick(rng, ["Ski-prep strength block", "Ease this week", "Reshape the build", "Daily mobility"]),
        evidence: "Two easy weeks and a trip on the calendar.",
        rationale: "Enough loading to matter, spaced so nothing lands on top of a hard day.",
        expiresAt,
        flags: [],
        ops,
      },
    ],
    question: null,
    memoryOps: [],
    focus: "Strength twice, running unchanged.",
    ...(chance(rng, 0.3) ? { raceLine: null } : {}),
  };
}
