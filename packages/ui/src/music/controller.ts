/**
 * The music dock's controller (2026-10-17; one abstraction, 2026-10-19): everything the dock does, apart from how it
 * looks — a small store the React dock subscribes to (music/dock.tsx), driven by injected deps so the tests run it
 * against a fake Spotify.
 *
 * The dock holds the athlete's own playlists (or albums): each linked by picking it from their Spotify playlists (a
 * page at a time, listed only when the add flow opens) or by pasting a link — named from Spotify (its name, plain
 * description, cover and count, read once and kept) and tagged with what it suits (`goodFor`, the Worker's
 * `/api/music/playlists/tags`). The label is Spotify's name unless the athlete renames it; the tags are theirs to edit.
 * One linked before names and tags is read and tagged once, the first time the dock opens (`tidy`). The app builds,
 * changes and deletes nothing in their Spotify account.
 *
 * It plays only when asked: opening the dock reads (now playing, then the devices) and then polls now playing while it
 * is open and the page visible; a play, a pause, the next track and the volume are sent only from a tap — and a
 * workout's music once, when its session starts (`autoPlay`, the player's). A play waiting for a device (the open-link
 * fallback) is retried when the page is visible again.
 *
 * Asked to slow down (a 429), nothing goes out until the shared backoff ends (music/backoff.ts): the dock says so in one
 * calm line, and a tap on a playlist says it with the time left, making no call.
 */
import {
  MUSIC_LABEL_MAX,
  MUSIC_SHORTCUTS_MAX,
  musicWordsOf,
  type MusicGoodFor,
  type MusicPreferences,
  type MusicShortcut,
} from "@rg/domain";
import { backInWords } from "./backoff.js";
import { parseSpotifyLink } from "./links.js";
import { makePoller, POLL_MS } from "./poller.js";
import { chooseDevice, makeRemote, playContext, type DeviceKind, type RemoteResult } from "./remote.js";
import { isSlowDown, NotConnected, SpotifyError, type ContextDetails, type Device, type PlayerState, type PlaylistSummary, type Spotify } from "./spotify.js";
import { volumeOf } from "./dock-model.js";

export type Connection = "connected" | "not_connected" | "reconnect";

export interface AddingState {
  error?: string;
  /** A link Spotify won't name for this athlete: they name it. */
  needsLabel?: { uri: string };
}

/** A workout's music, as the player asks for it: the playlist resolved at Start. */
export interface WorkoutTarget {
  id: string;
  label: string;
  uri: string;
}

/** Why a workout's music didn't start: Spotify Premium needed, the consent to renew (or Spotify not connected), or no
 * answer. */
export type WorkoutFailure = "premium" | "reconnect" | "error";

export interface DockState {
  connection: Connection;
  music: MusicPreferences;
  expanded: boolean;
  player: PlayerState | null;
  /** When `player` was read (the pill names the track until it should have ended). */
  readAt: number | null;
  devices: Device[] | null;
  busy: null | "playing" | "saving" | "adding";
  notice: { text: string; tone: "info" | "warn" } | null;
  /** The playlist's open.spotify.com link while a play waits for a device: shown to tap. */
  link: string | null;
  adding: AddingState | null;
  /** The athlete's playlists listed in the add flow: the pages read so far, and the next page's offset. */
  playlists: { items: PlaylistSummary[]; next: number | null } | null;
  editing: boolean;
  /** The playlist open in the editor (its name and tags), while editing. */
  editingId: string | null;
  /** A workout's music asked to play at Start that couldn't yet: no device open, Spotify asking to slow down, that backoff
   * run out ("ready": the player offers Play again — review-M M9), or a play that failed and why (review-M2 m4). */
  workout:
    | { target: WorkoutTarget; status: "no_device" | "slow" | "ready" }
    | { target: WorkoutTarget; status: "failed"; why: WorkoutFailure }
    | null;
}

