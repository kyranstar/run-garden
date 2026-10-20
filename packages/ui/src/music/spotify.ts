/**
 * The music dock's Spotify client (2026-10-17): a Spotify Connect remote. It asks the Worker for a short-lived access
 * token (`/api/music/spotify/token`; the tokens themselves stay encrypted on the server) and calls the Web API
 * directly. Every call goes through injected deps, so the tests drive it against a fake API.
 *
 *  - 401: the token is fetched again once, asking the Worker for a fresh one, and the call tried again.
 *  - 429: the shared backoff (music/backoff.ts) — the call is not tried again; while it lasts every call is refused
 *    here, before the network (`SpotifyError` 429, reason "BACKOFF", with the time left). A success once it has run out
 *    resets it. A token the Worker can't hand out (its 502) backs off the same way (reason "TOKEN").
 *  - 404 `NO_ACTIVE_DEVICE` (or any 404 from a player command): `isNoDevice` — the dock's open-link fallback.
 *
 * It reads and plays; it never creates, changes or deletes anything in the athlete's Spotify account.
 *
 * Development-mode notes (Spotify, 2026): a playlist's items are readable only when the athlete owns or collaborates on
 * it (`/playlists/{id}/items`, renamed from `/tracks`); its name and description are readable either way.
 */
import { isSpotifyCover, MUSIC_DESCRIPTION_MAX, MUSIC_NAME_MAX, plainSpotifyText } from "@rg/domain";
import { makeBackoff, type Backoff } from "./backoff.js";

export const SPOTIFY_API = "https://api.spotify.com/v1";
/** A token closer than this to its expiry is fetched again before use. */
export const TOKEN_EARLY_MS = 60_000;
/** The athlete's playlists listed at a time, in the add flow. */
export const PLAYLISTS_PAGE = 20;

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

/** Spotify asked the dock to slow down (a 429 just now, or the backoff still running): `retryAfterMs` is the time left. */
export const isSlowDown = (e: unknown): e is SpotifyError => e instanceof SpotifyError && e.status === 429;

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
  /** The backoff every call shares (default: one of this client's own, kept nowhere). */
  backoff?: Backoff;
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

/** What Spotify says of a playlist or an album, as the dock keeps it: plain words, a cover on Spotify's own hosts. */
export interface ContextDetails {
  name: string;
  description: string;
  image: string | null;
  total: number | null;
}

