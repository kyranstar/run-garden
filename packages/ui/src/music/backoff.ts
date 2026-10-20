/**
 * Backing off when Spotify says "slow down" (the music dock, 2026-10-19): one state for every call the dock makes — the
 * poller's reads, a play, the playlists listed in the add flow, a playlist's details — so nothing goes out while it
 * lasts (music/spotify.ts checks it before every request, and a call it refuses never reaches the network).
 *
 * A 429 backs off for the longer of Spotify's Retry-After (when the page can read it: a browser often hides it, CORS)
 * and the step's own wait, which doubles from 30 s at each 429 in a row to about 15 minutes at most (a 429 for a call
 * that was already out when the backoff began is the same step). Only a success resets the steps. Kept on the device,
 * so a reload doesn't start the count over (a private window: for the visit).
 */

export const BACKOFF_FIRST_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const BACKOFF_KEY = "rg-music-backoff";

export interface Backoff {
  /** How long is left, in ms; 0 when calls may go. */
  remaining(): number;
  /** A 429: back off (the larger of Spotify's wait, when known, and the step's); answers the wait. */
  hit(retryAfterMs: number | null): number;
  /** A call answered: the steps start over. */
  ok(): void;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safeStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function makeBackoff(deps: { now: () => number; storage?: Store | null }): Backoff {
  const storage = deps.storage === undefined ? safeStorage() : deps.storage;
  let until = 0;
  let step = 0;
  try {
    const raw = storage?.getItem(BACKOFF_KEY);
    const v = raw ? (JSON.parse(raw) as { until?: unknown; step?: unknown }) : null;
    if (v && typeof v.until === "number" && typeof v.step === "number" && Number.isFinite(v.until) && v.step >= 0) {
      // Never longer than the most a step waits from now (a clock moved back can't hold it for good).
      until = Math.min(v.until, deps.now() + BACKOFF_MAX_MS);
      step = Math.min(Math.floor(v.step), 10);
    }
  } catch {
    /* nothing kept: none */
  }
  const keep = () => {
    try {
      if (step === 0) storage?.removeItem(BACKOFF_KEY);
      else storage?.setItem(BACKOFF_KEY, JSON.stringify({ until, step }));
    } catch {
      /* no storage: for this visit */
    }
  };
  return {
    remaining: () => Math.max(0, until - deps.now()),
    hit(retryAfterMs) {
      // A call already out when the backoff began: the same step (only Spotify's own wait can lengthen it).
      if (until > deps.now()) {
        until = Math.max(until, deps.now() + Math.min(BACKOFF_MAX_MS, retryAfterMs ?? 0));
        keep();
        return until - deps.now();
      }
      const own = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** step);
      const wait = Math.min(BACKOFF_MAX_MS, Math.max(own, retryAfterMs ?? 0));
      until = deps.now() + wait;
      step += 1;
      keep();
      return wait;
    },
    ok() {
      if (step === 0) return;
      step = 0;
      until = 0;
      keep();
    },
  };
}

/** "back in about 4 minutes" — the time left, said calmly (never seconds to the second). */
export function backInWords(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  return min <= 1 ? "back in about a minute" : `back in about ${min} minutes`;
}
