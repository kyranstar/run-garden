// @vitest-environment jsdom
/**
 * A workout's music (2026-10-19; packages/ui/src/music/workout-music.tsx, dock.tsx `WorkoutMusicLine`):
 *
 *  - the session sheet says what plays — "Music · Spa (default)", the coach's pick, the athlete's, or No music — and
 *    Change offers the saved playlists, No music and Use the default (the athlete's choice saved for that workout);
 *  - dark, or no playlist: nothing at all;
 *  - Start hands the player what resolves (`musicAtStart`, kept in the session's extras on the device);
 *  - the player plays it once, as a session just started here begins — connected, the setting on — never on a resume,
 *    never with the setting off; with no device, one quiet line with Play (a tap: Spotify may open).
 *  - Settings → Sounds: "Play the workout's music when I start", on by default, only while the dock is on.
 *
 * Synthetic data only.
 */
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { musicApi, type MusicDto, type SessionDto } from "@rg/api-client";
import type { MusicShortcut } from "@rg/domain";
import { EQUIPMENT_IDS, EXERCISES, TMJ } from "@rg/exercise-library";
import { deriveDoc, quickStartDoc, QUICK_START_KINDS } from "@rg/workout";
import { MUSIC_QUERY, setDockFor, WorkoutMusicLine } from "../../src/music/dock.js";
import { musicAtStart, sessionMusic, WorkoutMusicRow } from "../../src/music/workout-music.js";
import { makeDockController, SLOW_LINE } from "../../src/music/controller.js";
import { BACKOFF_FIRST_MS, BACKOFF_KEY, makeBackoff } from "../../src/music/backoff.js";
import { makeSpotify } from "../../src/music/spotify.js";
import { AUTOPLAY_KEY } from "../../src/music/autoplay-setting.js";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import { saveBuild } from "../../src/offline/builds.js";
import { loadExtras, rememberStart, saveExtras } from "../../src/player/stored.js";
import { PlayerScreen, type PlayerMusicStart } from "../../src/screens/player.js";
import type { CuePlayer } from "../../src/player/cue-player.js";
import { SoundsSection } from "../../src/screens/settings/sounds.js";
import { fakeSpotify, fakeTokens, sid } from "./fake-spotify.js";
import { build, profiles, SLOT, T0, view } from "../player/fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPA = sid("spaed");
const spa: MusicShortcut = { id: "spa", label: "Spa", uri: `spotify:playlist:${SPA}`, shuffle: true, goodFor: ["mobility", "wind-down"] };
const gym: MusicShortcut = { id: "s2", label: "Gym", uri: `spotify:playlist:${sid("gym")}`, shuffle: true, goodFor: ["strength"] };
const dto = (extra: Partial<MusicDto> = {}): MusicDto => ({ connected: true, music: { shortcuts: [spa, gym] }, choices: {}, ...extra });
const TODAY = "2026-10-19";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let db: OfflineDb | null = null;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  db?.close();
  db = null;
  vi.restoreAllMocks();
});

function mount(el: ReactElement, qc: QueryClient, router = true) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client: qc }, router ? createElement(MemoryRouter, null, el) : el)));
}
const client = (data?: MusicDto | null) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (data !== undefined) qc.setQueryData(MUSIC_QUERY, data);
  return qc;
};
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
const text = () => host?.textContent ?? "";
const button = (name: string | RegExp) =>
  [...document.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent === name || b.getAttribute("aria-label") === name : name.test(b.textContent ?? "")));

