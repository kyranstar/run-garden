/**
 * The music dock's controller (2026-10-17; packages/ui/src/music/controller.ts): what the dock does, apart from how it
 * looks — driven against the fake Spotify, its preferences saved through an injected save.
 *
 *  - It plays only when asked: opening it reads (the devices, now playing) and never sends a player command.
 *  - The default shortcuts: "Minecraft, complete" (built on first use, its id saved, then played; a stored one reused)
 *    and "Add your spa playlist" until one is set (a tap opens the add panel, never a play).
 *  - Adding: a pasted link (named from Spotify when it can be read, else the athlete names it), one of their playlists,
 *    the spa slot; removing; the build's "N of M albums found".
 *  - Not connected / reconnect from the Worker; no device → the link to tap.
 *  - The volume is offered only on a device that takes it.
 *
 * Synthetic ids only.
 */
import { describe, expect, it } from "vitest";
import { MUSIC_SPA_ID, type MusicPreferences } from "@rg/domain";
import { fakeSpotify, fakeTokens, sid } from "./fake-spotify.js";
import { makeSpotify } from "../../src/music/spotify.js";
import { makeDockController, type DockState } from "../../src/music/controller.js";
import { MINECRAFT_ALBUMS, MINECRAFT_PLAYLIST_NAME } from "../../src/music/minecraft.js";
import { dockShortcuts, shortTitle, volumeOf } from "../../src/music/dock-model.js";

const PL = sid("mine");
const phone = { id: "phone-1", name: "Phone", type: "Smartphone", supports_volume: false };
const desk = { id: "desk-1", name: "Desktop", type: "Computer", supports_volume: true, volume_percent: 40 };

function albums() {
  return MINECRAFT_ALBUMS.slice(0, 8).map((a, i) => ({ id: sid(`mc${i}`), name: `${a.title} (Original Game Soundtrack)`, artists: [a.artists[0]!], tracks: 5 }));
}

function setup(
  opts: { devices?: Array<typeof phone>; music?: Partial<MusicPreferences>; reason?: "not_connected" | "reconnect"; allowOpen?: boolean; renewFails?: boolean } = {},
) {
  const fake = fakeSpotify({ devices: opts.devices ?? [phone], albums: albums(), ownedPlaylists: [{ id: PL, name: "Easy run", total: 30 }] });
  const tokens = fakeTokens(fake, { reason: opts.reason });
  const token = opts.renewFails
    ? async (fresh: boolean) =>
        fresh
          ? { connected: false as const, reason: "reconnect" as const }
          : { connected: true as const, accessToken: "a-token-spotify-refuses", expiresAt: new Date(3600_000).toISOString() }
    : tokens.token;
  const spotify = makeSpotify({ token, fetch: fake.fetch, now: () => 0, sleep: async () => undefined });
  const saved: MusicPreferences[] = [];
  const opened: string[] = [];
  const timers: Array<() => void> = [];
  let ids = 0;
  const dock = makeDockController({
    spotify,
    saveMusic: async (music) => {
      saved.push(music);
      return music;
    },
    prefer: () => "Smartphone",
    random: () => 0,
    openLink: (url) => {
      opened.push(url);
      return opts.allowOpen ?? true;
    },
    now: () => 0,
    sleep: async () => undefined,
    schedule: (fn) => {
      timers.push(fn);
      return () => undefined;
    },
    isVisible: () => true,
    newId: () => `s${++ids}`,
  });
  dock.setServer({ connected: !opts.reason, ...(opts.reason === "reconnect" ? { reason: "reconnect" as const } : {}), music: { shortcuts: [], ...opts.music } });
  const commands = () => fake.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  return { fake, dock, saved, opened, commands, state: (): DockState => dock.get() };
}

describe("it plays only when asked", () => {
  it("opening the dock reads the devices and now playing, and sends no command", async () => {
    const { dock, fake, commands, state } = setup();
    await dock.open();
    expect(state().expanded).toBe(true);
    expect(commands()).toEqual([]);
    expect(fake.calls.map((c) => c.path).sort()).toEqual(["/me/player", "/me/player/devices"]);
    await dock.close();
    expect(state().expanded).toBe(false);
    expect(commands()).toEqual([]);
  });

  it("closed, it reads nothing at all", async () => {
    const { dock, fake } = setup();
    dock.setVisible(true);
    dock.setVisible(false);
    dock.setVisible(true);
    expect(fake.calls).toEqual([]);
  });
});

