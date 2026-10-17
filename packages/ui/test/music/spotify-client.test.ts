/**
 * The music dock's client (2026-10-17; packages/ui/src/music): a Spotify Connect remote that fetches its token from the
 * Worker and calls Spotify directly — every call injectable. Against a fake Spotify Web API:
 *
 *  - a 401 refetches the token once (asking the Worker for a fresh one); a 429 waits Retry-After (a short one) or says
 *    how long (a long one); NO_ACTIVE_DEVICE is told apart;
 *  - a shortcut plays with shuffle on: the shuffle's 204 before the play is sent, from a random position inside the
 *    context's count; a device that refuses a shuffle before it plays gets it after;
 *  - no device listed: the open.spotify.com link opens, and when the app is visible again the play is retried against
 *    the device that is now listed;
 *  - the volume only where the device takes it;
 *  - links and URIs parsed;
 *  - the Minecraft playlist built from the official albums (found or missing, batches of 100), and a stored one reused;
 *  - the player read only while the dock is expanded and the page visible, every 5 s, backing off on a 429.
 *
 * Synthetic ids only.
 */
import { describe, expect, it } from "vitest";
import { API, fakeSpotify, fakeTokens, sid, trackUri } from "./fake-spotify.js";
import { isNoDevice, makeSpotify, NotConnected, SpotifyError } from "../../src/music/spotify.js";
import { openUrlOf, parseSpotifyLink } from "../../src/music/links.js";
import { chooseDevice, makeRemote, playContext } from "../../src/music/remote.js";
import { buildMinecraftPlaylist, MINECRAFT_ALBUMS, MINECRAFT_PLAYLIST_NAME, matchAlbum } from "../../src/music/minecraft.js";
import { makePoller, POLL_MS } from "../../src/music/poller.js";

const ID = "0123456789abcdefABCDEF";

