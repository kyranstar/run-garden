import { useState } from "react";
import type { CoachPlanDto, PlanProgression, ProgramDto, ProgramsResponse, TrainingLineDto } from "@rg/api-client";
import { planEnded } from "@rg/domain";
import { formatShortDate, type Units } from "../components.js";
import { ProgramSettingsSheet } from "../components/program-settings-sheet.js";
import { useCoach } from "./studio/coach-ask.js";

const KM_PER_MI = 1.609344;

/** "10.9" from 6.8 mi shown in km — one decimal, trailing .0 dropped. */
function convertedValue(v: number, from: "km" | "mi", to: Units): string {
  const converted = from === to ? v : from === "mi" ? v * KM_PER_MI : v / KM_PER_MI;
  const rounded = converted.toFixed(1);
  return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}

/**
 * The progression's one-line summary, in the user's display units. A
 * progression carries its OWN unit from the worker ("mi" for a plan written
 * in miles) — when that unit is a distance and disagrees with the display
 * preference, the values convert; non-distance units (kg, min, reps) pass
 * through untouched.
 */
export function progressionHeadline(p: PlanProgression, units: Units): string {
  if ((p.unit === "km" || p.unit === "mi") && p.unit !== units) {
    const from = convertedValue(p.from, p.unit, units);
    const to = convertedValue(p.to, p.unit, units);
    const now = p.now !== null && p.now !== p.to ? ` · now ${convertedValue(p.now, p.unit, units)}` : "";
    return `${p.label} ${from} → ${to} ${units}${now}`;
  }
  const now = p.now !== null && p.now !== p.to ? ` · now ${p.now}` : "";
  return `${p.label} ${p.from} → ${p.to} ${p.unit}${now}`;
}

/**
 * YOUR PLANS (the new shape §6): one list — programs, training lines, Studio and COROS plans — one row each with its kind
 * and its state, each opening its sheet (a program its settings, a line or plan its sheet). Its foot starts something
 * new: a program, or a plan asked of the coach (the words written in the box, the athlete's to send). What a plan is
 * doing — its charts, its weeks, its actions — is one tap down, in the sheet.
 */

const DISCIPLINE_KIND: Record<CoachPlanDto["discipline"], string> = {
  run: "Running",
  lift: "Lifting",
  mobility: "Mobility",
};

/** One row on the list: a program, a training line (a chain of the coach's blocks), or a Studio / COROS plan. */
export type PlanEntry =
  | { kind: "program"; program: ProgramDto }
  | { kind: "line"; line: TrainingLineDto }
  | { kind: "plan"; plan: CoachPlanDto };

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);

/** A block's week by the calendar: 0 before it starts, else which of its weeks `today` falls in. */
function blockWeek(plan: { startDate: string; endDate: string }, today: string): { into: number; total: number } {
  const total = Math.max(1, Math.round(daysBetween(plan.startDate, plan.endDate) / 7));
  if (today < plan.startDate) return { into: 0, total };
  return { into: Math.min(total, Math.floor(daysBetween(plan.startDate, today) / 7) + 1), total };
}

/** A block's state in a few plain words: a plan's row, and a one-phase line's row. */
function blockState(p: { status: CoachPlanDto["status"]; source?: CoachPlanDto["source"]; startDate: string; endDate: string }, today: string): string {
  if (p.status === "draft") return p.source === "studio" ? "Draft — not on your watch" : "Draft";
  const { into, total } = blockWeek(p, today);
  if (p.source === "coros") return into === 0 ? `From COROS · starts ${formatShortDate(p.startDate)}` : `From COROS · week ${into} of ${total}`;
  return into === 0 ? `Starts ${formatShortDate(p.startDate)}` : `Week ${into} of ${total} · ends ${formatShortDate(p.endDate)}`;
}

/** What a row says: its kind, and its state in a few plain words. */
export function planRowState(entry: Exclude<PlanEntry, { kind: "line" }>, today: string): { kind: string; state: string } {
  if (entry.kind === "program") {
    const p = entry.program;
    const week = `${p.week.done} of ${p.week.goal} this week`;
    return { kind: "Program", state: p.block ? `Block ${p.block.number} · week ${p.block.week} of ${p.block.weeks} · ${week}` : week };
  }
  const p = entry.plan;
  return { kind: `${DISCIPLINE_KIND[p.discipline]} plan`, state: blockState(p, today) };
}

/** A line's row: its kind, the phase it is in (a one-phase line reads as a block does), and what it builds toward. */
export function lineRowState(line: TrainingLineDto, today: string): { kind: string; state: string; goal: string | null } {
  const goal = line.goalRaceDate ? `Toward ${formatShortDate(line.goalRaceDate)}` : null;
  const idx = Math.max(0, line.phases.findIndex((p) => p.id === line.currentPhaseId));
  const phase = line.phases[idx]!;
  if (line.phases.length === 1) return { kind: line.name, state: blockState({ ...phase, source: "coach" }, today), goal };
  if (today < line.startDate) return { kind: line.name, state: `Starts ${formatShortDate(line.startDate)}`, goal };
  const { into, total } = blockWeek(phase, today);
  const where = into === 0 ? `starts ${formatShortDate(phase.startDate)}` : `week ${into} of ${total}`;
  return { kind: line.name, state: `Phase ${idx + 1} of ${line.phases.length} · ${phase.name} · ${where}`, goal };
}

const entryStart = (e: PlanEntry): string => (e.kind === "line" ? e.line.startDate : e.kind === "plan" ? e.plan.startDate : "");
const entryEnd = (e: PlanEntry): string => (e.kind === "line" ? e.line.endDate : e.kind === "plan" ? e.plan.endDate : "");
const entryName = (e: PlanEntry): string => (e.kind === "line" ? e.line.name : e.kind === "plan" ? e.plan.name : e.program.name);

