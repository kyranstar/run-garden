import { addDays, formatWeight, startOfIsoWeek, toKg, type Weight } from "@rg/domain";
import type { EngineData, ExerciseRecord, HistoryEntry, HistorySession, HistorySet } from "@rg/exercise-library";
import { Hist } from "./hist.js";
import { Lib } from "./lib.js";

// Records (first time, heaviest weight, most reps at that weight, longest hold) and milestones, derived from
// saved sessions — never stored. Old sessions may be sparse or damaged; all of it is tolerated. Calm streaks
// come from each active profile's own check and words.

const SAME_KG = 0.05;
const SESSION_COUNTS = [10, 25, 50, 100];
const GOAL_STREAKS = [2, 4, 8, 12, 26, 52];
const CALM_STREAKS = [5, 10, 20, 50];

export interface RecordEvent {
  kind: "first" | "weight" | "reps" | "hold";
  exerciseId: string;
  sessionId: string | null;
  date: string;
  value: Weight | number | null;
  previous: Weight | number | null;
  text: string;
}

export interface Milestone {
  id: string;
  sessionId: string | null;
  date: string;
  text: string;
}

interface Best {
  kg: number | null;
  w: Weight | null;
  reps: number | null;
  secs: number | null;
}

type LoadedSet = HistorySet & { w: Weight };

const maxOf = (nums: number[]): number | null => (nums.length ? Math.max(...nums) : null);
const loaded = (set: HistorySet): set is LoadedSet => Boolean(set.w && set.w.v > 0);
const kgOf = (set: LoadedSet): number => toKg(set.w);
const setsOf = (entry: HistoryEntry): HistorySet[] => (entry.sets || []).filter(Boolean);
// Ladders and circuits are deliberately light or timed; they say nothing about bests.
const countsForBests = (entry: HistoryEntry): boolean => entry.format !== "ladder" && entry.format !== "circuit";
const isKettlebell = (entry: HistoryEntry): boolean => String(entry.implement || "").toLowerCase() === "kettlebell";
const liftText = (w: Weight | null, reps: number | null): string => (w ? `${formatWeight(w)}${reps != null ? ` × ${reps}` : ""}` : `${reps} reps`);

// Only holds and carries have a longest-time best. An unknown (retired) id counts any logged seconds.
function holdKind(ex: ExerciseRecord | null): "hold" | "carry" | null {
  if (!ex || ex.dose.type === "time") return "hold";
  return ex.dose.type === "carry" ? "carry" : null;
}

// One exercise's sets from one session against its bests so far (updated in place).
// The first value of each kind only sets the bar; a record needs something to beat.
function improve(data: EngineData, best: Best, id: string, sets: HistorySet[]): Array<Pick<RecordEvent, "kind" | "value" | "previous" | "text">> {
  const out: Array<Pick<RecordEvent, "kind" | "value" | "previous" | "text">> = [];
  const ex = Lib.get(data, id);
  const name = ex ? ex.name : id;
  const atKg = (kg: number | null) => sets.filter(s => (kg == null ? !loaded(s) : loaded(s) && Math.abs(kgOf(s) - kg) < SAME_KG));
  const mostReps = (kg: number | null) => atKg(kg).filter(s => s.reps != null).sort((a, b) => (b.reps as number) - (a.reps as number))[0] || null;

  const topKg = maxOf(sets.filter(loaded).map(kgOf));
  if (topKg != null && (best.kg == null || topKg > best.kg + SAME_KG)) {
    const w = sets.filter(loaded).find(s => kgOf(s) === topKg)!.w;
    const top = mostReps(topKg);
    const reps = top ? top.reps : null;
    if (best.kg != null) out.push({ kind: "weight", value: w, previous: best.w, text: `New best: ${name} ${liftText(w, reps)}` });
    Object.assign(best, { kg: topKg, w, reps });
  } else {
    const top = mostReps(best.kg);
    if (top && top.reps != null && best.reps != null && top.reps > best.reps) out.push({ kind: "reps", value: top.reps, previous: best.reps, text: `New best: ${name} ${liftText(top.w, top.reps)}` });
    if (top && top.reps != null && (best.reps == null || top.reps > best.reps)) best.reps = top.reps;
  }

  const kind = holdKind(ex);
  const secs = kind ? maxOf(sets.filter(s => (s.secs ?? 0) > 0).map(s => s.secs as number)) : null;
  if (kind && secs != null) {
    if (best.secs != null && secs > best.secs) out.push({ kind: "hold", value: secs, previous: best.secs, text: `Longest ${kind}: ${name} ${secs} s` });
    if (best.secs == null || secs > best.secs) best.secs = secs;
  }
  return out;
}

