/**
 * Now playing, read only while it can be seen (the music dock, 2026-10-17): Spotify's development-mode quotas are low,
 * so `GET /me/player` is read only while the dock is expanded AND the page visible — at once, then every 5 s. Asked to
 * slow down, the next read waits out the shared backoff (music/backoff.ts: the client refuses every call while it
 * lasts, so a read due meanwhile never reaches the network), and the dock is told. Collapsed or hidden, nothing is read
 * and no timer is left.
 */
import { isSlowDown, type PlayerState } from "./spotify.js";

export const POLL_MS = 5_000;

export interface PollerDeps {
  read: () => Promise<PlayerState | null>;
  onState: (state: PlayerState | null) => void;
  onError?: (e: unknown) => void;
  /** Run `fn` after `ms`; answers a cancel. */
  schedule: (fn: () => void, ms: number) => () => void;
}

export function makePoller(deps: PollerDeps) {
  let active = false;
  let cancel: (() => void) | null = null;
  /** Bumped on every stop, so a read that was in flight when the dock closed never schedules another. */
  let generation = 0;

  const stop = () => {
    generation += 1;
    cancel?.();
    cancel = null;
  };

  function queue(ms: number, gen: number) {
    cancel = deps.schedule(() => {
      cancel = null;
      void tick(gen);
    }, ms);
  }

  async function tick(gen: number) {
    let wait = POLL_MS;
    try {
      const state = await deps.read();
      if (gen !== generation) return;
      deps.onState(state);
    } catch (e) {
      if (gen !== generation) return;
      if (isSlowDown(e)) wait = Math.max(POLL_MS, e.retryAfterMs ?? POLL_MS);
      deps.onError?.(e);
    }
    // The dock may have stopped it from inside `onState` or `onError` (a sign-in gone): a read queued under the old
    // generation would still go out (its token ask) before being dropped.
    if (gen !== generation) return;
    queue(wait, gen);
  }

  return {
    /** The dock's state: reading runs exactly while both are true — at once, or after `firstDelayMs` when the caller
     * has just read itself. */
    set(s: { expanded: boolean; visible: boolean }, opts: { firstDelayMs?: number } = {}) {
      const next = s.expanded && s.visible;
      if (next === active) return;
      active = next;
      stop();
      if (active) queue(opts.firstDelayMs ?? 0, generation);
    },
    stop() {
      active = false;
      stop();
    },
  };
}