export interface DockDeps {
  spotify: Spotify;
  /** The preferences save (`PUT /api/music`): answers what was stored. */
  saveMusic: (music: MusicPreferences) => Promise<MusicPreferences>;
  /** What each playlist suits (`POST /api/music/playlists/tags`), by its key. */
  tag: (playlists: Array<{ key: string; name: string; description: string }>) => Promise<Record<string, MusicGoodFor[]>>;
  disconnect?: () => Promise<void>;
  prefer: () => DeviceKind;
  random: () => number;
  openLink: (url: string) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  schedule: (fn: () => void, ms: number) => () => void;
  isVisible: () => boolean;
  /** A new playlist id: lower-case letters, digits and hyphens. */
  newId: () => string;
}

export type AddResult = { kind: "saved" } | { kind: "needs_label" } | { kind: "invalid" } | { kind: "failed" };

const NOT_A_LINK = "That isn't a Spotify playlist or album link.";
/** Why a play failed, for the player's line. */
function failureOf(e: unknown): WorkoutFailure {
  if (e instanceof NotConnected) return "reconnect";
  if (e instanceof SpotifyError && e.reason === "PREMIUM_REQUIRED") return "premium";
  return "error";
}

/** What the dock says while Spotify asks it to slow down. */
export const SLOW_LINE = "Spotify asked us to slow down — back in a few minutes";
/** …and when a tap meets it: the time left. */
export const slowLine = (ms: number): string => `Spotify asked us to slow down — ${backInWords(ms)}.`;

/** What the dock keeps of what Spotify said of a playlist: its name, and its description, cover and count when known. */
function linkedDetails(d: ContextDetails): Pick<MusicShortcut, "name" | "description" | "image" | "total"> {
  return {
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    ...(d.image ? { image: d.image } : {}),
    ...(d.total !== null ? { total: d.total } : {}),
  };
}

/** A playlist as the dock keeps it, from what Spotify said of it. */
function linked(id: string, uri: string, label: string, d: ContextDetails | null): MusicShortcut {
  return { id, label: label.trim().slice(0, MUSIC_LABEL_MAX).trim() || "Playlist", uri, shuffle: true, ...(d ? linkedDetails(d) : {}) };
}

