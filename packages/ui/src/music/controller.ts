/**
 * The music dock's controller (2026-10-17): everything the dock does, apart from how it looks — a small store the React
 * dock subscribes to (music/dock.tsx), driven by injected deps so the tests run it against a fake Spotify.
 *
 * It plays only when asked. Opening the dock reads (the devices, now playing) and then polls now playing while it is
 * open and the page visible; a play, a pause, the next track and the volume are sent only from a tap. A play waiting
 * for a device (the open-link fallback) is retried when the page is visible again.
 */
import { MUSIC_LABEL_MAX, MUSIC_SHORTCUTS_MAX, MUSIC_SPA_ID, type MusicPreferences, type MusicShortcut } from "@rg/domain";
import { parseSpotifyLink } from "./links.js";
import { buildMinecraftPlaylist } from "./minecraft.js";
import { makePoller, POLL_MS } from "./poller.js";
import { chooseDevice, makeRemote, type DeviceKind, type RemoteResult } from "./remote.js";
import { NotConnected, SpotifyError, type Device, type PlayerState, type PlaylistSummary, type Spotify } from "./spotify.js";
import { dockShortcuts, MINECRAFT_SHORTCUT_ID, volumeOf } from "./dock-model.js";

export type Connection = "connected" | "not_connected" | "reconnect";

export interface AddingState {
  target: "spa" | "custom";
  error?: string;
  /** A link Spotify won't name for this athlete: they name it. */
  needsLabel?: { uri: string };
}

export interface DockState {
  connection: Connection;
  music: MusicPreferences;
  expanded: boolean;
  player: PlayerState | null;
  /** When `player` was read (the pill names the track until it should have ended). */
  readAt: number | null;
  devices: Device[] | null;
  busy: null | "building" | "playing" | "saving";
  notice: { text: string; tone: "info" | "warn" } | null;
  /** The shortcut's open.spotify.com link while a play waits for a device: shown to tap. */
  link: string | null;
  build: { found: number; of: number; missing: string[] } | null;
  adding: AddingState | null;
  playlists: PlaylistSummary[] | null;
  editing: boolean;
}

export interface DockDeps {
  spotify: Spotify;
  /** The preferences save (`PUT /api/music`): answers what was stored. */
  saveMusic: (music: MusicPreferences) => Promise<MusicPreferences>;
  disconnect?: () => Promise<void>;
  prefer: () => DeviceKind;
  random: () => number;
  openLink: (url: string) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  schedule: (fn: () => void, ms: number) => () => void;
  isVisible: () => boolean;
  /** A new shortcut id: lower-case letters, digits and hyphens. */
  newId: () => string;
}

export type AddResult = { kind: "saved" } | { kind: "needs_label" } | { kind: "invalid" } | { kind: "failed" };

const NOT_A_LINK = "That isn't a Spotify playlist or album link.";