/**
 * The list's order. Live: programs first, then lines and Studio / COROS plans as they start. Past: ended lines and
 * plans and completed blocks, the latest end first; retired ones are absent. Blocks a line holds are the line's row,
 * not their own; a payload without `lines` falls back to the coach's blocks as rows.
 */
export function planEntries(
  plans: readonly CoachPlanDto[],
  programs: readonly ProgramDto[],
  lines: readonly TrainingLineDto[] | undefined,
  today: string,
): { live: PlanEntry[]; past: PlanEntry[] } {
  const inLine = new Set((lines ?? []).flatMap((l) => l.phases.map((p) => p.id)));
  const candidates: PlanEntry[] = [
    ...(lines ?? []).map((line): PlanEntry => ({ kind: "line", line })),
    ...plans
      .filter((p) => p.status !== "retired" && !inLine.has(p.id))
      .map((plan): PlanEntry => ({ kind: "plan", plan })),
  ];
  const isPast = (e: PlanEntry): boolean =>
    planEnded(entryEnd(e), today) || (e.kind === "plan" && e.plan.status === "completed");
  const byName = (a: PlanEntry, b: PlanEntry) => entryName(a).localeCompare(entryName(b));
  const live = candidates
    .filter((e) => !isPast(e))
    .sort((a, b) => entryStart(a).localeCompare(entryStart(b)) || byName(a, b));
  const past = candidates
    .filter(isPast)
    .sort((a, b) => entryEnd(b).localeCompare(entryEnd(a)) || byName(a, b));
  return {
    live: [
      ...programs
        .filter((p) => p.status === "active")
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((program): PlanEntry => ({ kind: "program", program })),
      ...live,
    ],
    past,
  };
}

/** The words "Plan with the coach" writes in the conversation's box (§8 §6): the athlete's to send, never sent for them. */
export const NEW_PLAN_REQUEST = "Help me plan my next few weeks";

export function YourPlans({
  plans,
  lines,
  programs,
  today,
  onOpenPlan,
  onOpenLine,
}: {
  plans: readonly CoachPlanDto[];
  /** `GET /api/coach/plans` `lines`: the coach's blocks as training lines (absent in an older payload). */
  lines?: readonly TrainingLineDto[] | undefined;
  /** `GET /api/programs`: the programs, and the places and profiles their settings pick from (absent: none). */
  programs: ProgramsResponse | undefined;
  today: string;
  onOpenPlan: (id: string) => void;
  onOpenLine: (key: string) => void;
}) {
  const coach = useCoach();
  // A program's settings ("new": a new program), opened from its row or the list's foot.
  const [programOpen, setProgramOpen] = useState<string | null>(null);
  const programList = programs?.programs ?? [];
  const editing = programOpen && programOpen !== "new" ? programList.find((p) => p.id === programOpen) : undefined;
  const { live, past } = planEntries(plans, programList, lines, today);
  const row = (e: PlanEntry, isPast: boolean) => {
    const id = e.kind === "program" ? e.program.id : e.kind === "line" ? e.line.key : e.plan.id;
    const name = e.kind === "program" ? e.program.name : e.kind === "line" ? (e.line.phases.find((p) => p.id === e.line.currentPhaseId)?.name ?? e.line.name) : e.plan.name;
    const { kind, state, goal } = e.kind === "line" ? lineRowState(e.line, today) : { ...planRowState(e, today), goal: null };
    const says = isPast && e.kind !== "program" ? `${kind} · ${formatShortDate(entryStart(e))} – ${formatShortDate(entryEnd(e))}` : `${kind} · ${state}`;
    return (
      <li key={`${e.kind}:${id}`}>
        <button
          type="button"
          className="plan-row"
          aria-haspopup="dialog"
          onClick={() => (e.kind === "program" ? setProgramOpen(id) : e.kind === "line" ? onOpenLine(id) : onOpenPlan(id))}
        >
          <span className="plan-row-name">{name}</span>
          <span className="plan-row-state">{says}</span>
          {goal && !isPast ? <span className="plan-row-state plan-row-goal">{goal}</span> : null}
        </button>
      </li>
    );
  };
  return (
    <section className="your-plans" aria-labelledby="your-plans-h">
      <h2 id="your-plans-h" className="your-plans-h">
        Your plans
      </h2>
      {live.length > 0 ? <ul className="plan-rows">{live.map((e) => row(e, false))}</ul> : null}
      {past.length > 0 ? (
        <details className="plan-past">
          <summary>Past plans</summary>
          <ul className="plan-rows">{past.map((e) => row(e, true))}</ul>
        </details>
      ) : null}
      {/* A plan asked of the coach (§8 §6): the conversation opens with the words written, the athlete's to send. */}
      <div className="plan-rows-foot">
        <button type="button" className="btn btn-small" aria-haspopup="dialog" onClick={() => setProgramOpen("new")}>
          New program…
        </button>
        {coach ? (
          <button type="button" className="btn btn-small" onClick={() => coach.open({ request: NEW_PLAN_REQUEST })}>
            Plan with the coach
          </button>
        ) : null}
      </div>
      {programOpen && (programOpen === "new" || editing) ? (
        <ProgramSettingsSheet
          program={editing ?? null}
          places={programs?.places ?? []}
          profiles={programs?.profiles ?? []}
          onClose={() => setProgramOpen(null)}
        />
      ) : null}
    </section>
  );
}
