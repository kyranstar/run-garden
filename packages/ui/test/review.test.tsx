// @vitest-environment jsdom
/**
 * THE REVIEW (Phase 2b Task 7; mocks §5; spec §2b "Review and save"), after the player's last step or "End and review":
 * the post-check, each move's done sets (editable), 👍 / 👎 / not-for-me, graduation offers, records, a note, Save and
 * Discard. Nothing is decided until Save (the engine's pending change set); Save puts the session in the outbox and
 * goes back to Today; Discard keeps nothing — the slot keeps its build and is not done (Review Focus 5).
 *
 * Offline throughout: IndexedDB is fake-indexeddb; the network is never asked (the outbox's drain is handed an api
 * that fails like a dropped connection, unless a test says otherwise).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewBasisDto, SessionBuildDto, SessionDto } from "@rg/api-client";
import { EXERCISES, makeEngineData } from "@rg/exercise-library";
import { historyFromPerformed, Records, type Step } from "@rg/session-engine";
import { performedSessionSaveSchema } from "@rg/domain";
import { openOfflineDb, type OfflineDb } from "../src/offline/idb.js";
import { loadBuild, saveBuild } from "../src/offline/builds.js";
import { readLive } from "../src/offline/live.js";
import { outboxEntries } from "../src/offline/outbox.js";
import { saveBasis, saveExtras } from "../src/player/stored.js";
import { PlayerScreen } from "../src/screens/player.js";
import type { Chimes } from "../src/player/audio.js";
import { build, exercise, flagLabel, profiles, SLOT, T0, TODAY, view } from "./player/fixtures.js";

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
});

const noChimes: Chimes = { unlock: () => undefined, schedule: () => undefined, cancel: () => undefined };
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

async function stored(opts: { build?: SessionBuildDto; basis?: ReviewBasisDto | null } = {}) {
  db = await openOfflineDb(new IDBFactory());
  await saveBuild(db, { workoutId: SLOT, build: opts.build ?? build(), view: view() } as unknown as SessionDto);
  await saveExtras(db, { workoutId: SLOT, title: "Program one", profiles: profiles(), savedAt: T0 });
  if (opts.basis) await saveBasis(db, SLOT, opts.basis);
}

function mount(opts: { savePerformed?: (id: string, p: unknown) => Promise<unknown> } = {}) {
  const getSession = vi.fn(offline);
  const savePerformed = vi.fn(opts.savePerformed ?? offline);
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const player = createElement(PlayerScreen, {
    workoutId: SLOT,
    deps: { db: () => Promise.resolve(db!), getSession, reviewBasis: vi.fn(offline), savePerformed, chimes: noChimes, wake: () => () => undefined },
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
  return { getSession, savePerformed };
}

const flush = () => act(async () => void (await new Promise((r) => setImmediate(r))));
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await flush();
  }
  throw new Error(`timed out waiting for: ${what}\n${text()}`);
}
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
const controls = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>("button, a, input, textarea")].filter((b) => {
    const t = (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim();
    return typeof name === "string" ? t === name : name.test(t);
  });
const control = (name: string | RegExp) => controls(name)[0];
async function click(name: string | RegExp, el?: HTMLElement) {
  const b = el ?? control(name);
  if (!b) throw new Error(`no control ${String(name)}\n${text()}`);
  await act(async () => b.click());
}
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const S = 1000;

/** Two steps played (the flow's two sides, 45 s each), then ✕ → End and review. */
async function abandonAfterTwoSteps() {
  await until(() => text().includes("1 of 9"), "the first step");
  vi.setSystemTime(T0 + 48 * S);
  await click("Skip");
  vi.setSystemTime(T0 + 96 * S);
  await click("Skip");
  await until(() => text().includes("3 of 9"), "the third step");
  await click("Leave the session");
  await click("End and review");
  await until(() => !!control("Save"), "the review");
}

