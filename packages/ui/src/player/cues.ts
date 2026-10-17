/**
 * THE SESSION'S CUES, PLANNED (the sound pass, 2026-10-17): where the session stands → the cues the cue player places
 * (`cue-player.ts`), in epoch ms. Pure: the player calls it again whenever the step, its clock, a pause or a rest's
 * length changes, and every 30 s (so cues past the cue player's window are placed as they come into it).
 *
 *  - A get-ready: ticks at its end −3, −2 and −1 s (the countdown's 3, 2, 1; only those inside it), then go.
 *  - The end of a timed hold: ticks at −3, −2, −1 s when it lasts 4 s or more; then what comes next — rest (a rest),
 *    switch (the same move's other side), done (the last step), next (anything else: a new move, a set).
 *  - The end of a rest: next when the step after it opens with a get-ready (no ticks: the get-ready's own lead into go);
 *    when work starts at once, ticks and go.
 *  - A hold to max: its get-ready's ticks, go, then target at its target; nothing after it (it ends on Done).
 *  - A set ends the plan (it waits for Done), as does auto-advance off after the step in play.
 *  - Spacing: two runs of ticks are never within 5 s of each other — the earlier goes, since the later leads into what
 *    comes next (a get-ready's into go), and a plan made later, from that step on, says the same; a tick within 0.5 s
 *    of another cue goes; a tick never comes before its step began.
 *  - Only what is ahead: after `now` (a cue due at `now` itself is the plan before's, and plays from there), and within
 *    the cue player's window.
 *  - A session finished by a tap plays done at once — unless a done was already due (a session that ran out to its end,
 *    or a Next after the last hold's own done): never twice.
 *
 * And the calm signal (`calmSession`), which picks bowls over soft keys when the palette is automatic.
 */
import type { SessionBuildDto, SessionExerciseDto } from "@rg/api-client";
import { isPlyometric } from "@rg/exercise-library";
import type { Live, Step } from "@rg/session-engine";
import { WINDOW_MS, type Cue, type CueKind } from "./cue-player.js";
import { goesToMax, type PlayerState } from "./run.js";
import { lengthMs, readyMs } from "./timer.js";

/** What the plan reads of the session. */
export type CueState = Pick<PlayerState, "index" | "clock" | "paused" | "finished" | "finishedAt" | "restExtra" | "toMax"> & {
  live: Pick<Live, "steps">;
};

export interface PlanOpts {
  /** "Move on when a timer ends". */
  auto: boolean;
  now: number;
  /** The plan given before this one: a finished session's done is never played twice. */
  played?: readonly Cue[];
}

/** Two runs of ticks closer than this: the earlier goes. */
export const RUN_GAP_MS = 5000;
/** A tick closer than this to another cue goes. */
export const NEAR_MS = 500;
/** "At once": a moment ahead, so the cue player (which leaves what is already due) still places it. */
export const AT_ONCE_MS = 50;
/** A finish this recent was the tap's own; older, it is a session opened again on its review. */
export const FRESH_FINISH_MS = 2000;
/** A hold counts as a run of ticks only when it lasts this long. */
const TICKED_HOLD_MS = 4000;
/** Steps are planned until one starts this far past the window: what is dropped never depends on what is unseen. */
const LOOKAHEAD_MS = WINDOW_MS + 10_000;

