import type { Weight } from "@rg/domain";
import type { CheckReading, EngineData, ExerciseRecord, FormatId, HistoryEntry, HistorySession, Mode } from "@rg/exercise-library";
import { Blocks } from "./blocks.js";
import { Lib } from "./lib.js";
import type { Block, Prefs, Step } from "./types.js";

// The session being recorded: which steps you reached, what you logged, and the saved record it becomes.
// Condition flags on an exercise (each profile's `setFlag`) are kept as a list of flag ids.

export interface RecorderMeta {
  id: string;
  startedAt: string;
  date: string;
  mode: Mode;
  theme: string | null;
  locationId: string;
  minutes: number;
  block: Pick<Block, "id" | "number"> | null;
  /** Today's checks per profile id, as answered before the session. */
  checks: Readonly<Record<string, CheckReading>>;
  equipment: readonly string[];
  plannedSeconds: number;
  newMove: string | null;
}

export interface LiveSet {
  w: Weight | null;
  reps: number | null;
  secs: number | null;
  done: boolean;
  touched: boolean;
}

export interface LiveEntry {
  id: string;
  implement: string | null;
  /** What gets written: weight (+reps or time), reps only, or time only. */
  log: "load" | "time" | "reps";
  metric: "reps" | "time";
  perSide: boolean;
  format: FormatId;
  flags: string[];
  sets: LiveSet[];
}

export interface PlanSteps {
  steps: Step[];
  plannedSeconds: number;
}

export interface Live {
  meta: RecorderMeta;
  plan: PlanSteps;
  steps: Step[];
  entries: Record<string, LiveEntry>;
  order: string[];
  reached: Set<number>;
  secs: Record<string, number>;
  runningMs: number;
}

export interface SavedEntry extends HistoryEntry {
  log: LiveEntry["log"];
  metric: LiveEntry["metric"];
  format: FormatId;
  flags: string[];
  sets: Array<{ w: Weight | null; reps: number | null; secs: number | null }>;
}

/**
 * A finished (or ended-early) session: the save payload, and a HistorySession the engine can read as is
 * (records and graduation offers for the review screen run on it before it is saved).
 */
export interface PerformedSessionSave extends HistorySession {
  version: 2;
  mode: Mode;
  endedAt: string;
  seconds: number;
  plannedSeconds: number;
  minutes: number;
  locationId: string;
  blockId: string | null;
  completed: boolean;
  stepsTotal: number;
  stepsDone: number;
  note: string;
  newMove: string | null;
  done: Array<{ id: string; secs: number }>;
  entries: SavedEntry[];
}

const logKind = (ex: ExerciseRecord): LiveEntry["log"] => (ex.load === "external" ? "load" : ex.dose.type === "time" ? "time" : "reps");
const metric = (ex: ExerciseRecord): LiveEntry["metric"] => (ex.dose.type === "reps" ? "reps" : "time");
const blankSet = (): LiveSet => ({ w: null, reps: null, secs: null, done: false, touched: false });

function create(data: EngineData, plan: PlanSteps, meta: RecorderMeta): Live {
  const entries: Record<string, LiveEntry> = {};
  const order: string[] = [];
  const sparse: Record<string, Array<LiveSet | undefined>> = {};
  // A stored plan may name a move the library has since renamed: every step reads its current id, so what you
  // reach and log lands on the entry under that id.
  const steps = plan.steps.map(s => {
    const ex = s.exerciseId ? Lib.get(data, s.exerciseId) : null;
    return ex && ex.id !== s.exerciseId ? { ...s, exerciseId: ex.id } : s;
  });
  for (const step of steps) {
    if (!step.log || !step.exerciseId) continue;
    const ex = Lib.get(data, step.exerciseId);
    if (!ex) continue;   // a move no longer in the library is played, not logged
    if (!entries[ex.id]) {
      entries[ex.id] = {
        id: ex.id, implement: Lib.implementFor(ex, meta.equipment), log: logKind(ex), metric: metric(ex),
        perSide: ex.laterality === "unilateral", format: step.format.id, flags: [], sets: [],
      };
      sparse[ex.id] = [];
      order.push(ex.id);
    }
    const t = step.target || {};
    sparse[ex.id]![step.setIndex ?? 0] = {
      w: t.w || null, reps: t.reps ?? null, secs: t.secs || (step.kind === "timed" ? step.seconds : null),
      done: false, touched: false,
    };
  }
  for (const id of order) entries[id]!.sets = Array.from(sparse[id]!, s => s || blankSet());
  return { meta, plan, steps, entries, order, reached: new Set(), secs: {}, runningMs: 0 };
}

