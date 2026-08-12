import type { LiftingPlan } from "@rg/domain";

/**
 * Deterministic progression extractors (rework spec §4): the numbers a plan
 * PRESCRIBES, graphed honestly. Lifting completion data carries no actual
 * bar weights (COROS sends none), so lift series are the prescription with
 * completed sessions marked; running series carry planned values with an
 * actual-seconds overlay where matches exist.
 */

export interface PlanProgressionPoint {
  week: number; // 1-based
  value: number;
  done?: boolean;
  /** Actual observed value for the week, same unit as `value`, when known. */
  actual?: number;
}

export interface PlanProgression {
  key: string;
  label: string;
  unit: string;
  from: number;
  to: number;
  now: number | null;
  series: PlanProgressionPoint[];
}

const METERS_PER_MILE = 1609.34;

/** Top-N lifts by appearance, each as top-set weight by week; plus weekly
 * total sets. Bodyweight entries carry no load and are excluded from weight
 * series (they still count toward sets). */
/** The headline's second number is the plan's PEAK, not its final week — a
 * block that deloads into its finish otherwise understates itself
 * ("12 → 16 kg" for a wave that tops at 20; user nit, 2026-08-12). */
function peak(series: PlanProgressionPoint[]): number {
  return Math.max(...series.map((p) => p.value));
}

export function liftProgressions(
  plan: Pick<LiftingPlan, "weeks">,
  doneWeeks: Set<number>,
  currentWeek: number | null,
  topN = 3,
): PlanProgression[] {
  const byOrigin = new Map<string, { name: string; count: number; weekMax: Map<number, number> }>();
  const setsByWeek = new Map<number, number>();

  plan.weeks.forEach((week, i) => {
    const weekNo = i + 1;
    for (const session of week.sessions) {
      for (const ex of session.exercises) {
        setsByWeek.set(weekNo, (setsByWeek.get(weekNo) ?? 0) + ex.sets);
        const entry = byOrigin.get(ex.originId) ?? { name: ex.name, count: 0, weekMax: new Map() };
        entry.count += 1;
        if (ex.weight.type === "kg") {
          entry.weekMax.set(weekNo, Math.max(entry.weekMax.get(weekNo) ?? 0, ex.weight.value));
        }
        byOrigin.set(ex.originId, entry);
      }
    }
  });

  const out: PlanProgression[] = [];
  const ranked = [...byOrigin.entries()]
    .filter(([, e]) => e.weekMax.size >= 2) // a progression needs at least two loaded weeks
    // A flat line is not a progression — "34 → 34 sets" earned a user
    // complaint. Only series that actually go somewhere get graphed.
    .filter(([, e]) => new Set(e.weekMax.values()).size > 1)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, topN);
  for (const [originId, e] of ranked) {
    const series: PlanProgressionPoint[] = [...e.weekMax.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([week, value]) => ({ week, value, ...(doneWeeks.has(week) ? { done: true } : {}) }));
    const from = series[0]!.value;
    const to = peak(series);
    const nowPoint =
      currentWeek === null ? null : [...series].reverse().find((p) => p.week <= currentWeek) ?? null;
    out.push({
      key: `lift:${originId}`,
      label: e.name,
      unit: "kg",
      from,
      to,
      now: nowPoint?.value ?? null,
      series,
    });
  }

  if (setsByWeek.size >= 2 && new Set(setsByWeek.values()).size > 1) {
    const series: PlanProgressionPoint[] = [...setsByWeek.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([week, value]) => ({ week, value, ...(doneWeeks.has(week) ? { done: true } : {}) }));
    out.push({
      key: "lift:weekly-sets",
      label: "Weekly sets",
      unit: "sets",
      from: series[0]!.value,
      to: peak(series),
      now:
        currentWeek === null
          ? null
          : ([...series].reverse().find((p) => p.week <= currentWeek)?.value ?? null),
      series,
    });
  }
  return out;
}

export interface RunWeekFacts {
  week: number; // 1-based
  /** max planned expectedDistanceMeters among the week's workouts, if any */
  longRunMeters: number | null;
  /** summed planned seconds (non-rest) */
  plannedSeconds: number;
  /** summed matched-activity seconds, when any completion matched */
  actualSeconds: number | null;
  done: boolean;
}

/** Long-run distance and weekly planned minutes by week, actuals overlaid. */
export function runProgressions(weeks: RunWeekFacts[], currentWeek: number | null): PlanProgression[] {
  const out: PlanProgression[] = [];
  const withLong = weeks.filter((w) => w.longRunMeters !== null && w.longRunMeters > 0);
  if (withLong.length >= 2 && new Set(withLong.map((w) => w.longRunMeters)).size > 1) {
    const series: PlanProgressionPoint[] = withLong.map((w) => ({
      week: w.week,
      value: Math.round((w.longRunMeters! / METERS_PER_MILE) * 10) / 10,
      ...(w.done ? { done: true } : {}),
    }));
    out.push({
      key: "run:long-run",
      label: "Long run",
      unit: "mi",
      from: series[0]!.value,
      to: peak(series),
      now:
        currentWeek === null
          ? null
          : ([...series].reverse().find((p) => p.week <= currentWeek)?.value ?? null),
      series,
    });
  }
  const withTime = weeks.filter((w) => w.plannedSeconds > 0);
  if (withTime.length >= 2 && new Set(withTime.map((w) => w.plannedSeconds)).size > 1) {
    const series: PlanProgressionPoint[] = withTime.map((w) => ({
      week: w.week,
      value: Math.round(w.plannedSeconds / 60),
      ...(w.done ? { done: true } : {}),
      ...(w.actualSeconds !== null ? { actual: Math.round(w.actualSeconds / 60) } : {}),
    }));
    out.push({
      key: "run:weekly-minutes",
      label: "Weekly time",
      unit: "min",
      from: series[0]!.value,
      to: peak(series),
      now:
        currentWeek === null
          ? null
          : ([...series].reverse().find((p) => p.week <= currentWeek)?.value ?? null),
      series,
    });
  }
  return out;
}

/** "bench 125, squat 175 · 44 sets" — the weeks-list one-liner for a studio week. */
export function liftWeekSummary(plan: LiftingPlan, weekIndex1: number): string {
  const week = plan.weeks[weekIndex1 - 1];
  if (!week) return "";
  const heaviest = new Map<string, number>();
  let sets = 0;
  for (const s of week.sessions) {
    for (const ex of s.exercises) {
      sets += ex.sets;
      if (ex.weight.type === "kg") {
        heaviest.set(ex.name, Math.max(heaviest.get(ex.name) ?? 0, ex.weight.value));
      }
    }
  }
  const top = [...heaviest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const lifts = top.map(([name, kg]) => `${name.toLowerCase()} ${kg}kg`).join(", ");
  return [lifts, `${sets} sets`].filter(Boolean).join(" · ");
}
