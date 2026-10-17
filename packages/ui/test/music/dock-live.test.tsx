// @vitest-environment jsdom
/**
 * The music dock, live in a DOM (2026-10-17, the review's minor items):
 *
 *  - the volume is sent as it changes — a screen reader's steps fire `change` with no pointer or key released — once
 *    it settles (debounced), not only on a pointer's release;
 *  - in the session player the dock is one of the top bar's tools (`PlayerScreen`'s `tools`), in its row, never
 *    floating over the player's own lines.
 *
 * Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@rg/api-client";
import type { MusicDto } from "@rg/api-client";
import { MUSIC_QUERY, MusicPanel, PlayerMusicTools, VOLUME_SETTLE_MS, type PanelActions } from "../../src/music/dock.js";
import type { DockState } from "../../src/music/controller.js";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import { saveBuild } from "../../src/offline/builds.js";
import { saveExtras } from "../../src/player/stored.js";
import { PlayerScreen } from "../../src/screens/player.js";
import type { CuePlayer } from "../../src/player/cue-player.js";
import { build, profiles, SLOT, T0, view } from "../player/fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let db: OfflineDb | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  db?.close();
  db = null;
  vi.useRealTimers();
});

function mount(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}

const desk = { id: "desk-1", name: "Desktop", type: "Computer", supports_volume: true, volume_percent: 40, is_active: true };
const state: DockState = {
  connection: "connected",
  music: { shortcuts: [] },
  expanded: true,
  player: { is_playing: true, device: desk, progress_ms: 0, item: { name: "A Song", artists: [{ name: "An Artist" }], duration_ms: 200_000 } },
  readAt: 0,
  devices: [desk],
  busy: null,
  notice: null,
  link: null,
  build: null,
  adding: null,
  playlists: null,
  editing: false,
};

function slide(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the volume", () => {
  it("is sent as it changes, once it settles — a screen reader's steps set it too", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const actions = new Proxy({} as PanelActions, {
      get: (_, key) => (key === "setVolume" ? (n: number) => void sent.push(n) : () => undefined),
    });
    mount(createElement(MusicPanel, { state, actions }));
    const input = host!.querySelector<HTMLInputElement>('input[type="range"]')!;
    slide(input, "45");
    slide(input, "50");
    slide(input, "55");
    expect(sent).toEqual([]);
    act(() => void vi.advanceTimersByTime(VOLUME_SETTLE_MS));
    expect(sent).toEqual([55]);
    expect(input.value).toBe("55");
    // Another step later is sent on its own.
    slide(input, "60");
    act(() => void vi.advanceTimersByTime(VOLUME_SETTLE_MS));
    expect(sent).toEqual([55, 60]);
  });
});

describe("dark", () => {
  it("the player's dock is not mounted at all — no controller, no listener — and on, it is", () => {
    for (const [data, mounted] of [[null, false], [{ connected: true, music: { shortcuts: [] } }, true]] as Array<[MusicDto | null, boolean]>) {
      const add = vi.spyOn(document, "addEventListener");
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      qc.setQueryData(MUSIC_QUERY, data);
      mount(createElement(QueryClientProvider, { client: qc }, createElement(PlayerMusicTools)));
      expect(add.mock.calls.some((c) => c[0] === "visibilitychange"), String(mounted)).toBe(mounted);
      add.mockRestore();
      act(() => root?.unmount());
      host?.remove();
      root = null;
    }
  });
});

describe("in the session player", () => {
  const noCues: CuePlayer = { unlock: () => undefined, schedule: () => undefined, cancel: () => undefined, configure: () => undefined, preview: () => undefined, running: () => false };

  it("the dock is one of the top bar's tools, first in its row", async () => {
    db = await openOfflineDb(new IDBFactory());
    await saveBuild(db, { workoutId: SLOT, build: build(), view: view() } as unknown as SessionDto);
    await saveExtras(db, { workoutId: SLOT, title: "Program one", profiles: profiles(), savedAt: T0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const player = createElement(PlayerScreen, {
      workoutId: SLOT,
      tools: createElement("button", { type: "button", id: "music-tool", "aria-label": "Music" }),
      deps: {
        db: () => Promise.resolve(db!),
        getSession: () => Promise.reject(new TypeError("Failed to fetch")),
        cues: noCues,
        wake: () => () => undefined,
      },
    });
    mount(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(MemoryRouter, { initialEntries: [`/session/${SLOT}`] }, createElement(Routes, null, createElement(Route, { path: "/session/:workoutId", element: player }))),
      ),
    );
    for (let i = 0; i < 300 && !document.querySelector(".player-tools"); i++) {
      await act(async () => void (await new Promise((r) => setImmediate(r))));
    }
    const tools = document.querySelector(".player-top .player-tools");
    expect(tools).not.toBeNull();
    expect(tools!.firstElementChild?.id).toBe("music-tool");
    expect(document.querySelectorAll("#music-tool")).toHaveLength(1);
  });
});
