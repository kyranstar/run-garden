import { useState } from "react";
import type { CoachPlanDto, PlanProgression, ProgramDto, ProgramsResponse } from "@rg/api-client";
import { formatShortDate, type Units } from "../components.js";
import { ProgramSettingsSheet } from "../components/program-settings-sheet.js";

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
 * YOUR PLANS (the new shape §6): one list — programs, running and lifting plans, one-offs — one row each with its kind
 * and its state, each opening its sheet (a program its settings, a plan the plan sheet). Its foot starts something
 * new: a program, or a plan asked of the coach (the words written in the box, the athlete's to send). What a plan is
 * doing — its charts, its weeks, its actions — is one tap down, in the sheet.
 */

const DISCIPLINE_KIND: Record<CoachPlanDto["discipline"], string> = {
  run: "Running",
  lift: "Lifting",
  mobility: "Mobility",
};

/** One row on the list: a program, or a plan (a block or a bucket of one-offs). */
export type PlanEntry = { kind: "program"; program: ProgramDto } | { kind: "plan"; plan: CoachPlanDto };

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);

/** A block's week by the calendar: 0 before it starts, else which of its weeks `today` falls in. */
function blockWeek(plan: CoachPlanDto, today: string): { into: number; total: number } {
  const total = Math.max(1, Math.round(daysBetween(plan.startDate, plan.endDate) / 7));
  if (today < plan.startDate) return { into: 0, total };
  return { into: Math.min(total, Math.floor(daysBetween(plan.startDate, today) / 7) + 1), total };
}

/** What a row says: its kind, and its state in a few plain words. */
export function planRowState(entry: PlanEntry, today: string): { kind: string; state: string } {
  if (entry.kind === "program") {
    const p = entry.program;
    const week = `${p.week.done} of ${p.week.goal} this week`;
    return { kind: "Program", state: p.block ? `Block ${p.block.number} · week ${p.block.week} of ${p.block.weeks} · ${week}` : week };
  }
  const p = entry.plan;
  if (p.kind === "loose") {
    const held = p.holds ?? { sessions: 0, done: 0, firstDate: null, lastDate: null };
    const state =
      held.sessions === 0
        ? "Nothing here yet"
        : `${held.sessions} ${held.sessions === 1 ? "session" : "sessions"}${held.done > 0 ? ` · ${held.done} done` : ""}`;
    return { kind: `${DISCIPLINE_KIND[p.discipline]} one-offs`, state };
  }
  const kind = `${DISCIPLINE_KIND[p.discipline]} plan`;
  if (p.status === "draft") return { kind, state: p.source === "studio" ? "Draft — not on your watch" : "Draft" };
  const { into, total } = blockWeek(p, today);
  if (p.source === "coros") return { kind, state: into === 0 ? `From COROS · starts ${formatShortDate(p.startDate)}` : `From COROS · week ${into} of ${total}` };
  return { kind, state: into === 0 ? `Starts ${formatShortDate(p.startDate)}` : `Week ${into} of ${total} · ends ${formatShortDate(p.endDate)}` };
}

/** The list's order: programs first, then blocks as they happen, then the one-off buckets. */
export function planEntries(plans: readonly CoachPlanDto[], programs: readonly ProgramDto[]): PlanEntry[] {
  const live = plans.filter((p) => p.status === "active" || p.status === "draft");
  return [
    ...programs
      .filter((p) => p.status === "active")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((program): PlanEntry => ({ kind: "program", program })),
    ...live
      .filter((p) => p.kind !== "loose")
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name))
      .map((plan): PlanEntry => ({ kind: "plan", plan })),
    ...live
      .filter((p) => p.kind === "loose")
      .sort((a, b) => a.discipline.localeCompare(b.discipline))
      .map((plan): PlanEntry => ({ kind: "plan", plan })),
  ];
}

/**
 * What "Plan with the coach" sends the THREAD coach (the integrated review, I4): its intake, as the plan modal's was —
 * the conversation can't build a whole plan in this wave (§8). Its draft lands on Plan with its other cards.
 */
export const NEW_PLAN_THREAD_REQUEST = "I want a new plan — interview me for what you need.";

export function YourPlans({
  plans,
  programs,
  today,
  onOpenPlan,
  onAskThread,
}: {
  plans: readonly CoachPlanDto[];
  /** `GET /api/programs`: the programs, and the places and profiles their settings pick from (absent: none). */
  programs: ProgramsResponse | undefined;
  today: string;
  onOpenPlan: (id: string) => void;
  /** Send the thread coach a message ("Plan with the coach"); none: it is not offered. */
  onAskThread?: (body: string) => void;
}) {
  const [askedThread, setAskedThread] = useState(false);
  // A program's settings ("new": a new program), opened from its row or the list's foot.
  const [programOpen, setProgramOpen] = useState<string | null>(null);
  const programList = programs?.programs ?? [];
  const editing = programOpen && programOpen !== "new" ? programList.find((p) => p.id === programOpen) : undefined;
  const entries = planEntries(plans, programList);
  return (
    <section className="your-plans" aria-labelledby="your-plans-h">
      <h2 id="your-plans-h" className="your-plans-h">
        Your plans
      </h2>
      {entries.length > 0 ? (
        <ul className="plan-rows">
          {entries.map((e) => {
            const id = e.kind === "program" ? e.program.id : e.plan.id;
            const name = e.kind === "program" ? e.program.name : e.plan.name;
            const { kind, state } = planRowState(e, today);
            return (
              <li key={`${e.kind}:${id}`}>
                <button
                  type="button"
                  className="plan-row"
                  aria-haspopup="dialog"
                  onClick={() => (e.kind === "program" ? setProgramOpen(id) : onOpenPlan(id))}
                >
                  <span className="plan-row-name">{name}</span>
                  <span className="plan-row-state">
                    {kind} · {state}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="plan-rows-foot">
        <button type="button" className="btn btn-small" aria-haspopup="dialog" onClick={() => setProgramOpen("new")}>
          New program…
        </button>
        {onAskThread ? (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              onAskThread(NEW_PLAN_THREAD_REQUEST);
              setAskedThread(true);
            }}
          >
            Plan with the coach
          </button>
        ) : null}
      </div>
      {askedThread ? (
        <p className="plan-asked" role="status">
          Asked your coach. Its suggestion will appear on Plan.
        </p>
      ) : null}
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
