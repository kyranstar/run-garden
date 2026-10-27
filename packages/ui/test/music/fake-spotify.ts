/**
 * A fake Spotify Web API for the music dock's client tests: the endpoints the dock calls, a little state, every call
 * recorded with when it started and finished (so "shuffle, then play" can be checked as an order, not a hope), and
 * scripted failures (a 401, a 429, no device). It has nothing that creates or changes a playlist: the dock never asks.
 * Synthetic ids only.
 */
export const API = "https://api.spotify.com/v1";

export interface FakeDevice {
  id: string;
  name: string;
  type: string;
  is_active?: boolean;
  is_restricted?: boolean;
  supports_volume: boolean;
  volume_percent?: number | null;
}

export interface FakeAlbum {
  id: string;
  name: string;
  artists: string[];
  album_type?: string;
  tracks: number;
}

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  auth: string | null;
  started: number;
  finished: number;
}

/** A scripted answer: `body` sent as JSON, or `text` as it is. */
export interface Scripted {
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  gate?: Promise<void>;
}

/** What Spotify's shuffle answers now: 200 and an opaque id of 27 characters that isn't JSON (prod, 2026-10-26; this
 * one is synthetic). */
export const OPAQUE_ANSWER = "synthetic0opaque0answer0id0";

export const sid = (word: string): string => `${word.replace(/[^A-Za-z0-9]/g, "")}${"0".repeat(22)}`.slice(0, 22);
/** The i-th track of an album (or playlist) in the fake: distinct per container and index. */
export const trackUri = (containerId: string, i: number): string => `spotify:track:${sid(`${containerId.slice(0, 10)}t${i}x`)}`;

/** A playlist in the fake: its description as Spotify sends it (HTML-escaped), its covers. */
export interface FakePlaylist {
  name: string;
  owned: boolean;
  uris: string[];
  description?: string;
  images?: Array<{ url: string; width?: number }>;
}

