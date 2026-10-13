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
  /**
   * A hold played a side at a time (a left and a right window of one set: `pairedSide`), to max or not: the seconds held
   * on each side done, neither overwriting the other — one set, saved with each side (`SavedEntry`); its `secs` the
   * shorter side's so far. Absent otherwise (a hold on one fixed side is a plain set).
   */
  sides?: Partial<Record<HoldSide, number>>;
}

/** A side of a hold played a side at a time, as a saved set names it. */
export type HoldSide = "left" | "right";

/** How a timed hold is left (`finishTimed`). */
export interface HoldEnd {
  /** A hold to max (a document item's `dose.max`). Each side of any hold played a side at a time is logged on its own. */
  toMax?: boolean;
  /** Ended with Done: it counts at whatever time was held, a second or more — where you stopped is the result. */
  done?: boolean;
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
  /**
   * Timed holds left so far, by step index: true once held at least half its time, false when left before half (and
   * never held). A hold left before half is no step done, and an unlogged one no move done (ruling 2b-R15). Absent on
   * a state kept before it existed: every hold reached then counts, as it did.
   */
  held?: Record<number, boolean>;
  secs: Record<string, number>;
  runningMs: number;
  /**
   * Each logged move's sets, by place in its entry (`entries[id].sets[place]`): the set keys (`setKey`: a slot and its
   * set number) in the order the session first plays them. A set is its slot's and number's alone — the same move in
   * two items, or a part played in rounds, never shares one; an engine build (a move in one slot, numbered from 0) keeps
   * its numbers. Absent on a session kept before it existed: a step's set is then at its set number, as it was.
   */
  keys?: Record<string, string[]>;
}

/** A step's set, as its move's entry knows it: its slot and its set number. */
const setKey = (step: Pick<Step, "slotKey" | "setIndex">): string => `${step.slotKey}#${step.setIndex ?? 0}`;
const slotOfKey = (key: string): string => key.slice(0, key.lastIndexOf("#"));

/**
 * Where a step's set is in its move's entry (`Live.keys`), or -1 when the step is no set of it (a window of the move
 * that is not logged, where the move is logged elsewhere). A session kept before the keys: the step's set number.
 */
function placeOf(live: Pick<Live, "keys">, step: Pick<Step, "exerciseId" | "slotKey" | "setIndex">): number {
  const keys = step.exerciseId ? live.keys?.[step.exerciseId] : undefined;
  return keys ? keys.indexOf(setKey(step)) : (step.setIndex ?? 0);
}

const setOf = (live: Live, step: Step): LiveSet | undefined => {
  const e = step.exerciseId ? live.entries[step.exerciseId] : undefined;
  const at = placeOf(live, step);
  return e && at >= 0 ? e.sets[at] : undefined;
};

export interface SavedEntry extends HistoryEntry {
  log: LiveEntry["log"];
  metric: LiveEntry["metric"];
  format: FormatId;
  flags: string[];
  /**
   * A set of a hold played a side at a time is one set: its seconds the shorter side's (what it held on both, as history
   * reads one set) — none when only one side was done (it measures nothing) — and each side's (`sides`, a row per side
   * on the wire).
   */
  sets: Array<{ w: Weight | null; reps: number | null; secs: number | null; sides?: Partial<Record<HoldSide, number>> }>;
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
  /** How many moves the session held, done or skipped: what the review may rate (ruling 2b-R17). */
  movesPlanned: number;
  note: string;
  newMove: string | null;
  /**
   * The moves done, each with its seconds and — when it was played in one slot — that slot (`slotKey`): a reader judges a
   * set by the slot it was played in, never by its entry's index, which drifts from the build's order (an entry with no
   * done set is dropped; a swap after a slot's first set adds the new move's entry after the old one's).
   */
  done: Array<{ id: string; secs: number; slotKey?: string }>;
  entries: SavedEntry[];
}

const logKind = (ex: ExerciseRecord): LiveEntry["log"] => (ex.load === "external" ? "load" : ex.dose.type === "time" ? "time" : "reps");
const metric = (ex: ExerciseRecord): LiveEntry["metric"] => (ex.dose.type === "reps" ? "reps" : "time");
const blankSet = (): LiveSet => ({ w: null, reps: null, secs: null, done: false, touched: false });

