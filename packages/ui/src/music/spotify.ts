/**
 * The music dock's Spotify client (2026-10-17): a Spotify Connect remote. It asks the Worker for a short-lived access
 * token (`/api/music/spotify/token`; the tokens themselves stay encrypted on the server) and calls the Web API
 * directly. Every call goes through injected deps, so the tests drive it against a fake API.
 *
 *  - 401: the token is fetched again once, asking the Worker for a fresh one, and the call tried again.
 *  - 429: a short `Retry-After` is waited out and the call tried once more; a longer one is handed back with its wait
 *    (the poller backs off by it; a command says "try again shortly").
 *  - 404 `NO_ACTIVE_DEVICE` (or any 404 from a player command): `isNoDevice` — the dock's open-link fallback.
 *
 * Development-mode notes (Spotify, 2026): search answers at most 10; a playlist's items are readable only when the
 * athlete owns or collaborates on it (`/playlists/{id}/items`, renamed from `/tracks`); playlists are created with
 * `POST /me/playlists`.
 */

export const SPOTIFY_API = "https://api.spotify.com/v1";
/** A token closer than this to its expiry is fetched again before use. */
export const TOKEN_EARLY_MS = 60_000;
/** The longest `Retry-After` an interactive call waits out by itself. */
export const SHORT_WAIT_MS = 3_000;
/** When a 429 carries no `Retry-After`. */
const DEFAULT_RETRY_MS = 5_000;

export type TokenAnswer =
  | { connected: true; accessToken: string; expiresAt: string; apiBase?: string }
  | { connected: false; reason: "not_connected" | "reconnect" };

export class SpotifyError extends Error {
  constructor(
    public status: number,
    public reason: string | null,
    public retryAfterMs: number | null,
    public path = "",
  ) {
    super(`spotify_${status}${reason ? `_${reason}` : ""}`);
  }
}

/** Spotify isn't connected for this athlete, or the consent needs renewing ("reconnect"). */
export class NotConnected extends Error {
  constructor(public reason: "not_connected" | "reconnect") {
    super(`spotify_${reason}`);
  }
}

/** No device to play on: Spotify's NO_ACTIVE_DEVICE, or a player command's 404 (the device it named is gone). */
export const isNoDevice = (e: unknown): boolean =>
  e instanceof SpotifyError && e.status === 404 && (e.reason === "NO_ACTIVE_DEVICE" || e.path.startsWith("/me/player"));

export interface SpotifyDeps {
  /** The Worker's token route; `fresh` asks it to refresh whatever the time left (after a 401). */
  token: (fresh: boolean) => Promise<TokenAnswer>;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface Device {
  id: string | null;
  name: string;
  type: string;
  is_active?: boolean;
  is_restricted?: boolean;
  supports_volume?: boolean;
  volume_percent?: number | null;
}

export interface PlayerState {
  is_playing: boolean;
  device?: Device | null;
  progress_ms?: number | null;
  context?: { uri: string } | null;
  item?: { name: string; artists?: Array<{ name: string }>; duration_ms?: number; uri?: string } | null;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  uri: string;
  total: number | null;
}

export interface AlbumHit {
  id: string;
  name: string;
  album_type?: string;
  total_tracks?: number;
  artists: Array<{ name: string }>;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** The longest Retry-After waited out here (default: a short one), and how many times. */
  maxWaitMs?: number;
  waits?: number;
}

/** A path on this origin (the fixture's stand-in API), never another host. */
const sameOriginPath = (base: string | undefined): string | null =>
  base && base.startsWith("/") && !base.startsWith("//") ? base.replace(/\/+$/, "") : null;

/** Spotify's Retry-After, in ms. Missing, empty or unreadable — a browser shows the page only the headers CORS
 * exposes, and this one may not be — it is the default, never 0 (review #3: `Number(null)` was 0, a retry at once). */
function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after")?.trim();
  const secs = raw ? Number(raw) : NaN;
  return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1000) : DEFAULT_RETRY_MS;
}

