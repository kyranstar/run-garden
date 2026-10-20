/**
 * The music dock's client (2026-10-17; packages/ui/src/music): a Spotify Connect remote that fetches its token from the
 * Worker and calls Spotify directly — every call injectable. Against a fake Spotify Web API:
 *
 *  - a 401 refetches the token once (asking the Worker for a fresh one); a 429 backs off — no call tried again, every
 *    call refused before the network while it lasts, the steps doubling from 30 s with no Retry-After (CORS hides
 *    it), Spotify's own wait when longer, reset by a success; NO_ACTIVE_DEVICE is told apart;
 *  - a playlist's or an album's details in one read (its name, its description made plain, its cover, its count), and
 *    the athlete's playlists a page at a time;
 *  - a shortcut plays with shuffle on: the shuffle's 204 before the play is sent, from a random position inside the
 *    context's count; a device that refuses a shuffle before it plays gets it after;
 *  - no device listed: the open.spotify.com link opens, and when the app is visible again the play is retried against
 *    the device that is now listed;
 *  - the volume only where the device takes it;
 *  - links and URIs parsed;
 *  - the player read only while the dock is expanded and the page visible, every 5 s, waiting out a backoff.
 *
 * Synthetic ids only.
 */
import { describe, expect, it } from "vitest";
import { API, fakeSpotify, fakeTokens, sid, trackUri } from "./fake-spotify.js";
import { isNoDevice, makeSpotify, NotConnected, SpotifyError } from "../../src/music/spotify.js";
import { BACKOFF_FIRST_MS, BACKOFF_KEY, BACKOFF_MAX_MS, makeBackoff } from "../../src/music/backoff.js";
import { openUrlOf, parseSpotifyLink } from "../../src/music/links.js";
import { chooseDevice, makeRemote, playContext } from "../../src/music/remote.js";
import { makePoller, POLL_MS } from "../../src/music/poller.js";

const ID = "0123456789abcdefABCDEF";

function setup(init: Parameters<typeof fakeSpotify>[0] = {}, opts: { expiresInMs?: number; reason?: "not_connected" | "reconnect" } = {}) {
  const fake = fakeSpotify(init);
  let clock = 1_000_000;
  const tokens = fakeTokens(fake, { ...opts, now: () => clock });
  const spotify = makeSpotify({ token: tokens.token, fetch: fake.fetch, now: () => clock });
  return { fake, spotify, tokens, advance: (ms: number) => (clock += ms) };
}

// ── The client ───────────────────────────────────────────────────────────────