/** Reaching a set counts it; a timed hold only counts when you leave it (finishTimed). */
function reach(live: Live, index: number): void {
  const step = live.steps[index];
  if (!step) return;
  live.reached.add(index);
  const e = step.exerciseId ? live.entries[step.exerciseId] : undefined;
  const set = e ? e.sets[step.setIndex ?? 0] : undefined;
  if (set && step.kind !== "timed") set.done = true;
}

/** Leaving a timed hold: it counts if you held at least half of it, at the time you held (unless you typed one). */
function finishTimed(live: Live, index: number, elapsedSecs: number): void {
  const step = live.steps[index];
  const e = step && step.exerciseId ? live.entries[step.exerciseId] : undefined;
  const set = e && step ? e.sets[step.setIndex ?? 0] : undefined;
  if (!step || !set || step.kind !== "timed" || elapsedSecs < step.seconds / 2) return;
  set.done = true;
  if (!set.touched) set.secs = Math.round(elapsedSecs);
}

const addSeconds = (live: Live, exId: string, secs: number): void => {
  live.secs[exId] = (live.secs[exId] || 0) + secs;
};

/** Editing a set also updates later sets you haven't touched yet. */
function update<K extends "w" | "reps" | "secs">(live: Live, exId: string, setIndex: number, field: K, value: LiveSet[K]): void {
  const e = live.entries[exId];
  const set = e ? e.sets[setIndex] : undefined;
  if (!e || !set) return;
  set[field] = value;
  set.touched = true;
  for (let i = setIndex + 1; i < e.sets.length; i++) if (!e.sets[i]!.touched) e.sets[i]![field] = value;
}

function setDone(live: Live, exId: string, setIndex: number, done: boolean): void {
  const set = live.entries[exId]?.sets[setIndex];
  if (set) set.done = Boolean(done);
}

function addSet(live: Live, exId: string): void {
  const e = live.entries[exId];
  if (!e) return;
  const last = e.sets[e.sets.length - 1] || blankSet();
  e.sets.push({ w: last.w, reps: last.reps, secs: last.secs, done: true, touched: true });
}

/** Sets or clears a profile's flag (its `setFlag.id`) on a logged exercise. */
function setFlag(live: Live, exId: string, flag: string, value: boolean): void {
  const e = live.entries[exId];
  if (!e) return;
  const others = e.flags.filter(f => f !== flag);
  e.flags = value ? [...others, flag] : others;
}

/** During a rest, the log card shows the set you just finished; typing there edits that set. */
function logStepIndex(live: Live, index: number): number | null {
  const s = live.steps[index];
  if (!s) return null;
  if (s.kind !== "rest") return s.log ? index : null;
  for (let k = index - 1; k >= 0; k--) {
    const prev = live.steps[k]!;
    if (prev.kind === "rest") continue;
    return prev.log ? k : null;
  }
  return null;
}

export interface EndOptions {
  endedAt: string;
  /** The after-session check per profile id. */
  post?: Readonly<Record<string, number | null>>;
  note?: string;
  completed?: boolean;
}

