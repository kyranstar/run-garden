// @vitest-environment jsdom
/**
 * R11: a quick start started offline plays from the build made on the device, under its provisional id, exactly as a
 * session the server built: the player never asks the server for it (there is nothing there yet), and Save puts it in
 * the outbox — which records the workout (once, played offline) and then the session onto it, the before-reading as
 * the session's own `pre` check. Discard keeps nothing and sends nothing.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateDocWorkoutRequest, SessionDto } from "@rg/api-client";
import { workoutDocSchema, type PerformedSessionWire } from "@rg/domain";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import { saveBuild } from "../../src/offline/builds.js";
import { loadLocalStart, localIdOf, rememberLocalStart } from "../../src/offline/local-starts.js";
import { drain, outboxEntries } from "../../src/offline/outbox.js";
import { localBuild } from "../../src/player/local-build.js";
import { saveExtras } from "../../src/player/stored.js";
import { PlayerScreen } from "../../src/screens/player.js";
import type { Chimes } from "../../src/player/audio.js";
import { profiles, T0, TODAY } from "./fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLIENT = "c0ffee00-0000-4000-8000-000000000002";
const LOCAL = localIdOf(CLIENT);
const ME = "user-1";

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

const doc = workoutDocSchema.parse({
  version: 1,
  title: "Desk reset",
  intent: { summary: "Undo the desk.", goals: ["posture"], focus: [], effort: "maintain" },
  parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 12, restSec: 30 }, cue: "Squeeze at the top." }] }],
  source: { kind: "studio", ref: "quick_start:desk_reset" },
});

/** What the builder leaves on the device at an offline Start: the build, the player's extras, the start. */
async function startedOffline(): Promise<void> {
  db = await openOfflineDb(new IDBFactory());
  const { build, view } = localBuild(doc, { localId: LOCAL, date: TODAY, checks: { tmj: { pre: 2, feelingOff: false } }, location: { id: "home", name: "Home", equipment: [] }, now: T0 });
  await saveBuild(db, { workoutId: LOCAL, build, view } as unknown as SessionDto);
  await saveExtras(db, { workoutId: LOCAL, title: "Desk reset", profiles: profiles(), userId: ME, savedAt: T0 });
  await rememberLocalStart(db, { localId: LOCAL, clientId: CLIENT, userId: ME, kind: "quick_start:desk_reset", title: "Desk reset", doc, date: TODAY, time: "18:00", createdAt: T0 });
}

function mount(opts: { online?: boolean } = {}) {
  const getSession = vi.fn(offline);
  const reviewBasis = vi.fn(offline);
  const unstartSession = vi.fn(offline);
  const savePerformed = vi.fn(opts.online ? async () => ({ status: "saved" }) : offline);
  const createWorkout = vi.fn(opts.online ? async (_b: CreateDocWorkoutRequest) => ({ workout: { id: "w-server" } }) : offline);
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const player = createElement(PlayerScreen, {
    workoutId: LOCAL,
    deps: { db: () => Promise.resolve(db!), getSession, reviewBasis, savePerformed, createWorkout, unstartSession, whoAmI: async () => null, chimes: noChimes, wake: () => () => undefined, saveWaitMs: 2000 },
  });
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          { initialEntries: [`/session/${encodeURIComponent(LOCAL)}`] },
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
  return { getSession, reviewBasis, savePerformed, createWorkout, unstartSession };
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
const control = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("button, a, input, textarea")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim() === name);
async function click(name: string) {
  const b = control(name);
  if (!b) throw new Error(`no control ${name}\n${text()}`);
  await act(async () => b.click());
}

/** The first set played, then ✕ → End and review. */
async function playAndReview(): Promise<void> {
  await until(() => text().includes("1 of 3"), "the first step");
  // The item's cue, as the server's build shows it.
  expect(text()).toContain("Squeeze at the top.");
  vi.setSystemTime(T0 + 60_000);
  await click("Done");
  await until(() => !!control("Leave the session"), "the next step");
  await click("Leave the session");
  await click("End and review");
  await until(() => !!control("Save"), "the review");
}

describe("a quick start started offline, in the player (R11)", () => {
  it("plays from the device and never asks the server for it; Save, online, records the workout once and the session onto it", async () => {
    await startedOffline();
    const { getSession, reviewBasis, savePerformed, createWorkout } = mount({ online: true });
    await playAndReview();
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    expect(getSession).not.toHaveBeenCalled();
    expect(reviewBasis).not.toHaveBeenCalled();
    expect(createWorkout.mock.calls.map((c) => c[0])).toEqual([{ date: TODAY, time: "18:00", doc, clientId: CLIENT, startNow: true, playedOffline: true }]);
    expect(savePerformed).toHaveBeenCalledTimes(1);
    const sent = savePerformed.mock.calls[0]![1] as unknown as PerformedSessionWire;
    expect(sent).toMatchObject({ workoutId: "w-server", buildId: null, localDate: TODAY, source: "app" });
    // The before-reading answered at Start: the session's own `pre` check — no check-in of its own.
    expect(sent.checks.filter((c) => c.kind === "pre")).toEqual([expect.objectContaining({ profileId: "tmj", value: 2 })]);
    expect(await outboxEntries(db!)).toEqual([]);
    expect(await loadLocalStart(db!, LOCAL)).toBeUndefined();
  });

  it("Save offline waits in the outbox under the provisional id; back online, the outbox records it", async () => {
    await startedOffline();
    const { savePerformed } = mount();
    await playAndReview();
    await click("Save");
    await until(() => text().includes("today screen"), "Today");
    const [waiting] = await outboxEntries(db!);
    expect(waiting).toMatchObject({ userId: ME, state: "pending", payload: { workoutId: LOCAL } });
    expect(savePerformed).not.toHaveBeenCalled();
    const saves: PerformedSessionWire[] = [];
    const result = await drain(db!, { savePerformed: async (_id, p) => void saves.push(p), createWorkout: async () => ({ workout: { id: "w-server" } }) }, { userId: ME });
    expect(result).toMatchObject({ saved: 1, failed: 0 });
    expect(saves.map((s) => [s.workoutId, s.buildId])).toEqual([["w-server", null]]);
  });

  it("Discard keeps nothing and asks the server nothing", async () => {
    await startedOffline();
    const { unstartSession, createWorkout, savePerformed } = mount({ online: true });
    await playAndReview();
    await click("Discard");
    await click("Discard session");
    await until(() => text().includes("today screen"), "Today");
    expect(unstartSession).not.toHaveBeenCalled();
    expect(createWorkout).not.toHaveBeenCalled();
    expect(savePerformed).not.toHaveBeenCalled();
    expect(await loadLocalStart(db!, LOCAL)).toBeUndefined();
  });
});
