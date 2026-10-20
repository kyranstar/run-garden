/**
 * The music dock's controller (2026-10-17; one abstraction 2026-10-19; packages/ui/src/music/controller.ts): what the
 * dock does, apart from how it looks — driven against the fake Spotify, its preferences saved and its playlists tagged
 * through injected deps.
 *
 *  - It plays only when asked: opening it reads (now playing, then the devices) and never sends a player command.
 *  - One list: the athlete's own playlists, each linked by picking it (their playlists listed a page at a time, only in
 *    the add flow) or pasting a link — named and described from Spotify (one read, kept), tagged once; renamed and
 *    retagged in Edit; removed. Nothing is ever created in their Spotify account.
 *  - Linked before names and tags: read once and tagged on the dock's first open (the old spa slot named by Spotify).
 *  - Asked to slow down: nothing goes out until the backoff ends — one call per step at most, none while collapsed — a
 *    calm line, and a tap says the time left.
 *  - A workout's music at Start: played on the device Spotify would use; no device, the player's line (no link opened
 *    unasked), its Play a tap that may open Spotify.
 *  - Not connected / reconnect from the Worker; no device → the link to tap; the volume only on a device that takes it.
 *
 * Synthetic ids only.
 */
import { describe, expect, it } from "vitest";
import { MUSIC_SHORTCUTS_MAX, keywordGoodFor, type MusicGoodFor, type MusicPreferences, type MusicShortcut } from "@rg/domain";
import { fakeSpotify, fakeTokens, sid } from "./fake-spotify.js";
import { makeSpotify } from "../../src/music/spotify.js";
import { makeBackoff, BACKOFF_FIRST_MS } from "../../src/music/backoff.js";
import { makeDockController, SLOW_LINE, type DockState } from "../../src/music/controller.js";
import { goodForWords, shortTitle, volumeOf } from "../../src/music/dock-model.js";

const PL = sid("mine");
const SPA = sid("spaed");
const phone = { id: "phone-1", name: "Phone", type: "Smartphone", supports_volume: false };
const desk = { id: "desk-1", name: "Desktop", type: "Computer", supports_volume: true, volume_percent: 40 };
const mine = (id: string, uri = `spotify:playlist:${PL}`, extra: Partial<MusicShortcut> = {}): MusicShortcut => ({ id, label: id.toUpperCase(), uri, shuffle: true, ...extra });