function create(data: EngineData, plan: PlanSteps, meta: RecorderMeta): Live {
  const entries: Record<string, LiveEntry> = {};
  const order: string[] = [];
  const sparse: Record<string, Array<LiveSet | undefined>> = {};
  const keys: Record<string, string[]> = {};
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
      keys[ex.id] = [];
      order.push(ex.id);
    }
    const key = setKey(step);
    let at = keys[ex.id]!.indexOf(key);
    if (at < 0) at = keys[ex.id]!.push(key) - 1;
    const t = step.target || {};
    // A range of reps asked (a document's "5–8": no single number) is filled in at its low end.
    const ranged = t.reps == null && t.type === "reps" && typeof t.lo === "number" && typeof t.hi === "number" && t.hi > t.lo ? t.lo : null;
    sparse[ex.id]![at] = {
      w: t.w || null, reps: t.reps ?? ranged, secs: t.secs || (step.kind === "timed" ? step.seconds : null),
      done: false, touched: false,
    };
  }
  for (const id of order) entries[id]!.sets = Array.from(sparse[id]!, s => s || blankSet());
  return { meta, plan, steps, entries, order, reached: new Set(), held: {}, secs: {}, runningMs: 0, keys };
}

/** Reaching a set counts it; a timed hold only counts when you leave it having held half of it (finishTimed). */
function reach(live: Live, index: number): void {
  const step = live.steps[index];
  if (!step) return;
  live.reached.add(index);
  const set = setOf(live, step);
  if (set && step.kind !== "timed") set.done = true;
}

/**
 * Leaving a timed hold: it counts if you held at least half of it, at the time you held (unless you typed one) — a
 * logged hold's set and an unlogged hold alike (ruling 2b-R15). Once held, going back to it and leaving early again
 * does not undo it. A hold to max ended with Done (`how.done`) counts at whatever time you held it, a second or more:
 * where you stopped is the result. A hold played a side at a time — to max or not — logs each side on its own
 * (`LiveSet.sides`), its seconds the shorter side's so far.
 */
function finishTimed(live: Live, index: number, elapsedSecs: number, how: HoldEnd = {}): void {
  const step = live.steps[index];
  if (!step || step.kind !== "timed") return;
  const held = elapsedSecs >= step.seconds / 2 || (how.done === true && Math.round(elapsedSecs) >= 1);
  live.held ??= {};
  if (held) live.held[index] = true;
  else if (live.held[index] !== true) live.held[index] = false;
  const set = setOf(live, step);
  if (!set || !held) return;
  set.done = true;
  const side = pairedSide(live, step);
  if (side) {
    set.sides = { ...set.sides, [side]: Math.round(elapsedSecs) };
    if (!set.touched) set.secs = shorterSide(set.sides);
  } else if (!set.touched) set.secs = Math.round(elapsedSecs);
}

/**
 * The step's side when it is one of a left and a right window of one set (the same move, slot and set number): the
 * set is played a side at a time. Null for a hold with no side, or on one fixed side.
 */
function pairedSide(live: Live, step: Step): HoldSide | null {
  const side = sideOf(step);
  if (!side) return null;
  const pair = live.steps.some(o =>
    o !== step && o.kind === step.kind && o.exerciseId === step.exerciseId && o.slotKey === step.slotKey && o.setIndex === step.setIndex
    && o.side !== null && o.side !== step.side);
  return pair ? side : null;
}

const shorterSide = (sides: Partial<Record<HoldSide, number>>): number | null => {
  const held = Object.values(sides);
  return held.length > 0 ? Math.min(...held) : null;
};

const sideOf = (step: Step): HoldSide | null => (step.side === "Left" ? "left" : step.side === "Right" ? "right" : null);

/** Editing one side's seconds of a hold to max played a side at a time (a side held, never one that was not). */
function setSide(live: Live, exId: string, setIndex: number, side: HoldSide, secs: number): void {
  const set = live.entries[exId]?.sets[setIndex];
  if (set?.sides?.[side] === undefined) return;
  set.sides = { ...set.sides, [side]: secs };
  if (!set.touched) set.secs = shorterSide(set.sides);
}

