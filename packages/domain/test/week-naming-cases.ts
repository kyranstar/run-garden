/**
 * The week-naming table (training lines §3.6): ONE table both readers of "which plan names this week" are held to —
 * the Plan screen's week line (`weekPlan`, client) and the week brief (`GET /api/plan/week`, server). Imported by
 * `packages/ui/test/week-plan-line.test.tsx` and `apps/worker/test/plan-routes.test.ts`; not part of the runtime.
 *
 * Dates are offsets from `monday` (the anchor week's Monday, which is also "today" for the lines), so the worker suite
 * can run it against the real clock. Synthetic ids and names only.
 */
import { addDays } from "../src/time.js";

export type NamingPlan = {
  id: string;
  name: string;
  discipline: "run" | "lift" | "mobility";
  status: "draft" | "active" | "completed" | "retired";
  /** Day offsets from the anchor Monday. */
  start: number;
  end: number;
  /** Day offset of the plan's own race, if it has one. */
  race?: number;
  /**
   * Default "coach". "studio" is the Studio's lifting plan (its entry comes from the plan list's reader). "orphan" is
   * no plan at all: sessions filed under an id that is no candidate (a programme's slots, a Studio lift in COROS's
   * container plan), which form no group and are no "+1" on either side.
   */
  source?: "coach" | "studio" | "orphan";
  /** The sport its sessions carry (default: run for a run plan, strength for a lift). */
  sport?: "run" | "strength" | "mobility";
  /** A one-off bucket: no plan of its own. */
  loose?: boolean;
  /** Its sessions in the queried week. */
  sessions: number;
};

export type NamingCase = {
  name: string;
  /** The queried week, in weeks from the anchor. */
  weekOffset: number;
  plans: NamingPlan[];
  /** The plan that names the week (null: none holds it), the other groups ("+N"), and its own week counter. */
  expect: { planId: string | null; others: number; weekOf: [number, number] | null };
};

const P = (id: string, p: Partial<NamingPlan> & Pick<NamingPlan, "start" | "end">): NamingPlan => ({
  id,
  name: `Plan ${id}`,
  discipline: "run",
  status: "active",
  sessions: 0,
  ...p,
});

