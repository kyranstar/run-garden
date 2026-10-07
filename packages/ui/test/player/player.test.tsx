// @vitest-environment jsdom
/**
 * THE PLAYER SCREEN (Phase 2b Task 4; mocks §4; spec §2b "Player"), driven against IndexedDB (fake-indexeddb) with no
 * network: what Start stored is what plays.
 *
 *  - full screen, no tab bar; "N of M", the step's block and name; a hold's get-ready and countdown; a set's target;
 *    Done → the log card (weights typed as "25", "25 lb", "12kg"; steppers through the place's bells; the profile's
 *    flag) → Confirm → the rest (+15 s, Skip);
 *  - the keyboard: Space only when no control has focus, Enter confirms the log, Esc closes a panel and carries on;
 *  - Review Focus 1 on the screen: hidden for two minutes mid-hold, visible again → the step and time the clock says;
 *  - ✕ asks, Leave keeps the session, and opening it again resumes on the same step with the timer where it was.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@rg/api-client";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import { saveBuild } from "../../src/offline/builds.js";
import { readLive } from "../../src/offline/live.js";
import { saveExtras } from "../../src/player/stored.js";
import { PlayerScreen } from "../../src/screens/player.js";
import type { Chimes } from "../../src/player/audio.js";
import { build, flagLabel, profiles, SLOT, T0, view } from "./fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let db: OfflineDb | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
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

const noChimes: Chimes = { unlock: () => undefined, schedule: () => undefined, cancel: () => undefined };

async function storedStart(): Promise<OfflineDb> {
  db = await openOfflineDb(new IDBFactory());
  await saveBuild(db, { workoutId: SLOT, build: build(), view: view() } as unknown as SessionDto);
  await saveExtras(db, { workoutId: SLOT, title: "Program one", profiles: profiles(), savedAt: T0 });
  return db;
}

function mount(opts: { getSession?: () => Promise<SessionDto>; writeDelayMs?: number; noIndexedDb?: boolean } = {}) {
  const getSession = vi.fn(opts.getSession ?? (() => Promise.reject(new TypeError("Failed to fetch"))));
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const player = createElement(PlayerScreen, {
    workoutId: SLOT,
    deps: {
      db: () => (opts.noIndexedDb ? Promise.reject(new Error("IndexedDB is unavailable")) : Promise.resolve(db!)),
      getSession,
      chimes: noChimes,
      wake: () => () => undefined,
      ...(opts.writeDelayMs === undefined ? {} : { writeDelayMs: opts.writeDelayMs }),
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
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/session/:workoutId", element: player }),
            createElement(Route, { path: "/", element: createElement("p", null, "today screen") }),
          ),
        ),
      ),
    );
  });
  return { getSession };
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
const control = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>("button, a, input")].find((b) => {
    const t = (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim();
    return typeof name === "string" ? t === name : name.test(t);
  });
async function click(name: string | RegExp) {
  const b = control(name);
  if (!b) throw new Error(`no control ${String(name)}\n${text()}`);
  await act(async () => b.click());
}
async function press(key: string, target: EventTarget = document.body) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
async function at(ms: number) {
  vi.setSystemTime(ms);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const S = 1000;

/** Walk to the first set (two flow sides, then the goblet squat). */
async function toFirstSet() {
  await until(() => text().includes("1 of 9"), "the first step");
  await click("Skip");
  await click("Skip");
  await until(() => text().includes("3 of 9"), "the first set");
}