function compute(data: EngineData, sessions: readonly (HistorySession | null)[] | null | undefined, { weeklyGoal = 4 }: { weeklyGoal?: number } = {}): { records: RecordEvent[]; milestones: Milestone[] } {
  const records: RecordEvent[] = [];
  const milestones: Milestone[] = [];
  const awarded = new Set<string>();
  const bests = new Map<string, Best>();
  const weekCounts = new Map<string, number>();
  const weekStreaks = new Map<string, number>();
  const weekFamilies = new Map<string, Set<string>>();
  const calmProfiles = data.profiles.active.filter(p => p.calmStreakLabel);
  const calm = new Map<string, number>();
  let count = 0;
  let topBlock: number | null = null;
  let heaviestBellKg: number | null = null;

  for (const s of Hist.sorted((sessions || []).filter((x): x is HistorySession => Boolean(x && x.date)))) {
    const at = { sessionId: s.id ?? null, date: s.date };
    const award = (id: string, text: string) => { if (!awarded.has(id)) { awarded.add(id); milestones.push({ id, ...at, text }); } };
    const entries = (s.entries || []).filter(e => e && e.id);

    for (const raw of Hist.idsIn(s)) {
      const id = Hist.canonical(data, raw);
      if (bests.has(id)) continue;
      bests.set(id, { kg: null, w: null, reps: null, secs: null });
      const ex = Lib.get(data, id);
      records.push({ kind: "first", exerciseId: id, ...at, value: null, previous: null, text: `First time: ${ex ? ex.name : id}` });
    }
    const setsById = new Map<string, HistorySet[]>();
    for (const e of entries.filter(countsForBests)) {
      const id = Hist.canonical(data, e.id);
      setsById.set(id, [...(setsById.get(id) || []), ...setsOf(e)]);
    }
    for (const [id, sets] of setsById) {
      for (const r of improve(data, bests.get(id)!, id, sets)) records.push({ kind: r.kind, exerciseId: id, ...at, value: r.value, previous: r.previous, text: r.text });
    }

    count += 1;
    if (SESSION_COUNTS.includes(count)) award(`sessions-${count}`, `${count} sessions`);

    const week = startOfIsoWeek(s.date);
    weekCounts.set(week, (weekCounts.get(week) || 0) + 1);
    if (weekCounts.get(week) === weeklyGoal) {
      const streak = (weekStreaks.get(addDays(week, -7)) || 0) + 1;
      weekStreaks.set(week, streak);
      if (GOAL_STREAKS.includes(streak)) award(`goal-weeks-${streak}`, `${streak} weeks in a row at your goal`);
    }

    // A calm session per profile: its check ended no higher than it started. The first profile's milestone
    // ids are `calm-N`; any further profile's are `calm-<profile>-N`.
    calmProfiles.forEach((p, i) => {
      const c = s.checks ? s.checks[p.id] : undefined;
      const n = c && c.pre != null && c.post != null && c.post <= c.pre ? (calm.get(p.id) || 0) + 1 : 0;
      calm.set(p.id, n);
      if (CALM_STREAKS.includes(n)) award(i === 0 ? `calm-${n}` : `calm-${p.id}-${n}`, `${n} ${p.calmStreakLabel} sessions in a row`);
    });

    if (typeof s.blockNumber === "number") {
      if (topBlock != null && s.blockNumber > topBlock) award(`block-${s.blockNumber - 1}`, `Block ${s.blockNumber - 1} complete`);
      topBlock = Math.max(topBlock ?? s.blockNumber, s.blockNumber);
    }

    const bells = entries.filter(isKettlebell).flatMap(setsOf).filter(loaded);
    const bellKg = maxOf(bells.map(kgOf));
    if (bellKg != null) {
      if (heaviestBellKg != null && bellKg > heaviestBellKg + SAME_KG) {
        award(`bell-${Math.round(bellKg)}`, `New heaviest bell: ${formatWeight(bells.find(b => kgOf(b) === bellKg)!.w)}`);
      }
      heaviestBellKg = Math.max(heaviestBellKg ?? bellKg, bellKg);
    }

    const families = weekFamilies.get(week) || new Set<string>();
    for (const raw of Hist.idsIn(s)) { const f = Lib.coreFamilyOf(data, Lib.get(data, raw)); if (f) families.add(f); }
    weekFamilies.set(week, families);
    if (data.coreFamilies.every(f => families.has(f.id))) award(`all-core-${week}`, "Every core lift trained in one week");
  }
  return { records, milestones };
}

/** What one session achieved — for the review screen right after saving it. */
function forSession(data: EngineData, sessions: readonly (HistorySession | null)[] | null | undefined, sessionId: string, opts?: { weeklyGoal?: number }): { records: RecordEvent[]; milestones: Milestone[] } {
  const all = compute(data, sessions, opts);
  const mine = (x: { sessionId: string | null }) => x.sessionId === sessionId;
  return { records: all.records.filter(mine), milestones: all.milestones.filter(mine) };
}

export const Records = { compute, forSession };