export function fakeSpotify(init: { devices?: FakeDevice[]; albums?: FakeAlbum[]; ownedPlaylists?: Array<{ id: string; name: string; total: number; description?: string }> } = {}) {
  let tick = 0;
  const state = {
    devices: init.devices ?? [{ id: "phone-1", name: "Phone", type: "Smartphone", supports_volume: false }],
    albums: init.albums ?? [],
    playlists: new Map<string, FakePlaylist>(
      (init.ownedPlaylists ?? []).map((p) => [
        p.id,
        { name: p.name, owned: true, uris: Array.from({ length: p.total }, (_, i) => trackUri(p.id, i)), ...(p.description !== undefined ? { description: p.description } : {}) },
      ]),
    ),
    player: null as null | Record<string, unknown>,
    /** Scripted answers, consumed in order, by "METHOD /path" (the path without the API base or query). */
    script: new Map<string, Array<Scripted>>(),
    validToken: "token-1",
  };
  const calls: Call[] = [];

  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
    new Response(status === 204 || body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  /** A body that isn't JSON: what Spotify's shuffle answers (seen in prod, 2026-10-26). */
  const raw = (status: number, text: string): Response => new Response(text, { status });
  const playerError = (status: number, reason: string) => reply(status, { error: { status, message: reason, reason } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.href.startsWith(API)) throw new Error(`unexpected fetch ${url.href}`);
    const path = url.pathname.replace(/^\/v1/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = new Headers(init?.headers).get("authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { method, path, query: Object.fromEntries(url.searchParams), body, auth, started: ++tick, finished: 0 };
    calls.push(call);
    await Promise.resolve();
    const gate = state.script.get(`${method} ${path}`)?.[0]?.gate;
    if (gate) await gate;
    const res = answer(method, path, url.searchParams, body, auth);
    call.finished = ++tick;
    return res;
  }) as typeof fetch;

  function answer(method: string, path: string, q: URLSearchParams, body: any, auth: string | null): Response {
    const scripted = state.script.get(`${method} ${path}`)?.shift();
    if (scripted) return scripted.text !== undefined ? raw(scripted.status, scripted.text) : reply(scripted.status, scripted.body, scripted.headers);
    if (auth !== `Bearer ${state.validToken}`) return reply(401, { error: { status: 401, message: "The access token expired" } });
    const deviceFor = () => state.devices.find((d) => d.id === (q.get("device_id") ?? state.devices.find((x) => x.is_active)?.id));

    if (method === "GET" && path === "/me/player/devices") return reply(200, { devices: state.devices });
    if (method === "GET" && path === "/me/player") return state.player ? reply(200, state.player) : reply(204);
    if (method === "PUT" && path === "/me/player/shuffle") return deviceFor() ? raw(200, OPAQUE_ANSWER) : playerError(404, "NO_ACTIVE_DEVICE");
    if (method === "PUT" && path === "/me/player/play") {
      const d = deviceFor();
      if (!d) return playerError(404, "NO_ACTIVE_DEVICE");
      for (const x of state.devices) x.is_active = x.id === d.id;
      state.player = { is_playing: true, device: d, context: body?.context_uri ? { uri: body.context_uri } : null, item: { name: "A Song", artists: [{ name: "An Artist" }], duration_ms: 200_000 }, progress_ms: 0 };
      return reply(204);
    }
    if (method === "PUT" && path === "/me/player/pause") return deviceFor() ? reply(204) : playerError(404, "NO_ACTIVE_DEVICE");
    if (method === "POST" && path === "/me/player/next") return deviceFor() ? reply(204) : playerError(404, "NO_ACTIVE_DEVICE");
    if (method === "PUT" && path === "/me/player/volume") {
      const d = deviceFor();
      if (!d) return playerError(404, "NO_ACTIVE_DEVICE");
      if (!d.supports_volume) return playerError(403, "VOLUME_CONTROL_DISALLOW");
      d.volume_percent = Number(q.get("volume_percent"));
      return reply(204);
    }
    const json = (id: string, p: FakePlaylist) => ({
      id,
      name: p.name,
      description: p.description ?? "",
      images: p.images ?? [],
      uri: `spotify:playlist:${id}`,
      ...(p.owned ? { items: { total: p.uris.length } } : {}),
    });
    if (method === "GET" && path === "/me/playlists") {
      const owned = [...state.playlists].filter(([, p]) => p.owned);
      const limit = Number(q.get("limit") ?? 20);
      const offset = Number(q.get("offset") ?? 0);
      if (limit > 50) return reply(400, { error: { status: 400, message: "Invalid limit" } });
      const items = owned.slice(offset, offset + limit).map(([id, p]) => json(id, p));
      return reply(200, { items, next: offset + limit < owned.length ? `${API}/me/playlists?offset=${offset + limit}&limit=${limit}` : null, total: owned.length });
    }
    let m = /^\/playlists\/([^/]+)\/items$/.exec(path);
    if (m && method === "GET") {
      const p = state.playlists.get(m[1]!);
      if (!p) return reply(404, { error: { status: 404, message: "Not found" } });
      if (!p.owned) return reply(403, { error: { status: 403, message: "Forbidden" } });
      return reply(200, { items: [], total: p.uris.length });
    }
    m = /^\/playlists\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const p = state.playlists.get(m[1]!);
      return p ? reply(200, json(m[1]!, p)) : reply(404, { error: { status: 404, message: "Not found" } });
    }
    m = /^\/albums\/([^/]+)\/tracks$/.exec(path);
    if (m && method === "GET") {
      const a = state.albums.find((x) => x.id === m![1]);
      if (!a) return reply(404, { error: { status: 404, message: "Not found" } });
      const limit = Number(q.get("limit") ?? 20);
      const offset = Number(q.get("offset") ?? 0);
      const end = Math.min(a.tracks, offset + limit);
      const items = Array.from({ length: Math.max(0, end - offset) }, (_, i) => ({ uri: trackUri(a.id, offset + i), name: `T${offset + i}` }));
      return reply(200, { items, total: a.tracks, offset, limit, next: end < a.tracks ? `${API}/albums/${a.id}/tracks?offset=${end}&limit=${limit}` : null });
    }
    m = /^\/albums\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const a = state.albums.find((x) => x.id === m![1]);
      return a ? reply(200, { id: a.id, name: a.name, total_tracks: a.tracks, artists: a.artists.map((name) => ({ name })) }) : reply(404, { error: { status: 404, message: "Not found" } });
    }
    if (method === "GET" && path === "/search") {
      const limit = Number(q.get("limit") ?? 5);
      if (limit > 10) return reply(400, { error: { status: 400, message: "Invalid limit" } });
      const words = (q.get("q") ?? "").toLowerCase().split(/\s+/);
      const items = state.albums
        .filter((a) => words.filter((w) => w.length > 2 && `${a.name} ${a.artists.join(" ")}`.toLowerCase().includes(w)).length >= 2)
        .slice(0, limit)
        .map((a) => ({ id: a.id, name: a.name, uri: `spotify:album:${a.id}`, album_type: a.album_type ?? "album", total_tracks: a.tracks, artists: a.artists.map((name) => ({ name })) }));
      return reply(200, { albums: { items, total: items.length, limit } });
    }
    return reply(404, { error: { status: 404, message: `no fake for ${method} ${path}` } });
  }

  /** Script the next answers to one endpoint. */
  const script = (key: string, ...answers: Scripted[]) => {
    state.script.set(key, [...(state.script.get(key) ?? []), ...answers]);
  };

  return { fetch: fetchImpl, calls, state, script };
}

/** The Worker's token route, faked: hands out `state.validToken` (a forced read rotates it, as a refresh would). */
export function fakeTokens(spotify: ReturnType<typeof fakeSpotify>, opts: { reason?: "not_connected" | "reconnect"; expiresInMs?: number; now?: () => number } = {}) {
  const asked: boolean[] = [];
  let rotations = 1;
  const token = async (fresh: boolean) => {
    asked.push(fresh);
    if (opts.reason) return { connected: false as const, reason: opts.reason };
    if (fresh) spotify.state.validToken = `token-${++rotations}`;
    return { connected: true as const, accessToken: spotify.state.validToken, expiresAt: new Date((opts.now?.() ?? 0) + (opts.expiresInMs ?? 3600_000)).toISOString() };
  };
  return { token, asked };
}
