/**
 * WALL-CLOCK TIMERS (Phase 2 spec §2b "Player"; plan Global Constraints). A timer is the epoch ms it was last started
 * from plus the time it had already run: what has elapsed is always worked out from `Date.now()`, never by counting
 * ticks, so a backgrounded tab, a locked phone or a relaunch reads the true time on its next look.
 */
import type { Step } from "@rg/session-engine";

export interface StepClock {
  /** Epoch ms the clock was last started from; null while it is stopped. */
  anchor: number | null;
  /** Milliseconds run before `anchor` (time kept across pauses). */
  bankedMs: number;
}

export const stoppedClock = (bankedMs = 0): StepClock => ({ anchor: null, bankedMs });
export const runningClock = (from: number): StepClock => ({ anchor: from, bankedMs: 0 });

export function elapsedMs(clock: StepClock, now: number): number {
  return clock.bankedMs + (clock.anchor === null ? 0 : Math.max(0, now - clock.anchor));
}

export const startClock = (clock: StepClock, now: number): StepClock =>
  clock.anchor === null ? { anchor: now, bankedMs: clock.bankedMs } : clock;

export const stopClock = (clock: StepClock, now: number): StepClock =>
  clock.anchor === null ? clock : { anchor: null, bankedMs: elapsedMs(clock, now) };

/** The get-ready before a timed step: 8 s, or 3 s inside flows and circuits (the step's own `prepGap`). */
export const readyMs = (step: Step): number => (step.kind === "timed" ? (step.prepGap || 0) * 1000 : 0);

/** How long a step's timer runs: get-ready + hold for a timed step, the rest (plus any +15 s) for a rest; a set has none. */
export function lengthMs(step: Step, extraSecs = 0): number | null {
  if (step.kind === "timed") return readyMs(step) + step.seconds * 1000;
  if (step.kind === "rest") return (step.seconds + extraSecs) * 1000;
  return null;
}

export type Phase = "ready" | "hold" | "rest" | "set" | "over";

export interface PhaseView {
  phase: Phase;
  /** Left in this phase (0 when over; for a set, 0). */
  remainingMs: number;
  /** The whole step's elapsed time. */
  elapsedMs: number;
  /** The phase's own length (for the ring), or 0 for a set. */
  phaseMs: number;
}

/** Where a step stands after `elapsed` ms of its timer. */
export function phaseAt(step: Step, elapsed: number, extraSecs = 0): PhaseView {
  if (step.kind === "set") return { phase: "set", remainingMs: 0, elapsedMs: elapsed, phaseMs: 0 };
  const length = lengthMs(step, extraSecs)!;
  if (elapsed >= length) return { phase: "over", remainingMs: 0, elapsedMs: elapsed, phaseMs: step.kind === "rest" ? length : step.seconds * 1000 };
  if (step.kind === "rest") return { phase: "rest", remainingMs: length - elapsed, elapsedMs: elapsed, phaseMs: length };
  const ready = readyMs(step);
  if (elapsed < ready) return { phase: "ready", remainingMs: ready - elapsed, elapsedMs: elapsed, phaseMs: ready };
  return { phase: "hold", remainingMs: length - elapsed, elapsedMs: elapsed, phaseMs: step.seconds * 1000 };
}

/** Seconds of a timed step's hold actually held: its timer past the get-ready, never more than the hold. */
export function heldSecs(step: Step, elapsed: number): number {
  if (step.kind !== "timed") return 0;
  return Math.min(step.seconds, Math.max(0, elapsed - readyMs(step)) / 1000);
}

/** "0:48", "14:06", "1:02:05". */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