describe("what Start stored plays with the network off", () => {
  it("full screen, no tab bar: the step, its count, the get-ready and the next side — and the network is never asked", async () => {
    await storedStart();
    const { getSession } = mount();
    await until(() => text().includes("1 of 9"), "the first step");
    expect(text()).toContain("Low lunge");
    expect(text()).toContain("Left side");
    expect(text()).toContain("Get ready");
    expect(text()).toContain("0:03");
    expect(text()).toContain("Next · Right side");
    expect(control("Plan")).toBeUndefined();
    expect(getSession).not.toHaveBeenCalled();
    // The session is in IndexedDB from the first moment, with a performed id made on this device.
    const live = await readLive(db!, SLOT);
    expect(live?.performedId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the hold counts down from the wall clock after its get-ready", async () => {
    await storedStart();
    mount();
    await until(() => text().includes("1 of 9"), "the first step");
    await at(T0 + 13 * S);
    expect(text()).toContain("0:35");
    expect(text()).not.toContain("Get ready");
  });
});

describe("a set, the log card, the rest", () => {
  it("shows the target; Done opens the log card; a weight typed as 12kg is logged as typed; Confirm starts the rest", async () => {
    await storedStart();
    mount();
    await toFirstSet();
    expect(text()).toContain("Goblet squat");
    expect(text()).toContain("set 1 of 3");
    expect(text()).toContain("reps @ 30 lb");
    await click("Done");
    const weight = control("Weight") as HTMLInputElement;
    expect(weight.value).toBe("30 lb");
    await type(weight, "12kg");
    await click(flagLabel());
    expect(control(flagLabel())!.getAttribute("aria-pressed")).toBe("true");
    await click(/^Confirm · rest 75 s$/);
    await until(() => text().includes("4 of 9"), "the rest");
    expect(text()).toContain("Rest");
    expect(text()).toContain("1:15");
    const live = await readLive<{ live: { entries: Record<string, { sets: Array<{ w: unknown; reps: number }>; flags: string[] }> } }>(db!, SLOT);
    // The writer debounces 250 ms; leaving the page flushes it.
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await until(() => true, "flush");
    const stored = await readLive<{ live: { entries: Record<string, { sets: Array<{ w: unknown; reps: number }>; flags: string[] }> } }>(db!, SLOT);
    expect(stored?.recorder.live.entries.gobletSquat!.sets[0]!.w).toEqual({ v: 12, u: "kg" });
    expect(stored?.recorder.live.entries.gobletSquat!.flags.length).toBe(1);
    expect(live).toBeDefined();
  });

  it.each([
    ["25", { v: 25, u: "lb" }],
    ["25 lb", { v: 25, u: "lb" }],
    ["12kg", { v: 12, u: "kg" }],
  ])("the weight field takes %j", async (typed, want) => {
    await storedStart();
    mount();
    await toFirstSet();
    await click("Done");
    await type(control("Weight") as HTMLInputElement, typed);
    await click(/^Confirm/);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await until(() => true, "flush");
    const stored = await readLive<{ live: { entries: Record<string, { sets: Array<{ w: unknown }> }> } }>(db!, SLOT);
    expect(stored?.recorder.live.entries.gobletSquat!.sets[0]!.w).toEqual(want);
  });

  it("the steppers move through the place's bells and the reps by one", async () => {
    await storedStart();
    mount();
    await toFirstSet();
    await click("Done");
    await click("Heavier");
    expect((control("Weight") as HTMLInputElement).value).toBe("35 lb");
    await click("Heavier");
    expect((control("Weight") as HTMLInputElement).value).toBe("35 lb");
    await click("Lighter");
    await click("Lighter");
    expect((control("Weight") as HTMLInputElement).value).toBe("20 lb");
    await click("Fewer reps");
    expect((control("Reps") as HTMLInputElement).value).toBe("5");
  });

  it("a rest takes +15 s and Skip", async () => {
    await storedStart();
    mount();
    await toFirstSet();
    await click("Done");
    await click(/^Confirm/);
    await until(() => text().includes("4 of 9"), "the rest");
    await click("+15 s");
    expect(text()).toContain("1:30");
    await click("Skip");
    await until(() => text().includes("5 of 9"), "the next set");
  });
});

describe("⇄ mid-session", () => {
  it("Use plays the alternative; after it ⇄ offers the planned move back first (Task 5)", async () => {
    await storedStart();
    mount();
    await toFirstSet();
    await click("Swap");
    await until(() => !!document.querySelector('[role="dialog"]'), "the swap list");
    expect(text()).toContain("Supported split squat");
    // Every Use is a full-size button: 44px tall (styles.css `.choice-move > .btn`), never the 36px small one.
    const uses = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].filter((b) => b.textContent === "Use");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect([...u.classList]).toEqual(["btn"]);
    await click("Use");
    await until(() => !document.querySelector('[role="dialog"]'), "the list closed");
    expect(text()).toContain("Supported split squat");
    expect(text()).toContain("3 of 9");
    await click("Swap");
    await until(() => !!document.querySelector('[role="dialog"]'), "the swap list again");
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Goblet squat");
  });
});