describe("what a session plays", () => {
  const input = { workoutId: "w1", category: "yoga", calm: false };

  it("the default for its kind, the athlete's choice, the workout's own — none while the dock is off or has no playlist", () => {
    expect(sessionMusic(dto(), input)).toEqual({ shortcut: spa, source: "default" });
    expect(sessionMusic(dto(), { ...input, category: "strength" })).toEqual({ shortcut: gym, source: "default" });
    expect(sessionMusic(dto(), { ...input, docMusic: { playlist: "s2" } })).toEqual({ shortcut: gym, source: "workout" });
    expect(sessionMusic(dto({ choices: { w1: { date: TODAY, use: "none" } } }), input)).toEqual({ shortcut: null, source: "athlete" });
    // Another workout's choice is not this one's.
    expect(sessionMusic(dto({ choices: { w2: { date: TODAY, use: "none" } } }), input)!.shortcut).toBe(spa);
    expect(sessionMusic(null, input)).toBeNull();
    expect(sessionMusic(dto({ music: { shortcuts: [] } }), input)).toBeNull();
    // A calm session (recovery mode, a "recover" effort) winds down: a wind-down playlist before a mobility one.
    const flow: MusicShortcut = { ...gym, id: "s4", label: "Flow", goodFor: ["mobility"] };
    const calmList: MusicShortcut = { ...gym, id: "s5", label: "Calm", goodFor: ["wind-down"] };
    const both = dto({ music: { shortcuts: [flow, calmList] } });
    expect(sessionMusic(both, input)!.shortcut).toBe(flow);
    expect(sessionMusic(both, { ...input, calm: true })!.shortcut).toBe(calmList);
  });

  it("Start hands the player what resolves now, from the dock's read as cached", () => {
    expect(musicAtStart(client(dto()), input)).toEqual({ id: "spa", label: "Spa", uri: spa.uri });
    expect(musicAtStart(client(dto()), { ...input, category: "cross_training" })).toBeNull();
    expect(musicAtStart(client(null), input)).toBeNull();
    expect(musicAtStart(client(), input)).toBeNull();
  });
});

describe("the mobility workouts, once the playlists are tagged (the backfill)", () => {
  it("every one plays the playlist good for mobility: each quick start, a planned mobility session, a programme's in recovery mode, a calm template", () => {
    // Before any tagging — the owner's old spa slot exactly as stored, the dock never opened (review-M I1): its words
    // say what it suits, as the tagging's would.
    const old = { id: "spa", label: "Spa", uri: spa.uri, shuffle: true };
    const untagged = dto({ music: { shortcuts: [gym, old] } });
    expect(sessionMusic(untagged, { workoutId: "w1", category: "yoga", calm: false })!.shortcut).toEqual(old);
    expect(sessionMusic(untagged, { workoutId: "w1", category: "yoga", calm: true })!.shortcut).toEqual(old);
    expect(sessionMusic(untagged, { workoutId: "w1", category: "strength", calm: false })!.shortcut).toBe(gym);
    expect(sessionMusic(dto({ music: { shortcuts: [old] } }), { workoutId: "w1", category: "strength", calm: false })!.shortcut).toBeNull();
    expect(musicAtStart(client(untagged), { workoutId: "w1", category: "yoga", calm: false })).toEqual({ id: "spa", label: "Spa", uri: spa.uri });
    const tagged = dto({ music: { shortcuts: [gym, spa] } });
    for (const kind of QUICK_START_KINDS) {
      const made = quickStartDoc(kind, EXERCISES, { activeProfiles: [TMJ], day: null, focusRefs: [], recentIds: [], pinned: [], excluded: [], equipment: EQUIPMENT_IDS, seed: 1 } as never);
      if (!("doc" in made)) throw new Error(made.reason);
      const category = deriveDoc(made.doc, EXERCISES).category;
      expect(sessionMusic(tagged, { workoutId: null, category, calm: made.doc.intent.effort === "recover", docMusic: made.doc.music ?? null })!.shortcut, kind).toBe(spa);
    }
    expect(sessionMusic(tagged, { workoutId: "w2", category: "yoga", calm: false })!.shortcut).toBe(spa);
    expect(sessionMusic(tagged, { workoutId: "w3", category: "yoga", calm: true })!.shortcut).toBe(spa);
    // A strength session plays the strength one, never the mobility one.
    expect(sessionMusic(tagged, { workoutId: "w4", category: "strength", calm: true })!.shortcut).toBe(gym);
  });
});

