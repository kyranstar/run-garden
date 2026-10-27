/**
 * The music dock's stand-in Spotify (fixture mode only; routes/music.ts mounts it at `/api/music/fixture/v1` and
 * refuses it outside fixture mode). The fixture stack can't reach Spotify, so the dock's journeys run against this: the
 * Web API endpoints the dock calls, answered from a little state kept in the isolate — two devices (a phone that
 * refuses remote volume and a desktop that takes it), the athlete's playlists (each with a description, escaped as
 * Spotify sends it; listed a page at a time), an editorial one, and a catalogue of albums. It makes nothing in the
 * account: the app builds no playlist. `PUT /state/limit` answers the next calls 429 with no Retry-After (as a browser
 * sees one: CORS hides it), so the dock's backing off can be seen. Synthetic ids; nothing here leaves the machine.
 */
import { Hono, type Context } from "hono";
import type { AppContext } from "../auth/middleware.js";
import type { SpotifyTokens } from "./spotify-auth.js";

export const FIXTURE_SPOTIFY_API_BASE = "/api/music/fixture/v1";
/** A fixture login's tokens: they last a year, so the fixture never asks Spotify to refresh them. */
export const FIXTURE_SPOTIFY_TOKENS: SpotifyTokens = {
  accessToken: "fixture-access-token",
  refreshToken: "fixture-refresh-token",
  expiresInSec: 365 * 86_400,
  scope: "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private",
};

interface Track {
  uri: string;
  name: string;
  artist: string;
  durationMs: number;
}
interface Album {
  id: string;
  name: string;
  artists: string[];
  tracks: Track[];
}
interface Playlist {
  id: string;
  name: string;
  /** As Spotify sends it: HTML-escaped. */
  description: string;
  owned: boolean;
  uris: string[];
}
interface Device {
  id: string;
  name: string;
  type: string;
  supports_volume: boolean;
  volume_percent: number | null;
}

/** A 22-character fixture id from a word (base-62 alphabet only). */
const fid = (word: string): string => `${word.replace(/[^A-Za-z0-9]/g, "")}${"0".repeat(22)}`.slice(0, 22);

function album(key: string, name: string, artists: string[], count: number): Album {
  const id = fid(`fxalb${key}`);
  return {
    id,
    name,
    artists,
    tracks: Array.from({ length: count }, (_, i) => ({
      uri: `spotify:track:${fid(`fxt${key}${i}`)}`,
      name: `${name} ${i + 1}`,
      artist: artists[0]!,
      durationMs: 150_000 + ((i * 37_000) % 120_000),
    })),
  };
}

/** The albums the athlete's playlists play from (and one to paste by link). Synthetic. */
const CATALOGUE: Album[] = [album("hours", "Quiet Hours", ["A Pianist"], 24), album("rain", "Rain Studies", ["Field Notes"], 30)];

const USER_PLAYLISTS: Playlist[] = [
  { id: fid("fxplEasyRun"), name: "Easy run", description: "Steady songs for easy miles", owned: true, uris: CATALOGUE[1]!.tracks.slice(0, 12).map((t) => t.uri) },
  { id: fid("fxplLongRun"), name: "Long run", description: "", owned: true, uris: CATALOGUE[1]!.tracks.slice(10, 30).map((t) => t.uri) },
  { id: fid("fxplStretch"), name: "Stretch", description: "Slow stretches &amp; long holds", owned: true, uris: CATALOGUE[0]!.tracks.slice(0, 8).map((t) => t.uri) },
  // An editorial playlist: playable, its name and description readable, its items not (as Spotify answers a playlist the
  // athlete doesn't own).
  {
    id: fid("fxplSpaEditorial"),
    name: "Spa Sounds",
    description: "Calm music for yoga, massage &amp; rest. &lt;a href=&quot;spotify:playlist:fxplmore&quot;&gt;More&lt;/a&gt;",
    owned: false,
    uris: CATALOGUE[0]!.tracks.slice(8, 20).map((t) => t.uri),
  },
];

interface State {
  devices: Device[];
  active: string | null;
  playing: boolean;
  shuffle: boolean;
  context: string | null;
  queue: string[];
  index: number;
  playlists: Playlist[];
  /** The next calls answered 429 (`PUT /state/limit`). */
  limited: number;
}