export function makeSpotify(deps: SpotifyDeps) {
  let cached: { token: string; expiresAt: number; base: string } | null = null;
  /** The token fetch under way, shared by every call that needs one meanwhile (review #1: the dock reads two
   * endpoints at once, and two fetches after the hour meant two refreshes racing on the server). A fresh one is never
   * answered by a plain one already under way. */
  let inflight: { fresh: boolean; promise: Promise<{ token: string; expiresAt: number; base: string }> } | null = null;

  async function token(fresh: boolean): Promise<{ token: string; base: string }> {
    if (!fresh && cached && cached.expiresAt - deps.now() > TOKEN_EARLY_MS) return cached;
    if (inflight && (inflight.fresh || !fresh)) return inflight.promise;
    const promise = (async () => {
      const answer = await deps.token(fresh);
      if (!answer.connected) {
        cached = null;
        throw new NotConnected(answer.reason);
      }
      cached = { token: answer.accessToken, expiresAt: Date.parse(answer.expiresAt), base: sameOriginPath(answer.apiBase) ?? SPOTIFY_API };
      return cached;
    })();
    inflight = { fresh, promise };
    try {
      return await promise;
    } finally {
      if (inflight?.promise === promise) inflight = null;
    }
  }

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T | null> {
    let t = await token(false);
    let refetched = false;
    let waits = opts.waits ?? 1;
    const maxWait = opts.maxWaitMs ?? SHORT_WAIT_MS;
    const qs = Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    for (;;) {
      const res = await deps.fetch(`${t.base}${path}${qs ? `?${qs}` : ""}`, {
        method,
        headers: { Authorization: `Bearer ${t.token}`, ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
      if (res.status === 401 && !refetched) {
        refetched = true;
        // A newer token than the one refused (another call's 401 already fetched one): use it; else ask for one.
        t = cached && cached.token !== t.token ? cached : await token(true);
        continue;
      }
      if (res.status === 429) {
        const wait = retryAfterMs(res);
        if (waits > 0 && wait <= maxWait) {
          waits -= 1;
          await deps.sleep(wait);
          continue;
        }
        throw new SpotifyError(429, null, wait, path);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { reason?: unknown } } | null;
        throw new SpotifyError(res.status, typeof body?.error?.reason === "string" ? body.error.reason : null, null, path);
      }
      if (res.status === 204 || res.status === 202) return null;
      const text = await res.text();
      return text ? (JSON.parse(text) as T) : null;
    }
  }

  /** A paged list read to its end — bounded, so a cursor that never ends can't loop. */
  async function pages<T>(path: string, query: Record<string, string | number>, maxPages: number, opts: RequestOptions = {}): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const res = await request<{ items?: T[]; next?: string | null }>("GET", path, { ...opts, query: { ...query, offset } });
      const items = res?.items ?? [];
      out.push(...items);
      if (!res?.next || items.length === 0) break;
      offset += items.length;
    }
    return out;
  }

  const device = (deviceId?: string | null) => (deviceId ? { device_id: deviceId } : {});
  const contextPath = (uri: string): { kind: string; id: string } | null => {
    const m = /^spotify:(playlist|album):([A-Za-z0-9]+)$/.exec(uri);
    return m ? { kind: m[1]!, id: m[2]! } : null;
  };

  return {
    request,
    devices: async (): Promise<Device[]> => (await request<{ devices?: Device[] }>("GET", "/me/player/devices"))?.devices ?? [],
    /** Now playing; null when nothing is (Spotify's 204). */
    player: (opts: { waits?: number } = {}) => request<PlayerState>("GET", "/me/player", { waits: opts.waits ?? 0 }),
    shuffle: (on: boolean, deviceId?: string | null) => request("PUT", "/me/player/shuffle", { query: { state: on, ...device(deviceId) } }),
    play: (p: { contextUri?: string; position?: number; deviceId?: string | null }) =>
      request("PUT", "/me/player/play", {
        query: device(p.deviceId),
        ...(p.contextUri ? { body: { context_uri: p.contextUri, ...(p.position !== undefined ? { offset: { position: p.position } } : {}) } } : {}),
      }),
    pause: (deviceId?: string | null) => request("PUT", "/me/player/pause", { query: device(deviceId) }),
    next: (deviceId?: string | null) => request("POST", "/me/player/next", { query: device(deviceId) }),
    volume: (percent: number, deviceId?: string | null) =>
      request("PUT", "/me/player/volume", { query: { volume_percent: Math.max(0, Math.min(100, Math.round(percent))), ...device(deviceId) } }),
    /** How many tracks a context holds — an album's, or a playlist's the athlete owns; null when Spotify won't say. */
    count: async (uri: string): Promise<number | null> => {
      const ctx = contextPath(uri);
      if (!ctx) return null;
      const path = ctx.kind === "album" ? `/albums/${ctx.id}/tracks` : `/playlists/${ctx.id}/items`;
      try {
        const res = await request<{ total?: unknown }>("GET", path, { query: { limit: 1 } });
        return typeof res?.total === "number" ? res.total : null;
      } catch (e) {
        if (e instanceof NotConnected) throw e;
        return null;
      }
    },
    /** A playlist's or an album's name, when Spotify lets the athlete read it; else null. */
    name: async (uri: string): Promise<string | null> => {
      const ctx = contextPath(uri);
      if (!ctx) return null;
      try {
        const res = await request<{ name?: unknown }>("GET", `/${ctx.kind}s/${ctx.id}`, ctx.kind === "playlist" ? { query: { fields: "name" } } : {});
        return typeof res?.name === "string" && res.name.trim() ? res.name.trim() : null;
      } catch (e) {
        if (e instanceof NotConnected) throw e;
        return null;
      }
    },
    /** The athlete's own playlists (and those they follow), a short list. */
    myPlaylists: async (limit = 20): Promise<PlaylistSummary[]> => {
      const res = await request<{ items?: Array<{ id: string; name: string; uri?: string; items?: { total?: number }; tracks?: { total?: number } } | null> }>(
        "GET",
        "/me/playlists",
        { query: { limit } },
      );
      return (res?.items ?? [])
        .filter((p): p is NonNullable<typeof p> => !!p && typeof p.id === "string")
        .map((p) => ({ id: p.id, name: p.name, uri: p.uri ?? `spotify:playlist:${p.id}`, total: p.items?.total ?? p.tracks?.total ?? null }));
    },
    searchAlbums: async (q: string, opts: RequestOptions = {}): Promise<AlbumHit[]> =>
      (await request<{ albums?: { items?: AlbumHit[] } }>("GET", "/search", { ...opts, query: { q, type: "album", limit: 10 } }))?.albums?.items ?? [],
    /** Every track of an album (pages of 50, at most 20 pages). */
    albumTracks: async (id: string, opts: RequestOptions = {}): Promise<string[]> =>
      (await pages<{ uri?: string }>(`/albums/${id}/tracks`, { limit: 50 }, 20, opts)).map((t) => t.uri).filter((u): u is string => typeof u === "string"),
    createPlaylist: async (name: string, description: string, opts: RequestOptions = {}): Promise<{ id: string }> => {
      const res = await request<{ id?: string }>("POST", "/me/playlists", { ...opts, body: { name, public: false, description } });
      if (!res?.id) throw new SpotifyError(500, "NO_PLAYLIST_ID", null, "/me/playlists");
      return { id: res.id };
    },
    addItems: (id: string, uris: string[], opts: RequestOptions = {}) => request("POST", `/playlists/${id}/items`, { ...opts, body: { uris } }),
    replaceItems: (id: string, uris: string[], opts: RequestOptions = {}) => request("PUT", `/playlists/${id}/items`, { ...opts, body: { uris } }),
  };
}

export type Spotify = ReturnType<typeof makeSpotify>;
