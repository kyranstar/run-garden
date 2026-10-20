/**
 * Backing off when Spotify says "slow down" (the music dock, 2026-10-19): one state for every call the dock makes — the
 * poller's reads, a play, the playlists listed in the add flow, a playlist's details, a token the Worker can't refresh —
 * so nothing goes out while it lasts (music/spotify.ts checks it before every request, and a call it refuses never
 * reaches the network).
 *
 * A 429 backs off for the longer of Spotify's Retry-After (when the page can read it: a browser often hides it, CORS)
 * and the step's own wait, which doubles from 30 s at each 429 in a row to about 15 minutes at most (a 429 for a call
 * that was already out when the backoff began is the same step). Only a success resets the steps — and only once the
 * backoff has run out: while it runs every new call is refused, so a success that lands then was sent before the 429
 * and says nothing about now (review-M I2). Kept on the device, so a reload doesn't start the count over (a private
 * window: for the visit), and heard by the other tabs as it is kept (the `storage` event: review-M M6).
 */

export const BACKOFF_FIRST_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const BACKOFF_KEY = "rg-music-backoff";

export interface Backoff {
  /** How long is left, in ms; 0 when calls may go. */
  remaining(): number;
  /** A 429: back off (the larger of Spotify's wait, when known, and the step's); answers the wait. */
  hit(retryAfterMs: number | null): number;
  /** A call answered: the steps start over — unless the backoff still runs (that call left before it began). */
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

/** The page's own: another tab's change to the kept backoff, as the browser reports it. */
function storageEvents(fn: (raw: string | null) => void): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === BACKOFF_KEY) fn(e.newValue);
  });
}

export function makeBackoff(deps: {
  now: () => number;
  storage?: Store | null;
  /** Hears the kept backoff change in another tab (default: the window's `storage` event, with the default storage). */
  listen?: (fn: (raw: string | null) => void) => void;
}): Backoff {
  const storage = deps.storage === undefined ? safeStorage() : deps.storage;
  const listen = deps.listen ?? (deps.storage === undefined ? storageEvents : undefined);
  let until = 0;
  let step = 0;
  /** What is kept, read: a step and when it ends (never longer than the most a step waits from now — a clock moved back
   * can't hold it for good); anything else is none. */
  const read = (raw: string | null): { until: number; step: number } | null => {
    try {
      const v = raw ? (JSON.parse(raw) as { until?: unknown; step?: unknown }) : null;
      if (v && typeof v.until === "number" && typeof v.step === "number" && Number.isFinite(v.until) && v.step >= 0) {
        return { until: Math.min(v.until, deps.now() + BACKOFF_MAX_MS), step: Math.min(Math.floor(v.step), 10) };
      }
    } catch {
      /* unreadable: none */
    }
    return null;
  };
  try {
    const kept = read(storage?.getItem(BACKOFF_KEY) ?? null);
    if (kept) ({ until, step } = kept);
  } catch {
    /* nothing kept: none */
  }
  listen?.((raw) => {
    if (raw === null) {
      until = 0;
      step = 0;
      return;
    }
    const kept = read(raw);
    if (kept) ({ until, step } = kept);
  });
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
      // Still running: this success was sent before the 429 that began it (I2).
      if (step === 0 || until > deps.now()) return;
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