/** The steps that count as done: every step reached but a rest, and but a hold left before half its time. */
function stepsCounted(live: Live): Step[] {
  return [...live.reached]
    .sort((a, b) => a - b)
    .filter(i => live.held?.[i] !== false)
    .map(i => live.steps[i])
    .filter((s): s is Step => Boolean(s) && s!.kind !== "rest");
}

/** The moves done: a logged one with a done set, an unlogged one with a step that counts (in the order reached). */
function movesDone(live: Live): string[] {
  return [...new Set(stepsCounted(live).map(s => s.exerciseId).filter((x): x is string => Boolean(x)))]
    .filter(id => !live.entries[id] || live.entries[id]!.sets.some(x => x.done));
}

/** The slot each move done was played in (its steps that count): none for a move played in more than one. */
function slotsPlayed(live: Live): Map<string, string> {
  const slots = new Map<string, Set<string>>();
  for (const s of stepsCounted(live)) {
    if (!s.exerciseId) continue;
    const held = slots.get(s.exerciseId) ?? new Set<string>();
    held.add(s.slotKey);
    slots.set(s.exerciseId, held);
  }
  return new Map([...slots].flatMap(([id, keys]) => (keys.size === 1 ? [[id, [...keys][0]!] as const] : [])));
}

const addSeconds = (live: Live, exId: string, secs: number): void => {
  live.secs[exId] = (live.secs[exId] || 0) + secs;
};

/**
 * Editing a set (at its place in the entry) also updates the later sets of its slot you haven't touched yet — never
 * another item's sets of the same move (a warm-up's seconds are not the main part's).
 */
function update<K extends "w" | "reps" | "secs">(live: Live, exId: string, setIndex: number, field: K, value: LiveSet[K]): void {
  const e = live.entries[exId];
  const set = e ? e.sets[setIndex] : undefined;
  if (!e || !set) return;
  write(set, field, value);
  set.touched = true;
  const keys = live.keys?.[exId];
  const slot = keys?.[setIndex] === undefined ? null : slotOfKey(keys[setIndex]!);
  for (let i = setIndex + 1; i < e.sets.length; i++) {
    if (slot !== null && (keys![i] === undefined || slotOfKey(keys![i]!) !== slot)) continue;
    if (!e.sets[i]!.touched) write(e.sets[i]!, field, value);
  }
}

