/**
 * THE SESSION BEING PLAYED (Phase 2 spec §2b "Player"; plan Task 4). A pure state machine over the session engine's
 * recorder, run in the browser against the build's own exercise slice — never the whole library — so it works with
 * the network off. Every change returns a new state; the screen keeps it, and `toLiveSession` is what IndexedDB holds.
 *
 *  - Steps come from the locked build. Arriving at a set counts it (the recorder's rule); a timed hold counts when
 *    it is left, if at least half of it was held (`finishTimed`), at the time held — never more than the hold.
 *  - Timers are wall-clock anchored (`timer.ts`). `settle` catches up with the clock: a timed step or a rest whose
 *    time has run out ends at the moment it ran out and, with auto-advance on, the next step starts from that moment
 *    — so a phone locked mid-hold resumes on the step the clock says, each hold judged at the time it could be held.
 *    A set never runs out: it waits for Done.
 *  - A pause stops the step's timer and the session's running time together (`seconds` on the save is time running).
 *  - The new move's how-to holds the countdown the first time it comes up (`howto`), until it is closed.
 */
import type { SessionBuildDto, SessionViewDto } from "@rg/api-client";
import type { Weight } from "@rg/domain";
import { isProfileId, makeEngineData, type CheckReading, type EngineData, type ExerciseRecord } from "@rg/exercise-library";
import { Recorder, Swapping, type Live, type LiveEntry, type PerformedSessionSave, type SlotChoice, type Step } from "@rg/session-engine";
import type { LiveSession } from "../offline/live.js";
import { elapsedMs, heldSecs, lengthMs, phaseAt, runningClock, startClock, stopClock, stoppedClock, type PhaseView, type StepClock } from "./timer.js";

/** What the player plays: a locked build, its view, and the switched-on condition profiles. */
export interface PlayerSource {
  workoutId: string;
  build: SessionBuildDto;
  view: SessionViewDto;
  /** The switched-on condition profile ids (their rules, flags and checks). */
  profiles: readonly string[];
}

export interface PlayerState {
  workoutId: string;
  performedId: string;
  buildId: string;
  /** Epoch ms of Start. */
  startedAt: number;
  live: Live;
  index: number;
  /** The current step's timer. */
  clock: StepClock;
  /** The session's running time. */
  session: StepClock;
  paused: boolean;
  /** Seconds added to a rest (+15 s), by step index. */
  restExtra: Record<number, number>;
  /** Past the last step (or ended early): the review is next. */
  finished: boolean;
  /** The new move's how-to has been shown once. */
  newMoveShown: boolean;
  /** An exercise whose how-to should open now (the new move, the first time it comes up). */
  howto: string | null;
  /** Swaps made mid-session, in order: the slot and the move it holds now. */
  swaps: Array<{ slotKey: string; to: string }>;
}

/** What IndexedDB's `live` store keeps as the recorder state (plain data: no Set). */
export interface PlayerRecord {
  kind: "rg-player";
  v: 1;
  live: Omit<Live, "reached"> & { reached: number[] };
  session: StepClock;
  restExtra: Record<number, number>;
  finished: boolean;
  newMoveShown: boolean;
  howto: string | null;
  swaps: Array<{ slotKey: string; to: string }>;
}

/** The engine data the recorder needs: the build's slice of the library and the switched-on profiles' rules. */
export function playerData(src: Pick<PlayerSource, "build" | "profiles">): EngineData {
  return makeEngineData({
    activeProfiles: src.profiles.filter(isProfileId),
    careProfiles: [],
    exercises: Object.values(src.build.exercises) as unknown as ExerciseRecord[],
  });
}

const serialize = (live: Live): PlayerRecord["live"] => JSON.parse(JSON.stringify({ ...live, reached: [...live.reached] })) as PlayerRecord["live"];
const deserialize = (live: PlayerRecord["live"]): Live => ({ ...live, reached: new Set(live.reached) });
const cloneLive = (live: Live): Live => deserialize(serialize(live));
/** A working copy: the recorder changes what it is given. */
const draft = (s: PlayerState): PlayerState => ({ ...s, live: cloneLive(s.live), restExtra: { ...s.restExtra }, swaps: [...s.swaps] });