export function planCues(state: CueState, opts: PlanOpts): Cue[] {
  const { now } = opts;
  if (state.finished) {
    const fresh = state.finishedAt !== null && now - state.finishedAt <= FRESH_FINISH_MS;
    const had = (opts.played ?? []).some((c) => c.kind === "done" && c.at <= now);
    return fresh && !had ? [{ at: now + AT_ONCE_MS, kind: "done" }] : [];
  }
  if (state.paused || state.clock.anchor === null) return [];

  const steps = state.live.steps;
  const marks: Cue[] = [];
  const runs: Cue[][] = [];
  /** The countdown into `end`: its ticks at −3, −2, −1 s, none before `floor` (the start of the step it belongs to). */
  const countdown = (end: number, floor: number) => {
    const run: Cue[] = [];
    for (const n of [3, 2, 1] as const) if (end - n * 1000 >= floor) run.push({ at: end - n * 1000, kind: "tick", n });
    runs.push(run);
  };
  const mark = (at: number, kind: CueKind) => marks.push({ at, kind });

  let start = state.clock.anchor - state.clock.bankedMs;
  for (let i = state.index; i < steps.length && start <= now + LOOKAHEAD_MS; i++) {
    const step = steps[i]!;
    const after = steps[i + 1];
    if (step.kind === "set") break;
    const length = lengthMs(step, state.restExtra[i] ?? 0);
    if (length === null) break;
    if (step.kind === "timed") {
      const ready = readyMs(step);
      if (ready > 0) {
        countdown(start + ready, start);
        mark(start + ready, "go");
      }
      if (goesToMax(state, step)) {
        mark(start + ready + step.seconds * 1000, "target");
        break;
      }
      const end = start + length;
      if (step.seconds * 1000 >= TICKED_HOLD_MS) countdown(end, start + ready);
      mark(end, holdEnd(step, after));
    } else {
      // A rest.
      const end = start + length;
      if (!after) mark(end, "done");
      else if (after.kind === "rest" || readyMs(after) > 0) mark(end, "next");
      else {
        countdown(end, start);
        mark(end, "go");
      }
    }
    start += length;
    if (!opts.auto) break;
  }

  // A tick near another cue goes; then, of two runs closer than RUN_GAP_MS, the earlier (walking back from the last).
  const near = (t: Cue) => marks.some((m) => Math.abs(m.at - t.at) < NEAR_MS);
  const kept: Cue[][] = [];
  for (const run of runs.map((r) => r.filter((t) => !near(t))).filter((r) => r.length > 0).reverse()) {
    const later = kept[kept.length - 1];
    if (later && later[0]!.at - run[run.length - 1]!.at < RUN_GAP_MS) continue;
    kept.push(run);
  }
  return [...marks, ...kept.flat()].filter((c) => c.at > now && c.at - now <= WINDOW_MS).sort((a, b) => a.at - b.at);
}

/** What the end of a timed hold says: what comes after it. */
function holdEnd(step: Step, after: Step | undefined): CueKind {
  if (!after) return "done";
  if (after.kind === "rest") return "rest";
  if (after.exerciseId && after.exerciseId === step.exerciseId && after.side && step.side && after.side !== step.side) return "switch";
  return "next";
}

/** A HOLD this long or longer is slow enough for a calm session. */
export const CALM_HOLD_SECS = 45;

/**
 * A strength or jumping move: never part of a calm session. A move kept in a build before records had purposes (an
 * in-progress session from before 2026-10-10) is read without them, never a crash: this runs as the player renders.
 */
const effortful = (ex: SessionExerciseDto | undefined): boolean =>
  !!ex && (!!ex.purposes?.includes("strength") || !!ex.purposes?.includes("power") || isPlyometric(ex));

/**
 * A calm session — bowls, when the palette is automatic: a recovery session (an engine build's mode, or a document's
 * "recover" effort, whose mode it is), or a slow held one like yin yoga: every timed hold 45 s or longer, with no sets
 * and no strength or jumping move.
 */
export function calmSession(live: Pick<Live, "meta" | "steps">, build: Pick<SessionBuildDto, "fromDoc" | "exercises">): boolean {
  if (live.meta.mode === "recovery" || build.fromDoc?.effort === "recover") return true;
  const work = live.steps.filter((s) => s.kind !== "rest");
  if (work.length === 0 || work.some((s) => s.kind === "set")) return false;
  return work.every((s) => s.seconds >= CALM_HOLD_SECS && !effortful(s.exerciseId ? build.exercises[s.exerciseId] : undefined));
}