function setup(init: Parameters<typeof fakeSpotify>[0] = {}, opts: { expiresInMs?: number; reason?: "not_connected" | "reconnect" } = {}) {
  const fake = fakeSpotify(init);
  let clock = 1_000_000;
  const slept: number[] = [];
  const tokens = fakeTokens(fake, { ...opts, now: () => clock });
  const spotify = makeSpotify({
    token: tokens.token,
    fetch: fake.fetch,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  return { fake, spotify, tokens, slept, advance: (ms: number) => (clock += ms) };
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

  it("a 429 waits a short Retry-After and tries once more; a long one is reported with its wait", async () => {
    const { fake, spotify, slept } = setup();
    fake.script("GET /me/player/devices", { status: 429, headers: { "Retry-After": "2" } });
    expect(await spotify.devices()).toHaveLength(1);
    expect(slept).toEqual([2000]);
    fake.script("GET /me/player/devices", { status: 429, headers: { "Retry-After": "40" } });
    const err = (await spotify.devices().catch((e: unknown) => e)) as SpotifyError;
    expect(err).toBeInstanceOf(SpotifyError);
    expect([err.status, err.retryAfterMs]).toEqual([429, 40_000]);
    expect(slept).toEqual([2000]);
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
        sleep: async () => undefined,
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
    const remote = makeRemote({
      spotify: env.spotify,
      prefer: () => "Smartphone",
      random: () => 0,
      openLink: (url) => {
        opened.push(url);
        return allowOpen;
      },
      now: () => 0,
      sleep: async () => undefined,
    });
    return { ...env, remote };
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
    // Spotify is open now: the phone is listed.
    fake.state.devices.push({ ...phone });
    expect(await remote.visible()).toMatchObject({ kind: "playing", device: { id: "phone-1" } });
    expect(fake.calls.find((c) => c.path === "/me/player/play")!.query).toEqual({ device_id: "phone-1" });
    expect(remote.pending()).toBeNull();
    expect(opened).toHaveLength(1);
  });

  it("back with still no device: it looks again a few times, never opens the link twice, and keeps the play waiting", async () => {
    const opened: string[] = [];
    const { remote, fake } = remoteWith([], opened);
    await remote.play(shortcut);
    expect(await remote.visible()).toEqual({ kind: "waiting", openUrl: `https://open.spotify.com/playlist/${PL}` });
    expect(fake.calls.filter((c) => c.path === "/me/player/devices").length).toBeGreaterThanOrEqual(3);
    expect(opened).toHaveLength(1);
    expect(remote.pending()?.id).toBe("mine");
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

// ── The Minecraft playlist ───────────────────────────────────────────────────

/** The official albums as the fake catalogue holds them, with decoys. */
function catalogue(opts: { missing?: string[]; bigAlpha?: number } = {}) {
  const albums = MINECRAFT_ALBUMS.filter((a) => !(opts.missing ?? []).includes(a.title)).map((a, i) => ({
    id: sid(`mc${i}`),
    name: `${a.title} (Original Game Soundtrack)`.replace(/^Minecraft – (Volume \w+) \(Original Game Soundtrack\)$/, "Minecraft - $1"),
    artists: [a.artists[0]!],
    tracks: i === 0 ? (opts.bigAlpha ?? 24) : 6 + i,
  }));
  return [
    // Decoys: a cover album of the right name, and the trailer score — never the soundtrack.
    { id: sid("decoy1"), name: "Minecraft - Volume Alpha (Piano Covers)", artists: ["Someone Else"], tracks: 10 },
    { id: sid("decoy2"), name: "Minecraft: Chase the Skies (Original Trailer Score)", artists: ["Amos Roddy"], tracks: 2 },
    ...albums,
  ];
}

describe("the Minecraft playlist", () => {
  it("matches an album by its name AND an artist, never a cover or a trailer score", () => {
    const alpha = MINECRAFT_ALBUMS[0]!;
    expect(matchAlbum(alpha, [{ id: "a", name: "Minecraft - Volume Alpha", artists: [{ name: "C418" }] }])?.id).toBe("a");
    expect(matchAlbum(alpha, [{ id: "b", name: "Minecraft - Volume Alpha", artists: [{ name: "Someone Else" }] }])).toBeNull();
    expect(matchAlbum(alpha, [{ id: "c", name: "Minecraft - Volume Alpha (Piano Covers)", artists: [{ name: "C418" }] }])).toBeNull();
    expect(matchAlbum(alpha, [{ id: "d", name: "Minecraft - Volume Beta", artists: [{ name: "C418" }] }])).toBeNull();
    const skies = MINECRAFT_ALBUMS.find((a) => a.title.includes("Skies"))!;
    expect(matchAlbum(skies, [{ id: "e", name: "Minecraft: Chase the Skies (Original Trailer Score)", artists: [{ name: "Amos Roddy" }] }])).toBeNull();
    expect(matchAlbum(skies, [{ id: "f", name: "Minecraft: Chase the Skies (Original Game Soundtrack)", artists: [{ name: "amos roddy" }] }])?.id).toBe("f");
    const caves = MINECRAFT_ALBUMS.find((a) => a.title.includes("Caves"))!;
    expect(matchAlbum(caves, [{ id: "g", name: "Minecraft: Caves and Cliffs (Original Game Soundtrack)", artists: [{ name: "Kumi Tanioka" }] }])?.id).toBe("g");
  });

  it("lists every official album the brief names, and the later one confirmed (Chaos Cubed)", () => {
    expect(MINECRAFT_ALBUMS.map((a) => a.title)).toEqual([
      "Minecraft – Volume Alpha",
      "Minecraft – Volume Beta",
      "Minecraft: Nether Update",
      "Minecraft: Caves & Cliffs",
      "Minecraft: The Wild Update",
      "Minecraft: Trails & Tales",
      "Minecraft: Tricky Trials",
      "Minecraft: Chase the Skies",
      "Minecraft: Chaos Cubed",
    ]);
  });

  it("builds a private playlist of every track of every album found, in batches of 100, and says what it couldn't find", async () => {
    const albums = catalogue({ missing: ["Minecraft: Chaos Cubed"], bigAlpha: 130 });
    const { fake, spotify } = setup({ albums });
    const built = await buildMinecraftPlaylist(spotify, {});
    expect(built.found).toBe(8);
    expect(built.of).toBe(9);
    expect(built.missing).toEqual(["Minecraft: Chaos Cubed"]);
    const create = fake.calls.find((c) => c.method === "POST" && c.path === "/me/playlists")!;
    expect(create.body).toMatchObject({ name: MINECRAFT_PLAYLIST_NAME, public: false });
    const expected = albums.filter((a) => !a.name.includes("Covers") && !a.name.includes("Trailer")).reduce((n, a) => n + a.tracks, 0);
    expect(built.tracks).toBe(expected);
    const adds = fake.calls.filter((c) => c.method === "POST" && c.path === `/playlists/${built.playlistId}/items`);
    expect(adds.map((c) => (c.body as { uris: string[] }).uris.length)).toEqual([100, 100, Math.max(0, expected - 200)].filter((n) => n > 0));
    expect(fake.state.playlists.get(built.playlistId)!.uris).toHaveLength(expected);
    // Paged album tracks (130 > 50), and no search asks for more than Spotify's ten.
    expect(fake.calls.filter((c) => c.path === `/albums/${albums[2]!.id}/tracks`).length).toBe(3);
    expect(fake.calls.filter((c) => c.path === "/search").every((c) => Number(c.query.limit) <= 10 && c.query.type === "album")).toBe(true);
    // No decoy's tracks.
    const decoyTrack = trackUri(albums[0]!.id, 0);
    expect(fake.state.playlists.get(built.playlistId)!.uris).not.toContain(decoyTrack);
  });

  it("all albums missing builds nothing", async () => {
    const { fake, spotify } = setup({ albums: [] });
    const built = await buildMinecraftPlaylist(spotify, {});
    expect([built.found, built.of, built.playlistId]).toEqual([0, 9, null]);
    expect(fake.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("a stored playlist is reused without building; Rebuild replaces its tracks rather than making another", async () => {
    const albums = catalogue();
    const { fake, spotify } = setup({ albums, ownedPlaylists: [{ id: PL, name: MINECRAFT_PLAYLIST_NAME, total: 3 }] });
    expect(await buildMinecraftPlaylist(spotify, { storedId: PL })).toEqual({ playlistId: PL, reused: true });
    expect(fake.calls).toEqual([]);
    const rebuilt = await buildMinecraftPlaylist(spotify, { storedId: PL, rebuild: true });
    expect(rebuilt).toMatchObject({ playlistId: PL, found: 9, of: 9 });
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/me/playlists")).toEqual([]);
    const writes = fake.calls.filter((c) => c.path === `/playlists/${PL}/items` && c.method !== "GET");
    expect(writes[0]!.method).toBe("PUT");
    expect(writes.slice(1).every((c) => c.method === "POST")).toBe(true);
    expect(fake.state.playlists.get(PL)!.uris).toHaveLength(albums.filter((a) => !/Covers|Trailer/.test(a.name)).reduce((n, a) => n + a.tracks, 0));
  });

  it("a stored playlist that is gone is built afresh on Rebuild", async () => {
    const { fake, spotify } = setup({ albums: catalogue() });
    const rebuilt = await buildMinecraftPlaylist(spotify, { storedId: sid("gone"), rebuild: true });
    expect(rebuilt).toMatchObject({ found: 9 });
    expect("playlistId" in rebuilt && rebuilt.playlistId).not.toBe(sid("gone"));
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/me/playlists")).toHaveLength(1);
  });

  it("a 429 mid-build waits Retry-After and carries on", async () => {
    const { fake, spotify, slept } = setup({ albums: catalogue() });
    fake.script("GET /search", { status: 429, headers: { "Retry-After": "7" } });
    const built = await buildMinecraftPlaylist(spotify, {});
    expect(built).toMatchObject({ found: 9 });
    expect(slept).toContain(7000);
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
