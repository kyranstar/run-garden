import { z } from "zod";

// ── The music dock (2026-10-17) ──────────────────────────────────────────────

/**
 * `music` in the user's preferences: the dock's shortcuts — each a label and a Spotify playlist or album, played with
 * shuffle on — and the id of the "Minecraft — complete" playlist the app built in the athlete's Spotify account, so it
 * is built once. Absent until the athlete sets something (no migration: the preferences are JSON).
 */

/** A Spotify id: base-62 (22 characters today; a little latitude either way costs nothing). */
export const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{16,32}$/;
const CONTEXT_URI = /^spotify:(playlist|album):([A-Za-z0-9]{16,32})$/;

/** The most shortcuts the dock keeps. */
export const MUSIC_SHORTCUTS_MAX = 12;
/** A shortcut's label, at most. */
export const MUSIC_LABEL_MAX = 60;
/** The spa playlist's shortcut id: the one the dock offers as "Add your spa playlist" until it is set. */
export const MUSIC_SPA_ID = "spa";

export type SpotifyContextKind = "playlist" | "album";

/** A playlist's or an album's Spotify URI, read: its kind and id. Anything else (a track, an artist, a link) is null. */
export function spotifyContextUri(uri: string): { kind: SpotifyContextKind; id: string } | null {
  const m = CONTEXT_URI.exec(uri);
  return m ? { kind: m[1] as SpotifyContextKind, id: m[2]! } : null;
}

export const musicShortcutSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/, "a short id"),
    label: z.string().trim().min(1, "a label").max(MUSIC_LABEL_MAX),
    uri: z.string().regex(CONTEXT_URI, "a Spotify playlist or album"),
    shuffle: z.boolean().default(true),
  })
  .strict();
export type MusicShortcut = z.infer<typeof musicShortcutSchema>;

export const musicPreferencesSchema = z
  .object({
    shortcuts: z
      .array(musicShortcutSchema)
      .max(MUSIC_SHORTCUTS_MAX)
      .refine((list) => new Set(list.map((s) => s.id)).size === list.length, "a shortcut listed twice")
      .default([]),
    minecraftPlaylistId: z.string().regex(SPOTIFY_ID_PATTERN, "a Spotify id").optional(),
  })
  .strict();
export type MusicPreferences = z.infer<typeof musicPreferencesSchema>;
