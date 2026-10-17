/**
 * THE RING/SILENT SWITCH, SAID ONCE (the sound pass, 2026-10-17). The cues ask for an "ambient" audio session so they
 * mix over the athlete's music — and an ambient session follows the ring/silent switch: on silent, no cues. A phone or
 * tablet with an audio session (iPhone, iPad: Safari 16.4+) says so on the first session with sound on, quietly, and
 * never again once it has been seen (kept on the device).
 */
export const HINT_KEY = "rg-sound-hint-seen";

interface NavLike {
  audioSession?: unknown;
  maxTouchPoints?: number;
}

/** A touch device with an audio session: one with a ring/silent switch (a Mac's Safari has the session, not the switch). */
export function ringSwitchDevice(nav: NavLike | undefined = typeof navigator === "undefined" ? undefined : (navigator as NavLike)): boolean {
  return !!nav && nav.audioSession != null && (nav.maxTouchPoints ?? 0) > 0;
}

/** Say it now: sound is on, the device has the switch, and it has not been said before. */
export function hintDue(soundOn: boolean, nav?: NavLike, storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  if (!soundOn || !ringSwitchDevice(nav)) return false;
  try {
    return storage?.getItem(HINT_KEY) == null;
  } catch {
    return false;
  }
}

/** It has been seen: never again. */
export function hintSeen(storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(HINT_KEY, "1");
  } catch {
    // private mode: it may come again next time
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