export function makeDockController(deps: DockDeps) {
  const { spotify } = deps;
  let state: DockState = {
    connection: "not_connected",
    music: { shortcuts: [] },
    expanded: false,
    player: null,
    readAt: null,
    devices: null,
    busy: null,
    notice: null,
    link: null,
    build: null,
    adding: null,
    playlists: null,
    editing: false,
  };
  let visible = deps.isVisible();
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DockState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  const remote = makeRemote({ spotify, prefer: deps.prefer, random: deps.random, openLink: deps.openLink, now: deps.now, sleep: deps.sleep });
  const poller = makePoller({
    read: () => spotify.player(),
    onState: (player) => set({ player, readAt: deps.now() }),
    onError: (e) => fail(e),
    schedule: deps.schedule,
  });

  function fail(e: unknown): void {
    if (e instanceof NotConnected) {
      poller.stop();
      set({ connection: e.reason, busy: null, notice: e.reason === "reconnect" ? { text: "Spotify needs you to sign in again.", tone: "warn" } : null });
      return;
    }
    const text =
      e instanceof SpotifyError && e.status === 429
        ? "Spotify is busy. Try again in a moment."
        : e instanceof SpotifyError && e.reason === "PREMIUM_REQUIRED"
          ? "Playing from here needs Spotify Premium."
          : "Spotify didn't answer. Try again.";
    set({ busy: null, notice: { text, tone: "warn" } });
  }

  async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      fail(e);
      return undefined;
    }
  }

  const readPlayer = () => guarded(async () => set({ player: await spotify.player(), readAt: deps.now() }));

  /** `keep`: a notice this tap already gave (the build's "8 of 9 albums found") stays once it plays. */
  async function applyRemote(out: RemoteResult | null | undefined, keep: DockState["notice"] = null): Promise<void> {
    if (!out) return;
    if (out.kind === "playing") {
      set({ link: null, busy: null, notice: keep });
      await readPlayer();
      return;
    }
    set({
      link: out.openUrl,
      busy: null,
      notice: out.kind === "opened" ? { text: "Opening Spotify. Come back and it will play.", tone: "info" } : { text: "No Spotify device is open.", tone: "warn" },
    });
  }

  async function save(next: MusicPreferences): Promise<boolean> {
    set({ busy: "saving" });
    const stored = await guarded(() => deps.saveMusic(next));
    if (!stored) return false;
    set({ music: stored, busy: null });
    return true;
  }

  async function addShortcut(uri: string, label: string): Promise<AddResult> {
    const target = state.adding?.target ?? "custom";
    const shortcuts = [...state.music.shortcuts];
    if (target === "spa") {
      const spa: MusicShortcut = { id: MUSIC_SPA_ID, label: "Spa", uri, shuffle: true };
      const at = shortcuts.findIndex((s) => s.id === MUSIC_SPA_ID);
      if (at >= 0) shortcuts[at] = spa;
      else shortcuts.unshift(spa);
    } else if (!shortcuts.some((s) => s.uri === uri && s.id !== MUSIC_SPA_ID)) {
      if (shortcuts.length >= MUSIC_SHORTCUTS_MAX) {
        set({ adding: { target, error: "That's as many shortcuts as the dock keeps." } });
        return { kind: "failed" };
      }
      shortcuts.push({ id: deps.newId(), label: label.trim().slice(0, MUSIC_LABEL_MAX), uri, shuffle: true });
    }
    if (!(await save({ ...state.music, shortcuts }))) return { kind: "failed" };
    set({ adding: null, playlists: null });
    return { kind: "saved" };
  }

  /** Build (or rebuild) the Minecraft playlist, keep its id, and say how many albums were found. */
  async function buildMinecraft(rebuild: boolean): Promise<string | null> {
    set({ busy: "building", notice: null });
    const stored = state.music.minecraftPlaylistId;
    const built = await guarded(() => buildMinecraftPlaylist(spotify, { ...(stored ? { storedId: stored } : {}), rebuild }));
    if (!built) return null;
    if ("reused" in built) return built.playlistId;
    if (!built.playlistId) {
      set({ busy: null, build: { found: 0, of: built.of, missing: built.missing }, notice: { text: "No Minecraft albums found on Spotify.", tone: "warn" } });
      return null;
    }
    set({ build: { found: built.found, of: built.of, missing: built.missing }, notice: { text: `${built.found} of ${built.of} albums found`, tone: "info" } });
    if (built.playlistId !== stored && !(await save({ ...state.music, minecraftPlaylistId: built.playlistId }))) return null;
    const notice = state.notice;
    set({ busy: null, notice });
    return built.playlistId;
  }

  const deviceId = (): string | undefined => state.player?.device?.id ?? undefined;

  return {
    get: (): DockState => state,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The Worker's read (`GET /api/music`). */
    setServer(dto: { connected: boolean; reason?: "reconnect"; music: MusicPreferences }) {
      set({ connection: dto.connected ? "connected" : dto.reason === "reconnect" ? "reconnect" : "not_connected", music: dto.music });
      if (!dto.connected) poller.stop();
    },
    /** Expanded: read the devices and now playing, then keep now playing fresh while open and visible. Never plays. */
    async open(): Promise<void> {
      set({ expanded: true, editing: false });
      if (state.connection !== "connected") return;
      await guarded(async () => {
        const [devices, player] = await Promise.all([spotify.devices(), spotify.player()]);
        set({ devices, player, readAt: deps.now() });
      });
      if (state.expanded && state.connection === "connected") poller.set({ expanded: true, visible }, { firstDelayMs: POLL_MS });
    },
    async close(): Promise<void> {
      poller.set({ expanded: false, visible });
      set({ expanded: false, adding: null, playlists: null, editing: false });
    },
    /** The page's visibility: polling follows it, and a play waiting for a device is tried again when it returns. */
    async setVisible(next: boolean): Promise<void> {
      visible = next;
      poller.set({ expanded: state.expanded && state.connection === "connected", visible: next });
      if (next && remote.pending()) await applyRemote(await guarded(() => remote.visible()));
    },
    /** One tap on a shortcut: play it (building the Minecraft playlist first, the first time). The spa slot unset opens
     * the add panel instead. */
    async tap(id: string): Promise<void> {
      if (state.connection !== "connected" || state.busy) return;
      const shortcut = dockShortcuts(state.music).find((s) => s.id === id);
      if (!shortcut) return;
      if (shortcut.kind === "spa" && !shortcut.uri) {
        set({ adding: { target: "spa" }, playlists: null });
        return;
      }
      let uri = shortcut.uri;
      let built: DockState["notice"] = null;
      if (!uri) {
        // Only Minecraft is built on first use.
        if (shortcut.id !== MINECRAFT_SHORTCUT_ID) return;
        const playlistId = await buildMinecraft(false);
        if (!playlistId) return;
        uri = `spotify:playlist:${playlistId}`;
        built = state.notice;
      }
      const play: MusicShortcut = { id: shortcut.id, label: shortcut.label, uri, shuffle: true };
      // Known to have no device: the link opens now, inside the tap (a browser opens a new context only inside one).
      // Not after a build: that tap is long over.
      const noDevice = built === null && state.devices !== null && chooseDevice(state.devices, deps.prefer()) === null;
      const pending = remote.play(play, { noDevice });
      set({ busy: "playing", notice: built });
      await applyRemote(await guarded(() => pending), built);
      if (state.busy === "playing") set({ busy: null });
    },
    async pause(): Promise<void> {
      if ((await guarded(() => spotify.pause(deviceId()))) !== undefined && state.player) set({ player: { ...state.player, is_playing: false } });
    },
    async resume(): Promise<void> {
      if ((await guarded(() => spotify.play({ deviceId: deviceId() }))) !== undefined && state.player) set({ player: { ...state.player, is_playing: true } });
    },
    async next(): Promise<void> {
      if ((await guarded(() => spotify.next(deviceId()))) !== undefined) await readPlayer();
    },
    async setVolume(percent: number): Promise<void> {
      const v = volumeOf(state.player, state.devices);
      if (!v?.supported) return;
      const sent = await guarded(() => spotify.volume(percent, v.deviceId));
      if (sent === undefined) return;
      const withVolume = (d: Device | null | undefined) => (d && d.id === v.deviceId ? { ...d, volume_percent: Math.round(percent) } : d);
      set({
        player: state.player ? { ...state.player, device: withVolume(state.player.device) ?? null } : null,
        devices: state.devices?.map((d) => withVolume(d)!) ?? null,
      });
    },
    startAdding(target: "spa" | "custom"): void {
      set({ adding: { target }, playlists: null });
    },
    cancelAdding(): void {
      set({ adding: null, playlists: null });
    },
    /** A pasted link: saved under Spotify's name for it when the athlete can read it, else they name it. */
    async addLink(text: string): Promise<AddResult> {
      const target = state.adding?.target ?? "custom";
      const link = parseSpotifyLink(text);
      if (!link) {
        set({ adding: { target, error: NOT_A_LINK } });
        return { kind: "invalid" };
      }
      if (target === "spa") return addShortcut(link.uri, "Spa");
      const name = await guarded(() => spotify.name(link.uri));
      if (name) return addShortcut(link.uri, name);
      if (state.connection !== "connected") return { kind: "failed" };
      set({ adding: { target, needsLabel: { uri: link.uri } }, notice: null });
      return { kind: "needs_label" };
    },
    async nameAndSave(label: string): Promise<AddResult> {
      const adding = state.adding;
      if (!adding?.needsLabel) return { kind: "failed" };
      if (!label.trim()) {
        set({ adding: { ...adding, error: "Give it a name." } });
        return { kind: "failed" };
      }
      return addShortcut(adding.needsLabel.uri, label);
    },
    async loadPlaylists(): Promise<void> {
      const playlists = await guarded(() => spotify.myPlaylists(20));
      if (playlists) set({ playlists });
    },
    async addPlaylist(p: PlaylistSummary): Promise<AddResult> {
      return addShortcut(p.uri, p.name);
    },
    async remove(id: string): Promise<void> {
      await save({ ...state.music, shortcuts: state.music.shortcuts.filter((s) => s.id !== id) });
    },
    async rebuildMinecraft(): Promise<void> {
      if (state.connection !== "connected" || state.busy) return;
      await buildMinecraft(true);
      if (state.busy === "building") set({ busy: null });
    },
    /** A line in the sheet (the login's outcome, when it came back here). */
    say(text: string, tone: "info" | "warn"): void {
      set({ notice: { text, tone } });
    },
    setEditing(editing: boolean): void {
      set({ editing, adding: null });
    },
    async disconnect(): Promise<void> {
      if (!deps.disconnect) return;
      try {
        await deps.disconnect();
      } catch {
        set({ notice: { text: "Couldn't disconnect. Try again.", tone: "warn" } });
        return;
      }
      poller.stop();
      set({ connection: "not_connected", player: null, devices: null, editing: false, link: null, notice: null });
    },
    /** The dock leaves the page: no timer survives it. */
    dispose(): void {
      poller.stop();
      listeners.clear();
    },
  };
}

export type DockController = ReturnType<typeof makeDockController>;
