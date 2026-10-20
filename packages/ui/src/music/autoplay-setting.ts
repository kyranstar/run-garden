/**
 * "Play the workout's music when I start" (Settings → Sounds; 2026-10-19): kept on this device, like the session's
 * sounds — a phone and a laptop may want it differently. On by default: a session whose music resolves starts it on the
 * athlete's Spotify at Start, and nowhere else does music start on its own.
 */
export const AUTOPLAY_KEY = "rg-music-autoplay";

type Store = Pick<Storage, "getItem">;

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** On unless switched off here ("0"); anything unreadable is on. */
export function readAutoPlay(storage: Store | null = safeStorage()): boolean {
  try {
    return storage?.getItem(AUTOPLAY_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeAutoPlay(on: boolean, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(AUTOPLAY_KEY, on ? "1" : "0");
  } catch {
    // private mode or full: for this visit
  }
}