function toSession(live: Live, { endedAt, post = {}, note = "", completed = false }: EndOptions): PerformedSessionSave {
  const m = live.meta;
  const reachedSteps = [...live.reached].sort((a, b) => a - b).map(i => live.steps[i]).filter((s): s is Step => Boolean(s) && s!.kind !== "rest");
  // Logged moves count when a set is done; unlogged ones (mobility, breathing) when you reached them.
  const doneIds = [...new Set(reachedSteps.map(s => s.exerciseId).filter((x): x is string => Boolean(x)))]
    .filter(id => !live.entries[id] || live.entries[id]!.sets.some(x => x.done));
  const entries: SavedEntry[] = live.order.map(id => live.entries[id]!).map(e => ({
    id: e.id, implement: e.implement, log: e.log, metric: e.metric, perSide: e.perSide, format: e.format, flags: [...e.flags],
    sets: e.sets.filter(s => s.done).map(s => ({
      w: e.log === "load" ? s.w : null,
      reps: e.metric === "reps" ? s.reps : null,
      secs: e.metric === "time" ? s.secs : null,
    })),
  })).filter(e => e.sets.length);
  const checks: Record<string, CheckReading> = {};
  for (const id of new Set([...Object.keys(m.checks || {}), ...Object.keys(post)])) {
    const before = (m.checks || {})[id];
    checks[id] = { pre: before?.pre ?? null, post: post[id] ?? null, feelingOff: Boolean(before?.feelingOff) };
  }
  return {
    id: m.id, version: 2, date: m.date, startedAt: m.startedAt, endedAt,
    seconds: Math.round(live.runningMs / 1000), plannedSeconds: m.plannedSeconds, minutes: m.minutes,
    mode: m.mode, theme: m.theme, locationId: m.locationId,
    blockId: m.block ? m.block.id : null, blockNumber: m.block ? m.block.number : null,
    completed: Boolean(completed),
    stepsTotal: live.steps.filter(s => s.kind !== "rest").length, stepsDone: reachedSteps.length,
    checks, note, newMove: m.newMove || null,
    done: doneIds.map(id => ({ id, secs: Math.round(live.secs[id] || 0) })),
    entries,
  };
}

// A swap mid-session: the swapped slot's remaining sets come from the fresh plan; every other step stays as it was,
// along with what you reached and logged.
function rebase(data: EngineData, old: Live, freshPlan: PlanSteps, index: number, slotKey: string): Live {
  const isSlot = (s: Step) => s.kind !== "rest" && s.slotKey === slotKey;
  const freshSlot = freshPlan.steps.filter(isSlot);
  const steps = old.steps.slice(0, index);
  const moved = new Map(steps.map((_, k) => [k, k]));
  const emitted = new Set<number | null>();
  for (let k = index; k < old.steps.length; k++) {
    const s = old.steps[k]!;
    if (!isSlot(s)) { moved.set(k, steps.length); steps.push(s); continue; }
    if (emitted.has(s.setIndex)) continue;
    emitted.add(s.setIndex);
    steps.push(...freshSlot.filter(x => x.setIndex === s.setIndex));
  }
  const live = create(data, { ...freshPlan, steps }, { ...old.meta, plannedSeconds: freshPlan.plannedSeconds });
  for (const id of old.order) {
    if (!live.entries[id] && !old.entries[id]!.sets.some(x => x.done)) continue;
    if (!live.entries[id]) live.order.push(id);
    live.entries[id] = old.entries[id]!;
  }
  old.reached.forEach(k => { if (moved.has(k)) live.reached.add(moved.get(k)!); });
  live.secs = { ...old.secs };
  live.runningMs = old.runningMs;
  return live;
}

export const Recorder = { create, reach, finishTimed, addSeconds, update, setDone, addSet, setFlag, logStepIndex, toSession, rebase };

// ---- Review: the decisions made on the review screen (ratings, "not for me", graduations) are held as a
// pending change set and applied on save, never written while reviewing (spec §5 change 4).

