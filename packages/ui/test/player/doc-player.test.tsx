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
import { build, docBuild, docView, HOLD_CUE, maxBuild, PLANNED_WHY, profiles, SLOT, SQUAT_CUE, STRETCH_CUE, T0, view } from "./fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let db: OfflineDb | null = null;
let scheduled: number[][] = [];
/** How many steps the build started has. */
let total = 9;

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
  total = b.steps.length;
  await until(() => text().includes(`1 of ${total}`), "the first step");
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
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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
  while (!text().includes(`${n} of ${total}`)) await press("ArrowRight");
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

  it("a cue is said of its move: swapped for another, the slot shows none; swapped back, it shows again", async () => {
    await start(docBuild(), docView());
    await stepTo(3);
    await click("Swap");
    await until(() => !!document.querySelector('[role="dialog"]'), "the swap list");
    await click("Use");
    await until(() => document.querySelector("h1.player-name")!.textContent === "Supported split squat", "the alternate");
    expect(document.querySelector(".player-cue")).toBeNull();
    await click("Swap");
    await until(() => !!document.querySelector('[role="dialog"]'), "the swap list again");
    await click("Use");
    await until(() => document.querySelector("h1.player-name")!.textContent === "Goblet squat", "the planned move");
    expect(underName()!.textContent).toBe(SQUAT_CUE);
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
    // Short of the target: the session's time left, and the ring's mark is not where the fill starts.
    expect(text()).toContain("left");
    expect(text()).not.toContain("elapsed");
    const mark = document.querySelector(".player-ring-mark")!;
    expect(Number(mark.getAttribute("x1"))).toBeLessThan(40);
    // 30 s of a 40 s target: the fill is at 0.8 of the way to the mark, which sits 0.8 round.
    const fill = document.querySelector(".player-ring-fill")!.getAttribute("stroke-dasharray")!;
    expect(Number(fill.split(" ")[0])).toBeCloseTo(2 * Math.PI * 46 * 0.6, 1);
    await at(T0 + 78 * S);
    // Still on the hold, 70 s held: counting up past the 40 s target, 30 s past it; the session's time so far.
    expect(text()).toContain("8 of 9");
    expect(text()).toContain("1:10");
    expect(text()).toContain("+0:30");
    expect(text()).not.toContain("To max");
    expect(text()).toContain("1:18 elapsed");
    expect(text()).not.toContain(" left");
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

  it("Skip on a hold to max moves on and logs nothing of it", async () => {
    await start(docBuild(), docView());
    await stepTo(8);
    await at(T0 + 78 * S);
    await click("Skip");
    await until(() => text().includes("9 of 9"), "the next step");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await until(() => true, "flush");
    const stored = await readLive<{ live: { entries: Record<string, { sets: Array<{ secs: number | null; done: boolean }> }> } }>(db!, SLOT);
    expect(stored?.recorder.live.entries.wallSit!.sets[0]!.done).toBe(false);
  });

  it("after Done the rest says what was held — each side of a hold played a side at a time — and Edit fixes it", async () => {
    type Stored = { live: { entries: Record<string, { sets: Array<{ secs: number | null; done: boolean; sides?: Record<string, number> }> }> } };
    await start(maxBuild(), docView());
    await at(T0 + 53 * S);
    await click("Done");
    await until(() => text().includes("2 of 6"), "the right side");
    await at(T0 + 94 * S);
    await click("Done");
    await until(() => text().includes("3 of 6"), "the rest");
    expect(text()).toContain("Held 0:50 left · 0:38 right");
    await click("Edit");
    const right = control("Right seconds") as HTMLInputElement;
    expect((control("Left seconds") as HTMLInputElement).value).toBe("50");
    expect(right.value).toBe("38");
    await type(right, "40");
    await click("Confirm");
    expect(text()).toContain("Held 0:50 left · 0:40 right");
    expect(text()).toContain("3 of 6");
    // The wall sit: 61 s held of 40; the rest after it says so, and its seconds can be fixed.
    await click("Skip");
    await until(() => text().includes("4 of 6"), "the wall sit");
    await at(T0 + 163 * S);
    await click("Done");
    await until(() => text().includes("5 of 6"), "the rest");
    expect(text()).toContain("Held 1:01");
    await click("Edit");
    await type(control("Seconds") as HTMLInputElement, "58");
    await click("Confirm");
    expect(text()).toContain("Held 0:58");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await until(() => true, "flush");
    const stored = await readLive<Stored>(db!, SLOT);
    expect(stored?.recorder.live.entries.lowLunge!.sets[0]!.sides).toEqual({ left: 50, right: 40 });
    expect(stored?.recorder.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 58 });
  });

  it("an Edit card holds the clocks while it is open; Confirm writes to the hold, and the next step is neither touched nor skipped", async () => {
    type Stored = { live: { entries: Record<string, { sets: Array<{ secs: number | null; done: boolean; touched: boolean }> }> } };
    await start(maxBuild(), docView());
    await stepTo(4);
    await at(T0 + 69 * S);
    await click("Done");
    await until(() => text().includes("5 of 6"), "the rest after the wall sit");
    await click("Edit");
    // Well past the rest's 30 s with the card open: still the rest, its time held, card and Confirm in reach.
    await at(T0 + 150 * S);
    expect(text()).toContain("5 of 6");
    expect(text()).toContain("0:30");
    await type(control("Seconds") as HTMLInputElement, "58");
    await click("Confirm");
    // Closed: the rest carries on from now — its 30 s, then the next step.
    await at(T0 + 151 * S);
    expect(text()).toContain("5 of 6");
    await at(T0 + 180 * S);
    await until(() => text().includes("6 of 6"), "the next step");
    expect(text()).toContain("Reclined butterfly");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await until(() => true, "flush");
    const stored = await readLive<Stored>(db!, SLOT);
    expect(stored?.recorder.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 58 });
    expect(stored?.recorder.live.entries.reclinedButterfly!.sets[0]).toMatchObject({ secs: null, touched: false });
  });

  it("an Edit card opened in a session already paused leaves it paused when it closes", async () => {
    await start(maxBuild(), docView());
    await stepTo(4);
    await at(T0 + 30 * S);
    await click("Pause");
    expect(text()).toContain("Resume");
    // Done while paused: the rest after it starts paused too.
    await click("Done");
    await until(() => text().includes("5 of 6"), "the rest");
    expect(text()).toContain("Paused");
    await click("Edit");
    await click("Confirm");
    await at(T0 + 60 * S);
    expect(text()).toContain("Paused");
    expect(text()).toContain("0:30");
  });

  it("a card held past the rest's end never plays its overrun into the next step: the hold after arrives at its get-ready", async () => {
    type Stored = { live: { entries: Record<string, { sets: Array<{ secs: number | null; done: boolean }> }> } };
    await start(maxBuild(), docView());
    await at(T0 + 53 * S);
    await click("Done");
    await until(() => text().includes("2 of 6"), "the right side");
    await at(T0 + 94 * S);
    await click("Done");
    await until(() => text().includes("3 of 6"), "the rest");
    // A second of the rest left; the card open 20 s past its end.
    await at(T0 + 123 * S);
    await click("Edit");
    await at(T0 + 144 * S);
    await click("Confirm");
    await at(T0 + 145 * S);
    await until(() => text().includes("4 of 6"), "the wall sit");
    expect(text()).toContain("Get ready");
    // Done just after its get-ready: a second held, never the 20 s the card was open.
    await at(T0 + 154 * S);
    await click("Done");
    await until(() => text().includes("5 of 6"), "the rest after");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await until(() => true, "flush");
    const stored = await readLive<Stored>(db!, SLOT);
    expect(stored?.recorder.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 1 });
  });

  it("a timed move to max with no target counts up from its start, and Done's card holds the seconds counted", async () => {
    await start(maxBuild(), docView());
    await stepTo(6);
    expect(text()).toContain("To max");
    await at(T0 + 95 * S);
    expect(text()).toContain("1:35");
    expect(text()).toContain("elapsed");
    await click("Done");
    expect((control("Seconds") as HTMLInputElement).value).toBe("95");
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