describe("the shortcuts", () => {
  it("default to Minecraft and the spa slot, then the athlete's own", () => {
    expect(dockShortcuts({ shortcuts: [] }).map((s) => [s.id, s.label, s.uri])).toEqual([
      ["minecraft", "Minecraft, complete", null],
      ["spa", "Add your spa playlist", null],
    ]);
    const music: MusicPreferences = {
      shortcuts: [
        { id: "s1", label: "Easy run", uri: `spotify:playlist:${PL}`, shuffle: true },
        { id: MUSIC_SPA_ID, label: "Spa", uri: `spotify:playlist:${sid("spa")}`, shuffle: true },
      ],
      minecraftPlaylistId: sid("mcbuilt"),
    };
    expect(dockShortcuts(music).map((s) => [s.id, s.label, s.uri])).toEqual([
      ["minecraft", "Minecraft, complete", `spotify:playlist:${sid("mcbuilt")}`],
      ["spa", "Spa", `spotify:playlist:${sid("spa")}`],
      ["s1", "Easy run", `spotify:playlist:${PL}`],
    ]);
  });

  it("Minecraft on first use: built, its id saved, then played shuffled", async () => {
    const { dock, fake, saved, commands, state } = setup();
    await dock.open();
    await dock.tap("minecraft");
    const create = fake.calls.find((c) => c.method === "POST" && c.path === "/me/playlists")!;
    expect((create.body as { name: string }).name).toBe(MINECRAFT_PLAYLIST_NAME);
    const id = saved.at(-1)!.minecraftPlaylistId!;
    expect(id).toBeTruthy();
    expect(commands().slice(-2)).toEqual(["PUT /me/player/shuffle", "PUT /me/player/play"]);
    expect(fake.calls.find((c) => c.path === "/me/player/play")!.body).toMatchObject({ context_uri: `spotify:playlist:${id}` });
    expect(state().build).toEqual({ found: 8, of: 9, missing: ["Minecraft: Chaos Cubed"] });
    expect(state().notice?.text).toBe("8 of 9 albums found");
  });

  it("Minecraft with a stored playlist plays it without building", async () => {
    const { dock, fake, commands } = setup({ music: { minecraftPlaylistId: PL } });
    await dock.tap("minecraft");
    expect(fake.calls.filter((c) => c.path === "/search")).toEqual([]);
    expect(commands()).toEqual(["PUT /me/player/shuffle", "PUT /me/player/play"]);
    expect(fake.calls.find((c) => c.path === "/me/player/play")!.body).toMatchObject({ context_uri: `spotify:playlist:${PL}` });
  });

  it("Rebuild builds the stored playlist again and says how many albums it found", async () => {
    const { dock, fake, saved, state } = setup({ music: { minecraftPlaylistId: PL } });
    await dock.rebuildMinecraft();
    expect(fake.calls.filter((c) => c.path === `/playlists/${PL}/items` && c.method === "PUT")).toHaveLength(1);
    expect(saved.at(-1)?.minecraftPlaylistId ?? PL).toBe(PL);
    expect(state().notice?.text).toBe("8 of 9 albums found");
    expect(fake.calls.some((c) => c.path === "/me/player/play")).toBe(false);
  });

  it("the spa slot, unset, opens the add panel for it — no play", async () => {
    const { dock, commands, state } = setup();
    await dock.tap("spa");
    expect(state().adding).toMatchObject({ target: "spa" });
    expect(commands()).toEqual([]);
  });

  it("a shortcut of the athlete's plays shuffled on the chosen device", async () => {
    const { dock, commands, fake } = setup({ music: { shortcuts: [{ id: "s1", label: "Easy run", uri: `spotify:playlist:${PL}`, shuffle: true }] } });
    await dock.tap("s1");
    expect(commands()).toEqual(["PUT /me/player/shuffle", "PUT /me/player/play"]);
    expect(fake.calls.find((c) => c.path === "/me/player/play")!.query).toEqual({ device_id: "phone-1" });
  });
});

