import { addDays } from "./time.js";
import type { CoachOp, CoachSession } from "./coach.js";

/**
 * The hard floor outside the model (spec §4): pure, exhaustive, unit-tested.
 * Hard violations reject a proposal (after one repair round-trip); soft
 * violations are FLAGS the proposal must carry — the wake pipeline unions
 * these with whatever the model volunteered, so the "breaks your rule" chip
 * can never be forgotten.
 */

export interface GuardrailWorkout {
  id: string;
  date: string;
  category: string;
  completionState: string;
  durationMinutes: number;
  discipline: "run" | "strength" | "yoga";
}

export interface SoftRule {
  id: string;
  /** anchor_day: category must stay on weekday; fixed_slot: same test. */
  kind: "anchor_day" | "fixed_slot";
  category: string;
  /** ISO weekday 1 (Mon) .. 7 (Sun). */
  weekday: number;
}

export interface GuardrailCtx {
  today: string;
  workouts: GuardrailWorkout[];
  /** Trailing 4 completed weeks of training minutes, oldest first. */
  weeklyMinutesByDiscipline: Record<string, number[]>;
  raceDates: string[];
  /** Latest firm-detail date across active coached plans. */
  firmHorizonEnd: string;
  rules: SoftRule[];
  /**
   * Every plan id the coach authored (any status). Structural ops
   * (reshape/firmUp/extend/windDown/retire) may only touch these — imported
   * COROS plans are structurally read-only, though their individual sessions
   * remain fair game for ease/move/skip.
   */
  coachPlanIds: string[];
}

export interface Violation {
  rule: string;
  opIndex: number;
  detail: string;
}

const HARD_CATEGORIES = new Set(["quality", "long", "race"]);
/** Strength counts as a hard day only at meaningful volume (no per-lift
 * intensity signal exists yet). */
const HARD_LIFT_MINUTES = 60;

const RAMP_CAP = 1.1;
const RACE_WINDOW_DAYS = 7;

interface CalEntry {
  date: string;
  category: string;
  durationMinutes: number;
  discipline: string;
  /** Introduced or rewritten by these ops (drives race-week "new intensity"). */
  fromOp: number | null;
}

function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function mondayOf(date: string): string {
  return addDays(date, -(isoWeekday(date) - 1));
}

function disciplineOfSession(s: CoachSession): "run" | "strength" {
  return s.lift ? "strength" : "run";
}

function isHard(e: { category: string; durationMinutes: number; discipline: string }): boolean {
  if (HARD_CATEGORIES.has(e.category)) return true;
  return e.discipline === "strength" && e.durationMinutes >= HARD_LIFT_MINUTES;
}