export interface ReviewState {
  /** Rating per exercise id; null clears the rating. */
  ratings: Readonly<Record<string, number | null>>;
  /** Exclusion per exercise id ("not for me"). */
  excluded: Readonly<Record<string, boolean>>;
  /** Accepted graduation per core family: the harder move. */
  graduate: Readonly<Record<string, string>>;
}

export interface PendingChanges {
  ratings: Record<string, number | null>;
  excluded: Record<string, boolean>;
  graduations: Array<{ family: string; to: string }>;
}

export interface ReviewOffer {
  family: string;
  to: string;
}

const startReview = (): ReviewState => ({ ratings: {}, excluded: {}, graduate: {} });

const has = (rec: object, key: string): boolean => Object.prototype.hasOwnProperty.call(rec, key);
const ratingNow = (prefs: Pick<Prefs, "ratings">, review: ReviewState, exId: string): number | null =>
  has(review.ratings, exId) ? review.ratings[exId] ?? null : prefs.ratings[exId] ?? null;
const excludedNow = (prefs: Pick<Prefs, "excluded">, review: ReviewState, exId: string): boolean =>
  has(review.excluded, exId) ? Boolean(review.excluded[exId]) : prefs.excluded.includes(exId);

/** 👍 / 👎 toggles against what's saved plus what's pending; "never" toggles "not for me". */
function rate(review: ReviewState, prefs: Pick<Prefs, "ratings" | "excluded">, exId: string, value: 1 | -1 | "never"): ReviewState {
  if (value === "never") return { ...review, excluded: { ...review.excluded, [exId]: !excludedNow(prefs, review, exId) } };
  return { ...review, ratings: { ...review.ratings, [exId]: ratingNow(prefs, review, exId) === value ? null : value } };
}

function graduateInReview(review: ReviewState, family: string, to: string, accepted: boolean): ReviewState {
  const graduate: Record<string, string> = { ...review.graduate };
  if (accepted) graduate[family] = to;
  else delete graduate[family];
  return { ...review, graduate };
}

/** Only offers that still stand count: an edit that withdraws an offer also withdraws your yes to it. */
const stillOffered = (offers: readonly ReviewOffer[], accepted: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(accepted).filter(([f, to]) => offers.some(o => o.family === f && o.to === to)));

function pending(review: ReviewState, offers: readonly ReviewOffer[]): PendingChanges {
  return {
    ratings: { ...review.ratings },
    excluded: { ...review.excluded },
    graduations: Object.entries(stillOffered(offers, review.graduate)).map(([family, to]) => ({ family, to })),
  };
}

function applyToPrefs(prefs: Prefs, changes: Pick<PendingChanges, "ratings" | "excluded">): Prefs {
  const ratings: Record<string, number> = { ...prefs.ratings };
  for (const [id, v] of Object.entries(changes.ratings)) {
    if (v == null) delete ratings[id];
    else ratings[id] = v;
  }
  let excluded = [...prefs.excluded];
  for (const [id, out] of Object.entries(changes.excluded)) {
    excluded = excluded.filter(x => x !== id);
    if (out) excluded.push(id);
  }
  return { ...prefs, ratings, excluded };
}

/** What the review screen shows: saved preferences with the pending decisions on top. */
const effectivePrefs = (prefs: Prefs, review: ReviewState): Prefs => applyToPrefs(prefs, review);

/** On save: the preferences and block with the pending decisions applied (graduations use Home's gear). */
function applyReview(data: EngineData, state: { prefs: Prefs; block: Block | null; today: string; equipment: readonly string[] }, changes: PendingChanges): { prefs: Prefs; block: Block | null } {
  let block = state.block;
  for (const g of changes.graduations) if (block) block = Blocks.graduate(data, block, g.family, g.to, state.today, state.equipment);
  return { prefs: applyToPrefs(state.prefs, changes), block };
}

export const Review = { start: startReview, rate, graduate: graduateInReview, stillOffered, pending, effectivePrefs, apply: applyReview };