export interface PlaylistSummary extends ContextDetails {
  id: string;
  uri: string;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** A path on this origin (the fixture's stand-in API), never another host. */
const sameOriginPath = (base: string | undefined): string | null =>
  base && base.startsWith("/") && !base.startsWith("//") ? base.replace(/\/+$/, "") : null;

/** Spotify's Retry-After, in ms — or null when the page can't read it (a browser shows the page only the headers CORS
 * exposes, and this one may not be): the backoff's own step decides then. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after")?.trim();
  const secs = raw ? Number(raw) : NaN;
  return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1000) : null;
}

/** The smallest cover of at least 64 px (Spotify lists them largest first), on Spotify's own hosts; else null. */
function coverOf(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const usable = images.filter((i): i is { url: string; width?: number | null } => !!i && isSpotifyCover((i as { url?: unknown }).url));
  const fit = usable.filter((i) => (i.width ?? 640) >= 64);
  return (fit.at(-1) ?? usable[0])?.url ?? null;
}

const totalOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Spotify's playlist JSON as the dock keeps it; null without a name. */
function playlistDetails(p: { name?: unknown; description?: unknown; images?: unknown; items?: { total?: unknown }; tracks?: { total?: unknown } }): ContextDetails | null {
  const name = plainSpotifyText(p.name, MUSIC_NAME_MAX);
  if (!name) return null;
  return {
    name,
    description: plainSpotifyText(p.description, MUSIC_DESCRIPTION_MAX),
    image: coverOf(p.images),
    total: totalOf(p.items?.total) ?? totalOf(p.tracks?.total),
  };
}

export function makeSpotify(deps: SpotifyDeps) {
  const backoff = deps.backoff ?? makeBackoff({ now: deps.now, storage: null });
  let cached: { token: string; expiresAt: number; base: string } | null = null;
  /** The token fetch under way, shared by every call that needs one meanwhile (review #1: the dock reads two
   * endpoints at once, and two fetches after the hour meant two refreshes racing on the server). A fresh one is never
   * answered by a plain one already under way. */
  let inflight: { fresh: boolean; promise: Promise<{ token: string; expiresAt: number; base: string }> } | null = null;

  async function token(fresh: boolean): Promise<{ token: string; base: string }> {
    if (!fresh && cached && cached.expiresAt - deps.now() > TOKEN_EARLY_MS) return cached;
    if (inflight && (inflight.fresh || !fresh)) return inflight.promise;
    const promise = (async () => {
      let answer: TokenAnswer;
      try {
        answer = await deps.token(fresh);
      } catch {
        // The Worker couldn't hand out a token (its 502: Spotify refused the refresh; or no answer at all): the same
        // backoff as a 429, so a poll every 5 s doesn't ask again and again (review-M M5).
        throw new SpotifyError(429, "TOKEN", backoff.hit(null), "/token");
      }
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

  /** Backing off: refused here, before the token or the network. */
  const holdIfBackingOff = (path: string) => {
    const left = backoff.remaining();
    if (left > 0) throw new SpotifyError(429, "BACKOFF", left, path);
  };

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T | null> {
    holdIfBackingOff(path);
    let t = await token(false);
    let refetched = false;
    const qs = Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    for (;;) {
      holdIfBackingOff(path);
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
      if (res.status === 429) throw new SpotifyError(429, null, backoff.hit(retryAfterMs(res)), path);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { reason?: unknown } } | null;
        throw new SpotifyError(res.status, typeof body?.error?.reason === "string" ? body.error.reason : null, null, path);
      }
      backoff.ok();
      if (res.status === 204 || res.status === 202) return null;
      const text = await res.text();
      return text ? (JSON.parse(text) as T) : null;
    }
  }

  const device = (deviceId?: string | null) => (deviceId ? { device_id: deviceId } : {});
  const contextPath = (uri: string): { kind: string; id: string } | null => {
    const m = /^spotify:(playlist|album):([A-Za-z0-9]+)$/.exec(uri);
    return m ? { kind: m[1]!, id: m[2]! } : null;
  };
  /** A read that may fail for this athlete (not theirs, gone): null — but never past a lost connection or a slow-down. */
  async function soft<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (e) {
      if (e instanceof NotConnected || isSlowDown(e)) throw e;
      return null;
    }
  }

  return {
    request,
    backoff,
    devices: async (): Promise<Device[]> => (await request<{ devices?: Device[] }>("GET", "/me/player/devices"))?.devices ?? [],
    /** Now playing; null when nothing is (Spotify's 204). */
    player: () => request<PlayerState>("GET", "/me/player"),
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
    count: (uri: string): Promise<number | null> =>
      soft(async () => {
        const ctx = contextPath(uri);
        if (!ctx) return null;
        const path = ctx.kind === "album" ? `/albums/${ctx.id}/tracks` : `/playlists/${ctx.id}/items`;
        return totalOf((await request<{ total?: unknown }>("GET", path, { query: { limit: 1 } }))?.total);
      }),
    /** What Spotify says of a playlist or an album — its name, its description (an album's: who made it), its cover and
     * its count — in one read; null when the athlete can't read it. */
    details: (uri: string): Promise<ContextDetails | null> =>
      soft(async () => {
        const ctx = contextPath(uri);
        if (!ctx) return null;
        if (ctx.kind === "playlist") {
          return playlistDetails((await request<Parameters<typeof playlistDetails>[0]>("GET", `/playlists/${ctx.id}`, { query: { fields: "name,description,images" } })) ?? {});
        }
        const a = await request<{ name?: unknown; images?: unknown; total_tracks?: unknown; artists?: Array<{ name?: unknown }> }>("GET", `/albums/${ctx.id}`);
        const name = plainSpotifyText(a?.name, MUSIC_NAME_MAX);
        if (!name) return null;
        const by = (a?.artists ?? []).map((x) => plainSpotifyText(x?.name, 60)).filter(Boolean);
        return { name, description: by.length ? plainSpotifyText(`Album by ${by.join(", ")}`, MUSIC_DESCRIPTION_MAX) : "", image: coverOf(a?.images), total: totalOf(a?.total_tracks) };
      }),
    /** One page of the athlete's own playlists (and those they follow), with what the dock keeps of each; `next` is the
     * offset of the page after it, or null. One read: the add flow asks for the next page only when the athlete does. */
    myPlaylists: async (offset = 0, limit = PLAYLISTS_PAGE): Promise<{ items: PlaylistSummary[]; next: number | null }> => {
      const res = await request<{ items?: Array<Record<string, unknown> | null>; next?: unknown }>("GET", "/me/playlists", { query: { limit, offset } });
      const raw = res?.items ?? [];
      const items = raw.flatMap((p) => {
        if (!p || typeof p.id !== "string") return [];
        const d = playlistDetails(p as Parameters<typeof playlistDetails>[0]);
        return d ? [{ id: p.id, uri: typeof p.uri === "string" ? p.uri : `spotify:playlist:${p.id}`, ...d }] : [];
      });
      return { items, next: res?.next && raw.length > 0 ? offset + raw.length : null };
    },
  };
}

export type Spotify = ReturnType<typeof makeSpotify>;