/** Apply ops to the known calendar, tracking which entries ops introduced. */
function resultingCalendar(ops: CoachOp[], ctx: GuardrailCtx): CalEntry[] {
  const cal: CalEntry[] = ctx.workouts
    .filter((w) => !["skipped", "missed"].includes(w.completionState))
    .map((w) => ({
      date: w.date,
      category: w.category,
      durationMinutes: w.durationMinutes,
      discipline: w.discipline,
      fromOp: null,
    }));
  const byId = new Map(ctx.workouts.map((w) => [w.id, w]));
  const entryFor = (id: string): CalEntry | undefined => {
    const w = byId.get(id);
    return w ? cal.find((e) => e.date === w.date && e.category === w.category && e.fromOp === null) : undefined;
  };

  ops.forEach((op, i) => {
    switch (op.kind) {
      case "ease": {
        const e = entryFor(op.workoutId);
        if (e) {
          e.category = op.session.category;
          e.durationMinutes = op.session.durationMinutes;
          e.discipline = disciplineOfSession(op.session);
          e.fromOp = i;
        }
        break;
      }
      case "move": {
        const e = entryFor(op.workoutId);
        if (e) {
          e.date = op.toDate;
          e.fromOp = i;
        }
        break;
      }
      case "swap": {
        for (const e of cal) {
          if (e.date === op.dayA) {
            e.date = op.dayB;
            e.fromOp = i;
          } else if (e.date === op.dayB) {
            e.date = op.dayA;
            e.fromOp = i;
          }
        }
        break;
      }
      case "skip": {
        const w = byId.get(op.workoutId);
        if (w) {
          const idx = cal.findIndex((e) => e.date === w.date && e.category === w.category);
          if (idx >= 0) cal.splice(idx, 1);
        }
        break;
      }
      case "add":
        cal.push({
          date: op.date,
          category: op.session.category,
          durationMinutes: op.session.durationMinutes,
          discipline: disciplineOfSession(op.session),
          fromOp: i,
        });
        break;
      case "reshapeWeek":
      case "firmUp":
      case "windDown":
        for (const s of op.sessions) {
          cal.push({
            date: s.date,
            category: s.session.category,
            durationMinutes: s.session.durationMinutes,
            discipline: disciplineOfSession(s.session),
            fromOp: i,
          });
        }
        break;
      case "createPlan":
        for (const s of op.firmSessions) {
          cal.push({
            date: s.date,
            category: s.session.category,
            durationMinutes: s.session.durationMinutes,
            discipline: disciplineOfSession(s.session),
            fromOp: i,
          });
        }
        break;
      case "extendPlan":
      case "retirePlan":
      // Demoting a mislabeled race row (or moving the race-day setting)
      // reshapes no training day, so the load calendar is untouched.
      case "resolveRaceConflict":
        break;
    }
  });
  return cal;
}

/** Dates an op edits directly (for horizon + touch checks). */
function opDates(op: CoachOp, ctx: GuardrailCtx): string[] {
  const byId = new Map(ctx.workouts.map((w) => [w.id, w]));
  switch (op.kind) {
    case "ease":
    case "skip":
      return byId.has(op.workoutId) ? [byId.get(op.workoutId)!.date] : [];
    case "move":
      return byId.has(op.workoutId) ? [byId.get(op.workoutId)!.date, op.toDate] : [op.toDate];
    case "swap":
      return [op.dayA, op.dayB];
    case "add":
      return [op.date];
    case "reshapeWeek":
    case "firmUp":
    case "windDown":
      return op.sessions.map((s) => s.date);
    case "createPlan":
      return op.firmSessions.map((s) => s.date);
    case "extendPlan":
    case "retirePlan":
    case "resolveRaceConflict":
      return [];
  }
}

const HORIZON_EXEMPT = new Set([
  "firmUp",
  "extendPlan",
  "reshapeWeek",
  "createPlan",
  "windDown",
  "retirePlan",
  "resolveRaceConflict",
]);