const stepAt = (s: PlayerState, i = s.index): Step | undefined => s.live.steps[i];

/** Leaving the current step at `now`: a hold is judged by the half-time rule; time on a move is added to it. */
function leave(s: PlayerState, now: number): void {
  const step = stepAt(s);
  if (!step || s.finished) return;
  const elapsed = elapsedMs(s.clock, now);
  if (step.kind === "timed") {
    const held = heldSecs(step, elapsed);
    Recorder.finishTimed(s.live, s.index, held);
    if (step.exerciseId) Recorder.addSeconds(s.live, step.exerciseId, held);
  } else if (step.kind === "set" && step.exerciseId) {
    Recorder.addSeconds(s.live, step.exerciseId, elapsed / 1000);
  }
}

/** Arriving at step `i`, its timer starting at `from` (stopped while paused). Past the end, the session is finished. */
function arrive(s: PlayerState, i: number, from: number, newMove: string | null): void {
  s.index = i;
  const step = stepAt(s, i);
  if (!step) {
    s.finished = true;
    s.clock = stoppedClock();
    s.session = stopClock(s.session, from);
    s.paused = false;
    return;
  }
  Recorder.reach(s.live, i);
  s.clock = s.paused ? stoppedClock() : runningClock(from);
  if (newMove && step.exerciseId === newMove && !s.newMoveShown) {
    // The new move's how-to holds the countdown until it is closed.
    s.newMoveShown = true;
    s.howto = step.exerciseId;
    s.paused = true;
    s.clock = stoppedClock();
    s.session = stopClock(s.session, from);
  }
}

export function beginPlayer(src: PlayerSource, data: EngineData, opts: { performedId: string; now: number }): PlayerState {
  const { build, view } = src;
  const checks: Record<string, CheckReading> = {};
  for (const [id, c] of Object.entries(build.params.checks ?? {})) checks[id] = { pre: c.pre, post: null, feelingOff: !!c.feelingOff };
  const live = Recorder.create(data, { steps: build.steps, plannedSeconds: build.plannedSeconds }, {
    id: opts.performedId,
    startedAt: new Date(opts.now).toISOString(),
    date: build.date,
    mode: build.mode,
    theme: build.theme,
    locationId: build.locationId,
    minutes: build.minutes,
    block: build.blockRef ? { id: build.blockRef, number: view.block?.number ?? 0 } : null,
    checks,
    equipment: view.location.equipment,
    plannedSeconds: build.plannedSeconds,
    newMove: build.newMove,
  });
  const s: PlayerState = {
    workoutId: src.workoutId,
    performedId: opts.performedId,
    buildId: build.buildId,
    startedAt: opts.now,
    live,
    index: 0,
    clock: stoppedClock(),
    session: runningClock(opts.now),
    paused: false,
    restExtra: {},
    finished: false,
    newMoveShown: false,
    howto: null,
    swaps: [],
  };
  arrive(s, 0, opts.now, build.newMove);
  return s;
}

/** Catch up with the wall clock: timed steps and rests whose time has run out end, and (auto-advance) the next starts. */
export function settle(state: PlayerState, now: number, opts: { autoAdvance: boolean }): PlayerState {
  if (state.paused || state.finished || !opts.autoAdvance) return state;
  let s: PlayerState | null = null;
  for (let guard = 0; guard < 10_000; guard++) {
    const cur = s ?? state;
    const step = stepAt(cur);
    if (!step || cur.paused || cur.finished) break;
    const length = lengthMs(step, cur.restExtra[cur.index] ?? 0);
    if (length === null) break;
    const elapsed = elapsedMs(cur.clock, now);
    if (elapsed < length) break;
    // It ran out at `endedAt`; the next step began then.
    const endedAt = now - (elapsed - length);
    s = s ?? draft(state);
    leave(s, endedAt);
    arrive(s, s.index + 1, endedAt, s.live.meta.newMove);
  }
  return s ?? state;
}