describe("adding and removing", () => {
  it("a pasted link Spotify lets them read is saved under its name", async () => {
    const { dock, saved, state } = setup();
    dock.startAdding("custom");
    expect(await dock.addLink(`https://open.spotify.com/playlist/${PL}?si=x`)).toEqual({ kind: "saved" });
    expect(saved.at(-1)!.shortcuts).toEqual([{ id: "s1", label: "Easy run", uri: `spotify:playlist:${PL}`, shuffle: true }]);
    expect(state().adding).toBeNull();
  });

  it("one it can't read asks for a name, then saves it", async () => {
    const { dock, saved, state } = setup();
    const other = sid("notmine");
    dock.startAdding("custom");
    expect(await dock.addLink(`spotify:playlist:${other}`)).toEqual({ kind: "needs_label" });
    expect(state().adding).toMatchObject({ target: "custom", needsLabel: { uri: `spotify:playlist:${other}` } });
    expect(await dock.nameAndSave("  Calm  ")).toEqual({ kind: "saved" });
    expect(saved.at(-1)!.shortcuts.at(-1)).toEqual({ id: "s1", label: "Calm", uri: `spotify:playlist:${other}`, shuffle: true });
  });

  it("a link that isn't a playlist or an album is refused in plain words, nothing saved", async () => {
    const { dock, saved, state } = setup();
    dock.startAdding("custom");
    expect(await dock.addLink("https://open.spotify.com/track/0123456789abcdefABCDEF")).toEqual({ kind: "invalid" });
    expect(state().adding?.error).toBe("That isn't a Spotify playlist or album link.");
    expect(saved).toEqual([]);
  });

  it("the spa slot takes a link as Spa", async () => {
    const { dock, saved } = setup();
    await dock.tap("spa");
    await dock.addLink(`https://open.spotify.com/playlist/${PL}`);
    expect(saved.at(-1)!.shortcuts).toEqual([{ id: MUSIC_SPA_ID, label: "Spa", uri: `spotify:playlist:${PL}`, shuffle: true }]);
  });

  it("the athlete's own playlists are listed to add from", async () => {
    const { dock, saved, state } = setup();
    dock.startAdding("custom");
    await dock.loadPlaylists();
    expect(state().playlists).toEqual([{ id: PL, name: "Easy run", uri: `spotify:playlist:${PL}`, total: 30 }]);
    await dock.addPlaylist(state().playlists![0]!);
    expect(saved.at(-1)!.shortcuts.map((s) => s.label)).toEqual(["Easy run"]);
  });

  it("removing a shortcut saves the rest", async () => {
    const { dock, saved } = setup({ music: { shortcuts: [{ id: "s1", label: "A", uri: `spotify:playlist:${PL}`, shuffle: true }, { id: "s2", label: "B", uri: `spotify:album:${PL}`, shuffle: true }] } });
    await dock.remove("s1");
    expect(saved.at(-1)!.shortcuts.map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("connection and devices", () => {
  it("a consent to renew shows as reconnect, and a play asks Spotify nothing", async () => {
    const { dock, fake, state } = setup({ reason: "reconnect" });
    expect(state().connection).toBe("reconnect");
    await dock.tap("minecraft");
    expect(fake.calls).toEqual([]);
  });

  it("a token Spotify refuses that the Worker can't renew turns the dock to reconnect, saying so", async () => {
    const { dock, fake, state } = setup({ music: { minecraftPlaylistId: PL }, renewFails: true });
    await dock.tap("minecraft");
    expect(state().connection).toBe("reconnect");
    expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("no device: the link opens, and the dock keeps it to tap; a blocked one is offered", async () => {
    const { dock, opened, state } = setup({ devices: [], music: { minecraftPlaylistId: PL } });
    await dock.tap("minecraft");
    expect(opened).toEqual([`https://open.spotify.com/playlist/${PL}`]);
    expect(state().link).toBe(`https://open.spotify.com/playlist/${PL}`);
    const blocked = setup({ devices: [], music: { minecraftPlaylistId: PL }, allowOpen: false });
    await blocked.dock.tap("minecraft");
    expect(blocked.state().link).toBe(`https://open.spotify.com/playlist/${PL}`);
  });

  it("with the dock already knowing no device is listed, the link opens before anything is awaited (inside the tap)", async () => {
    const { dock, opened } = setup({ devices: [], music: { minecraftPlaylistId: PL } });
    await dock.open();
    const pending = dock.tap("minecraft");
    expect(opened).toEqual([`https://open.spotify.com/playlist/${PL}`]);
    await pending;
  });

  it("visible again with a play waiting: it plays on the device now listed", async () => {
    const { dock, fake, commands, state } = setup({ devices: [], music: { minecraftPlaylistId: PL } });
    await dock.tap("minecraft");
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
    const { dock, commands } = setup({ music: { minecraftPlaylistId: PL } });
    await dock.tap("minecraft");
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