describe("the sheet's Music row", () => {
  const row = (data: MusicDto | null | undefined, extra: Partial<Parameters<typeof WorkoutMusicRow>[0]> = {}) => {
    mount(createElement(WorkoutMusicRow, { workoutId: "w1", category: "yoga", calm: false, date: TODAY, ...extra }), client(data));
  };

  it("says what plays and whose choice it is; dark, or no playlist, nothing at all", () => {
    row(dto());
    expect(text()).toBe("Music Spa (default)Change");
    expect(button("Change the music: Spa")?.getAttribute("aria-haspopup")).toBe("dialog");
    act(() => root?.unmount());
    row(dto(), { docMusic: { playlist: "s2" } });
    expect(text()).toBe("Music Gym (the coach's pick)Change");
    act(() => root?.unmount());
    row(dto({ choices: { w1: { date: TODAY, use: "playlist", playlist: "s2" } } }));
    expect(text()).toBe("Music GymChange");
    act(() => root?.unmount());
    row(dto(), { category: "cross_training" });
    expect(text()).toBe("Music No musicChange");
    act(() => root?.unmount());
    row(null);
    expect(text()).toBe("");
    act(() => root?.unmount());
    row(dto({ music: { shortcuts: [] } }));
    expect(text()).toBe("");
  });

  it("Change offers the saved playlists, No music and Use the default; a pick is kept for this workout and said at once", async () => {
    const choose = vi.spyOn(musicApi, "choose").mockImplementation(async (workoutId, choice) => ({ choices: { [workoutId]: choice } }));
    row(dto());
    act(() => button("Change")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Music for this workout");
    const options = [...dialog.querySelectorAll(".choice-list button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
    expect(options).toEqual([
      ["Spa", "false"],
      ["Gym", "false"],
      ["No music", "false"],
      ["Use the default · Spa", "true"],
    ]);
    await act(async () => button("Gym")!.click());
    await settle();
    expect(choose).toHaveBeenCalledWith("w1", { date: TODAY, use: "playlist", playlist: "s2" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(text()).toBe("Music GymChange");
    act(() => button("Change")!.click());
    await act(async () => button("No music")!.click());
    await settle();
    expect(choose).toHaveBeenLastCalledWith("w1", { date: TODAY, use: "none" });
    expect(text()).toBe("Music No musicChange");
  });

  it("before there is a workout to keep it under (the Studio's), a pick is handed back, nothing saved", async () => {
    const choose = vi.spyOn(musicApi, "choose");
    const picked: unknown[] = [];
    row(dto(), { workoutId: null, onPick: (c) => picked.push(c) });
    act(() => button("Change")!.click());
    await act(async () => button("No music")!.click());
    expect(picked).toEqual([{ date: TODAY, use: "none" }]);
    expect(choose).not.toHaveBeenCalled();
  });
});

describe("Start keeps the session's music with it", () => {
  it("in the session's extras on the device; none when nothing resolved", async () => {
    db = await openOfflineDb(new IDBFactory());
    const session = { workoutId: SLOT, build: build(), view: view(), profiles: profiles() } as unknown as SessionDto;
    await rememberStart(db, session, "Program one", "u1", T0, { id: "spa", label: "Spa", uri: spa.uri });
    expect((await loadExtras(db, SLOT))!.music).toEqual({ id: "spa", label: "Spa", uri: spa.uri });
    await rememberStart(db, session, "Program one", "u1", T0);
    expect((await loadExtras(db, SLOT))!.music).toBeUndefined();
  });
});

describe("the player, as the session begins", () => {
  const target = { id: "spa", label: "Spa", uri: spa.uri };

  function dockWith(devices: Array<{ id: string; name: string; type: string; supports_volume: boolean }>, now: () => number = () => 0) {
    const fake = fakeSpotify({ devices });
    fake.state.playlists.set(SPA, { name: "Spa", owned: false, uris: [] });
    const opened: string[] = [];
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const spotify = makeSpotify({ token: fakeTokens(fake, { now }).token, fetch: fake.fetch, now });
    const dock = makeDockController({
      spotify,
      saveMusic: async (m) => m,
      tag: async () => ({}),
      prefer: () => "Smartphone",
      random: () => 0,
      openLink: (url) => (opened.push(url), true),
      now,
      sleep: async () => undefined,
      schedule: (fn, ms) => (scheduled.push({ fn, ms }), () => undefined),
      isVisible: () => true,
      newId: () => "x",
    });
    const plays = () => fake.calls.filter((c) => c.path === "/me/player/play");
    return { dock, fake, opened, plays, spotify, scheduled };
  }

  it("its line's room is kept from the first draw, so a line that comes later moves nothing (M8)", async () => {
    const { dock, fake } = dockWith([]);
    let release: () => void = () => undefined;
    fake.script("GET /me/player/devices", { status: 200, body: { devices: [] }, gate: new Promise<void>((r) => (release = r)) });
    const qc = client(dto());
    setDockFor(qc, dock);
    mount(createElement(WorkoutMusicLine, { session: "perf-1", fresh: true, target }), qc);
    const kept = document.querySelector(".player-music");
    expect(kept).not.toBeNull();
    expect(kept!.textContent).toBe("");
    release();
    await settle();
    expect(document.querySelector(".player-music")).toBe(kept);
    expect(kept!.textContent).toBe("Open Spotify to play SpaPlay");
  });

  it("asked to slow down at Start: the calm line, then Play once the backoff has run out (M9)", async () => {
    let clock = 0;
    const { dock, spotify, scheduled, plays } = dockWith([phone], () => clock);
    spotify.backoff.hit(null);
    const qc = client(dto());
    setDockFor(qc, dock);
    mount(createElement(WorkoutMusicLine, { session: "perf-1", fresh: true, target }), qc);
    await settle();
    expect(document.querySelector(".player-music")!.textContent).toBe(SLOW_LINE);
    expect(button("Play")).toBeUndefined();
    // When the backoff runs out (the dock's own timer), Play is offered.
    const later = scheduled.find((s) => s.ms === BACKOFF_FIRST_MS)!;
    expect(later).toBeDefined();
    clock += BACKOFF_FIRST_MS;
    act(() => later.fn());
    expect(document.querySelector(".player-music")!.textContent).toBe("Ready to play SpaPlay");
    await act(async () => button("Play")!.click());
    await settle();
    expect(plays()).toHaveLength(1);
    expect(document.querySelector(".player-music")!.textContent).toBe("");
  });
  const phone = { id: "phone-1", name: "Phone", type: "Smartphone", supports_volume: false };

  it("plays the music once for a session just started here, connected and the setting on — the line says nothing", async () => {
    const { dock, plays } = dockWith([phone]);
    const qc = client(dto());
    setDockFor(qc, dock);
    mount(createElement(WorkoutMusicLine, { session: "perf-1", fresh: true, target }), qc);
    await settle();
    expect(plays()).toHaveLength(1);
    expect(plays()[0]!.body).toMatchObject({ context_uri: spa.uri });
    expect(text()).toBe("");
    // Drawn again, or its line mounted afresh, for the same session: never twice.
    act(() => root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(WorkoutMusicLine, { session: "perf-1", fresh: true, target: { ...target } })))));
    await settle();
    act(() => root?.unmount());
    host?.remove();
    mount(createElement(WorkoutMusicLine, { session: "perf-1", fresh: true, target }), qc);
    await settle();
    expect(plays()).toHaveLength(1);
  });

  it("never on a resumed session, with the setting off, not connected, or with no music", async () => {
    for (const [fresh, setting, data, t] of [
      [false, "1", dto(), target],
      [true, "0", dto(), target],
      [true, "1", dto({ connected: false }), target],
      [true, "1", dto(), null],
    ] as const) {
      localStorage.setItem(AUTOPLAY_KEY, setting);
      const { dock, plays, fake } = dockWith([phone]);
      const qc = client(data);
      setDockFor(qc, dock);
      mount(createElement(WorkoutMusicLine, { session: "perf-1", fresh, target: t }), qc);
      await settle();
      expect(plays(), `${fresh} ${setting} ${data.connected} ${!!t}`).toEqual([]);
      expect(fake.calls).toEqual([]);
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("no device open: one quiet line — Open Spotify to play Spa — whose Play (a tap) opens Spotify", async () => {
    const { dock, opened, plays } = dockWith([]);
    const qc = client(dto());
    setDockFor(qc, dock);
    mount(createElement(WorkoutMusicLine, { session: "perf-1", fresh: true, target }), qc);
    await settle();
    expect(plays()).toEqual([]);
    expect(opened).toEqual([]);
    const line = document.querySelector(".player-music")!;
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe("Open Spotify to play SpaPlay");
    await act(async () => button("Play")!.click());
    await settle();
    expect(opened).toEqual([`https://open.spotify.com/playlist/${SPA}`]);
  });

  it("the player hands its music line a fresh start the first time, and a resume after", async () => {
    db = await openOfflineDb(new IDBFactory());
    await saveBuild(db, { workoutId: SLOT, build: build(), view: view() } as unknown as SessionDto);
    await saveExtras(db, { workoutId: SLOT, title: "Program one", profiles: profiles(), savedAt: T0, music: target });
    const seen: PlayerMusicStart[] = [];
    const noCues: CuePlayer = { unlock: () => undefined, schedule: () => undefined, cancel: () => undefined, configure: () => undefined, preview: () => undefined, running: () => false };
    const open = async () => {
      const player = createElement(PlayerScreen, {
        workoutId: SLOT,
        musicLine: (m: PlayerMusicStart) => (seen.push(m), createElement("p", { className: "music-line-probe" }, m.fresh ? "fresh" : "resumed")),
        deps: { db: () => Promise.resolve(db!), getSession: () => Promise.reject(new TypeError("Failed to fetch")), cues: noCues, wake: () => () => undefined, writeDelayMs: 0 },
      });
      mount(
        createElement(MemoryRouter, { initialEntries: [`/session/${SLOT}`] }, createElement(Routes, null, createElement(Route, { path: "/session/:workoutId", element: player }))),
        client(),
        false,
      );
      for (let i = 0; i < 300 && !document.querySelector(".music-line-probe"); i++) await act(async () => void (await new Promise((r) => setImmediate(r))));
    };
    await open();
    const first = seen.at(-1)!;
    expect(first).toMatchObject({ fresh: true, target });
    act(() => root?.unmount());
    host?.remove();
    await open();
    // The same session, resumed.
    expect(seen.at(-1)).toEqual({ session: first.session, fresh: false, target });
  });
});

describe("two tabs (review-M M6)", () => {
  it("a backoff another tab begins reaches this one through the storage event, and its end too", () => {
    let clock = 5_000;
    const here = makeBackoff({ now: () => clock });
    expect(here.remaining()).toBe(0);
    const raw = JSON.stringify({ until: clock + BACKOFF_FIRST_MS, step: 1 });
    localStorage.setItem(BACKOFF_KEY, raw);
    window.dispatchEvent(new StorageEvent("storage", { key: BACKOFF_KEY, newValue: raw }));
    expect(here.remaining()).toBe(BACKOFF_FIRST_MS);
    window.dispatchEvent(new StorageEvent("storage", { key: "another-key", newValue: null }));
    expect(here.remaining()).toBe(BACKOFF_FIRST_MS);
    clock += BACKOFF_FIRST_MS;
    window.dispatchEvent(new StorageEvent("storage", { key: BACKOFF_KEY, newValue: null }));
    expect(here.hit(null)).toBe(BACKOFF_FIRST_MS);
  });
});

describe("Settings → Sounds", () => {
  it("'Play the workout's music when I start' — on by default, kept on this device — only while the dock is on", async () => {
    mount(createElement(SoundsSection), client(dto()));
    const sw = document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Play the workout\'s music when I start"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    act(() => sw.click());
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(AUTOPLAY_KEY)).toBe("0");
    act(() => root?.unmount());
    host?.remove();
    mount(createElement(SoundsSection), client(null));
    expect(document.querySelector('[aria-label="Play the workout\'s music when I start"]')).toBeNull();
  });
});