describe("the client", () => {
  it("calls Spotify with the Worker's token, and keeps it until it nears expiry", async () => {
    const { fake, spotify, tokens, advance } = setup({}, { expiresInMs: 3600_000 });
    await spotify.devices();
    await spotify.devices();
    expect(tokens.asked).toEqual([false]);
    expect(fake.calls.every((c) => c.auth === "Bearer token-1")).toBe(true);
    advance(3600_000 - 30_000);
    await spotify.devices();
    expect(tokens.asked).toEqual([false, false]);
  });

  it("calls made together share one token fetch (the dock reads two endpoints at once; review #1)", async () => {
    const { spotify, tokens } = setup({ albums: [{ id: sid("alb"), name: "An Album", artists: ["Someone"], tracks: 3 }] });
    await Promise.all([spotify.devices(), spotify.player(), spotify.count(`spotify:album:${sid("alb")}`)]);
    expect(tokens.asked).toEqual([false]);
  });

  it("two 401s together ask the Worker for ONE fresh token, and both try again with it", async () => {
    const { fake, spotify, tokens } = setup();
    fake.script("GET /me/player/devices", { status: 401 });
    fake.script("GET /me/player", { status: 401 });
    await Promise.all([spotify.devices(), spotify.player()]);
    expect(tokens.asked).toEqual([false, true]);
    expect(fake.calls.slice(2).map((c) => c.auth)).toEqual(["Bearer token-2", "Bearer token-2"]);
  });

  it("a 401 that arrives after another call already fetched a fresh token uses that one — never a second refresh", async () => {
    const { fake, spotify, tokens } = setup();
    let release: () => void = () => undefined;
    const late = new Promise<void>((r) => (release = r));
    fake.script("GET /me/player/devices", { status: 401 });
    fake.script("GET /me/player", { status: 401, gate: late });
    const a = spotify.devices();
    const b = spotify.player();
    await a; // A's 401, its fresh token, its retry: done
    release(); // B's 401 only now
    await b;
    expect(tokens.asked).toEqual([false, true]);
    expect(fake.calls.at(-1)!.auth).toBe("Bearer token-2");
  });

  it("a fresh ask after a 401 is never answered by a plain token fetch already under way", async () => {
    const fake = fakeSpotify();
    let clock = 0;
    const asked: boolean[] = [];
    let releasePlain: () => void = () => undefined;
    const spotify = makeSpotify({
      token: async (fresh) => {
        asked.push(fresh);
        if (!fresh && asked.length > 1) await new Promise<void>((r) => (releasePlain = r));
        if (fresh) fake.state.validToken = "token-2";
        return { connected: true, accessToken: fake.state.validToken, expiresAt: new Date(clock + 120_000).toISOString() };
      },
      fetch: fake.fetch,
      now: () => clock,
    });
    await spotify.devices(); // token-1, good for two minutes
    let releaseA: () => void = () => undefined;
    fake.script("GET /me/player/devices", { status: 401, gate: new Promise<void>((r) => (releaseA = r)) });
    const a = spotify.devices(); // sent with token-1; its 401 comes later
    clock += 90_000; // inside the last minute: the next call fetches a plain token
    const b = spotify.player();
    await new Promise((r) => setTimeout(r, 0));
    releaseA(); // A's 401 while B's plain fetch is under way
    await new Promise((r) => setTimeout(r, 0));
    releasePlain();
    await Promise.all([a, b]);
    expect(asked).toContain(true);
  });

  it("a 401 asks the Worker for a fresh token once, and tries again with it", async () => {
    const { fake, spotify, tokens } = setup();
    fake.script("GET /me/player/devices", { status: 401, body: { error: { status: 401, message: "expired" } } });
    const devices = await spotify.devices();
    expect(devices).toHaveLength(1);
    expect(tokens.asked).toEqual([false, true]);
    expect(fake.calls.map((c) => c.auth)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("a second 401 is not retried forever", async () => {
    const { fake, spotify, tokens } = setup();
    fake.script("GET /me/player/devices", { status: 401 }, { status: 401 }, { status: 401 });
    await expect(spotify.devices()).rejects.toMatchObject({ status: 401 });
    expect(tokens.asked).toEqual([false, true]);
    expect(fake.calls).toHaveLength(2);
  });

  it("not connected (or a consent to renew) is NotConnected with the Worker's reason, and Spotify is not called", async () => {
    const { fake, spotify } = setup({}, { reason: "reconnect" });
    const err = await spotify.devices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotConnected);
    expect((err as NotConnected).reason).toBe("reconnect");
    expect(fake.calls).toEqual([]);
  });

  it("a 429 backs off: the call is not tried again, and while it lasts every call is refused here — before the network — with the time left", async () => {
    const { fake, spotify, advance } = setup();
    fake.script("GET /me/player/devices", { status: 429 });
    const err = (await spotify.devices().catch((e: unknown) => e)) as SpotifyError;
    expect([err.status, err.reason, err.retryAfterMs]).toEqual([429, null, BACKOFF_FIRST_MS]);
    expect(fake.calls).toHaveLength(1);
    advance(10_000);
    for (const call of [() => spotify.player(), () => spotify.play({ contextUri: `spotify:playlist:${ID}` }), () => spotify.myPlaylists(0), () => spotify.details(`spotify:playlist:${ID}`)]) {
      const held = (await call().catch((e: unknown) => e)) as SpotifyError;
      expect([held.status, held.reason, held.retryAfterMs]).toEqual([429, "BACKOFF", 20_000]);
    }
    expect(fake.calls).toHaveLength(1);
    advance(20_000);
    expect(await spotify.devices()).toHaveLength(1);
    expect(fake.calls).toHaveLength(2);
  });

  it("with no Retry-After (a browser hides it): 30 s, 1 min, 2 min … doubling to about 15 min; Spotify's own wait when longer; a success starts over", async () => {
    const { fake, spotify, advance } = setup();
    const waits: Array<number | null> = [];
    const limited = async (headers?: Record<string, string>) => {
      fake.script("GET /me/player/devices", { status: 429, ...(headers ? { headers } : {}) });
      const err = (await spotify.devices().catch((e: unknown) => e)) as SpotifyError;
      waits.push(err.retryAfterMs);
      advance(err.retryAfterMs ?? 0);
    };
    for (const headers of [undefined, { "Retry-After": "" }, { "Retry-After": "soon" }, { "Retry-After": "0" }, undefined, undefined, undefined]) await limited(headers);
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    expect(BACKOFF_MAX_MS).toBe(15 * 60_000);
    // A success: the next 429 is the first step again — or Spotify's wait, when it is longer.
    expect(await spotify.devices()).toHaveLength(1);
    await limited({ "Retry-After": "90" });
    expect(waits.at(-1)).toBe(90_000);
    expect(await spotify.devices()).toHaveLength(1);
    await limited({ "Retry-After": "5" });
    expect(waits.at(-1)).toBe(BACKOFF_FIRST_MS);
    // Each 429 was one call: none was tried again.
    expect(fake.calls.filter((c) => c.path === "/me/player/devices")).toHaveLength(waits.length + 2);
  });

  it("a 429 for a call already out when the backoff began is the same step, never the next", async () => {
    const { fake, spotify } = setup();
    fake.script("GET /me/player/devices", { status: 429 });
    fake.script("GET /me/player", { status: 429 });
    const [a, b] = (await Promise.all([spotify.devices().catch((e: unknown) => e), spotify.player().catch((e: unknown) => e)])) as SpotifyError[];
    expect([a!.retryAfterMs, b!.retryAfterMs]).toEqual([BACKOFF_FIRST_MS, BACKOFF_FIRST_MS]);
  });

  it("the backoff is kept on the device: a reload finds it, and a success clears it", () => {
    let clock = 0;
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const first = makeBackoff({ now: () => clock, storage });
    first.hit(null);
    first.hit(null);
    clock += 10_000;
    const again = makeBackoff({ now: () => clock, storage });
    expect(again.remaining()).toBe(BACKOFF_FIRST_MS - 10_000);
    clock += BACKOFF_FIRST_MS;
    expect(again.hit(null)).toBe(2 * BACKOFF_FIRST_MS);
    again.ok();
    expect(store.has(BACKOFF_KEY)).toBe(false);
    // Unreadable or no storage at all: none.
    store.set(BACKOFF_KEY, "{not json");
    expect(makeBackoff({ now: () => clock, storage }).remaining()).toBe(0);
    expect(makeBackoff({ now: () => clock, storage: null }).remaining()).toBe(0);
  });

  it("a playlist's details in one read — its name, its description made plain, its cover on Spotify's host; an album's maker; null when not the athlete's to read", async () => {
    const { fake, spotify } = setup({
      albums: [{ id: sid("alb"), name: "An Album", artists: ["A Band", "B Band"], tracks: 9 }],
    });
    fake.state.playlists.set(sid("calm"), {
      name: "Calm",
      owned: false,
      uris: [],
      description: "Slow &amp; quiet. &lt;a href=&quot;spotify:playlist:x&quot;&gt;More&lt;/a&gt;",
      images: [
        { url: "https://i.scdn.co/image/large", width: 640 },
        { url: "https://i.scdn.co/image/small", width: 60 },
        { url: "https://i.scdn.co/image/mid", width: 300 },
      ],
    });
    expect(await spotify.details(`spotify:playlist:${sid("calm")}`)).toEqual({ name: "Calm", description: "Slow & quiet. More", image: "https://i.scdn.co/image/mid", total: null });
    expect(fake.calls.at(-1)!.query).toEqual({ fields: "name,description,images" });
    expect(await spotify.details(`spotify:album:${sid("alb")}`)).toEqual({ name: "An Album", description: "Album by A Band, B Band", image: null, total: 9 });
    expect(await spotify.details(`spotify:playlist:${sid("gone")}`)).toBeNull();
    fake.state.playlists.set(sid("odd"), { name: "Odd", owned: false, uris: [], images: [{ url: "https://example.com/x.jpg", width: 300 }] });
    expect((await spotify.details(`spotify:playlist:${sid("odd")}`))!.image).toBeNull();
    expect(fake.calls).toHaveLength(4);
  });

  it("the athlete's playlists, a page at a time: one read each, the next page's offset while there are more", async () => {
    const owned = Array.from({ length: 23 }, (_, i) => ({ id: sid(`pl${i}x`), name: `List ${i}`, total: i }));
    const { fake, spotify } = setup({ ownedPlaylists: owned });
    const first = await spotify.myPlaylists(0);
    expect(first.items).toHaveLength(20);
    expect(first.items[1]).toEqual({ id: sid("pl1x"), uri: `spotify:playlist:${sid("pl1x")}`, name: "List 1", description: "", image: null, total: 1 });
    expect(first.next).toBe(20);
    const second = await spotify.myPlaylists(first.next!);
    expect(second.items.map((p) => p.name)).toEqual(["List 20", "List 21", "List 22"]);
    expect(second.next).toBeNull();
    expect(fake.calls.map((c) => c.query)).toEqual([{ limit: "20", offset: "0" }, { limit: "20", offset: "20" }]);
  });

  it("NO_ACTIVE_DEVICE is told apart from other refusals", async () => {
    const { fake, spotify } = setup({ devices: [] });
    const err = await spotify.play({ contextUri: `spotify:playlist:${ID}`, deviceId: undefined }).catch((e: unknown) => e);
    expect(isNoDevice(err)).toBe(true);
    fake.script("PUT /me/player/pause", { status: 403, body: { error: { status: 403, reason: "PREMIUM_REQUIRED" } } });
    expect(isNoDevice(await spotify.pause().catch((e: unknown) => e))).toBe(false);
  });

  it("an API base the Worker names (fixture mode) is used instead of Spotify's — only a path on this origin", async () => {
    const fake = fakeSpotify();
    const seen: string[] = [];
    for (const apiBase of ["/api/music/fixture/v1", "https://evil.example/v1", "//evil.example/v1"]) {
      const spotify = makeSpotify({
        token: async () => ({ connected: true, accessToken: "token-1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), apiBase }),
        fetch: (async (input: RequestInfo | URL) => {
          seen.push(String(input));
          return new Response(JSON.stringify({ devices: [] }), { status: 200 });
        }) as typeof fetch,
        now: () => Date.now(),
      });
      await spotify.devices();
    }
    expect(seen).toEqual(["/api/music/fixture/v1/me/player/devices", `${API}/me/player/devices`, `${API}/me/player/devices`]);
    expect(fake.calls).toEqual([]);
  });
});

// ── Links ────────────────────────────────────────────────────────────────────

describe("links", () => {
  it("reads open.spotify.com links and spotify: URIs for playlists and albums", () => {
    const want = (kind: "playlist" | "album") => ({ kind, id: ID, uri: `spotify:${kind}:${ID}` });
    expect(parseSpotifyLink(`https://open.spotify.com/playlist/${ID}?si=abc123`)).toEqual(want("playlist"));
    expect(parseSpotifyLink(`  https://open.spotify.com/album/${ID}  `)).toEqual(want("album"));
    expect(parseSpotifyLink(`open.spotify.com/playlist/${ID}`)).toEqual(want("playlist"));
    expect(parseSpotifyLink(`https://open.spotify.com/intl-de/album/${ID}?si=x`)).toEqual(want("album"));
    expect(parseSpotifyLink(`spotify:playlist:${ID}`)).toEqual(want("playlist"));
    expect(parseSpotifyLink(`spotify:album:${ID}`)).toEqual(want("album"));
    expect(parseSpotifyLink(`spotify:user:someone:playlist:${ID}`)).toEqual(want("playlist"));
    expect(parseSpotifyLink(`Check this out https://open.spotify.com/playlist/${ID}?si=1 !`)).toEqual(want("playlist"));
  });

  it("refuses tracks, artists, other hosts and nonsense", () => {
    for (const bad of [
      `https://open.spotify.com/track/${ID}`,
      `https://open.spotify.com/artist/${ID}`,
      `spotify:track:${ID}`,
      `https://example.com/playlist/${ID}`,
      `https://open.spotify.com.evil.example/playlist/${ID}`,
      "https://open.spotify.com/playlist/short",
      "",
      "hello",
    ]) {
      expect(parseSpotifyLink(bad), bad).toBeNull();
    }
  });

  it("the open link for a URI", () => {
    expect(openUrlOf(`spotify:playlist:${ID}`)).toBe(`https://open.spotify.com/playlist/${ID}`);
    expect(openUrlOf(`spotify:album:${ID}`)).toBe(`https://open.spotify.com/album/${ID}`);
  });
});

// ── Playing a shortcut ───────────────────────────────────────────────────────

const PL = sid("pl");
const phone = { id: "phone-1", name: "Phone", type: "Smartphone", supports_volume: false };
const desk = { id: "desk-1", name: "Desktop", type: "Computer", supports_volume: true, volume_percent: 40 };

describe("choosing a device", () => {
  it("the active one; else the kind this app runs on; else the first; never a restricted one", () => {
    expect(chooseDevice([phone, { ...desk, is_active: true }], "Smartphone")?.id).toBe("desk-1");
    expect(chooseDevice([desk, phone], "Smartphone")?.id).toBe("phone-1");
    expect(chooseDevice([phone, desk], "Computer")?.id).toBe("desk-1");
    expect(chooseDevice([{ ...desk, type: "Speaker" }], "Smartphone")?.id).toBe("desk-1");
    expect(chooseDevice([{ ...phone, is_restricted: true, is_active: true }], "Smartphone")).toBeNull();
    expect(chooseDevice([], "Smartphone")).toBeNull();
  });
});

describe("playing a shortcut", () => {
  it("shuffle on, its 204 before the play is sent, then the play on the chosen device from a random position inside the count", async () => {
    const { fake, spotify } = setup({ devices: [phone], ownedPlaylists: [{ id: PL, name: "Mine", total: 40 }] });
    const out = await playContext(spotify, { uri: `spotify:playlist:${PL}`, shuffle: true }, { prefer: "Smartphone", random: () => 0.5 });
    expect(out).toMatchObject({ kind: "playing", device: { id: "phone-1" } });
    const player = fake.calls.filter((c) => c.path.startsWith("/me/player/") && c.method !== "GET");
    expect(player.map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /me/player/shuffle", "PUT /me/player/play"]);
    const [shuffle, play] = player as [typeof player[0], typeof player[0]];
    expect(shuffle.query).toEqual({ state: "true", device_id: "phone-1" });
    expect(shuffle.finished).toBeLessThan(play.started);
    expect(play.query).toEqual({ device_id: "phone-1" });
    expect(play.body).toEqual({ context_uri: `spotify:playlist:${PL}`, offset: { position: 20 } });
  });

  it("the random position is always inside the count — 0 at the bottom, count − 1 at the top", async () => {
    for (const [r, want] of [[0, 0], [0.999999, 39], [0.25, 10]] as const) {
      const { fake, spotify } = setup({ devices: [phone], ownedPlaylists: [{ id: PL, name: "Mine", total: 40 }] });
      await playContext(spotify, { uri: `spotify:playlist:${PL}`, shuffle: true }, { prefer: "Smartphone", random: () => r });
      expect((fake.calls.find((c) => c.path === "/me/player/play")!.body as any).offset).toEqual({ position: want });
    }
  });

  it("an album's count is its tracks; a playlist that can't be read (not the athlete's) plays shuffled from wherever Spotify starts", async () => {
    const album = { id: sid("alb"), name: "An Album", artists: ["Someone"], tracks: 12 };
    let { fake, spotify } = setup({ devices: [phone], albums: [album] });
    await playContext(spotify, { uri: `spotify:album:${album.id}`, shuffle: true }, { prefer: "Smartphone", random: () => 0.999 });
    expect((fake.calls.find((c) => c.path === "/me/player/play")!.body as any).offset).toEqual({ position: 11 });
    ({ fake, spotify } = setup({ devices: [phone] }));
    fake.script(`GET /playlists/${PL}/items`, { status: 403, body: { error: { status: 403, message: "Forbidden" } } });
    const out = await playContext(spotify, { uri: `spotify:playlist:${PL}`, shuffle: true }, { prefer: "Smartphone", random: () => 0.5 });
    expect(out.kind).toBe("playing");
    expect(fake.calls.find((c) => c.path === "/me/player/play")!.body).toEqual({ context_uri: `spotify:playlist:${PL}` });
  });

  it("a device that refuses the shuffle before anything plays gets it right after the play", async () => {
    const { fake, spotify } = setup({ devices: [phone], ownedPlaylists: [{ id: PL, name: "Mine", total: 5 }] });
    fake.script("PUT /me/player/shuffle", { status: 404, body: { error: { status: 404, reason: "NO_ACTIVE_DEVICE" } } });
    const out = await playContext(spotify, { uri: `spotify:playlist:${PL}`, shuffle: true }, { prefer: "Smartphone", random: () => 0 });
    expect(out.kind).toBe("playing");
    expect(fake.calls.filter((c) => c.method === "PUT").map((c) => c.path)).toEqual(["/me/player/shuffle", "/me/player/play", "/me/player/shuffle"]);
  });

  it("a shuffle refused after the play has started is not a failed play: the music is playing", async () => {
    const { fake, spotify } = setup({ devices: [phone], ownedPlaylists: [{ id: PL, name: "Mine", total: 5 }] });
    fake.script(
      "PUT /me/player/shuffle",
      { status: 404, body: { error: { status: 404, reason: "NO_ACTIVE_DEVICE" } } },
      { status: 403, body: { error: { status: 403, reason: "UNKNOWN" } } },
    );
    const out = await playContext(spotify, { uri: `spotify:playlist:${PL}`, shuffle: true }, { prefer: "Smartphone", random: () => 0 });
    expect(out).toMatchObject({ kind: "playing", device: { id: "phone-1" } });
  });

  it("no device listed: no player call, and the shortcut's open link is the way on", async () => {
    const { fake, spotify } = setup({ devices: [], ownedPlaylists: [{ id: PL, name: "Mine", total: 5 }] });
    const out = await playContext(spotify, { uri: `spotify:playlist:${PL}`, shuffle: true }, { prefer: "Smartphone", random: () => 0 });
    expect(out).toEqual({ kind: "no_device", openUrl: `https://open.spotify.com/playlist/${PL}` });
    expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a device that vanished between the list and the play is no device too", async () => {
    const { fake, spotify } = setup({ devices: [phone], ownedPlaylists: [{ id: PL, name: "Mine", total: 5 }] });
    fake.script("PUT /me/player/shuffle", { status: 404, body: { error: { status: 404, reason: "NO_ACTIVE_DEVICE" } } });
    fake.script("PUT /me/player/play", { status: 404, body: { error: { status: 404, reason: "NO_ACTIVE_DEVICE" } } });
    expect((await playContext(spotify, { uri: `spotify:playlist:${PL}`, shuffle: true }, { prefer: "Smartphone", random: () => 0 })).kind).toBe("no_device");
  });
});

describe("the remote: the open-link fallback and the retry when the app is visible again", () => {
  function remoteWith(devices: Array<typeof phone>, opened: string[], allowOpen = true) {
    const env = setup({ devices, ownedPlaylists: [{ id: PL, name: "Mine", total: 5 }] });
    let clock = 0;
    const remote = makeRemote({
      spotify: env.spotify,
      prefer: () => "Smartphone",
      random: () => 0,
      openLink: (url) => {
        opened.push(url);
        return allowOpen;
      },
      now: () => clock,
      sleep: async () => undefined,
    });
    return { ...env, remote, tick: (ms: number) => (clock += ms) };
  }
  const shortcut = { id: "mine", label: "Mine", uri: `spotify:playlist:${PL}`, shuffle: true };

  it("with a device it plays, and nothing is left pending", async () => {
    const opened: string[] = [];
    const { remote } = remoteWith([phone], opened);
    expect(await remote.play(shortcut)).toMatchObject({ kind: "playing" });
    expect(opened).toEqual([]);
    expect(remote.pending()).toBeNull();
  });

  it("without one it opens the shortcut in Spotify, and plays it on the device listed once the app is back", async () => {
    const opened: string[] = [];
    const { remote, fake } = remoteWith([], opened);
    expect(await remote.play(shortcut)).toEqual({ kind: "opened", openUrl: `https://open.spotify.com/playlist/${PL}` });
    expect(opened).toEqual([`https://open.spotify.com/playlist/${PL}`]);
    expect(remote.pending()?.id).toBe("mine");
    // The athlete goes to Spotify (the app is hidden), and Spotify lists the phone.
    remote.hidden();
    fake.state.devices.push({ ...phone });
    expect(await remote.visible()).toMatchObject({ kind: "playing", device: { id: "phone-1" } });
    expect(fake.calls.find((c) => c.path === "/me/player/play")!.query).toEqual({ device_id: "phone-1" });
    expect(remote.pending()).toBeNull();
    expect(opened).toHaveLength(1);
  });

  it("back with still no device: it looks again a few times, never opens the link twice — then forgets the play (review #2)", async () => {
    const opened: string[] = [];
    const { remote, fake } = remoteWith([], opened);
    await remote.play(shortcut);
    remote.hidden();
    expect(await remote.visible()).toEqual({ kind: "waiting", openUrl: `https://open.spotify.com/playlist/${PL}` });
    expect(fake.calls.filter((c) => c.path === "/me/player/devices").length).toBeGreaterThanOrEqual(3);
    expect(opened).toHaveLength(1);
    expect(remote.pending()).toBeNull();
    // A later return, Spotify open by then: nothing plays on its own.
    fake.state.devices.push({ ...phone });
    remote.hidden();
    expect(await remote.visible()).toBeNull();
    expect(fake.calls.some((c) => c.path === "/me/player/play")).toBe(false);
  });

  it("only a return from Spotify retries: back without having left plays nothing", async () => {
    const opened: string[] = [];
    const { remote, fake } = remoteWith([], opened);
    await remote.play(shortcut);
    fake.state.devices.push({ ...phone });
    expect(await remote.visible()).toBeNull();
    expect(fake.calls.some((c) => c.path === "/me/player/play")).toBe(false);
    expect(remote.pending()?.id).toBe("mine");
  });

  it("a waiting play lasts two minutes, then is forgotten", async () => {
    const opened: string[] = [];
    const { remote, fake, tick } = remoteWith([], opened);
    await remote.play(shortcut);
    remote.hidden();
    fake.state.devices.push({ ...phone });
    tick(2 * 60_000 + 1);
    expect(remote.pending()).toBeNull();
    expect(await remote.visible()).toBeNull();
    expect(fake.calls.some((c) => c.path === "/me/player/play")).toBe(false);
  });

  it("cancel forgets a waiting play", async () => {
    const opened: string[] = [];
    const { remote, fake } = remoteWith([], opened);
    await remote.play(shortcut);
    remote.cancel();
    remote.hidden();
    fake.state.devices.push({ ...phone });
    expect(await remote.visible()).toBeNull();
    expect(fake.calls.some((c) => c.path === "/me/player/play")).toBe(false);
  });

  it("a link the browser wouldn't open is handed back to be tapped", async () => {
    const opened: string[] = [];
    const { remote } = remoteWith([], opened, false);
    expect(await remote.play(shortcut)).toEqual({ kind: "blocked", openUrl: `https://open.spotify.com/playlist/${PL}` });
    expect(remote.pending()?.id).toBe("mine");
  });

  it("nothing pending, being visible again plays nothing", async () => {
    const opened: string[] = [];
    const { remote, fake } = remoteWith([phone], opened);
    expect(await remote.visible()).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});

describe("the volume", () => {
  it("is set on a device that takes it, and refused (said plainly) on one that doesn't", async () => {
    const { fake, spotify } = setup({ devices: [desk, phone] });
    await spotify.volume(35, "desk-1");
    expect(fake.calls.at(-1)).toMatchObject({ method: "PUT", path: "/me/player/volume", query: { volume_percent: "35", device_id: "desk-1" } });
    expect(fake.state.devices[0]!.volume_percent).toBe(35);
    await expect(spotify.volume(35, "phone-1")).rejects.toMatchObject({ status: 403, reason: "VOLUME_CONTROL_DISALLOW" });
  });

  it("is whole percent from 0 to 100", async () => {
    const { fake, spotify } = setup({ devices: [desk] });
    await spotify.volume(140.6, "desk-1");
    await spotify.volume(-3, "desk-1");
    expect(fake.calls.map((c) => c.query.volume_percent)).toEqual(["100", "0"]);
  });
});

// ── Polling ──────────────────────────────────────────────────────────────────

describe("polling the player", () => {
  function timers() {
    let now = 0;
    const queue: Array<{ at: number; fn: () => void; id: number }> = [];
    let next = 1;
    return {
      schedule: (fn: () => void, ms: number) => {
        const id = next++;
        queue.push({ at: now + ms, fn, id });
        return () => {
          const i = queue.findIndex((t) => t.id === id);
          if (i >= 0) queue.splice(i, 1);
        };
      },
      /** Run every timer due up to `ms` from now, in order. */
      async advance(ms: number) {
        const until = now + ms;
        for (let guard = 0; guard < 1000; guard++) {
          queue.sort((a, b) => a.at - b.at);
          const t = queue[0];
          if (!t || t.at > until) break;
          queue.shift();
          now = t.at;
          t.fn();
          await new Promise((r) => setTimeout(r, 0));
        }
        now = until;
      },
      pending: () => queue.length,
    };
  }

  it("reads only while the dock is expanded and the page visible: at once, then every 5 s; never otherwise", async () => {
    const t = timers();
    const reads: number[] = [];
    let n = 0;
    const poller = makePoller({ read: async () => (reads.push(++n), null), onState: () => undefined, schedule: t.schedule });
    await t.advance(60_000);
    expect(reads).toEqual([]);
    poller.set({ expanded: true, visible: false });
    await t.advance(60_000);
    expect(reads).toEqual([]);
    poller.set({ expanded: true, visible: true });
    await t.advance(0);
    expect(reads).toHaveLength(1);
    await t.advance(POLL_MS * 3);
    expect(reads).toHaveLength(4);
    expect(POLL_MS).toBe(5000);
    poller.set({ expanded: true, visible: false });
    await t.advance(60_000);
    expect(reads).toHaveLength(4);
    expect(t.pending()).toBe(0);
    poller.set({ expanded: true, visible: true });
    await t.advance(0);
    expect(reads).toHaveLength(5);
    poller.set({ expanded: false, visible: true });
    await t.advance(60_000);
    expect(reads).toHaveLength(5);
    expect(t.pending()).toBe(0);
  });

  it("a 429 waits its Retry-After before the next read", async () => {
    const t = timers();
    const reads: number[] = [];
    let first = true;
    const poller = makePoller({
      read: async () => {
        reads.push(1);
        if (first) {
          first = false;
          throw new SpotifyError(429, null, 30_000);
        }
        return null;
      },
      onState: () => undefined,
      schedule: t.schedule,
    });
    poller.set({ expanded: true, visible: true });
    await t.advance(0);
    await t.advance(29_000);
    expect(reads).toHaveLength(1);
    await t.advance(1000);
    expect(reads).toHaveLength(2);
    await t.advance(POLL_MS);
    expect(reads).toHaveLength(3);
  });

  it("a read still in flight when the dock closes is dropped, and nothing more is read", async () => {
    const t = timers();
    const states: unknown[] = [];
    let release: (v: null) => void = () => undefined;
    let reads = 0;
    const poller = makePoller({
      read: () => {
        reads += 1;
        return new Promise((r) => (release = r));
      },
      onState: (s) => states.push(s),
      schedule: t.schedule,
    });
    poller.set({ expanded: true, visible: true });
    await t.advance(0);
    expect(reads).toBe(1);
    poller.set({ expanded: false, visible: true });
    release(null);
    await t.advance(60_000);
    expect(states).toEqual([]);
    expect(reads).toBe(1);
    expect(t.pending()).toBe(0);
  });

  it("a read that fails while the dock closes schedules nothing either", async () => {
    const t = timers();
    let fail: (e: unknown) => void = () => undefined;
    let reads = 0;
    const errors: unknown[] = [];
    const poller = makePoller({
      read: () => {
        reads += 1;
        return new Promise((_, reject) => (fail = reject));
      },
      onState: () => undefined,
      onError: (e) => errors.push(e),
      schedule: t.schedule,
    });
    poller.set({ expanded: true, visible: true });
    await t.advance(0);
    poller.stop();
    fail(new Error("offline"));
    await t.advance(60_000);
    expect([reads, errors.length, t.pending()]).toEqual([1, 0, 0]);
  });

  it("hands each read to the dock", async () => {
    const t = timers();
    const states: unknown[] = [];
    const poller = makePoller({ read: async () => ({ is_playing: true }) as never, onState: (s) => states.push(s), schedule: t.schedule });
    poller.set({ expanded: true, visible: true });
    await t.advance(0);
    expect(states).toEqual([{ is_playing: true }]);
  });
});
