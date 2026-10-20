/**
 * The music dock's pure reads (2026-10-17): the pill's short title, now playing, whether the volume can be set from
 * here, and a playlist's line in the sheet.
 */
import { MUSIC_GOOD_FOR_LABELS, type MusicShortcut } from "@rg/domain";
import type { Device, PlayerState } from "./spotify.js";

/** What a playlist suits, in plain words ("Mobility · Winding down"); "" when it is not tagged or suits nothing. */
export function goodForWords(s: Pick<MusicShortcut, "goodFor">): string {
  return (s.goodFor ?? []).map((t) => MUSIC_GOOD_FOR_LABELS[t]).join(" · ");
}

/** A track's name as the resting pill shows it: no " - 2011 Remaster" or "(Remastered)", whole words, ≤ max. */
export function shortTitle(name: string, max = 22): string {
  const bare = name.replace(/\s+[-–—]\s+.*$/, "").replace(/\s*[([].*$/, "").trim() || name.trim();
  if (bare.length <= max) return bare;
  let out = "";
  for (const word of bare.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return `${(out || bare.slice(0, max)).replace(/[\s,.;:–—-]+$/, "")}…`;
}

export interface NowPlaying {
  title: string;
  artist: string;
  device: string | null;
  playing: boolean;
}

export function nowPlaying(player: PlayerState | null): NowPlaying | null {
  if (!player?.item?.name) return null;
  return {
    title: player.item.name,
    artist: (player.item.artists ?? []).map((a) => a.name).join(", "),
    device: player.device?.name ?? null,
    playing: player.is_playing,
  };
}

export type VolumeView = { supported: true; percent: number; deviceId: string } | { supported: false };

/** The device's volume: settable when it takes remote volume (many phones don't); null when no device is known. */
export function volumeOf(player: PlayerState | null, devices?: Device[] | null): VolumeView | null {
  const device = player?.device ?? devices?.find((d) => d.is_active) ?? devices?.[0] ?? null;
  if (!device?.id) return null;
  return device.supports_volume ? { supported: true, percent: device.volume_percent ?? 50, deviceId: device.id } : { supported: false };
}

/** When the track playing at the last read should end — past it, the resting pill stops naming it. */
export function trackEndsAt(player: PlayerState | null, readAt: number | null): number | null {
  if (!player?.is_playing || !player.item?.duration_ms || readAt === null) return null;
  return readAt + Math.max(0, player.item.duration_ms - (player.progress_ms ?? 0));
}

/** The resting pill's words: the track's short title while it plays and until it should have ended (the dock reads
 * Spotify only while it is open, so past that the pill can't know and shows the note alone); else null. */
export function pillTitle(state: { player: PlayerState | null; readAt: number | null }, now: number): string | null {
  const ends = trackEndsAt(state.player, state.readAt);
  if (ends === null || now >= ends || !state.player?.item?.name) return null;
  return shortTitle(state.player.item.name);
}
