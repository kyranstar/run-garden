// @vitest-environment jsdom
/**
 * A DOCUMENT WORKOUT ON THE PLAYER SCREEN (Stage 2 spec §11; Task 8), from IndexedDB with no network: an item's cue
 * under the move's name; a hold to max counting up past its target, the target shown, Done logging the seconds held;
 * ⇄ listing the item's planned alternates first, with their why. An engine build shows none of it.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionBuildDto, SessionDto, SessionViewDto } from "@rg/api-client";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import { saveBuild } from "../../src/offline/builds.js";
import { readLive } from "../../src/offline/live.js";
import { saveExtras } from "../../src/player/stored.js";
import { PlayerScreen } from "../../src/screens/player.js";
import type { Chimes } from "../../src/player/audio.js";
import { build, docBuild, docView, HOLD_CUE, PLANNED_WHY, profiles, SLOT, SQUAT_CUE, STRETCH_CUE, T0, view } from "./fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let db: OfflineDb | null = null;
let scheduled: number[][] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  scheduled = [];
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  db?.close();
  db = null;
  vi.useRealTimers();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

const chimes: Chimes = { unlock: () => undefined, schedule: (due) => void scheduled.push([...due]), cancel: () => undefined };

async function start(b: SessionBuildDto, v: SessionViewDto): Promise<void> {
  db = await openOfflineDb(new IDBFactory());
  await saveBuild(db, { workoutId: SLOT, build: b, view: v } as unknown as SessionDto);
  await saveExtras(db, { workoutId: SLOT, title: "Hips and legs", profiles: profiles(), savedAt: T0 });
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const player = createElement(PlayerScreen, {
    workoutId: SLOT,
    deps: {
      db: () => Promise.resolve(db!),
      getSession: () => Promise.reject(new TypeError("Failed to fetch")),
      chimes,
      wake: () => () => undefined,
    },
  });
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          { initialEntries: [`/session/${SLOT}`] },
          createElement(Routes, null, createElement(Route, { path: "/session/:workoutId", element: player })),
        ),
      ),
    );
  });
  await until(() => text().includes("1 of 9"), "the first step");
}

const flush = () => act(async () => void (await new Promise((r) => setImmediate(r))));
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await flush();
  }
  throw new Error(`timed out waiting for: ${what}\n${text()}`);
}
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const control = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("button, a, input")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim() === name);
async function click(name: string) {
  const b = control(name);
  if (!b) throw new Error(`no control ${name}\n${text()}`);
  await act(async () => b.click());
}
async function press(key: string) {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
async function at(ms: number) {
  vi.setSystemTime(ms);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function stepTo(n: number) {
  while (!text().includes(`${n} of 9`)) await press("ArrowRight");
}
/** What sits right under the move's name. */
const underName = () => document.querySelector("h1.player-name")?.nextElementSibling ?? null;
const S = 1000;

describe("a document workout's items, played", () => {
  it("an item's cue shows under the move's name", async () => {
    await start(docBuild(), docView());
    // A move whose item has no cue shows none.
    expect(document.querySelector("h1.player-name")!.textContent).toMatch(/^Low lunge/);
    expect(document.querySelector(".player-cue")).toBeNull();
    await stepTo(3);
    expect(document.querySelector("h1.player-name")!.textContent).toBe("Goblet squat");
    expect(underName()!.textContent).toBe(SQUAT_CUE);
    await stepTo(8);
    expect(document.querySelector("h1.player-name")!.textContent).toBe("Wall sit");
    expect(underName()!.textContent).toBe(HOLD_CUE);
    await stepTo(9);
    expect(underName()!.textContent).toBe(STRETCH_CUE);
  });

  it("a hold to max counts up past its target, shows the target, and Done logs the seconds held", async () => {
    await start(docBuild(), docView());
    await stepTo(8);
    expect(text()).toContain("Get ready");
    // A chime ends the get-ready and another marks the target; none past it (it ends on Done).
    expect(scheduled.at(-1)).toEqual([T0 + 8 * S, T0 + 48 * S]);
    await at(T0 + 38 * S);
    expect(text()).toContain("0:30");
    expect(text()).toContain("To max");
    expect(text()).toContain("Target 0:40");
    expect(document.querySelector(".player-ring-mark")).not.toBeNull();
    await at(T0 + 78 * S);
    // Still on the hold, 70 s held: counting up past the 40 s target.
    expect(text()).toContain("8 of 9");
    expect(text()).toContain("1:10");
    await click("Done");
    await until(() => text().includes("9 of 9"), "the next step");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await until(() => true, "flush");
    const stored = await readLive<{ live: { entries: Record<string, { sets: Array<{ secs: number | null; done: boolean }> }> } }>(db!, SLOT);
    expect(stored?.recorder.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 70 });
  });

  it("Space is Done on a hold to max (once the get-ready is over)", async () => {
    await start(docBuild(), docView());
    await stepTo(8);
    const hint = () => document.querySelector(".player-kbd")!.textContent!.replace(/\s+/g, " ");
    expect(hint()).toContain("Space Pause");
    await press(" ");
    expect(text()).toContain("Resume");
    await press(" ");
    await at(T0 + 30 * S);
    expect(hint()).toContain("Space Done");
    await press(" ");
    await until(() => text().includes("9 of 9"), "the next step");
  });

  it("⇄ lists the item's planned alternates first, with their why", async () => {
    await start(docBuild(), docView());
    await stepTo(3);
    await click("Swap");
    await until(() => !!document.querySelector('[role="dialog"]'), "the swap list");
    const first = document.querySelector('[role="dialog"] .choice-move');
    expect(first!.textContent).toContain("Supported split squat");
    expect(first!.textContent).toContain(PLANNED_WHY);
  });

  it("an engine build shows no cue and no target: its hold counts down as before", async () => {
    await start(build({ newMove: null }), view({ newMove: null }));
    await stepTo(3);
    expect(document.querySelector(".player-cue")).toBeNull();
    await stepTo(8);
    await at(T0 + 38 * S);
    expect(text()).toContain("0:10");
    expect(text()).not.toContain("Target");
    expect(document.querySelector(".player-ring-mark")).toBeNull();
  });
});