/** A value written to a set; the seconds of a set held a side at a time are each side's it holds. */
function write<K extends "w" | "reps" | "secs">(set: LiveSet, field: K, value: LiveSet[K]): void {
  set[field] = value;
  if (field === "secs" && set.sides && typeof value === "number") {
    set.sides = Object.fromEntries(Object.keys(set.sides).map(k => [k, value])) as Partial<Record<HoldSide, number>>;
  }
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
  // An added set is its last set's slot's, under a number no step has.
  const keys = live.keys?.[exId];
  if (keys && keys.length === e.sets.length - 1) keys.push(`${keys.length > 0 ? slotOfKey(keys[keys.length - 1]!) : ""}#added${keys.length}`);
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
  const reachedSteps = stepsCounted(live);
  // Logged moves count when a set is done; unlogged ones (mobility, breathing) when you reached them — a hold only
  // when you held half of it (ruling 2b-R15).
  const doneIds = movesDone(live);
  const slots = slotsPlayed(live);
  const entries: SavedEntry[] = live.order.map(id => live.entries[id]!).map(e => ({
    id: e.id, implement: e.implement, log: e.log, metric: e.metric, perSide: e.perSide, format: e.format, flags: [...e.flags],
    sets: e.sets.filter(s => s.done).map(s => {
      // A hold played a side at a time: one set, the shorter side's seconds, each side's beside them — with only one side
      // done, no seconds: it measures nothing (the side's own row is kept).
      const sides = s.sides && Object.keys(s.sides).length > 0 && e.metric === "time" ? s.sides : null;
      const both = sides !== null && sides.left !== undefined && sides.right !== undefined;
      return {
        w: e.log === "load" ? s.w : null,
        reps: e.metric === "reps" ? s.reps : null,
        secs: e.metric !== "time" ? null : sides ? (both ? Math.min(sides.left!, sides.right!) : null) : s.secs,
        ...(sides ? { sides: { ...sides } } : {}),
      };
    }),
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
    movesPlanned: new Set(live.steps.filter(s => s.kind !== "rest" && s.exerciseId).map(s => s.exerciseId)).size,
    checks, note, newMove: m.newMove || null,
    done: doneIds.map(id => {
      const slotKey = slots.get(id);
      return { id, secs: Math.round(live.secs[id] || 0), ...(slotKey ? { slotKey } : {}) };
    }),
    entries,
  };
}

/**
 * A move's set keys by place: the session's own (`Live.keys`), or for one kept before them, each logged step's key at its
 * set number (a place no step names holds a key no step has).
 */
function keysOf(live: Live, exId: string): string[] {
  const held = live.keys?.[exId];
  if (held) return [...held];
  const out: string[] = [];
  for (const s of live.steps) {
    if (!s.log || s.exerciseId !== exId) continue;
    const at = s.setIndex ?? 0;
    out[at] ??= setKey(s);
  }
  return Array.from(out, (k, i) => k ?? `#none${i}`);
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
  const keys = (live.keys ??= {});
  for (const id of old.order) {
    const before = old.entries[id]!;
    if (!live.entries[id] && !before.sets.some(x => x.done)) continue;
    if (!live.entries[id]) live.order.push(id);
    // The entry as it was, every set at its place; a set the new steps hold that it never had goes after them.
    const was = keysOf(old, id);
    const fresh = keys[id] ?? [];
    const freshSets = live.entries[id]?.sets ?? [];
    const added = fresh.flatMap((k, i) => (was.includes(k) ? [] : [{ k, set: freshSets[i] ?? blankSet() }]));
    live.entries[id] = added.length === 0 ? before : { ...before, sets: [...before.sets, ...added.map(a => a.set)] };
    keys[id] = [...was, ...added.map(a => a.k)];
  }
  old.reached.forEach(k => { if (moved.has(k)) live.reached.add(moved.get(k)!); });
  for (const [k, held] of Object.entries(old.held ?? {})) if (moved.has(Number(k))) live.held![moved.get(Number(k))!] = held;
  live.secs = { ...old.secs };
  live.runningMs = old.runningMs;
  return live;
}

export const Recorder = { create, reach, finishTimed, addSeconds, update, setDone, addSet, setFlag, setSide, logStepIndex, toSession, rebase, movesDone, placeOf };

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

/** `rec` with `exId` set to `value` — or without it when `value` is what is saved: no decision is left (ruling 2b-R17). */
function decide<T>(rec: Readonly<Record<string, T>>, exId: string, value: T, saved: T): Record<string, T> {
  const { [exId]: _dropped, ...rest } = rec;
  return value === saved ? rest : { ...rest, [exId]: value };
}

/**
 * 👍 / 👎 toggles against what's saved plus what's pending; "never" toggles "not for me". A toggle back to what is saved
 * leaves no pending decision for the move (ruling 2b-R17: a rating taken off again is no rating, and the save names no
 * key for it); taking off a SAVED rating is a decision — null, to clear it.
 */
function rate(review: ReviewState, prefs: Pick<Prefs, "ratings" | "excluded">, exId: string, value: 1 | -1 | "never"): ReviewState {
  if (value === "never") {
    return { ...review, excluded: decide(review.excluded, exId, !excludedNow(prefs, review, exId), prefs.excluded.includes(exId)) };
  }
  const next = ratingNow(prefs, review, exId) === value ? null : value;
  return { ...review, ratings: decide(review.ratings, exId, next, prefs.ratings[exId] ?? null) };
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

/**
 * The review with every "yes" to an offer that no longer stands dropped. Call it each time the offers are
 * recomputed (after every edit), as the standalone review did, so an offer that is withdrawn and then comes back
 * returns unaccepted.
 */
const prune = (review: ReviewState, offers: readonly ReviewOffer[]): ReviewState => ({ ...review, graduate: stillOffered(offers, review.graduate) });

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

export const Review = { start: startReview, rate, graduate: graduateInReview, stillOffered, prune, pending, effectivePrefs, apply: applyReview };
