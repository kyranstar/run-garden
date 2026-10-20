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
import type { Cue, CuePlayer } from "../../src/player/cue-player.js";
import { build, docBuild, docView, exercise, HOLD_CUE, maxBuild, PLANNED_WHY, profiles, SLOT, SQUAT_CUE, STRETCH_CUE, T0, view } from "./fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let db: OfflineDb | null = null;
let scheduled: Cue[][] = [];
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

const cues: CuePlayer = {
  unlock: () => undefined,
  schedule: (list) => void scheduled.push([...list]),
  cancel: () => undefined,
  configure: () => undefined,
  preview: () => undefined,
  running: () => false,
};

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
      cues,
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
  for (let presses = 0; !text().includes(`${n} of ${total}`); presses++) {
    // An arrow that never moves on fails here rather than pressing forever.
    if (presses >= 50) throw new Error(`ArrowRight did not reach step ${n} in 50 presses — it is not advancing`);
    await press("ArrowRight");
  }
}
/** What sits right under the move's name. */
const underName = () => document.querySelector("h1.player-name")?.nextElementSibling ?? null;
/** The cue, read where it sits: right after the summary under the name. */
const cueAfterSummary = () => {
  const next = underName()?.nextElementSibling ?? null;
  return next?.className === "player-cue" ? next.textContent : null;
};
/** The library's own summary of a move (never typed here). */
const summaryOf = (id: string) => exercise(id).text.summary;
/**
 * The footer's actions in order: each one's words, and whether it is the primary one. Every one is a 44px `.btn`. Back
 * (the step before, beside them on every step) is not one of the step's own.
 */
function actions(): Array<[string, boolean]> {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".player-actions button:not(.player-back)")];
  for (const b of buttons) expect(b.classList.contains("btn")).toBe(true);
  return buttons.map((b) => [b.textContent!.trim(), b.classList.contains("btn-primary")]);
}
/** The log card's title — the words inside the card that name it — or null when it has none. */
function cardTitle(): string | null {
  const card = document.querySelector(".player-log");
  const id = card?.getAttribute("aria-labelledby");
  const title = id ? card!.querySelector(`[id="${id}"]`) : null;
  return title?.textContent ?? null;
}
const S = 1000;