/** What the tagging is given of a playlist: its words (`musicWordsOf` — the same the default reads before it is tagged). */
const tagInput = (s: MusicShortcut) => ({ key: s.id, ...musicWordsOf(s) });

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
    adding: null,
    playlists: null,
    editing: false,
    editingId: null,
    workout: null,
  };
  let visible = deps.isVisible();
  /** The once-per-load read and tagging of playlists linked before names and tags (`tidy`): started or not. */
  let tidied = false;
  /** The sessions whose music was asked for (`autoPlay`): once each, however often the player's line is drawn. */
  const started = new Set<string>();
  /** The timer that offers a held-back workout's music again (`holdWorkout`): cancelled on dispose. */
  let readyTimer: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DockState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  const remote = makeRemote({ spotify, prefer: deps.prefer, random: deps.random, openLink: deps.openLink, now: deps.now, sleep: deps.sleep });
  const poller = makePoller({
    read: () => spotify.player(),
    onState: (player) => set({ player, readAt: deps.now(), ...(state.notice?.text === SLOW_LINE ? { notice: null } : {}) }),
    onError: (e) => fail(e),
    schedule: deps.schedule,
  });

  const slowFor = (): number => spotify.backoff.remaining();

  function fail(e: unknown, opts: { tapped?: boolean } = {}): void {
    if (e instanceof NotConnected) {
      poller.stop();
      set({ connection: e.reason, busy: null, notice: e.reason === "reconnect" ? { text: "Spotify needs you to sign in again.", tone: "warn" } : null });
      return;
    }
    if (isSlowDown(e)) {
      set({ busy: null, notice: { text: opts.tapped ? slowLine(e.retryAfterMs ?? slowFor()) : SLOW_LINE, tone: "info" } });
      return;
    }
    const text =
      e instanceof SpotifyError && e.reason === "PREMIUM_REQUIRED" ? "Playing from here needs Spotify Premium." : "Spotify didn't answer. Try again.";
    set({ busy: null, notice: { text, tone: "warn" } });
  }

  async function guarded<T>(fn: () => Promise<T>, opts: { tapped?: boolean } = {}): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      fail(e, opts);
      return undefined;
    }
  }

  /** A tap meeting the backoff: said with the time left, no call. */
  function heldBack(): boolean {
    const left = slowFor();
    if (left <= 0) return false;
    set({ notice: { text: slowLine(left), tone: "info" } });
    return true;
  }

  const readPlayer = () => guarded(async () => set({ player: await spotify.player(), readAt: deps.now() }));

  async function applyRemote(out: RemoteResult | null | undefined): Promise<void> {
    if (!out) return;
    if (out.kind === "playing") {
      set({ link: null, busy: null, notice: null, workout: null });
      await readPlayer();
      return;
    }
    set({
      link: out.openUrl,
      busy: null,
      notice: out.kind === "opened" ? { text: "Opening Spotify. Come back and it will play.", tone: "info" } : { text: "No Spotify device is open.", tone: "warn" },
    });
  }

  /** The saves, one at a time: each waits for the one before it to answer. */
  let saving: Promise<unknown> = Promise.resolve();
  /**
   * Save the playlists as `build` makes them from the playlists as they are when this save's turn comes — each save
   * the whole list, so one built while another was still out would write over it (the first open's tagging, answering
   * while an add's save was out, dropped the added playlist; one removed came back). `build` answering null: nothing
   * to save.
   */
  function save(build: (music: MusicPreferences) => MusicPreferences | null): Promise<boolean> {
    const turn = saving.then(async (): Promise<boolean> => {
      const next = build(state.music);
      if (!next) return true;
      set({ busy: "saving" });
      let stored: MusicPreferences;
      try {
        stored = await deps.saveMusic(next);
      } catch {
        set({ busy: null, notice: { text: "Couldn't save. Try again.", tone: "warn" } });
        return false;
      }
      set({ music: stored, busy: null });
      return true;
    });
    saving = turn.catch(() => false);
    return turn;
  }

  /** What the playlists suit, by id; {} when the Worker couldn't say (the next open tags them). */
  async function tagsFor(list: MusicShortcut[]): Promise<Record<string, MusicGoodFor[]>> {
    if (list.length === 0) return {};
    try {
      return await deps.tag(list.map(tagInput));
    } catch {
      return {};
    }
  }

  /** Link a playlist: tagged, then saved after the others. Linked already: nothing changes. */
  async function link(uri: string, label: string, details: ContextDetails | null): Promise<AddResult> {
    if (state.music.shortcuts.some((s) => s.uri === uri)) {
      set({ adding: null, playlists: null });
      return { kind: "saved" };
    }
    if (state.music.shortcuts.length >= MUSIC_SHORTCUTS_MAX) {
      set({ adding: { error: "That's as many playlists as the dock keeps." } });
      return { kind: "failed" };
    }
    set({ busy: "adding" });
    const fresh = linked(deps.newId(), uri, label, details);
    const goodFor = (await tagsFor([fresh]))[fresh.id];
    const next: MusicShortcut = goodFor ? { ...fresh, goodFor } : fresh;
    const added = (music: MusicPreferences) => (music.shortcuts.some((s) => s.uri === uri) ? null : { ...music, shortcuts: [...music.shortcuts, next] });
    if (!(await save(added))) return { kind: "failed" };
    set({ adding: null, playlists: null });
    return { kind: "saved" };
  }

  /**
   * Playlists linked before names and tags: each read from Spotify once (its name, description, cover and count — the
   * old spa slot's "Spa" label becomes Spotify's name), then all tagged in one request, then saved once. Once per load,
   * only while connected and not backing off; a read Spotify refuses leaves that one as it is (named by its label), a
   * slow-down stops the reading there. Their tags mark them done.
   */
  async function tidy(): Promise<void> {
    if (tidied || state.connection !== "connected" || slowFor() > 0) return;
    const untagged = state.music.shortcuts.filter((s) => s.goodFor === undefined);
    if (untagged.length === 0) return;
    tidied = true;
    /** Each asked, with what Spotify said of it: details, null (it wouldn't say), or undefined (named already). */
    const asked = new Map<string, ContextDetails | null | undefined>();
    for (const s of untagged) {
      if (s.name !== undefined) {
        asked.set(s.id, undefined);
        continue;
      }
      try {
        asked.set(s.id, await spotify.details(s.uri));
      } catch (e) {
        fail(e);
        break;
      }
    }
    if (asked.size === 0) return;
    const withDetails = (s: MusicShortcut): MusicShortcut => {
      const d = asked.get(s.id);
      if (!d || s.name !== undefined) return s;
      const named = { ...s, ...linkedDetails(d) };
      // The old spa slot's own label, still as it was, takes Spotify's name; a label the athlete chose is kept.
      return s.id === "spa" && s.label === "Spa" ? { ...named, label: linked(s.id, s.uri, d.name, d).label } : named;
    };
    const tags = await tagsFor(untagged.filter((s) => asked.has(s.id)).map(withDetails));
    // Merged into the playlists as they are by its turn to save (review-M M1; after any save still out): one removed
    // meanwhile stays removed, one added stays added, a rename or tags set meanwhile are kept — tags only where none
    // were set.
    await save((music) => {
      const shortcuts = music.shortcuts.map((s) => {
        if (!asked.has(s.id)) return s;
        const next = withDetails(s);
        const goodFor = tags[s.id];
        return goodFor && next.goodFor === undefined ? { ...next, goodFor } : next;
      });
      return JSON.stringify(shortcuts) !== JSON.stringify(music.shortcuts) ? { ...music, shortcuts } : null;
    });
  }

  const deviceId = (): string | undefined => state.player?.device?.id ?? undefined;

  /** A workout's music held back by the backoff: said so, and offered again when it runs out. */
  function holdWorkout(target: WorkoutTarget): void {
    set({ workout: { target, status: "slow" } });
    readyTimer?.();
    readyTimer = deps.schedule(() => {
      readyTimer = null;
      if (state.workout?.target === target && state.workout.status === "slow") set({ workout: { target, status: "ready" } });
    }, slowFor());
  }

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
    /** Expanded: read now playing, then the devices (one after the other: a slow-down stops at the first), then keep
     * now playing fresh while open and visible. Never plays. Backing off, it reads nothing and says so. */
    async open(): Promise<void> {
      set({ expanded: true, editing: false, editingId: null });
      if (state.connection !== "connected") return;
      if (slowFor() > 0) {
        set({ notice: { text: SLOW_LINE, tone: "info" } });
      } else {
        await guarded(async () => {
          const player = await spotify.player();
          set({ player, readAt: deps.now() });
          set({ devices: await spotify.devices() });
        });
        await tidy();
      }
      if (state.expanded && state.connection === "connected") poller.set({ expanded: true, visible }, { firstDelayMs: Math.max(POLL_MS, slowFor()) });
    },
    /** Closed, the dock forgets a play waiting for a device (review #2): it plays only when asked. */
    async close(): Promise<void> {
      poller.set({ expanded: false, visible });
      remote.cancel();
      set({ expanded: false, adding: null, playlists: null, editing: false, editingId: null, link: null });
    },
    /** The page's visibility: polling follows it, and a play waiting for a device is tried again on the return from
     * Spotify — once (music/remote.ts). */
    async setVisible(next: boolean): Promise<void> {
      visible = next;
      poller.set({ expanded: state.expanded && state.connection === "connected", visible: next });
      if (!next) remote.hidden();
      else if (remote.pending()) await applyRemote(await guarded(() => remote.visible()));
    },
    /** One tap on a playlist: play it, shuffled. Backing off: said with the time left, nothing sent. */
    async tap(id: string): Promise<void> {
      if (state.connection !== "connected" || state.busy) return;
      const shortcut = state.music.shortcuts.find((s) => s.id === id);
      if (!shortcut || heldBack()) return;
      // Known to have no device: the link opens now, inside the tap (a browser opens a new context only inside one).
      const noDevice = state.devices !== null && chooseDevice(state.devices, deps.prefer()) === null;
      const pending = remote.play({ ...shortcut, shuffle: true }, { noDevice });
      set({ busy: "playing", notice: null });
      await applyRemote(await guarded(() => pending, { tapped: true }));
      if (state.busy === "playing") set({ busy: null });
    },
    /**
     * A workout's music, when its session starts (the player's; once per session): played shuffled on the device Spotify would
     * use — never the open-link fallback, which needs a tap. No device open, or Spotify asking to slow down: kept as
     * `workout` for the player's quiet line (its Play is `playWorkout`). A failure says nothing in the player.
     */
    async autoPlay(target: WorkoutTarget, session: string): Promise<void> {
      if (state.connection !== "connected" || state.busy || started.has(session)) return;
      started.add(session);
      set({ busy: "playing" });
      let out: Awaited<ReturnType<typeof playContext>>;
      // Backing off, the client refuses before the network: the catch says so (status "slow").
      try {
        out = await playContext(spotify, { uri: target.uri, shuffle: true }, { prefer: deps.prefer(), random: deps.random });
      } catch (e) {
        fail(e);
        set({ busy: null, workout: null });
        // Held back: Play again once it runs out. Else the player says why (review-M2 m4): never a blank band.
        if (isSlowDown(e)) holdWorkout(target);
        else set({ workout: { target, status: "failed", why: failureOf(e) } });
        return;
      }
      set({ busy: null });
      if (out.kind === "playing") {
        set({ workout: null, link: null });
        await readPlayer();
      } else {
        set({ workout: { target, status: "no_device" }, devices: [] });
      }
    },
    /** The player's Play for a workout's music that couldn't start on its own: a tap, so the link may open. Still no
     * device (the link opened, or the browser blocked it): the player's line says "Open Spotify to play …" with the
     * link to tap — never "Ready to play …" again, whose Play would take the same blocked path. */
    async playWorkout(target: WorkoutTarget): Promise<void> {
      if (state.connection !== "connected" || state.busy) return;
      if (heldBack()) {
        holdWorkout(target);
        return;
      }
      const noDevice = state.devices !== null && chooseDevice(state.devices, deps.prefer()) === null;
      const pending = remote.play({ id: target.id, label: target.label, uri: target.uri, shuffle: true }, { noDevice });
      set({ busy: "playing", notice: null });
      const out = await guarded(() => pending, { tapped: true });
      await applyRemote(out);
      if (out && out.kind !== "playing") set({ workout: { target, status: "no_device" } });
      if (state.busy === "playing") set({ busy: null });
    },
    async pause(): Promise<void> {
      remote.cancel();
      if ((await guarded(() => spotify.pause(deviceId()), { tapped: true })) !== undefined && state.player) set({ player: { ...state.player, is_playing: false } });
    },
    async resume(): Promise<void> {
      if ((await guarded(() => spotify.play({ deviceId: deviceId() }), { tapped: true })) !== undefined && state.player) set({ player: { ...state.player, is_playing: true } });
    },
    async next(): Promise<void> {
      if ((await guarded(() => spotify.next(deviceId()), { tapped: true })) !== undefined) await readPlayer();
    },
    async setVolume(percent: number): Promise<void> {
      const v = volumeOf(state.player, state.devices);
      if (!v?.supported) return;
      const sent = await guarded(() => spotify.volume(percent, v.deviceId), { tapped: true });
      if (sent === undefined) return;
      const withVolume = (d: Device | null | undefined) => (d && d.id === v.deviceId ? { ...d, volume_percent: Math.round(percent) } : d);
      set({
        player: state.player ? { ...state.player, device: withVolume(state.player.device) ?? null } : null,
        devices: state.devices?.map((d) => withVolume(d)!) ?? null,
      });
    },
    /** The add flow: the athlete's first page of playlists is listed as it opens (one read). */
    async startAdding(): Promise<void> {
      set({ adding: {}, playlists: null, editingId: null });
      if (state.connection !== "connected") return;
      const page = await guarded(() => spotify.myPlaylists(0));
      if (page && state.adding) set({ playlists: page });
    },
    /** The next page of their playlists — only when asked for. */
    async morePlaylists(): Promise<void> {
      const listed = state.playlists;
      if (!listed || listed.next === null || state.busy) return;
      const page = await guarded(() => spotify.myPlaylists(listed.next!), { tapped: true });
      if (page && state.adding) set({ playlists: { items: [...listed.items, ...page.items], next: page.next } });
    },
    cancelAdding(): void {
      set({ adding: null, playlists: null });
    },
    /** A pasted link: named from Spotify when the athlete can read it (one read), else they name it. */
    async addLink(text: string): Promise<AddResult> {
      const parsed = parseSpotifyLink(text);
      if (!parsed) {
        set({ adding: { error: NOT_A_LINK } });
        return { kind: "invalid" };
      }
      if (state.music.shortcuts.some((s) => s.uri === parsed.uri)) return link(parsed.uri, "", null);
      let details: ContextDetails | null;
      try {
        details = await spotify.details(parsed.uri);
      } catch (e) {
        fail(e, { tapped: true });
        return { kind: "failed" };
      }
      if (details) return link(parsed.uri, details.name, details);
      if (state.connection !== "connected") return { kind: "failed" };
      set({ adding: { needsLabel: { uri: parsed.uri } }, notice: null });
      return { kind: "needs_label" };
    },
    async nameAndSave(label: string): Promise<AddResult> {
      const adding = state.adding;
      if (!adding?.needsLabel) return { kind: "failed" };
      if (!label.trim()) {
        set({ adding: { ...adding, error: "Give it a name." } });
        return { kind: "failed" };
      }
      return link(adding.needsLabel.uri, label, null);
    },
    /** One of their playlists, picked from the list: what the list said of it is kept (no read of its own). */
    async addPlaylist(p: PlaylistSummary): Promise<AddResult> {
      return link(p.uri, p.name, p);
    },
    async remove(id: string): Promise<void> {
      if (await save((music) => ({ ...music, shortcuts: music.shortcuts.filter((s) => s.id !== id) }))) set({ editingId: null });
    },
    /** A playlist's label and what it suits, as the athlete set them. */
    async edit(id: string, patch: { label: string; goodFor: MusicGoodFor[] }): Promise<boolean> {
      const label = patch.label.trim().slice(0, MUSIC_LABEL_MAX).trim();
      if (!label) return false;
      const ok = await save((music) => ({
        ...music,
        shortcuts: music.shortcuts.map((s) => (s.id === id ? { ...s, label, goodFor: [...new Set(patch.goodFor)] } : s)),
      }));
      if (ok) set({ editingId: null });
      return ok;
    },
    /** A line in the sheet (the login's outcome, when it came back here). */
    say(text: string, tone: "info" | "warn"): void {
      set({ notice: { text, tone } });
    },
    setEditing(editing: boolean): void {
      set({ editing, editingId: null, adding: null });
    },
    openEditor(id: string | null): void {
      set({ editingId: id });
    },
    async disconnect(): Promise<void> {
      remote.cancel();
      if (!deps.disconnect) return;
      try {
        await deps.disconnect();
      } catch {
        set({ notice: { text: "Couldn't disconnect. Try again.", tone: "warn" } });
        return;
      }
      poller.stop();
      set({ connection: "not_connected", player: null, devices: null, editing: false, editingId: null, link: null, notice: null, workout: null });
    },
    /** The dock leaves the page: no timer survives it. */
    dispose(): void {
      poller.stop();
      remote.cancel();
      readyTimer?.();
      readyTimer = null;
    },
  };
}

export type DockController = ReturnType<typeof makeDockController>;