/** Next, Skip, → : leave this step (a hold judged by the half-time rule) and go on; past the last step, finished. */
export function next(state: PlayerState, now: number): PlayerState {
  if (state.finished) return state;
  const s = draft(state);
  leave(s, now);
  arrive(s, s.index + 1, now, s.live.meta.newMove);
  return s;
}

/** ← : back one step, its timer from the start. */
export function prev(state: PlayerState, now: number): PlayerState {
  if (state.finished || state.index === 0) return state;
  const s = draft(state);
  leave(s, now);
  arrive(s, s.index - 1, now, s.live.meta.newMove);
  return s;
}

export function pause(state: PlayerState, now: number): PlayerState {
  if (state.paused || state.finished) return state;
  return { ...state, paused: true, clock: stopClock(state.clock, now), session: stopClock(state.session, now) };
}

export function resume(state: PlayerState, now: number): PlayerState {
  if (!state.paused || state.finished) return state;
  return { ...state, paused: false, clock: startClock(state.clock, now), session: startClock(state.session, now) };
}

/** The how-to that held the countdown is closed: carry on. */
export function closeHowto(state: PlayerState, now: number): PlayerState {
  return resume({ ...state, howto: null }, now);
}

/** +15 s on a rest. */
export function addRest(state: PlayerState, secs: number): PlayerState {
  const step = stepAt(state);
  if (!step || step.kind !== "rest") return state;
  return { ...state, restExtra: { ...state.restExtra, [state.index]: (state.restExtra[state.index] ?? 0) + secs } };
}

/**
 * ⇄ mid-session: the slot holds `choice` from here on — its remaining sets are the choice's own steps (exactly as
 * offered), every other step stays, and what was reached and logged is kept (`Recorder.rebase`). A set of the slot
 * that is playing now starts again as the new move's.
 */
export function swapSlot(state: PlayerState, data: EngineData, slotKey: string, choice: SlotChoice, now: number): PlayerState {
  if (state.finished) return state;
  const s = draft(state);
  const inSlot = (st: Step | undefined) => !!st && st.kind !== "rest" && st.slotKey === slotKey;
  const current = stepAt(s);
  const playing = inSlot(current);
  // The set being played is played as the new move: the old move's set was reached, not done.
  if (playing && current!.kind === "set" && current!.exerciseId) Recorder.setDone(s.live, current!.exerciseId, current!.setIndex ?? 0, false);
  const steps = Swapping.splice(s.live.plan.steps, slotKey, choice.steps);
  s.live = Recorder.rebase(data, s.live, { steps, plannedSeconds: Swapping.costOf(steps) }, s.index, slotKey);
  s.swaps = [...s.swaps.filter((x) => x.slotKey !== slotKey), { slotKey, to: choice.id }];
  if (playing) arrive(s, s.index, now, null);
  return s;
}

/** Stop where it is (the last step done, or ended early): the review is next. */
export function endSession(state: PlayerState, now: number): PlayerState {
  if (state.finished) return state;
  const s = draft(state);
  leave(s, now);
  s.finished = true;
  s.paused = false;
  s.clock = stoppedClock();
  s.session = stopClock(s.session, now);
  return s;
}

export interface StepView extends PhaseView {
  step: Step;
}

export function stepView(state: PlayerState, now: number): StepView {
  const step = stepAt(state)!;
  return { step, ...phaseAt(step, elapsedMs(state.clock, now), state.restExtra[state.index] ?? 0) };
}

export interface LogTarget {
  exerciseId: string;
  setIndex: number;
  entry: LiveEntry;
  w: Weight | null;
  reps: number | null;
  secs: number | null;
}

/** The set the log card edits: the current set, or during a rest the set just finished. */
export function logTarget(state: PlayerState): LogTarget | null {
  const k = Recorder.logStepIndex(state.live, state.index);
  const step = k === null ? undefined : state.live.steps[k];
  if (!step || !step.exerciseId) return null;
  const entry = state.live.entries[step.exerciseId];
  const setIndex = step.setIndex ?? 0;
  const set = entry?.sets[setIndex];
  if (!entry || !set) return null;
  return { exerciseId: step.exerciseId, setIndex, entry, w: set.w, reps: set.reps, secs: set.secs };
}