describe("a document workout's items, played", () => {
  it("an item's cue shows under the move's name, after its summary: the summary the how, the cue today's intent", async () => {
    await start(docBuild(), docView());
    // A move whose item has no cue shows none: its summary alone.
    expect(document.querySelector("h1.player-name")!.textContent).toMatch(/^Low lunge/);
    expect(document.querySelector(".player-cue")).toBeNull();
    expect(underName()!.textContent).toBe(summaryOf("lowLunge"));
    await stepTo(3);
    expect(document.querySelector("h1.player-name")!.textContent).toBe("Goblet squat");
    expect(underName()!.className).toBe("player-howto");
    expect(underName()!.textContent).toBe(summaryOf("gobletSquat"));
    expect(cueAfterSummary()).toBe(SQUAT_CUE);
    await stepTo(8);
    expect(document.querySelector("h1.player-name")!.textContent).toBe("Wall sit");
    expect(underName()!.textContent).toBe(summaryOf("wallSit"));
    expect(cueAfterSummary()).toBe(HOLD_CUE);
    await stepTo(9);
    expect(underName()!.textContent).toBe(summaryOf("reclinedButterfly"));
    expect(cueAfterSummary()).toBe(STRETCH_CUE);
  });

  it("a move with no summary keeps its cue right under its name", async () => {
    const b = docBuild();
    const squat = b.exercises.gobletSquat!;
    await start(docBuild({ exercises: { ...b.exercises, gobletSquat: { ...squat, text: { ...squat.text, summary: "" } } } }), docView());
    await stepTo(3);
    expect(document.querySelector(".player-howto")).toBeNull();
    expect(underName()!.className).toBe("player-cue");
    expect(underName()!.textContent).toBe(SQUAT_CUE);
  });

  it("a cue is said of its move: swapped for another, the slot shows none; swapped back, it shows again", async () => {
    await start(docBuild(), docView());
    await stepTo(3);
    await click("Swap");
    await until(() => !!document.querySelector('[role="dialog"]'), "the swap list");
    await click("Use");
    await until(() => document.querySelector("h1.player-name")!.textContent === "Supported split squat", "the alternate");
    expect(document.querySelector(".player-cue")).toBeNull();
    // The summary is the move's own: the alternate's now.
    expect(underName()!.textContent).toBe(summaryOf("splitSquat"));
    await click("Swap");
    await until(() => !!document.querySelector('[role="dialog"]'), "the swap list again");
    await click("Use");
    await until(() => document.querySelector("h1.player-name")!.textContent === "Goblet squat", "the planned move");
    expect(underName()!.textContent).toBe(summaryOf("gobletSquat"));
    expect(cueAfterSummary()).toBe(SQUAT_CUE);
  });

  it("a hold to max counts up past its target, shows the target, and Done logs the seconds held", async () => {
    await start(docBuild(), docView());
    await stepTo(8);
    expect(text()).toContain("Get ready");
    // The get-ready counts down into go, and a cue marks the target; none past it (it ends on Done).
    expect(scheduled.at(-1)).toEqual([
      { at: T0 + 5 * S, kind: "tick", n: 3 },
      { at: T0 + 6 * S, kind: "tick", n: 2 },
      { at: T0 + 7 * S, kind: "tick", n: 1 },
      { at: T0 + 8 * S, kind: "go" },
      { at: T0 + 48 * S, kind: "target" },
    ]);
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

  it("a tap on the stage never pauses a hold to max: the time held is the result, and a stray tap would understate it", async () => {
    await start(docBuild(), docView());
    await stepTo(8);
    await at(T0 + 38 * S);
    // Twice: the first tap after a load is audio's own (it unlocks, and pauses nothing); the second is a plain tap.
    for (let i = 0; i < 2; i++) {
      await act(async () => document.querySelector<HTMLElement>("h1.player-name")!.click());
      expect(text()).not.toContain("Paused");
    }
    expect(actions().at(-1)).toEqual(["Done", true]);
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

  it("a rest says the next move's summary under its Next line, and the hold to max after it says its own above its ring", async () => {
    await start(maxBuild(), docView());
    // The hold before the rest names the move after it: a rest is passed over.
    await stepTo(2);
    expect(document.querySelector(".player-next")!.textContent).toBe("Next · Wall sit");
    await stepTo(3);
    const next = document.querySelector(".player-next")!;
    expect(next.textContent).toMatch(/^Next · Wall sit/);
    expect(next.nextElementSibling?.className).toBe("player-howto");
    expect(next.nextElementSibling?.textContent).toBe(summaryOf("wallSit"));
    expect([...document.querySelectorAll(".player-howto")]).toHaveLength(1);
    await stepTo(4);
    await at(T0 + 20 * S);
    expect(document.querySelector(".player-ring-mark")).not.toBeNull();
    expect(underName()!.textContent).toBe(summaryOf("wallSit"));
    expect(underName()!.nextElementSibling?.className).toBe("player-ring");
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

  it("a hold to max paused, then Done: the rest offers Resume, and so does the set after it (Stage 2 minors)", async () => {
    await start(maxBuild(), docView());
    await stepTo(4);
    await at(T0 + 30 * S);
    await click("Pause");
    // Paused in its hold: Resume takes the primary place; Done is still there, and still logs.
    expect(actions()).toEqual([["Resume", true], ["Skip", false], ["Done", false]]);
    await click("Done");
    await until(() => text().includes("5 of 6"), "the rest");
    expect(document.querySelector(".player-big")!.textContent).toBe("0:30");
    expect(text()).toContain("Paused");
    expect(text()).toContain("Held 0:22");
    expect(actions()).toEqual([["Resume", true], ["−15 s", false], ["+15 s", false], ["Skip", false]]);
    await click("Skip");
    await until(() => text().includes("6 of 6"), "the set");
    expect(text()).toContain("Paused");
    expect(actions()).toEqual([["Resume", true], ["Done", false]]);
    await click("Resume");
    expect(text()).not.toContain("Paused");
    expect(actions()).toEqual([["Done", true]]);
    // Running again: the set counts up from the Resume, and the session's time from where it stopped.
    await at(T0 + 40 * S);
    expect(text()).toContain("0:10");
    expect(text()).toContain("0:40 elapsed");
  });

  it("the Edit card in a rest names what it edits: the move, its set, and the sides of a hold played a side at a time", async () => {
    await start(maxBuild(), docView());
    await at(T0 + 53 * S);
    await click("Done");
    await until(() => text().includes("2 of 6"), "the right side");
    await at(T0 + 94 * S);
    await click("Done");
    await until(() => text().includes("3 of 6"), "the rest");
    await click("Edit");
    // The library's name, as it is: "Low lunge · hands on front thigh".
    expect(cardTitle()).toBe(`${exercise("lowLunge").name} · set 1 · both sides`);
    await click("Confirm");
    await click("Skip");
    await until(() => text().includes("4 of 6"), "the wall sit");
    await at(T0 + 163 * S);
    await click("Done");
    await until(() => text().includes("5 of 6"), "the rest");
    await click("Edit");
    expect(cardTitle()).toBe("Wall sit · set 1");
    await click("Confirm");
    // A set's own card sits under the move's name: no title of its own.
    await click("Skip");
    await until(() => text().includes("6 of 6"), "the set");
    await click("Done");
    expect(document.querySelector(".player-log")).not.toBeNull();
    expect(cardTitle()).toBeNull();
  });

  it("a hold to max held on one side only: the Edit card names that side", async () => {
    await start(maxBuild(), docView());
    // The left side skipped (nothing logged), the right held 38 s.
    await click("Skip");
    await until(() => text().includes("2 of 6"), "the right side");
    await at(T0 + 41 * S);
    await click("Done");
    await until(() => text().includes("3 of 6"), "the rest");
    expect(text()).toContain("Held 0:38 right");
    await click("Edit");
    expect(cardTitle()).toBe(`${exercise("lowLunge").name} · set 1 · right side`);
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

  it("a hold to max left running and opened again half an hour later is back at its start, paused, with Resume (whole-branch M-4)", async () => {
    await start(maxBuild(), docView());
    await stepTo(4);
    await until(async () => (await readLive(db!, SLOT))?.stepIndex === 3, "the wall sit kept at once");
    // The app is killed on the wall sit; opened again 30 minutes later.
    act(() => root!.unmount());
    vi.setSystemTime(T0 + 1_800 * S);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const player = createElement(PlayerScreen, {
      workoutId: SLOT,
      deps: { db: () => Promise.resolve(db!), getSession: () => Promise.reject(new TypeError("Failed to fetch")), cues, wake: () => () => undefined },
    });
    root = createRoot(host!);
    act(() => {
      root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: [`/session/${SLOT}`] },
        createElement(Routes, null, createElement(Route, { path: "/session/:workoutId", element: player })))));
    });
    await until(() => text().includes("4 of 6"), "the wall sit again");
    expect(text()).toContain("Get ready");
    expect(text()).toContain("0:08");
    expect(text()).toContain("Paused");
    expect(control("Resume")!.classList.contains("btn-primary")).toBe(true);
    // Kept that way on the device.
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await until(async () => (await readLive(db!, SLOT))?.paused === true, "kept paused");
  });

  it("a set asked for a range of reps shows the range, and its log card starts at the low end (CUJ B1)", async () => {
    const b = docBuild();
    const range = { lo: 5, hi: 8, type: "reps" as const, reps: null, secs: null, w: null, note: "" };
    await start(docBuild({ steps: b.steps.map((s) => (s.kind === "set" && s.exerciseId === "gobletSquat" ? { ...s, target: range } : s)) as typeof b.steps }), docView());
    await stepTo(3);
    expect(document.querySelector("h1.player-name")!.textContent).toBe("Goblet squat");
    expect(document.querySelector(".player-big")!.textContent).toBe("5–8");
    await click("Done");
    expect((control("Reps") as HTMLInputElement).value).toBe("5");
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

describe("a document build names its parts as the Studio does (Stage 2 whole-branch review M2)", () => {
  it("the eyebrow says the step's part ('Main'), never the engine block's word", async () => {
    const b = docBuild();
    const first = b.steps[0]!.slotKey;
    const keys = [...new Set(b.steps.map((s) => s.slotKey))];
    await start(docBuild({ fromDoc: { ...b.fromDoc!, parts: [{ purpose: "main", keys: [first] }, { purpose: "cooldown", keys: keys.filter((k) => k !== first) }] } }), docView());
    const eyebrow = document.querySelector(".player-eyebrow")!.textContent!;
    expect(eyebrow.split(" · ")[0]).toBe("Main");
  });
});