function initial(): State {
  return {
    devices: [
      { id: "fixture-phone", name: "Phone", type: "Smartphone", supports_volume: false, volume_percent: null },
      { id: "fixture-desktop", name: "Desktop", type: "Computer", supports_volume: true, volume_percent: 60 },
    ],
    active: null,
    playing: false,
    shuffle: false,
    context: null,
    queue: [],
    index: 0,
    playlists: USER_PLAYLISTS.map((p) => ({ ...p, uris: [...p.uris] })),
    limited: 0,
  };
}

let state: State = initial();

const allTracks = (): Map<string, Track> => new Map(CATALOGUE.flatMap((a) => a.tracks.map((t) => [t.uri, t] as const)));

function playerError(c: Context<AppContext>, status: 400 | 403 | 404, message: string, reason: string) {
  return c.json({ error: { status, message, reason } }, status);
}

/** The context's track uris, or null for one that doesn't exist. */
function contextUris(uri: string): string[] | null {
  const [, kind, id] = uri.split(":");
  if (kind === "album") return CATALOGUE.find((a) => a.id === id)?.tracks.map((t) => t.uri) ?? null;
  if (kind === "playlist") return state.playlists.find((p) => p.id === id)?.uris ?? null;
  return null;
}

/** The device a player command addresses: the one named, else the active one; none is Spotify's NO_ACTIVE_DEVICE. */
function target(c: Context<AppContext>): Device | null {
  const id = c.req.query("device_id") ?? state.active;
  return state.devices.find((d) => d.id === id) ?? null;
}

export const spotifyFixtureApi = new Hono<AppContext>();

spotifyFixtureApi.use("*", async (c, next) => {
  if (c.req.header("authorization") !== `Bearer ${FIXTURE_SPOTIFY_TOKENS.accessToken}`) {
    return c.json({ error: { status: 401, message: "Invalid access token" } }, 401);
  }
  if (state.limited > 0 && !c.req.path.includes("/state")) {
    state.limited -= 1;
    return c.json({ error: { status: 429, message: "API rate limit exceeded" } }, 429);
  }
  await next();
});

/** Back to the start (the e2e and the screenshots begin from it). */
spotifyFixtureApi.delete("/state", (c) => {
  state = initial();
  return c.body(null, 204);
});
/** The next `count` calls answered 429, with no Retry-After (the backing off's journey). */
spotifyFixtureApi.put("/state/limit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { count?: number };
  state.limited = Math.max(0, Math.min(1000, Number(body.count ?? 0)));
  return c.body(null, 204);
});
/** The phone's Spotify app closed or open (the open-link fallback's journey). */
spotifyFixtureApi.put("/state/devices", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { none?: boolean };
  state.devices = body.none ? [] : initial().devices;
  if (body.none) state.active = null;
  return c.body(null, 204);
});

spotifyFixtureApi.get("/me", (c) => c.json({ id: "fixture-user", display_name: "Fixture", uri: "spotify:user:fixture-user" }));

spotifyFixtureApi.get("/me/player/devices", (c) =>
  c.json({ devices: state.devices.map((d) => ({ ...d, is_active: d.id === state.active, is_private_session: false, is_restricted: false })) }),
);

spotifyFixtureApi.get("/me/player", (c) => {
  const device = state.devices.find((d) => d.id === state.active);
  if (!device || !state.context) return c.body(null, 204);
  const track = allTracks().get(state.queue[state.index] ?? "");
  return c.json({
    device: { ...device, is_active: true, is_private_session: false, is_restricted: false },
    is_playing: state.playing,
    shuffle_state: state.shuffle,
    repeat_state: "off",
    progress_ms: 42_000,
    context: { uri: state.context, type: state.context.split(":")[1] },
    currently_playing_type: "track",
    item: track
      ? { uri: track.uri, name: track.name, duration_ms: track.durationMs, artists: [{ name: track.artist }], album: { name: "" } }
      : null,
  });
});

