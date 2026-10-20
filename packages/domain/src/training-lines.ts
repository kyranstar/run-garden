/**
 * Training lines (2026-10-20) — worked out at read time, never stored.
 *
 * Chain rule: a line is a maximal chain of one discipline's coach blocks
 * (retired ones dropped), taken in (startDate, id) order, where each block
 * starts no more than LINE_GAP_DAYS after the running maximum end of the
 * chain so far. Overlapping blocks join too. Callers pass coach blocks
 * only, never the loose `adhoc-` buckets.
 *
 * Naming rule (`weekNaming`): the plan that names a week is the naming phase
 * of the group holding the most sessions that week. A group is a line (all
 * its coach phases holding the week) or one non-coach plan. A tie goes to
 * the run group with a race, then to the earlier start. Inside the main
 * line the phase with the most sessions names the week; a tie goes to the
 * later start. `others` counts the other groups, so phases of one line never
 * read as "+1".
 */
import { addDays, startOfIsoWeek } from "./time.js";

export type LineBlock = {
  id: string;
  discipline: "run" | "lift" | "mobility";
  status: "draft" | "active" | "completed" | "retired";
  name: string;
  startDate: string;
  endDate: string;
  planRaceDate?: string | null;
};

export type TrainingLine = {
  key: string;
  discipline: LineBlock["discipline"];
  name: "Running" | "Lifting" | "Mobility";
  phases: LineBlock[];
  currentPhaseId: string;
  startDate: string;
  endDate: string;
  goalRaceDate: string | null;
  ended: boolean;
};

export const LINE_GAP_DAYS = 7;

const LINE_NAMES = {
  run: "Running",
  lift: "Lifting",
  mobility: "Mobility",
} as const;

const SENTENCE_NAMES = {
  run: "my running plan",
  lift: "my lifting plan",
  mobility: "my mobility plan",
} as const;

export function planEnded(endDate: string, today: string): boolean {
  return endDate < today;
}

export function lineSentenceName(
  discipline: LineBlock["discipline"],
): "my running plan" | "my lifting plan" | "my mobility plan" {
  return SENTENCE_NAMES[discipline];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function makeLine(phases: LineBlock[], today: string): TrainingLine {
  const first = phases[0]!;
  const last = phases[phases.length - 1]!;
  const endDate = phases.reduce((m, p) => (p.endDate > m ? p.endDate : m), first.endDate);
  // Overlapping phases can both cover today: the later-starting one is current.
  const covering = phases.filter((p) => p.startDate <= today && today <= p.endDate);
  const upcoming = phases.filter((p) => p.startDate > today);
  const current = covering.length > 0 ? covering[covering.length - 1]! : (upcoming[0] ?? last);
  const race = last.planRaceDate ?? null;
  return {
    key: `${first.discipline}:${first.id}`,
    discipline: first.discipline,
    name: LINE_NAMES[first.discipline],
    phases,
    currentPhaseId: current.id,
    startDate: first.startDate,
    endDate,
    goalRaceDate: race !== null && race >= today ? race : null,
    ended: planEnded(endDate, today),
  };
}

export function linesOf(blocks: readonly LineBlock[], today: string): TrainingLine[] {
  const sorted = blocks
    .filter((b) => b.status !== "retired")
    .sort((a, b) => cmp(a.startDate, b.startDate) || cmp(a.id, b.id));
  const open = new Map<LineBlock["discipline"], { phases: LineBlock[]; maxEnd: string }>();
  const chains: LineBlock[][] = [];
  for (const b of sorted) {
    const cur = open.get(b.discipline);
    if (cur && b.startDate <= addDays(cur.maxEnd, LINE_GAP_DAYS)) {
      cur.phases.push(b);
      if (b.endDate > cur.maxEnd) cur.maxEnd = b.endDate;
    } else {
      const phases = [b];
      chains.push(phases);
      open.set(b.discipline, { phases, maxEnd: b.endDate });
    }
  }
  return chains.map((c) => makeLine(c, today)).sort((a, b) => cmp(a.startDate, b.startDate));
}

export type WeekPlan = {
  id: string;
  discipline: string;
  startDate: string;
  endDate: string;
  raceDate?: string | null;
  source?: "coach" | "studio" | "coros";
};

type Group = {
  line: TrainingLine | null;
  plans: WeekPlan[];
  sessions: number;
  start: string;
  hasRace: boolean;
};

export function weekNaming(
  plans: readonly WeekPlan[],
  lines: readonly TrainingLine[],
  weekStart: string,
  sessionsByPlan: ReadonlyMap<string, number>,
): { planId: string | null; lineKey: string | null; others: number } {
  const lineOfPlan = new Map<string, TrainingLine>();
  for (const l of lines) for (const p of l.phases) lineOfPlan.set(p.id, l);

  const groups = new Map<string, Group>();
  for (const p of plans) {
    if (!(startOfIsoWeek(p.startDate) <= weekStart && weekStart <= p.endDate)) continue;
    const line = p.source === undefined || p.source === "coach" ? (lineOfPlan.get(p.id) ?? null) : null;
    const gk = line ? `line:${line.key}` : `plan:${p.id}`;
    let g = groups.get(gk);
    if (!g) {
      g = {
        line,
        plans: [],
        sessions: 0,
        start: line ? line.startDate : p.startDate,
        hasRace: line
          ? line.discipline === "run" && line.goalRaceDate !== null
          : p.discipline === "run" && !!p.raceDate,
      };
      groups.set(gk, g);
    }
    g.plans.push(p);
    g.sessions += sessionsByPlan.get(p.id) ?? 0;
  }
  if (groups.size === 0) return { planId: null, lineKey: null, others: 0 };

  const all = [...groups.values()];
  const main = all.reduce((best, g) => {
    if (g.sessions !== best.sessions) return g.sessions > best.sessions ? g : best;
    if (g.hasRace !== best.hasRace) return g.hasRace ? g : best;
    return g.start < best.start ? g : best;
  });
  const named = main.plans.reduce((best, p) => {
    const s = sessionsByPlan.get(p.id) ?? 0;
    const bs = sessionsByPlan.get(best.id) ?? 0;
    if (s !== bs) return s > bs ? p : best;
    return p.startDate > best.startDate ? p : best;
  });
  return { planId: named.id, lineKey: main.line?.key ?? null, others: all.length - 1 };
}
