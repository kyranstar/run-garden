import { addDays, formatWeight, isLocalDate, startOfIsoWeek, toKg, type Weight } from "@rg/domain";
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

export interface Best {
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

/**
 * Everything the records and milestones carry from one session to the next: the fold `compute` runs over a history.
 * Plain data (no Map or Set), so a baseline can be stored (`baseline`, `forSessionFrom`).
 */
export interface RecordsState {
  weeklyGoal: number;
  awarded: string[];
  /** Per canonical exercise id. */
  bests: Record<string, Best>;
  /** Per ISO week start. */
  weekCounts: Record<string, number>;
  weekStreaks: Record<string, number>;
  weekFamilies: Record<string, string[]>;
  /** Per profile id: the calm sessions in a row. */
  calm: Record<string, number>;
  count: number;
  topBlock: number | null;
  heaviestBellKg: number | null;
}

const emptyState = (weeklyGoal: number): RecordsState => ({
  weeklyGoal, awarded: [], bests: {}, weekCounts: {}, weekStreaks: {}, weekFamilies: {}, calm: {}, count: 0, topBlock: null, heaviestBellKg: null,
});

const has = (rec: object, key: string): boolean => Object.prototype.hasOwnProperty.call(rec, key);

/** One session onto the state (changed in place): what it set and what it earned. */
function fold(data: EngineData, st: RecordsState, s: HistorySession): { records: RecordEvent[]; milestones: Milestone[] } {
  const records: RecordEvent[] = [];
  const milestones: Milestone[] = [];
  const calmProfiles = data.profiles.active.filter(p => p.calmStreakLabel);
  const at = { sessionId: s.id ?? null, date: s.date };
  const award = (id: string, text: string) => { if (!st.awarded.includes(id)) { st.awarded.push(id); milestones.push({ id, ...at, text }); } };
  const entries = (s.entries || []).filter(e => e && e.id);

  for (const raw of Hist.idsIn(s)) {
    const id = Hist.canonical(data, raw);
    if (has(st.bests, id)) continue;
    st.bests[id] = { kg: null, w: null, reps: null, secs: null };
    const ex = Lib.get(data, id);
    records.push({ kind: "first", exerciseId: id, ...at, value: null, previous: null, text: `First time: ${ex ? ex.name : id}` });
  }
  const setsById = new Map<string, HistorySet[]>();
  for (const e of entries.filter(countsForBests)) {
    const id = Hist.canonical(data, e.id);
    setsById.set(id, [...(setsById.get(id) || []), ...setsOf(e)]);
  }
  for (const [id, sets] of setsById) {
    for (const r of improve(data, st.bests[id]!, id, sets)) records.push({ kind: r.kind, exerciseId: id, ...at, value: r.value, previous: r.previous, text: r.text });
  }

  st.count += 1;
  if (SESSION_COUNTS.includes(st.count)) award(`sessions-${st.count}`, `${st.count} sessions`);

  // A malformed date still counts for records and session totals; it just belongs to no week.
  const week = isLocalDate(s.date) ? startOfIsoWeek(s.date) : null;
  if (week) st.weekCounts[week] = (st.weekCounts[week] || 0) + 1;
  if (week && st.weekCounts[week] === st.weeklyGoal) {
    const streak = (st.weekStreaks[addDays(week, -7)] || 0) + 1;
    st.weekStreaks[week] = streak;
    if (GOAL_STREAKS.includes(streak)) award(`goal-weeks-${streak}`, `${streak} weeks in a row at your goal`);
  }

  // A calm session per profile: its check ended no higher than it started. The first profile's milestone
  // ids are `calm-N`; any further profile's are `calm-<profile>-N`.
  calmProfiles.forEach((p, i) => {
    const c = s.checks ? s.checks[p.id] : undefined;
    const n = c && c.pre != null && c.post != null && c.post <= c.pre ? (st.calm[p.id] || 0) + 1 : 0;
    st.calm[p.id] = n;
    if (CALM_STREAKS.includes(n)) award(i === 0 ? `calm-${n}` : `calm-${p.id}-${n}`, `${n} ${p.calmStreakLabel} sessions in a row`);
  });

  if (typeof s.blockNumber === "number") {
    if (st.topBlock != null && s.blockNumber > st.topBlock) award(`block-${s.blockNumber - 1}`, `Block ${s.blockNumber - 1} complete`);
    st.topBlock = Math.max(st.topBlock ?? s.blockNumber, s.blockNumber);
  }

  const bells = entries.filter(isKettlebell).flatMap(setsOf).filter(loaded);
  const bellKg = maxOf(bells.map(kgOf));
  if (bellKg != null) {
    if (st.heaviestBellKg != null && bellKg > st.heaviestBellKg + SAME_KG) {
      award(`bell-${Math.round(bellKg)}`, `New heaviest bell: ${formatWeight(bells.find(b => kgOf(b) === bellKg)!.w)}`);
    }
    st.heaviestBellKg = Math.max(st.heaviestBellKg ?? bellKg, bellKg);
  }

  if (week) {
    const families = new Set(st.weekFamilies[week] || []);
    for (const raw of Hist.idsIn(s)) { const f = Lib.coreFamilyOf(data, Lib.get(data, raw)); if (f) families.add(f); }
    st.weekFamilies[week] = [...families];
    if (data.coreFamilies.every(f => families.has(f.id))) award(`all-core-${week}`, "Every core lift trained in one week");
  }
  return { records, milestones };
}

const valid = (sessions: readonly (HistorySession | null)[] | null | undefined): HistorySession[] =>
  Hist.sorted((sessions || []).filter((x): x is HistorySession => Boolean(x && x.date)));

function compute(data: EngineData, sessions: readonly (HistorySession | null)[] | null | undefined, { weeklyGoal = 4 }: { weeklyGoal?: number } = {}): { records: RecordEvent[]; milestones: Milestone[] } {
  const records: RecordEvent[] = [];
  const milestones: Milestone[] = [];
  const st = emptyState(weeklyGoal);
  for (const s of valid(sessions)) {
    const out = fold(data, st, s);
    records.push(...out.records);
    milestones.push(...out.milestones);
  }
  return { records, milestones };
}

/**
 * A history folded down to what one more session — the newest, on `date`, playing only moves among `ids` — can read
 * (Phase 2b: the server works it out at Start; the review folds the session played onto it, offline). Bests are
 * kept only for `ids` (canonical); weeks only from the one before `date`'s.
 */
function baseline(
  data: EngineData,
  sessions: readonly (HistorySession | null)[] | null | undefined,
  { ids, date, weeklyGoal = 4 }: { ids: readonly string[]; date: string; weeklyGoal?: number },
): RecordsState {
  const st = emptyState(weeklyGoal);
  for (const s of valid(sessions)) fold(data, st, s);
  const keep = new Set(ids.map(id => Hist.canonical(data, id)));
  const from = isLocalDate(date) ? addDays(startOfIsoWeek(date), -7) : null;
  const recent = <T>(byWeek: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(byWeek).filter(([w]) => from !== null && w >= from));
  return {
    ...st,
    bests: Object.fromEntries(Object.entries(st.bests).filter(([id]) => keep.has(id))),
    weekCounts: recent(st.weekCounts),
    weekStreaks: recent(st.weekStreaks),
    weekFamilies: recent(st.weekFamilies),
  };
}

/** What `session` achieved on top of a `baseline` — the same as `forSession` over the whole history. */
function forSessionFrom(data: EngineData, base: RecordsState, session: HistorySession): { records: RecordEvent[]; milestones: Milestone[] } {
  const st: RecordsState = JSON.parse(JSON.stringify(base)) as RecordsState;
  if (!session || !session.date) return { records: [], milestones: [] };
  return fold(data, st, session);
}

/** What one session achieved — for the review screen right after saving it. */
function forSession(data: EngineData, sessions: readonly (HistorySession | null)[] | null | undefined, sessionId: string, opts?: { weeklyGoal?: number }): { records: RecordEvent[]; milestones: Milestone[] } {
  const all = compute(data, sessions, opts);
  const mine = (x: { sessionId: string | null }) => x.sessionId === sessionId;
  return { records: all.records.filter(mine), milestones: all.milestones.filter(mine) };
}

export const Records = { compute, forSession, baseline, forSessionFrom };