export function validateOps(
  ops: CoachOp[],
  ctx: GuardrailCtx,
): { hard: Violation[]; soft: Violation[] } {
  const hard: Violation[] = [];
  const soft: Violation[] = [];
  const byId = new Map(ctx.workouts.map((w) => [w.id, w]));

  // H3 / H6 / H4 — per-op checks.
  ops.forEach((op, i) => {
    const targeted =
      op.kind === "ease" || op.kind === "move" || op.kind === "skip" ? byId.get(op.workoutId) : undefined;
    if (targeted) {
      if (targeted.completionState !== "scheduled" && targeted.completionState !== "planned") {
        hard.push({ rule: "touch_resolved", opIndex: i, detail: `${op.kind} targets ${targeted.completionState} workout` });
      } else if (targeted.date <= ctx.today && targeted.date < ctx.today) {
        hard.push({ rule: "touch_resolved", opIndex: i, detail: `${op.kind} targets a past day` });
      }
      if (op.kind === "skip" && targeted.category === "race") {
        hard.push({ rule: "never_skip_race", opIndex: i, detail: "races are never skipped" });
      }
    }
    // H7 — structural ops on plans the coach did not author. Imported COROS
    // plans can have sessions skipped/moved, never their structure rewritten.
    if (
      (op.kind === "reshapeWeek" ||
        op.kind === "firmUp" ||
        op.kind === "extendPlan" ||
        op.kind === "windDown" ||
        op.kind === "retirePlan") &&
      !ctx.coachPlanIds.includes(op.planId)
    ) {
      hard.push({
        rule: "imported_plan_structure",
        opIndex: i,
        detail: `${op.kind} targets plan ${op.planId}, which the coach did not author — imported plans are structurally read-only`,
      });
    }
    if (!HORIZON_EXEMPT.has(op.kind)) {
      for (const d of opDates(op, ctx)) {
        if (d > ctx.firmHorizonEnd) {
          hard.push({ rule: "beyond_horizon", opIndex: i, detail: `${d} is past firm detail (${ctx.firmHorizonEnd})` });
          break;
        }
      }
    }
  });

  const cal = resultingCalendar(ops, ctx);

  // H2 — hard sessions on consecutive days (in the resulting calendar,
  // counting only pairs where at least one side was op-touched: pre-existing
  // adjacency is the plan's business, not this proposal's).
  const hardDays = new Map<string, CalEntry[]>();
  for (const e of cal) {
    if (isHard(e)) hardDays.set(e.date, [...(hardDays.get(e.date) ?? []), e]);
  }
  for (const [date, entries] of hardDays) {
    const next = hardDays.get(addDays(date, 1));
    if (!next) continue;
    const touched = [...entries, ...next].some((e) => e.fromOp !== null);
    if (touched) {
      const opIndex = [...entries, ...next].find((e) => e.fromOp !== null)!.fromOp!;
      hard.push({ rule: "hard_adjacency", opIndex, detail: `hard sessions on ${date} and the next day` });
    }
  }

  // H1 — ramp: any op-touched week's projected minutes vs trailing average.
  const touchedWeeks = new Set(cal.filter((e) => e.fromOp !== null).map((e) => mondayOf(e.date)));
  for (const week of touchedWeeks) {
    const weekEnd = addDays(week, 6);
    const perDiscipline = new Map<string, number>();
    for (const e of cal) {
      if (e.date >= week && e.date <= weekEnd && e.category !== "rest") {
        perDiscipline.set(e.discipline, (perDiscipline.get(e.discipline) ?? 0) + e.durationMinutes);
      }
    }
    for (const [disc, minutes] of perDiscipline) {
      const trailing = ctx.weeklyMinutesByDiscipline[disc];
      if (!trailing || trailing.length === 0) continue;
      const avg = trailing.reduce((a, b) => a + b, 0) / trailing.length;
      if (avg > 0 && minutes > avg * RAMP_CAP) {
        const opIndex = cal.find((e) => e.fromOp !== null && mondayOf(e.date) === week)!.fromOp!;
        hard.push({
          rule: "ramp",
          opIndex,
          detail: `${disc} week of ${week}: ${Math.round(minutes)}min > ${Math.round(avg * RAMP_CAP)}min cap`,
        });
      }
    }
  }

  // H5 — op-introduced intensity inside a race window.
  for (const race of ctx.raceDates) {
    const from = addDays(race, -RACE_WINDOW_DAYS);
    for (const e of cal) {
      if (e.fromOp === null) continue;
      if (e.date >= from && e.date < race && e.category === "quality") {
        hard.push({ rule: "race_week_intensity", opIndex: e.fromOp, detail: `quality on ${e.date}, race ${race}` });
      }
    }
  }

  // Soft — structured standing rules on op-touched entries.
  for (const rule of ctx.rules) {
    for (const e of cal) {
      if (e.fromOp === null) continue;
      if (e.category === rule.category && isoWeekday(e.date) !== rule.weekday) {
        soft.push({ rule: rule.id, opIndex: e.fromOp, detail: `${e.category} lands on weekday ${isoWeekday(e.date)}, rule wants ${rule.weekday}` });
      }
    }
  }

  return { hard, soft };
}
