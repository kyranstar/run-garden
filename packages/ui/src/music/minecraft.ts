/**
 * "Minecraft, complete" (the music dock, 2026-10-17): one private playlist in the athlete's Spotify account holding
 * every track of every official Minecraft soundtrack album — built on first use (or with Rebuild), its id kept in the
 * preferences so it is built once.
 *
 * Each album is found by search (Spotify answers at most ten) and matched carefully: the album's name must carry
 * "Minecraft" and its own words, none of a cover's, a remix's or a trailer score's, AND one of its artists must be one
 * of the album's composers. An album not found is skipped and named ("8 of 9 albums found"). The tracks are added in
 * batches of 100 (Spotify's most per call). Rebuild replaces a stored playlist's tracks rather than making another.
 */
import { SpotifyError, type AlbumHit, type Spotify } from "./spotify.js";

export const MINECRAFT_PLAYLIST_NAME = "Minecraft — complete (Run Garden)";
const DESCRIPTION = "Every official Minecraft soundtrack album, built by Run Garden.";

export interface MinecraftAlbum {
  title: string;
  /** Words the album's name must carry (after "Minecraft"), normalised. */
  words: string[];
  artists: string[];
}

/** The official soundtrack albums: the eight the owner named, and Chaos Cubed (fingerspit, May 2026), confirmed since. */
export const MINECRAFT_ALBUMS: MinecraftAlbum[] = [
  { title: "Minecraft – Volume Alpha", words: ["volume", "alpha"], artists: ["C418"] },
  { title: "Minecraft – Volume Beta", words: ["volume", "beta"], artists: ["C418"] },
  { title: "Minecraft: Nether Update", words: ["nether", "update"], artists: ["Lena Raine"] },
  { title: "Minecraft: Caves & Cliffs", words: ["caves", "cliffs"], artists: ["Lena Raine", "Kumi Tanioka"] },
  { title: "Minecraft: The Wild Update", words: ["wild", "update"], artists: ["Lena Raine", "Samuel Åberg"] },
  { title: "Minecraft: Trails & Tales", words: ["trails", "tales"], artists: ["Aaron Cherof", "Lena Raine"] },
  { title: "Minecraft: Tricky Trials", words: ["tricky", "trials"], artists: ["Aaron Cherof", "Kumi Tanioka", "Lena Raine"] },
  { title: "Minecraft: Chase the Skies", words: ["chase", "skies"], artists: ["Amos Roddy"] },
  { title: "Minecraft: Chaos Cubed", words: ["chaos", "cubed"], artists: ["fingerspit"] },
];

/** Never the soundtrack: covers, remixes, trailer scores and the like. */
const NOT_THE_SOUNDTRACK = ["trailer", "cover", "covers", "remix", "remixes", "remixed", "lofi", "piano", "orchestral", "tribute", "karaoke", "chiptune", "8bit", "medley", "sleep", "relaxing"];

const norm = (s: string): string =>
  ` ${s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

/** The search hit that IS this album: its name and an artist, never a decoy; an "album" before a single. */
export function matchAlbum<T extends Pick<AlbumHit, "id" | "name" | "artists"> & { album_type?: string }>(album: MinecraftAlbum, hits: T[]): T | null {
  const composers = new Set(album.artists.map(norm));
  const matches = hits.filter((hit) => {
    const name = norm(hit.name);
    if (!name.includes(" minecraft ")) return false;
    if (!album.words.every((w) => name.includes(` ${w} `))) return false;
    if (NOT_THE_SOUNDTRACK.some((w) => name.includes(` ${w} `))) return false;
    return (hit.artists ?? []).some((a) => composers.has(norm(a.name)));
  });
  return matches.find((m) => (m.album_type ?? "album") === "album") ?? matches[0] ?? null;
}

export type MinecraftBuild =
  | { playlistId: string; reused: true }
  | { playlistId: string | null; found: number; of: number; missing: string[]; tracks: number };

/** A 429 mid-build is waited out (Spotify says how long), up to this long each time, a few times. */
const BUILD_WAIT = { maxWaitMs: 30_000, waits: 3 };
const BATCH = 100;

const gone = (e: unknown): boolean => e instanceof SpotifyError && (e.status === 404 || e.status === 403);

export async function buildMinecraftPlaylist(spotify: Spotify, opts: { storedId?: string; rebuild?: boolean }): Promise<MinecraftBuild> {
  if (opts.storedId && !opts.rebuild) return { playlistId: opts.storedId, reused: true };

  const uris: string[] = [];
  const missing: string[] = [];
  let found = 0;
  for (const album of MINECRAFT_ALBUMS) {
    let hit: AlbumHit | null = null;
    for (const q of [`minecraft ${album.words.join(" ")} ${album.artists[0]}`, `minecraft ${album.words.join(" ")}`]) {
      hit = matchAlbum(album, await spotify.searchAlbums(q, BUILD_WAIT));
      if (hit) break;
    }
    if (!hit) {
      missing.push(album.title);
      continue;
    }
    found += 1;
    uris.push(...(await spotify.albumTracks(hit.id, BUILD_WAIT)));
  }
  const tracks = [...new Set(uris)];
  const of = MINECRAFT_ALBUMS.length;
  if (tracks.length === 0) return { playlistId: null, found, of, missing, tracks: 0 };

  const batches: string[][] = [];
  for (let i = 0; i < tracks.length; i += BATCH) batches.push(tracks.slice(i, i + BATCH));
  let playlistId: string | null = null;
  if (opts.storedId) {
    try {
      await spotify.replaceItems(opts.storedId, batches[0]!, BUILD_WAIT);
      playlistId = opts.storedId;
    } catch (e) {
      if (!gone(e)) throw e;
    }
  }
  let rest = batches.slice(1);
  if (!playlistId) {
    playlistId = (await spotify.createPlaylist(MINECRAFT_PLAYLIST_NAME, DESCRIPTION, BUILD_WAIT)).id;
    rest = batches;
  }
  for (const batch of rest) await spotify.addItems(playlistId, batch, BUILD_WAIT);
  return { playlistId, found, of, missing, tracks: tracks.length };
}