/** The whole fixture played: the flow, three goblet squat sets (one logged at 35 lb, with the flag), the holds. */
async function playThrough() {
  await until(() => text().includes("1 of 9"), "the first step");
  await click("Skip");
  await click("Skip");
  await click("Done");
  await type(control("Weight") as HTMLInputElement, "35 lb");
  await click(flagLabel());
  await click(/^Confirm/);
  for (let i = 0; i < 4; i++) {
    const done = control("Done");
    if (done) {
      await click("Done");
      await click(/^Confirm/);
    } else await click("Skip");
  }
  // The new move's how-to opens once and holds the countdown.
  if (document.querySelector('[role="dialog"]')) await click("Close");
  await click("Skip");
  await click("Skip");
  await until(() => !!control("Save"), "the review");
}

const entry = async () => {
  const all = await outboxEntries(db!);
  expect(all).toHaveLength(1);
  return all[0]!;
};

describe("Review Focus 5 — a session abandoned after two steps", () => {
  it("Save saves it partial: completed false, the steps done, to the outbox — and Today next", async () => {
    await stored();
    const { getSession } = mount();
    await abandonAfterTwoSteps();
    expect(control("Discard")).toBeDefined();
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    const e = await entry();
    expect(e.payload).toMatchObject({ workoutId: SLOT, buildId: "build-1", completed: false, stepsDone: 2, stepsTotal: 7, source: "app" });
    expect(e.payload.movesDone.map((m) => m.exerciseId)).toEqual(["lowLunge"]);
    expect(await readLive(db!, SLOT)).toBeUndefined();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("Discard keeps nothing: no outbox entry, no session in progress, nothing sent — and the slot keeps its build, not done", async () => {
    await stored();
    const { getSession, savePerformed } = mount();
    await abandonAfterTwoSteps();
    await click("Discard");
    await until(() => !!control("Discard session"), "the question");
    await click("Discard session");
    await until(() => text().includes("today screen"), "Today");
    expect(await outboxEntries(db!)).toEqual([]);
    expect(await readLive(db!, SLOT)).toBeUndefined();
    expect(savePerformed).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    // Still startable on this device, offline: Continue plays a fresh session from the same locked build.
    expect((await loadBuild(db!, SLOT))?.build.buildId).toBe("build-1");
  });
});

describe("the end of the session is kept at once", () => {
  it("reaching the review is written straight away, not 250 ms later — a reload right after finds the review", async () => {
    await stored();
    mount();
    await abandonAfterTwoSteps();
    // No pagehide, no wait for the debounce: what IndexedDB holds already says the session is over.
    const live = await readLive<{ finished: boolean }>(db!, SLOT);
    expect(live?.recorder.finished).toBe(true);
  });
});

describe("a session saved here and not yet synced", () => {
  it("is never played a second time: opening the player again says it is saved, and starts nothing", async () => {
    await stored();
    mount();
    await abandonAfterTwoSteps();
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    act(() => root!.unmount());
    // Online again, the server still says started (the outbox has not reached it): the player must not begin anew.
    host?.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const getSession = vi.fn(async () => ({ workoutId: SLOT, contentState: "started", build: build(), view: view(), profiles: profiles() }) as unknown as SessionDto);
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
              createElement(Route, {
                path: "/session/:workoutId",
                element: createElement(PlayerScreen, {
                  workoutId: SLOT,
                  deps: { db: () => Promise.resolve(db!), getSession, reviewBasis: vi.fn(offline), savePerformed: vi.fn(offline), chimes: noChimes, wake: () => () => undefined },
                }),
              }),
            ),
          ),
        ),
      );
    });
    await until(() => text().includes("This session is saved."), "the saved notice");
    expect(await readLive(db!, SLOT)).toBeUndefined();
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe("the review's own decisions, applied only on Save", () => {
  it("the post-check, ratings, not-for-me and the note land in the payload; nothing is sent before Save", async () => {
    await stored({
      basis: { workoutId: SLOT, buildId: "build-1", records: Records.baseline(makeEngineData({ activeProfiles: ["tmj"], careProfiles: [], exercises: EXERCISES }), [], { ids: [], date: TODAY }), graduation: { block: null, sessions: [], unit: "lb" }, prefs: { ratings: { wallSit: -1 }, excluded: [] }, exercises: {} },
    });
    const { savePerformed } = mount();
    await playThrough();
    // The profile's own words: "<label> now", and the reading before.
    expect(text()).toContain(`${profiles()[0]!.check.label} now`);
    expect(text()).toContain("Before 1");
    await click("0", controls("0").find((b) => b.getAttribute("role") === "radio"));
    await click("👍 Goblet squat");
    await click("Edit Goblet squat");
    await click("Not for me · Goblet squat");
    // 👎 was saved for the wall sit: it shows pressed, and pressing it again clears it.
    expect(control("👎 Wall sit")!.getAttribute("aria-pressed")).toBe("true");
    await click("👎 Wall sit");
    await type(control("Note") as HTMLTextAreaElement, "Felt good");
    expect(savePerformed).not.toHaveBeenCalled();
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    const e = await entry();
    expect(e.payload.completed).toBe(true);
    expect(e.payload.note).toBe("Felt good");
    expect(e.payload.checks).toEqual([
      { profileId: "tmj", kind: "pre", value: 1, feelingOff: false, at: new Date(T0).toISOString() },
      expect.objectContaining({ profileId: "tmj", kind: "post", value: 0, feelingOff: false }),
    ]);
    expect(e.payload.review).toEqual({ ratings: { gobletSquat: 1, wallSit: null }, excluded: { gobletSquat: true }, graduations: [] });
    expect(e.payload.entries.find((x) => x.exerciseId === "gobletSquat")!.sets[0]).toMatchObject({ load: { v: 35, u: "lb" }, flags: ["clenched"] });
  });

  it("each move's done sets are editable with the same steppers; a set can be taken out", async () => {
    await stored();
    mount();
    await playThrough();
    expect(text()).toContain("35 lb × 6 · 35 lb × 6 · 35 lb × 6");
    await click("Edit Goblet squat");
    const weights = controls("Weight") as HTMLInputElement[];
    expect(weights.map((w) => w.value)).toEqual(["35 lb", "35 lb", "35 lb"]);
    await type(weights[2]!, "40 lb");
    // The second set's "Done" taken off.
    await click("Done", controls("Done")[1]);
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    const sets = (await entry()).payload.entries.find((x) => x.exerciseId === "gobletSquat")!.sets;
    expect(sets.map((s) => s.load)).toEqual([{ v: 35, u: "lb" }, { v: 40, u: "lb" }]);
  });

  it("records: the session's new best and first times, folded onto the history kept at Start", async () => {
    const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: [], exercises: EXERCISES });
    const before = historyFromPerformed(
      performedSessionSaveSchema.parse({
        id: "earlier", source: "app", sourceRef: null, workoutId: "w0", buildId: "b0", localDate: "2026-10-01",
        startedAt: "2026-10-01T18:00:00.000Z", endedAt: "2026-10-01T18:30:00.000Z", seconds: 1800, plannedSeconds: 1800, minutes: 30,
        mode: "consistent", theme: null, locationId: "home", blockRef: null, blockNumber: 1, completed: true, stepsTotal: 3, stepsDone: 3,
        movesDone: [{ exerciseId: "gobletSquat", seconds: 300 }, { exerciseId: "lowLunge", seconds: 90 }], note: null, newMove: null,
        entries: [{ exerciseId: "gobletSquat", implement: "kettlebell", format: "straight", perSide: false, sets: [{ setIndex: 0, reps: 6, seconds: null, load: { v: 30, u: "lb" } }] }],
        checks: [],
      }),
    );
    const ids = Object.keys(build().exercises);
    await stored({
      basis: { workoutId: SLOT, buildId: "build-1", records: Records.baseline(data, [before], { ids, date: TODAY, weeklyGoal: 2 }), graduation: { block: null, sessions: [], unit: "lb" }, prefs: { ratings: {}, excluded: [] }, exercises: {} },
    });
    mount();
    await playThrough();
    expect(text()).toContain("New best: Goblet squat 35 lb × 6");
    // The cool-down's move was reached (unlogged moves count when reached); the skipped wall sit was not done.
    expect(text()).toContain("First time: Reclined butterfly");
    expect(text()).not.toContain("First time: Wall sit");
    expect(text()).not.toContain("First time: Goblet squat");
  });

  it("without the basis (Start went offline at once) the review still saves; it shows no records", async () => {
    await stored();
    mount();
    await playThrough();
    expect(text()).not.toContain("New best");
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    await entry();
  });
});

