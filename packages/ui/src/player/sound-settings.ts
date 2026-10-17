/**
 * The session's sound settings, kept on this device (like "Move on when a timer ends"): a phone and a laptop want
 * different volumes, and a session plays offline, so nothing here waits on the server.
 *
 * The palette is a choice: "auto" (the default) is soft keys, and bowls for a calm session — a recovery day, or a
 * slow, held, yin-like session (the owner, 2026-10-17: "soft keys and then bowls if it's for a relaxing workout like
 * yin yoga") — or one palette always.
 */
import { DEFAULT_SOUND, type SoundSettings } from "./cue-player.js";
import { PALETTE_IDS, type PaletteId } from "./sound-palettes.js";

export const SOUND_KEY = "rg-player-sound";

export type SoundChoice = PaletteId | "auto";

/** What is kept: on, the volume (0–1) and the palette choice. */
export interface StoredSound {
  on: boolean;
  volume: number;
  choice: SoundChoice;
}

export const DEFAULT_STORED: StoredSound = { on: DEFAULT_SOUND.on, volume: DEFAULT_SOUND.volume, choice: "auto" };

/** The palette a session plays: the choice, or for "auto" bowls when the session is calm and soft keys otherwise. */
export const resolvePalette = (choice: SoundChoice, calm: boolean): PaletteId => (choice === "auto" ? (calm ? "bowl" : "keys") : choice);

/** The cue player's settings for a session. */
export const soundFor = (stored: StoredSound, calm: boolean): SoundSettings => ({ on: stored.on, volume: stored.volume, palette: resolvePalette(stored.choice, calm) });

/** What is stored, read leniently: anything missing or wrong takes the default. */
export function readSound(storage: Pick<Storage, "getItem"> | null = safeStorage()): StoredSound {
  try {
    const raw = storage?.getItem(SOUND_KEY);
    if (!raw) return { ...DEFAULT_STORED };
    const v = JSON.parse(raw) as Partial<Record<keyof StoredSound, unknown>>;
    return {
      on: typeof v.on === "boolean" ? v.on : DEFAULT_STORED.on,
      volume: typeof v.volume === "number" && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : DEFAULT_STORED.volume,
      choice: v.choice === "auto" || PALETTE_IDS.includes(v.choice as PaletteId) ? (v.choice as SoundChoice) : DEFAULT_STORED.choice,
    };
  } catch {
    return { ...DEFAULT_STORED };
  }
}

export function writeSound(stored: StoredSound, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(SOUND_KEY, JSON.stringify(stored));
  } catch {
    // private mode or full: the setting lasts this visit
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