describe("the keyboard", () => {
  it("Space is Done when nothing has focus — but not while a button has focus", async () => {
    await storedStart();
    mount();
    await toFirstSet();
    const swap = control("Swap")!;
    swap.focus();
    await press(" ", swap);
    expect(control("Weight")).toBeUndefined();
    swap.blur();
    await press(" ");
    expect(control("Weight")).toBeDefined();
  });

  it("Enter confirms the log card from its weight field", async () => {
    await storedStart();
    mount();
    await toFirstSet();
    await press(" ");
    const weight = control("Weight") as HTMLInputElement;
    await press("Enter", weight);
    await until(() => text().includes("4 of 9"), "the rest");
  });

  it("I opens the how-to and holds the countdown; Esc closes it and the countdown carries on", async () => {
    await storedStart();
    mount();
    await until(() => text().includes("1 of 9"), "the first step");
    await at(T0 + 13 * S);
    await press("i");
    await until(() => !!document.querySelector('[role="dialog"]'), "the how-to");
    await at(T0 + 73 * S);
    await press("Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // 10 s of the hold were gone when the how-to opened; the minute it was open does not count.
    expect(text()).toContain("0:35");
    await at(T0 + 78 * S);
    expect(text()).toContain("0:30");
  });

  it("→ and ← step", async () => {
    await storedStart();
    mount();
    await until(() => text().includes("1 of 9"), "the first step");
    await press("ArrowRight");
    expect(text()).toContain("2 of 9");
    await press("ArrowLeft");
    expect(text()).toContain("1 of 9");
  });
});

describe("Review Focus 1 on the screen — locked for two minutes mid-hold", () => {
  it("comes back on the step and the time the wall clock says", async () => {
    await storedStart();
    mount();
    await until(() => text().includes("1 of 9"), "the first step");
    // 10 s into the Left side's 45 s hold, the phone locks…
    await at(T0 + 13 * S);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // …and is unlocked 2 minutes later: Left ended at 48 s, Right (3 + 45 s) at 96 s; the set waits for Done.
    vi.setSystemTime(T0 + 133 * S);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(text()).toContain("3 of 9");
    expect(text()).toContain("Goblet squat");
  });
});

describe("what a tap changes is kept at once (ruling 2b-R13)", () => {
  type Stored = { live: { entries: Record<string, { sets: Array<{ w: unknown; done: boolean }> }>; reached: number[] } };

  it("a confirmed set is in IndexedDB straight away — no pagehide, no wait for the writer's debounce", async () => {
    await storedStart();
    // The writer would wait a minute: only a flush at the tap can have written what follows.
    mount({ writeDelayMs: 60_000 });
    await toFirstSet();
    await click("Done");
    await type(control("Weight") as HTMLInputElement, "40 lb");
    await click(/^Confirm/);
    await until(() => text().includes("4 of 9"), "the rest");
    // The tab is killed here: nothing more runs. What IndexedDB holds is what a relaunch resumes.
    let stored = await readLive<Stored>(db!, SLOT);
    for (let i = 0; i < 20 && stored?.stepIndex !== 3; i++) {
      await flush();
      stored = await readLive<Stored>(db!, SLOT);
    }
    expect(stored?.stepIndex).toBe(3);
    expect(stored?.recorder.live.entries.gobletSquat!.sets[0]).toMatchObject({ w: { v: 40, u: "lb" }, done: true });
  });

  it("so are Skip and a swap", async () => {
    await storedStart();
    mount({ writeDelayMs: 60_000 });
    await until(() => text().includes("1 of 9"), "the first step");
    await click("Skip");
    await until(async () => (await readLive(db!, SLOT))?.stepIndex === 1, "Skip kept at once");
    await click("Skip");
    await until(async () => (await readLive(db!, SLOT))?.stepIndex === 2, "the second Skip kept at once");
    await click("Swap");
    await until(() => !!document.querySelector('[role="dialog"]'), "the swap list");
    await click("Use");
    await until(async () => ((await readLive<{ swaps: unknown[] }>(db!, SLOT))?.recorder.swaps.length ?? 0) === 1, "the swap kept at once");
  });
});

describe("a device with no IndexedDB (audit 2b-B I-2)", () => {
  it("plays the session started online — and says from the first moment that it isn't being kept here", async () => {
    const started = { workoutId: SLOT, contentState: "started", build: build(), view: view(), profiles: profiles() } as unknown as SessionDto;
    mount({ noIndexedDb: true, getSession: async () => started });
    await until(() => text().includes("1 of 9"), "the first step");
    expect(text()).toContain("This session isn't being kept on this device.");
    // Nothing ever clears it: no write can land.
    await click("Skip");
    await at(T0 + 5 * S);
    expect(text()).toContain("This session isn't being kept on this device.");
  });
});

describe("keeping the session on the device", () => {
  it("when a write fails (storage full), the athlete is told; when one lands again, the warning goes", async () => {
    await storedStart();
    const real = db!;
    let full = true;
    db = {
      ...real,
      put: async (store: string, key: string, value: unknown) => {
        if (store === "live" && full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return real.put(store as never, key, value);
      },
    } as OfflineDb;
    mount();
    await until(() => text().includes("1 of 9"), "the first step");
    await click("Skip");
    // The writer waits 250 ms (real time) before it writes.
    for (let i = 0; i < 50 && !text().includes("isn't being kept on this device"); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
    }
    expect(text()).toContain("isn't being kept on this device");
    full = false;
    await click("Skip");
    await at(T0 + 1000);
    for (let i = 0; i < 40 && text().includes("isn't being kept"); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      await at(T0 + 1000 + i);
    }
    expect(text()).not.toContain("isn't being kept");
  });
});

describe("leave and come back", () => {
  it("✕ asks; Leave keeps the session; opening it again resumes on the same step with the timer where it was", async () => {
    await storedStart();
    mount();
    await until(() => text().includes("1 of 9"), "the first step");
    await at(T0 + 13 * S);
    await click("Leave the session");
    await until(() => !!control(/^Leave$/), "the question");
    await click(/^Leave$/);
    await until(() => text().includes("today screen"), "Today");
    const live = await readLive(db!, SLOT);
    expect(live).toMatchObject({ stepIndex: 0, paused: true });
    act(() => root!.unmount());
    // Ten minutes later, opened again: the same step, 35 s of the hold left, waiting to carry on.
    vi.setSystemTime(T0 + 613 * S);
    mount();
    await until(() => text().includes("1 of 9"), "the same step");
    expect(text()).toContain("0:35");
    expect(control("Resume")).toBeDefined();
  });
});