spotifyFixtureApi.put("/me/player/shuffle", (c) => {
  const device = target(c);
  if (!device) return playerError(c, 404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE");
  state.shuffle = c.req.query("state") === "true";
  // As Spotify answers it (seen in prod, 2026-10-26): 200 and an opaque id that isn't JSON — not its documented 204.
  return new Response("fixture0opaque0answer0id000", { status: 200 });
});

spotifyFixtureApi.put("/me/player/play", async (c) => {
  const device = target(c);
  if (!device) return playerError(c, 404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE");
  const body = (await c.req.json().catch(() => ({}))) as { context_uri?: string; offset?: { position?: number } };
  if (body.context_uri) {
    const uris = contextUris(body.context_uri);
    if (!uris) return playerError(c, 404, "Not found", "UNKNOWN");
    const at = body.offset?.position ?? 0;
    if (at < 0 || at >= uris.length) return playerError(c, 400, "Invalid offset", "UNKNOWN");
    state.context = body.context_uri;
    state.queue = uris;
    state.index = at;
  } else if (!state.context) {
    return playerError(c, 404, "Player command failed: Nothing to play", "NO_ACTIVE_DEVICE");
  }
  state.active = device.id;
  state.playing = true;
  return c.body(null, 204);
});

spotifyFixtureApi.put("/me/player/pause", (c) => {
  if (!target(c)) return playerError(c, 404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE");
  state.playing = false;
  return c.body(null, 204);
});

spotifyFixtureApi.post("/me/player/next", (c) => {
  if (!target(c) || !state.context) return playerError(c, 404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE");
  state.index = (state.index + 1) % Math.max(1, state.queue.length);
  return c.body(null, 204);
});

spotifyFixtureApi.put("/me/player/volume", (c) => {
  const device = target(c);
  if (!device) return playerError(c, 404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE");
  if (!device.supports_volume) return playerError(c, 403, "Player command failed: Cannot control device volume", "VOLUME_CONTROL_DISALLOW");
  device.volume_percent = Math.max(0, Math.min(100, Number(c.req.query("volume_percent") ?? 0)));
  return c.body(null, 204);
});

const playlistJson = (p: Playlist) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  images: [],
  uri: `spotify:playlist:${p.id}`,
  owner: { id: p.owned ? "fixture-user" : "spotify" },
  ...(p.owned ? { items: { total: p.uris.length } } : {}),
});

/** The athlete's own playlists, a page at a time (`limit`, `offset`; `next` while there are more). */
spotifyFixtureApi.get("/me/playlists", (c) => {
  const owned = state.playlists.filter((p) => p.owned);
  const limit = Math.max(1, Math.min(50, Number(c.req.query("limit") ?? 20)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const page = owned.slice(offset, offset + limit);
  const next = offset + limit < owned.length ? `fixture://me/playlists?offset=${offset + limit}&limit=${limit}` : null;
  return c.json({ items: page.map(playlistJson), total: owned.length, limit, offset, next });
});

spotifyFixtureApi.get("/playlists/:id", (c) => {
  const p = state.playlists.find((x) => x.id === c.req.param("id"));
  return p ? c.json(playlistJson(p)) : c.json({ error: { status: 404, message: "Resource not found" } }, 404);
});

spotifyFixtureApi.get("/playlists/:id/items", (c) => {
  const p = state.playlists.find((x) => x.id === c.req.param("id"));
  if (!p) return c.json({ error: { status: 404, message: "Resource not found" } }, 404);
  if (!p.owned) return c.json({ error: { status: 403, message: "Forbidden" } }, 403);
  return c.json({ items: [], total: p.uris.length, next: null });
});

const albumJson = (a: Album) => ({
  id: a.id,
  name: a.name,
  uri: `spotify:album:${a.id}`,
  album_type: "album",
  total_tracks: a.tracks.length,
  artists: a.artists.map((name) => ({ name })),
});

spotifyFixtureApi.get("/albums/:id", (c) => {
  const a = CATALOGUE.find((x) => x.id === c.req.param("id"));
  return a ? c.json(albumJson(a)) : c.json({ error: { status: 404, message: "Resource not found" } }, 404);
});

spotifyFixtureApi.get("/albums/:id/tracks", (c) => {
  const a = CATALOGUE.find((x) => x.id === c.req.param("id"));
  if (!a) return c.json({ error: { status: 404, message: "Resource not found" } }, 404);
  const limit = Math.min(50, Number(c.req.query("limit") ?? 20));
  const offset = Number(c.req.query("offset") ?? 0);
  const items = a.tracks.slice(offset, offset + limit).map((t) => ({ uri: t.uri, name: t.name, duration_ms: t.durationMs, artists: [{ name: t.artist }] }));
  const next = offset + limit < a.tracks.length ? `fixture://albums/${a.id}/tracks?offset=${offset + limit}` : null;
  return c.json({ items, total: a.tracks.length, limit, offset, next });
});