function setup(
  opts: {
    devices?: Array<typeof phone>;
    music?: Partial<MusicPreferences>;
    reason?: "not_connected" | "reconnect";
    allowOpen?: boolean;
    renewFails?: boolean;
    owned?: number;
    tagFails?: boolean;
    /** The Worker can't refresh the token (its 502): every token ask throws. */
    tokenFails?: boolean;
    /** The tagging waits for this before it answers. */
    tagGate?: Promise<void>;
  } = {},
) {
  const owned = [
    { id: PL, name: "Easy run", total: 30, description: "Steady songs for easy miles" },
    ...Array.from({ length: opts.owned ?? 0 }, (_, i) => ({ id: sid(`more${i}x`), name: `More ${i}`, total: i })),
  ];
  const fake = fakeSpotify({ devices: opts.devices ?? [phone], albums: [{ id: sid("alb"), name: "An Album", artists: ["A Band"], tracks: 9 }], ownedPlaylists: owned });
  fake.state.playlists.set(SPA, { name: "Spa Sounds", owned: false, uris: [], description: "Calm music for yoga &amp; rest" });
  let clock = 1_000_000;
  const tokens = fakeTokens(fake, { reason: opts.reason, now: () => clock });
  let tokenAsks = 0;
  const token = opts.tokenFails
    ? async (): Promise<never> => {
        tokenAsks += 1;
        throw new Error("api_502");
      }
    : opts.renewFails
      ? async (fresh: boolean) =>
          fresh
            ? { connected: false as const, reason: "reconnect" as const }
            : { connected: true as const, accessToken: "a-token-spotify-refuses", expiresAt: new Date(clock + 3600_000).toISOString() }
      : tokens.token;
  const backoff = makeBackoff({ now: () => clock, storage: null });
  const spotify = makeSpotify({ token, fetch: fake.fetch, now: () => clock, backoff });
  const saved: MusicPreferences[] = [];
  const tagged: Array<Array<{ key: string; name: string; description: string }>> = [];
  const opened: string[] = [];
  const timers: Array<{ fn: () => void; at: number }> = [];
  let ids = 0;
  const dock = makeDockController({
    spotify,
    saveMusic: async (music) => {
      saved.push(music);
      return music;
    },
    tag: async (playlists) => {
      tagged.push(playlists);
      if (opts.tagGate) await opts.tagGate;
      if (opts.tagFails) throw new Error("offline");
      return Object.fromEntries(playlists.map((p) => [p.key, keywordGoodFor(p.name, p.description)]));
    },
    disconnect: async () => undefined,
    prefer: () => "Smartphone",
    random: () => 0,
    openLink: (url) => {
      opened.push(url);
      return opts.allowOpen ?? true;
    },
    now: () => clock,
    sleep: async () => undefined,
    schedule: (fn, ms) => {
      const t = { fn, at: clock + ms };
      timers.push(t);
      return () => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    isVisible: () => true,
    newId: () => `s${++ids}`,
  });
  dock.setServer({ connected: !opts.reason, ...(opts.reason === "reconnect" ? { reason: "reconnect" as const } : {}), music: { shortcuts: [], ...opts.music } });
  const commands = () => fake.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  /** Move the clock on, running each timer that comes due (the poller's reads), in order. */
  async function advance(ms: number) {
    const until = clock + ms;
    for (let guard = 0; guard < 500; guard++) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift();
      clock = t.at;
      t.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    clock = until;
  }
  return { fake, dock, saved, tagged, opened, commands, advance, state: (): DockState => dock.get(), backoff, tokenAsks: () => tokenAsks };
}

describe("it plays only when asked", () => {
  it("opening the dock reads now playing, then the devices, and sends no command", async () => {
    const { dock, fake, commands, state } = setup();
    await dock.open();
    expect(state().expanded).toBe(true);
    expect(commands()).toEqual([]);
    expect(fake.calls.map((c) => c.path)).toEqual(["/me/player", "/me/player/devices"]);
    await dock.close();
    expect(state().expanded).toBe(false);
    expect(commands()).toEqual([]);
  });

  it("closed, it reads nothing at all", async () => {
    const { dock, fake, advance } = setup();
    await dock.setVisible(true);
    await dock.setVisible(false);
    await dock.setVisible(true);
    await advance(10 * 60_000);
    expect(fake.calls).toEqual([]);
  });
});

describe("the playlists", () => {
  it("are the athlete's own, as saved — nothing the app made, none offered to make", () => {
    const { state } = setup({ music: { shortcuts: [mine("spa"), mine("s1")], minecraftPlaylistId: sid("old") } });
    expect(state().music.shortcuts.map((s) => s.id)).toEqual(["spa", "s1"]);
  });

  it("a tap plays one shuffled on the chosen device", async () => {
    const { dock, commands, fake } = setup({ music: { shortcuts: [mine("s1")] } });
    await dock.tap("s1");
    expect(commands()).toEqual(["PUT /me/player/shuffle", "PUT /me/player/play"]);
    expect(fake.calls.find((c) => c.path === "/me/player/play")!.query).toEqual({ device_id: "phone-1" });
    expect(fake.calls.find((c) => c.path === "/me/player/play")!.body).toMatchObject({ context_uri: `spotify:playlist:${PL}` });
  });

  it("what each suits, in plain words", () => {
    expect(goodForWords({ label: "Mix", goodFor: ["mobility", "wind-down"] })).toBe("Mobility · Winding down");
    expect(goodForWords({ label: "Mix" })).toBe("");
    // Not tagged yet: what its words say, as the default reads it (review-M I1).
    expect(goodForWords({ label: "Spa" })).toBe("Mobility · Winding down");
    expect(goodForWords({ label: "Spa", goodFor: [] })).toBe("");
  });
});

describe("adding a playlist", () => {
  it("the add flow lists the athlete's first page of playlists (one read); the next only when asked", async () => {
    const { dock, fake, state } = setup({ owned: 24 });
    await dock.startAdding();
    expect(state().playlists!.items).toHaveLength(20);
    expect(state().playlists!.items[0]).toEqual({ id: PL, uri: `spotify:playlist:${PL}`, name: "Easy run", description: "Steady songs for easy miles", image: null, total: 30 });
    expect(state().playlists!.next).toBe(20);
    expect(fake.calls).toHaveLength(1);
    await dock.morePlaylists();
    expect(state().playlists!.items).toHaveLength(25);
    expect(state().playlists!.next).toBeNull();
    await dock.morePlaylists();
    expect(fake.calls.map((c) => c.query.offset)).toEqual(["0", "20"]);
  });

  it("picked: saved under Spotify's name with what the list said of it, and tagged from its name and description — no read of its own", async () => {
    const { dock, fake, saved, tagged, state } = setup();
    await dock.startAdding();
    const calls = fake.calls.length;
    expect(await dock.addPlaylist(state().playlists!.items[0]!)).toEqual({ kind: "saved" });
    expect(fake.calls).toHaveLength(calls);
    expect(tagged).toEqual([[{ key: "s1", name: "Easy run", description: "Steady songs for easy miles" }]]);
    expect(saved.at(-1)!.shortcuts).toEqual([
      { id: "s1", label: "Easy run", uri: `spotify:playlist:${PL}`, shuffle: true, name: "Easy run", description: "Steady songs for easy miles", total: 30, goodFor: ["run"] },
    ]);
    expect(state().adding).toBeNull();
  });

  it("a pasted link is read once — named, described (made plain), tagged", async () => {
    const { dock, fake, saved } = setup();
    await dock.startAdding();
    expect(await dock.addLink(`https://open.spotify.com/playlist/${SPA}?si=x`)).toEqual({ kind: "saved" });
    expect(fake.calls.filter((c) => c.path === `/playlists/${SPA}`)).toHaveLength(1);
    expect(saved.at(-1)!.shortcuts).toEqual([
      { id: "s1", label: "Spa Sounds", uri: `spotify:playlist:${SPA}`, shuffle: true, name: "Spa Sounds", description: "Calm music for yoga & rest", goodFor: ["mobility", "wind-down"] },
    ]);
    // An album: its maker is its description.
    await dock.startAdding();
    await dock.addLink(`spotify:album:${sid("alb")}`);
    expect(saved.at(-1)!.shortcuts.at(-1)).toMatchObject({ label: "An Album", description: "Album by A Band", total: 9 });
  });

  it("one Spotify won't name asks for a name, then saves it, tagged by that name", async () => {
    const { dock, saved, state } = setup();
    const other = sid("notmine");
    await dock.startAdding();
    expect(await dock.addLink(`spotify:playlist:${other}`)).toEqual({ kind: "needs_label" });
    expect(state().adding).toMatchObject({ needsLabel: { uri: `spotify:playlist:${other}` } });
    expect(await dock.nameAndSave("  Calm stretch  ")).toEqual({ kind: "saved" });
    expect(saved.at(-1)!.shortcuts.at(-1)).toEqual({ id: "s1", label: "Calm stretch", uri: `spotify:playlist:${other}`, shuffle: true, goodFor: ["mobility", "wind-down"] });
  });

  it("a link that isn't a playlist or an album is refused in plain words, nothing read or saved", async () => {
    const { dock, saved, state, fake } = setup();
    dock.cancelAdding();
    await dock.addLink("https://open.spotify.com/track/0123456789abcdefABCDEF");
    expect(state().adding?.error).toBe("That isn't a Spotify playlist or album link.");
    expect(saved).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("one linked already changes nothing; at the most the dock keeps, it says so", async () => {
    const { dock, saved, fake } = setup({ music: { shortcuts: [mine("s1")] } });
    expect(await dock.addLink(`spotify:playlist:${PL}`)).toEqual({ kind: "saved" });
    expect(saved).toEqual([]);
    expect(fake.calls).toEqual([]);
    const full = setup({ music: { shortcuts: Array.from({ length: MUSIC_SHORTCUTS_MAX }, (_, i) => mine(`s${i + 1}`, `spotify:album:${sid(`a${i}x`)}`)) } });
    await full.dock.startAdding();
    expect(await full.dock.addPlaylist(full.state().playlists!.items[0]!)).toEqual({ kind: "failed" });
    expect(full.state().adding?.error).toBe("That's as many playlists as the dock keeps.");
  });

  it("tagging that fails still saves it — untagged, for the next open to tag", async () => {
    const { dock, saved, state } = setup({ tagFails: true });
    await dock.startAdding();
    await dock.addPlaylist(state().playlists!.items[0]!);
    expect(saved.at(-1)!.shortcuts[0]!.goodFor).toBeUndefined();
  });
});

describe("editing", () => {
  it("a playlist's name and what it suits are the athlete's to set; Remove takes it out", async () => {
    const { dock, saved } = setup({ music: { shortcuts: [mine("s1", undefined, { goodFor: ["run"] }), mine("s2", `spotify:album:${PL}`)] } });
    dock.setEditing(true);
    dock.openEditor("s1");
    expect(await dock.edit("s1", { label: "  Morning ", goodFor: ["mobility", "mobility", "wind-down"] })).toBe(true);
    expect(saved.at(-1)!.shortcuts[0]).toMatchObject({ id: "s1", label: "Morning", goodFor: ["mobility", "wind-down"] });
    expect(await dock.edit("s1", { label: "   ", goodFor: [] })).toBe(false);
    await dock.remove("s1");
    expect(saved.at(-1)!.shortcuts.map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("playlists linked before names and tags (the migration)", () => {
  it("on the first open each is read once and all are tagged in one request, then saved once; the old spa slot takes Spotify's name", async () => {
    const shortcuts = [
      { id: "spa", label: "Spa", uri: `spotify:playlist:${SPA}`, shuffle: true },
      { id: "s1", label: "My runs", uri: `spotify:playlist:${PL}`, shuffle: true },
      { id: "s2", label: "Tagged", uri: `spotify:album:${sid("alb")}`, shuffle: true, goodFor: ["strength"] as MusicGoodFor[] },
    ];
    const { dock, fake, saved, tagged } = setup({ music: { shortcuts } });
    await dock.open();
    expect(fake.calls.filter((c) => c.path.startsWith("/playlists/")).map((c) => c.path)).toEqual([`/playlists/${SPA}`, `/playlists/${PL}`]);
    expect(tagged).toEqual([
      [
        { key: "spa", name: "Spa Sounds", description: "Calm music for yoga & rest" },
        { key: "s1", name: "Easy run", description: "Steady songs for easy miles" },
      ],
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.shortcuts).toEqual([
      { id: "spa", label: "Spa Sounds", uri: `spotify:playlist:${SPA}`, shuffle: true, name: "Spa Sounds", description: "Calm music for yoga & rest", goodFor: ["mobility", "wind-down"] },
      // A label the athlete chose is kept.
      { id: "s1", label: "My runs", uri: `spotify:playlist:${PL}`, shuffle: true, name: "Easy run", description: "Steady songs for easy miles", total: 30, goodFor: ["run"] },
      shortcuts[2],
    ]);
    // Once: the next open reads only what it always reads.
    const before = fake.calls.length;
    await dock.close();
    await dock.open();
    expect(fake.calls.slice(before).map((c) => c.path)).toEqual(["/me/player", "/me/player/devices"]);
    expect(saved).toHaveLength(1);
  });

  it("one Spotify won't read keeps its label and is tagged by it; one named already is not read again", async () => {
    const gone = sid("gone");
    const { dock, fake, saved } = setup({
      music: { shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${gone}`, shuffle: true }, mine("s1", undefined, { name: "Easy run" })] },
    });
    await dock.open();
    expect(fake.calls.filter((c) => c.path.startsWith("/playlists/")).map((c) => c.path)).toEqual([`/playlists/${gone}`]);
    expect(saved[0]!.shortcuts.map((s) => [s.label, s.goodFor])).toEqual([
      ["Spa", ["mobility", "wind-down"]],
      ["S1", ["run"]],
    ]);
  });
});

describe("an edit made while the first open reads and tags (review-M M1)", () => {
  it("is kept: what Spotify says is merged into the playlists as they are by then, and tags go only where none were set", async () => {
    let release: () => void = () => undefined;
    const shortcuts = [
      { id: "spa", label: "Spa", uri: `spotify:playlist:${SPA}`, shuffle: true },
      { id: "s1", label: "My runs", uri: `spotify:playlist:${PL}`, shuffle: true },
    ];
    const { dock, saved, tagged } = setup({ music: { shortcuts }, tagGate: new Promise<void>((r) => (release = r)) });
    const opening = dock.open();
    for (let i = 0; i < 200 && tagged.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(tagged).toHaveLength(1);
    // Meanwhile the athlete renames the spa playlist and sets the second's tags.
    dock.setEditing(true);
    expect(await dock.edit("spa", { label: "Evening", goodFor: ["wind-down"] })).toBe(true);
    expect(await dock.edit("s1", { label: "My runs", goodFor: ["strength"] })).toBe(true);
    release();
    await opening;
    expect(saved.at(-1)!.shortcuts).toEqual([
      { id: "spa", label: "Evening", uri: `spotify:playlist:${SPA}`, shuffle: true, name: "Spa Sounds", description: "Calm music for yoga & rest", goodFor: ["wind-down"] },
      { id: "s1", label: "My runs", uri: `spotify:playlist:${PL}`, shuffle: true, name: "Easy run", description: "Steady songs for easy miles", total: 30, goodFor: ["strength"] },
    ]);
  });

  it("a playlist removed meanwhile stays removed", async () => {
    let release: () => void = () => undefined;
    const { dock, saved, tagged } = setup({
      music: { shortcuts: [{ id: "spa", label: "Spa", uri: `spotify:playlist:${SPA}`, shuffle: true }, mine("s1")] },
      tagGate: new Promise<void>((r) => (release = r)),
    });
    const opening = dock.open();
    for (let i = 0; i < 200 && tagged.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
    await dock.remove("spa");
    release();
    await opening;
    expect(saved.at(-1)!.shortcuts.map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("a token the Worker can't refresh (review-M M5)", () => {
  it("the dock says the calm line and its polling stops asking until the backoff ends", async () => {
    const { dock, fake, state, advance, tokenAsks } = setup({ tokenFails: true });
    await dock.open();
    expect(state().notice).toEqual({ text: SLOW_LINE, tone: "info" });
    expect(tokenAsks()).toBe(1);
    await advance(BACKOFF_FIRST_MS - 1000);
    expect(tokenAsks()).toBe(1);
    await advance(1000);
    expect(tokenAsks()).toBe(2);
    expect(fake.calls).toEqual([]);
  });
});

describe("asked to slow down", () => {
  it("a 429 on open: one call, a calm line, and the reads wait out each step — one call per step, doubling — never while collapsed", async () => {
    const { dock, fake, state, advance } = setup();
    for (let i = 0; i < 20; i++) fake.script("GET /me/player", { status: 429 });
    await dock.open();
    expect(fake.calls).toHaveLength(1);
    expect(state().notice).toEqual({ text: SLOW_LINE, tone: "info" });
    expect(SLOW_LINE).toBe("Spotify asked us to slow down — back in a few minutes");
    const calls: number[] = [];
    for (const step of [BACKOFF_FIRST_MS, 2 * BACKOFF_FIRST_MS, 4 * BACKOFF_FIRST_MS]) {
      await advance(step - 1000);
      calls.push(fake.calls.length);
      await advance(1000);
      calls.push(fake.calls.length);
    }
    expect(calls).toEqual([1, 2, 2, 3, 3, 4]);
    await dock.close();
    await advance(60 * 60_000);
    expect(fake.calls).toHaveLength(4);
  });

  it("a 429 while it polls: the calm line, and the next read waits out the step", async () => {
    const { dock, fake, state, advance } = setup();
    await dock.open();
    expect(state().notice).toBeNull();
    fake.script("GET /me/player", { status: 429 });
    await advance(5000);
    expect(state().notice).toEqual({ text: SLOW_LINE, tone: "info" });
    const calls = fake.calls.length;
    await advance(BACKOFF_FIRST_MS - 1000);
    expect(fake.calls).toHaveLength(calls);
  });

  it("the reads come back after a success, and the line goes", async () => {
    const { dock, fake, state, advance } = setup();
    fake.script("GET /me/player", { status: 429 });
    await dock.open();
    await advance(BACKOFF_FIRST_MS);
    expect(state().notice).toBeNull();
    await advance(5000);
    expect(fake.calls.map((c) => c.path)).toEqual(["/me/player", "/me/player", "/me/player"]);
  });

  it("a tap meanwhile says it with the time left, and makes no call — nor opens Spotify, with no device known", async () => {
    const { dock, fake, state, advance, opened } = setup({ devices: [], music: { shortcuts: [mine("s1", undefined, { goodFor: [] })] } });
    await dock.open();
    expect(state().devices).toEqual([]);
    fake.script("GET /me/player", { status: 429 });
    await advance(5000);
    const calls = fake.calls.length;
    await dock.close();
    await advance(10_000);
    await dock.tap("s1");
    expect(state().notice?.text).toBe("Spotify asked us to slow down — back in about a minute.");
    expect(opened).toEqual([]);
    await dock.startAdding();
    await dock.open();
    expect(fake.calls).toHaveLength(calls);
  });

  it("names and tags are tried once a load: a tagging that fails isn't asked again at every open", async () => {
    const { dock, fake, tagged } = setup({ tagFails: true, music: { shortcuts: [mine("s1")] } });
    await dock.open();
    await dock.close();
    await dock.open();
    expect(tagged).toHaveLength(1);
    expect(fake.calls.filter((c) => c.path.startsWith("/playlists/"))).toHaveLength(1);
  });
});

describe("a workout's music, at its Start", () => {
  const target = { id: "spa", label: "Spa", uri: `spotify:playlist:${SPA}` };

  it("plays on the device Spotify would use, shuffled, and the dock shows it", async () => {
    const { dock, fake, commands, state } = setup({ devices: [{ ...phone }] });
    await dock.autoPlay(target, "perf-1");
    expect(commands()).toEqual(["PUT /me/player/shuffle", "PUT /me/player/play"]);
    expect(fake.calls.find((c) => c.path === "/me/player/play")!.body).toMatchObject({ context_uri: target.uri });
    expect(state().player?.is_playing).toBe(true);
    expect(state().workout).toBeNull();
    // Once per session: asked again for it (its line drawn again), nothing is sent.
    await dock.autoPlay(target, "perf-1");
    expect(commands()).toHaveLength(2);
  });

  it("no device open: no play and no link opened unasked — the player's line; its Play (a tap) opens Spotify and plays on the return", async () => {
    const { dock, fake, opened, commands, state } = setup({ devices: [] });
    await dock.autoPlay(target, "perf-1");
    expect(commands()).toEqual([]);
    expect(opened).toEqual([]);
    expect(state().workout).toEqual({ target, status: "no_device" });
    await dock.playWorkout(target);
    expect(opened).toEqual([`https://open.spotify.com/playlist/${SPA}`]);
    fake.state.devices.push({ ...phone });
    await dock.setVisible(false);
    await dock.setVisible(true);
    expect(commands()).toContain("PUT /me/player/play");
    expect(state().workout).toBeNull();
  });

  it("backing off: no call, and the player says so calmly", async () => {
    const { dock, fake, state, backoff } = setup();
    backoff.hit(null);
    await dock.autoPlay(target, "perf-1");
    expect(fake.calls).toEqual([]);
    expect(state().workout).toEqual({ target, status: "slow" });
  });

  it("not connected: nothing at all", async () => {
    const { dock, fake, state } = setup({ reason: "not_connected" });
    await dock.autoPlay(target, "perf-1");
    expect(fake.calls).toEqual([]);
    expect(state().workout).toBeNull();
  });
});

describe("connection and devices", () => {
  it("a consent to renew shows as reconnect, and a play asks Spotify nothing", async () => {
    const { dock, fake, state } = setup({ reason: "reconnect", music: { shortcuts: [mine("s1")] } });
    expect(state().connection).toBe("reconnect");
    await dock.tap("s1");
    expect(fake.calls).toEqual([]);
  });

  it("a token Spotify refuses that the Worker can't renew turns the dock to reconnect, saying so", async () => {
    const { dock, fake, state } = setup({ music: { shortcuts: [mine("s1")] }, renewFails: true });
    await dock.tap("s1");
    expect(state().connection).toBe("reconnect");
    expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("no device: the link opens, and the dock keeps it to tap; a blocked one is offered", async () => {
    const { dock, opened, state } = setup({ devices: [], music: { shortcuts: [mine("s1")] } });
    await dock.tap("s1");
    expect(opened).toEqual([`https://open.spotify.com/playlist/${PL}`]);
    expect(state().link).toBe(`https://open.spotify.com/playlist/${PL}`);
    const blocked = setup({ devices: [], music: { shortcuts: [mine("s1")] }, allowOpen: false });
    await blocked.dock.tap("s1");
    expect(blocked.state().link).toBe(`https://open.spotify.com/playlist/${PL}`);
  });

  it("with the dock already knowing no device is listed, the link opens before anything is awaited (inside the tap)", async () => {
    const { dock, opened } = setup({ devices: [], music: { shortcuts: [mine("s1", undefined, { goodFor: [] })] } });
    await dock.open();
    const pending = dock.tap("s1");
    expect(opened).toEqual([`https://open.spotify.com/playlist/${PL}`]);
    await pending;
  });

  it("an abandoned play never starts later: the dock closed after the link opened, the play is forgotten (review #2)", async () => {
    const { dock, fake, commands } = setup({ devices: [], music: { shortcuts: [mine("s1", undefined, { goodFor: [] })] } });
    await dock.open();
    await dock.tap("s1");
    await dock.close();
    fake.state.devices.push({ ...phone });
    await dock.setVisible(false);
    await dock.setVisible(true);
    expect(commands()).not.toContain("PUT /me/player/play");
  });

  it("pause, and disconnecting, forget a waiting play too", async () => {
    for (const leave of ["pause", "disconnect"] as const) {
      const { dock, fake, commands } = setup({ devices: [], music: { shortcuts: [mine("s1")] } });
      await dock.tap("s1");
      await dock[leave]();
      fake.state.devices.push({ ...phone });
      await dock.setVisible(false);
      await dock.setVisible(true);
      expect(commands(), leave).not.toContain("PUT /me/player/play");
    }
  });

  it("visible again with a play waiting: it plays on the device now listed", async () => {
    const { dock, fake, commands, state } = setup({ devices: [], music: { shortcuts: [mine("s1")] } });
    await dock.tap("s1");
    fake.state.devices.push({ ...phone });
    await dock.setVisible(false);
    await dock.setVisible(true);
    expect(commands()).toContain("PUT /me/player/play");
    expect(state().link).toBeNull();
  });
});

describe("now playing and the volume", () => {
  it("the volume is offered on a device that takes it, and 'use the side buttons' on one that doesn't", () => {
    expect(volumeOf({ is_playing: true, device: desk })).toEqual({ supported: true, percent: 40, deviceId: "desk-1" });
    expect(volumeOf({ is_playing: true, device: phone })).toEqual({ supported: false });
    expect(volumeOf(null, [desk])).toEqual({ supported: true, percent: 40, deviceId: "desk-1" });
    expect(volumeOf(null, [])).toBeNull();
  });

  it("setting the volume sends it to the device", async () => {
    const { dock, fake } = setup({ devices: [{ ...desk, is_active: true } as never] });
    await dock.open();
    await dock.setVolume(25);
    expect(fake.calls.find((c) => c.path === "/me/player/volume")!.query).toEqual({ volume_percent: "25", device_id: "desk-1" });
  });

  it("pause, resume and next go to the device playing", async () => {
    const { dock, commands } = setup({ music: { shortcuts: [mine("s1")] } });
    await dock.tap("s1");
    await dock.pause();
    await dock.resume();
    await dock.next();
    expect(commands().slice(-3)).toEqual(["PUT /me/player/pause", "PUT /me/player/play", "POST /me/player/next"]);
  });

  it("a short title for the pill", () => {
    expect(shortTitle("Subwoofer Lullaby")).toBe("Subwoofer Lullaby");
    expect(shortTitle("A Very Long Song Title That Goes On - 2011 Remaster")).toBe("A Very Long Song Title…");
    expect(shortTitle("Sweden (Remastered)")).toBe("Sweden");
  });
});