describe("graduation offers", () => {
  const S2 = (i: number): Step => ({
    kind: "set", slotKey: "core:0", block: "core", exerciseId: "deadlift", side: null, setIndex: i, setCount: 2, seconds: 40, prepGap: 0,
    target: { lo: 6, hi: 10, type: "reps", w: { v: 35, u: "lb" }, reps: 10, secs: null, graduate: null, last: null, lastDate: null, action: "hold", note: "" },
    format: { id: "straight", group: null, round: null }, why: [], isNew: false, log: true,
  });
  const liftBuild = () =>
    build({
      steps: [S2(0), S2(1)],
      plannedSeconds: 80,
      items: [{ slotKey: "core:0", block: "core", exerciseId: "deadlift", format: "straight", sets: 2, group: null, coreFamily: "hinge", isNew: false, why: [] }],
      exercises: { deadlift: exercise("deadlift") },
      alternatives: {},
      targets: {},
      newMove: null,
    });
  const basis = (): ReviewBasisDto => ({
    workoutId: SLOT, buildId: "build-1",
    records: Records.baseline(makeEngineData({ activeProfiles: ["tmj"], careProfiles: [], exercises: EXERCISES }), [], { ids: ["deadlift"], date: TODAY }),
    graduation: { block: { id: "block-1", number: 1, startedAt: "2026-10-01", weeks: 5, core: { hinge: "deadlift" }, rotations: [] }, sessions: [], unit: "lb" },
    prefs: { ratings: {}, excluded: [] },
    exercises: { rdl: exercise("rdl") },
  });

  async function playLifts() {
    await until(() => text().includes("1 of 2"), "the first set");
    await click("Done");
    await click(/^Confirm/);
    await click("Done");
    await click(/^Confirm/);
    await until(() => !!control("Save"), "the review");
  }

  it("a lift topped out at the heaviest bell offers the harder move; Switch saves it, Not yet does not", async () => {
    await stored({ build: liftBuild(), basis: basis() });
    mount();
    await playLifts();
    expect(text()).toContain("Deadlift is topped out");
    expect(text()).toContain("Switch the block to Romanian deadlift?");
    await click("Switch");
    expect(control("Switch")!.getAttribute("aria-pressed")).toBe("true");
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    expect((await entry()).payload.review.graduations).toEqual([{ family: "hinge", to: "rdl" }]);
  });

  it("Not yet: nothing changes on Save", async () => {
    await stored({ build: liftBuild(), basis: basis() });
    mount();
    await playLifts();
    await click("Switch");
    await click("Not yet");
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    expect((await entry()).payload.review.graduations).toEqual([]);
  });
});

describe("saved while online", () => {
  it("Save sends it at once and the outbox is empty after", async () => {
    await stored();
    const { savePerformed } = mount({ savePerformed: async () => ({ status: "saved" }) });
    await abandonAfterTwoSteps();
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    await until(async () => (await outboxEntries(db!)).length === 0, "the outbox drained");
    expect(savePerformed).toHaveBeenCalledTimes(1);
  });
});
