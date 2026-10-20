/**
 * The music dock's preferences (2026-10-17): `music` in the user's preferences — the shortcuts (a label and a Spotify
 * playlist or album), and an earlier version's playlist id, still read. Synthetic ids only.
 */
import { describe, expect, it } from "vitest";
import {
  MUSIC_SHORTCUTS_MAX,
  musicPreferencesSchema,
  spotifyContextUri,
  userPreferencesSchema,
} from "../src/index.js";

const ID = "0123456789abcdefABCDEF";

describe("music preferences", () => {
  it("are a list of shortcuts and an optional playlist id; nothing set is no shortcuts", () => {
    expect(musicPreferencesSchema.parse({})).toEqual({ shortcuts: [] });
    const music = {
      shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${ID}`, shuffle: true }],
      minecraftPlaylistId: ID,
    };
    expect(musicPreferencesSchema.parse(music)).toEqual(music);
    // Shuffle is on unless said otherwise.
    expect(musicPreferencesSchema.parse({ shortcuts: [{ id: "a", label: "A", uri: `spotify:album:${ID}` }] }).shortcuts[0]!.shuffle).toBe(true);
  });

  it("refuse anything that is not a playlist or an album, an empty label, a repeated id, and too many", () => {
    const one = (uri: string, label = "A", id = "a") => ({ shortcuts: [{ id, label, uri }] });
    expect(musicPreferencesSchema.safeParse(one(`spotify:track:${ID}`)).success).toBe(false);
    expect(musicPreferencesSchema.safeParse(one(`spotify:artist:${ID}`)).success).toBe(false);
    expect(musicPreferencesSchema.safeParse(one(`https://open.spotify.com/playlist/${ID}`)).success).toBe(false);
    expect(musicPreferencesSchema.safeParse(one(`spotify:playlist:${ID}x"`)).success).toBe(false);
    expect(musicPreferencesSchema.safeParse(one(`spotify:playlist:${ID}`, "   ")).success).toBe(false);
    expect(musicPreferencesSchema.safeParse(one(`spotify:playlist:${ID}`, "A", "Not An Id")).success).toBe(false);
    const twice = { shortcuts: [one(`spotify:album:${ID}`).shortcuts[0], one(`spotify:album:${ID}`).shortcuts[0]] };
    expect(musicPreferencesSchema.safeParse(twice).success).toBe(false);
    const many = { shortcuts: Array.from({ length: MUSIC_SHORTCUTS_MAX + 1 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, uri: `spotify:album:${ID}` })) };
    expect(musicPreferencesSchema.safeParse(many).success).toBe(false);
    expect(musicPreferencesSchema.safeParse({ shortcuts: [], minecraftPlaylistId: "not an id!" }).success).toBe(false);
    expect(musicPreferencesSchema.safeParse({ shortcuts: [], other: 1 }).success).toBe(false);
  });

  it("ride in the user's preferences: absent until set, and a stored value that no longer reads is none, never a failure of the rest", () => {
    expect(userPreferencesSchema.parse({}).music).toBeUndefined();
    const good = { shortcuts: [{ id: "a", label: "A", uri: `spotify:album:${ID}`, shuffle: true }] };
    expect(userPreferencesSchema.parse({ music: good }).music).toEqual(good);
    const read = userPreferencesSchema.parse({ units: "mi", music: { shortcuts: "broken" } });
    expect(read.music).toBeUndefined();
    expect(read.units).toBe("mi");
  });

  it("a context uri is a playlist or an album", () => {
    expect(spotifyContextUri(`spotify:playlist:${ID}`)).toEqual({ kind: "playlist", id: ID });
    expect(spotifyContextUri(`spotify:album:${ID}`)).toEqual({ kind: "album", id: ID });
    expect(spotifyContextUri(`spotify:track:${ID}`)).toBeNull();
    expect(spotifyContextUri("spotify:playlist:")).toBeNull();
  });
});