const sameWeight = (a: Weight | null, b: Weight | null) => (a === null || b === null ? a === b : a.v === b.v && a.u === b.u);

/**
 * The log card's values for the set, written as the recorder writes an edit (a changed value also fills the later
 * sets not touched yet), with the profiles' set flags; on a set, Confirm then goes on (to the rest).
 */
export function editLog(
  state: PlayerState,
  values: { w?: Weight | null; reps?: number | null; secs?: number | null },
  flags: Readonly<Record<string, boolean>>,
): PlayerState {
  const t = logTarget(state);
  if (!t) return state;
  const s = draft(state);
  if (values.w !== undefined && !sameWeight(values.w, t.w)) Recorder.update(s.live, t.exerciseId, t.setIndex, "w", values.w);
  if (values.reps !== undefined && values.reps !== t.reps) Recorder.update(s.live, t.exerciseId, t.setIndex, "reps", values.reps);
  if (values.secs !== undefined && values.secs !== t.secs) Recorder.update(s.live, t.exerciseId, t.setIndex, "secs", values.secs);
  for (const [flag, on] of Object.entries(flags)) {
    if (s.live.entries[t.exerciseId]!.flags.includes(flag) !== on) Recorder.setFlag(s.live, t.exerciseId, flag, on);
  }
  return s;
}

export function confirmLog(
  state: PlayerState,
  values: { w?: Weight | null; reps?: number | null; secs?: number | null },
  flags: Readonly<Record<string, boolean>>,
  now: number,
): PlayerState {
  const edited = editLog(state, values, flags);
  return stepAt(edited)?.kind === "set" ? next(edited, now) : edited;
}

/** The recorder's save: the session as performed, with its running time. */
export function saveOf(
  state: PlayerState,
  opts: { endedAt: string; post?: Readonly<Record<string, number | null>>; note?: string; completed?: boolean },
): PerformedSessionSave {
  const live = cloneLive(state.live);
  live.runningMs = elapsedMs(state.session, Date.parse(opts.endedAt));
  return Recorder.toSession(live, opts);
}

export function toLiveSession(state: PlayerState, now: number): LiveSession<PlayerRecord> {
  return {
    workoutId: state.workoutId,
    performedId: state.performedId,
    buildId: state.buildId,
    recorder: {
      kind: "rg-player",
      v: 1,
      live: serialize(state.live),
      session: state.session,
      restExtra: state.restExtra,
      finished: state.finished,
      newMoveShown: state.newMoveShown,
      howto: state.howto,
      swaps: state.swaps,
    },
    stepIndex: state.index,
    timerAnchor: state.clock.anchor,
    timerBankedMs: state.clock.bankedMs,
    paused: state.paused,
    startedAt: state.startedAt,
    updatedAt: now,
  };
}

const isRecord = (r: unknown): r is PlayerRecord => {
  const x = r as Partial<PlayerRecord> | null;
  return !!x && x.kind === "rg-player" && x.v === 1 && !!x.live && Array.isArray(x.live.steps) && Array.isArray(x.live.reached);
};

/** The session as IndexedDB holds it, for this build; null when it is not one the player can resume. */
export function fromLiveSession(stored: LiveSession<unknown>, src: Pick<PlayerSource, "workoutId" | "build">): PlayerState | null {
  if (stored.workoutId !== src.workoutId || stored.buildId !== src.build.buildId || !isRecord(stored.recorder)) return null;
  const r = stored.recorder;
  return {
    workoutId: stored.workoutId,
    performedId: stored.performedId,
    buildId: stored.buildId,
    startedAt: stored.startedAt,
    live: deserialize(r.live),
    index: stored.stepIndex,
    clock: { anchor: stored.timerAnchor, bankedMs: stored.timerBankedMs },
    session: r.session,
    paused: stored.paused,
    restExtra: { ...r.restExtra },
    finished: r.finished,
    newMoveShown: r.newMoveShown,
    howto: r.howto,
    swaps: [...r.swaps],
  };
}
