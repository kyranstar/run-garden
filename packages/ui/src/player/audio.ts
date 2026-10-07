/**
 * CHIMES (spec §2b "Player"; spike report docs/reports/2026-10-07-offline-spike.md, "Audio, 30 minutes").
 *
 *  - Audio is unlocked inside the Start tap: `unlock()` makes (or resumes) the one AudioContext in the click handler.
 *    WebKit keeps a context made any other time suspended. Nothing is made before that.
 *  - Chimes are scheduled on the audio clock, so they play on time while timers are throttled (a background tab) —
 *    and each one is placed from its WALL-CLOCK due time when it is scheduled: `currentTime + (dueAt − now) / 1000`.
 *    The spike saw the audio clock stall and fall 2 s behind once; an offset taken at Start would carry that drift.
 *  - Scheduling replaces what was scheduled (a pause, a skip, a step change); a chime already due is not played late.
 */

/** What the player uses of an AudioContext (a test hands in a fake). */
export interface AudioContextLike {
  state: AudioContextState;
  currentTime: number;
  destination: AudioNode | object;
  resume(): Promise<void>;
  createOscillator(): Pick<OscillatorNode, "frequency" | "connect" | "disconnect" | "start" | "stop">;
  createGain(): Pick<GainNode, "gain" | "connect" | "disconnect">;
}

export interface Chimes {
  /** In a tap: make or resume the audio context. */
  unlock(): void;
  /** Replace what is scheduled with chimes at these epoch-ms times. */
  schedule(dueAt: readonly number[], now?: number): void;
  cancel(): void;
}

const CHIME_HZ = 880;
const CHIME_SECS = 0.25;

function makeContext(): AudioContextLike | null {
  const Ctor = (globalThis as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: new () => AudioContext }).webkitAudioContext;
  return Ctor ? (new Ctor() as unknown as AudioContextLike) : null;
}

export function createChimes(make: () => AudioContextLike | null = makeContext): Chimes {
  let ctx: AudioContextLike | null = null;
  let pending: Array<{ osc: ReturnType<AudioContextLike["createOscillator"]>; gain: ReturnType<AudioContextLike["createGain"]> }> = [];

  const cancel = () => {
    for (const p of pending) {
      try {
        p.osc.stop(0);
        p.osc.disconnect();
        p.gain.disconnect();
      } catch {
        // already stopped
      }
    }
    pending = [];
  };

  return {
    unlock() {
      try {
        ctx ??= make();
        if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      } catch {
        ctx = null;
      }
    },
    schedule(dueAt, now = Date.now()) {
      cancel();
      if (!ctx) return;
      for (const due of dueAt) {
        if (due < now) continue;
        const at = ctx.currentTime + (due - now) / 1000;
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = CHIME_HZ;
          gain.gain.value = 0.2;
          osc.connect(gain as unknown as AudioNode);
          gain.connect(ctx.destination as AudioNode);
          osc.start(at);
          osc.stop(at + CHIME_SECS);
          pending.push({ osc, gain });
        } catch {
          // a closed context: no chime
        }
      }
    },
    cancel,
  };
}

/** The app's chimes: one context for the page, unlocked by Start (or the first tap after a reload). */
export const chimes = createChimes();