export const WEEK_NAMING_CASES: NamingCase[] = [
  {
    // A's last day is Wednesday, B starts Thursday: one line, so never "+1"; B has more of the week.
    name: "a boundary week: a line's two phases name one, no +1",
    weekOffset: 0,
    plans: [P("a", { status: "completed", start: -35, end: 2, sessions: 2 }), P("b", { start: 3, end: 27, sessions: 3 })],
    expect: { planId: "b", others: 0, weekOf: [1, 4] },
  },
  {
    name: "a boundary week, the ending phase holding more: it names the week, with its own count",
    weekOffset: 0,
    plans: [P("a", { status: "completed", start: -35, end: 2, sessions: 4 }), P("b", { start: 3, end: 27, sessions: 1 })],
    expect: { planId: "a", others: 0, weekOf: [6, 6] },
  },
  {
    name: "two lines: the one holding more sessions, even when the other has the race",
    weekOffset: 0,
    plans: [
      P("run", { start: -14, end: 20, race: 20, sessions: 2 }),
      P("lift", { discipline: "lift", start: -7, end: 27, sessions: 3 }),
    ],
    expect: { planId: "lift", others: 1, weekOf: [2, 5] },
  },
  {
    name: "two lines tied on sessions: the run line with a race",
    weekOffset: 0,
    plans: [
      P("run", { start: -14, end: 20, race: 20, sessions: 2 }),
      P("lift", { discipline: "lift", start: -35, end: 27, sessions: 2 }),
    ],
    expect: { planId: "run", others: 1, weekOf: [3, 5] },
  },
  {
    name: "two lines tied, neither with a race: the earlier start",
    weekOffset: 0,
    plans: [
      P("run", { start: -14, end: 20, sessions: 2 }),
      P("lift", { discipline: "lift", start: -35, end: 27, sessions: 2 }),
    ],
    expect: { planId: "lift", others: 1, weekOf: [6, 9] },
  },
  {
    name: "a Studio plan beside a line: the Studio plan holding more names the week, and has no counter",
    weekOffset: 0,
    plans: [
      P("run", { start: -7, end: 20, sessions: 2 }),
      P("studio-1", { discipline: "lift", source: "studio", start: -7, end: 20, sessions: 3 }),
    ],
    expect: { planId: "studio-1", others: 1, weekOf: null },
  },
  {
    name: "a Studio plan beside a line: the line holding more names it",
    weekOffset: 0,
    plans: [
      P("run", { start: -7, end: 20, sessions: 4 }),
      P("studio-1", { discipline: "lift", source: "studio", start: -7, end: 20, sessions: 1 }),
    ],
    expect: { planId: "run", others: 1, weekOf: [2, 4] },
  },
  {
    name: "a past week whose phase has ended: the completed phase still names it",
    weekOffset: -3,
    plans: [P("a", { status: "completed", start: -35, end: -15, sessions: 3 }), P("b", { start: -14, end: 13, sessions: 0 })],
    expect: { planId: "a", others: 0, weekOf: [3, 3] },
  },
  {
    name: "phases overlapping in the week, tied: the later start names it",
    weekOffset: 0,
    plans: [P("a", { start: -14, end: 13, sessions: 2 }), P("b", { start: 0, end: 27, sessions: 2 })],
    expect: { planId: "b", others: 0, weekOf: [1, 4] },
  },
  {
    name: "a retired plan and a one-off bucket hold nothing: the line they sit beside names the week alone",
    weekOffset: 0,
    plans: [
      P("run", { start: -7, end: 20, sessions: 1 }),
      P("gone", { discipline: "lift", status: "retired", start: -21, end: 13, sessions: 5 }),
      P("adhoc-lift-1", { discipline: "lift", loose: true, start: 1, end: 1, sessions: 5 }),
    ],
    expect: { planId: "run", others: 0, weekOf: [2, 4] },
  },
  {
    name: "a programme's slots outnumbering the line: they are no plan's, and name nothing",
    weekOffset: 0,
    plans: [
      P("run", { start: -7, end: 20, sessions: 1 }),
      P("prog-0c1f9a2e", { discipline: "lift", sport: "strength", source: "orphan", start: -7, end: 20, sessions: 5 }),
    ],
    expect: { planId: "run", others: 0, weekOf: [2, 4] },
  },
  {
    name: "a Studio-pushed lift in COROS's container plan: the container is no candidate; the Studio plan holds the week with none of it, so the line names it",
    weekOffset: 0,
    plans: [
      P("run", { start: -7, end: 20, sessions: 1 }),
      P("studio-1", { discipline: "lift", source: "studio", start: -7, end: 20, sessions: 0 }),
      P("800000000000001234", { discipline: "lift", sport: "strength", source: "orphan", start: -7, end: 20, sessions: 4 }),
    ],
    expect: { planId: "run", others: 1, weekOf: [2, 4] },
  },
  {
    name: "a tie in sessions between a line and a Studio plan that started earlier: the earlier start, the Studio plan",
    weekOffset: 0,
    plans: [
      P("run", { start: -7, end: 20, sessions: 2 }),
      P("studio-1", { discipline: "lift", source: "studio", start: -35, end: 20, sessions: 2 }),
    ],
    expect: { planId: "studio-1", others: 1, weekOf: null },
  },
  {
    // One week counter (`phaseWeekOf`): ISO weeks from the week its first day falls in — the plan list's row says the same.
    name: "a phase that started on Saturday: the Monday after is its second week, of five",
    weekOffset: 0,
    plans: [P("sat", { start: -2, end: 25, sessions: 2 })],
    expect: { planId: "sat", others: 0, weekOf: [2, 5] },
  },
  {
    name: "no plan holds the week: no name, no counter",
    weekOffset: 10,
    plans: [P("a", { start: -7, end: 20, sessions: 0 })],
    expect: { planId: null, others: 0, weekOf: null },
  },
];

/** A case's plans as dates, given the anchor Monday. */
export function datedPlans(monday: string, c: NamingCase) {
  return c.plans.map((p) => ({
    ...p,
    startDate: addDays(monday, p.start),
    endDate: addDays(monday, p.end),
    raceDate: p.race === undefined ? null : addDays(monday, p.race),
  }));
}
