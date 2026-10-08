// @vitest-environment jsdom
/**
 * ONE SLOT, TWO DEVICES (ruling 2b-R18; re-review 2b-B N-3). The same started session open on two phones of one
 * account: whichever saves first is the slot's session; the other is never offered Continue for it, and its own save —
 * waiting in its outbox — becomes a conflict ("Saved on another device", Discard only), never a second performed
 * session for the slot.
 *
 * Each device is its own IndexedDB (fake-indexeddb) and plays through the real player, review, outbox, Today line and
 * Settings → Data. The server is a double that answers as the worker's save does (apps/worker/test/session-save.test.ts,
 * "a slot holds one app session"): the first app session of a slot is saved and the slot is done; the same session
 * again is `same_payload`; another session of that slot is 409 `slot_done`.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type SessionDto } from "@rg/api-client";
import { canonicalJson, type PerformedSessionWire } from "@rg/domain";
import { loadBuild, saveBuild } from "../src/offline/builds.js";
import { openOfflineDb, type OfflineDb } from "../src/offline/idb.js";
import { readLive } from "../src/offline/live.js";
import { drain, outboxEntries } from "../src/offline/outbox.js";
import { queuedUnstarts } from "../src/offline/unstarts.js";
import { saveExtras } from "../src/player/stored.js";
import type { Chimes } from "../src/player/audio.js";
import { PlayerScreen } from "../src/screens/player.js";
import { SessionsInProgress } from "../src/components/sessions-in-progress.js";
import { UnsyncedSessions } from "../src/components/unsynced-sessions.js";
import { build, profiles, SLOT, T0, view } from "./player/fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = "user-1";
const TOMORROW = "2026-10-09";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const opened: OfflineDb[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  unmount();
  for (const d of opened.splice(0)) d.close();
  vi.useRealTimers();
});

/** The server, as the worker's save answers (one app session per slot, ruling 2b-R18). */
function server() {
  const saved = new Map<string, { workoutId: string | null; body: string }>();
  let state: SessionDto["contentState"] = "started";
  const unstartSession = vi.fn(async () => {
    if (saved.size > 0) throw new ApiError(409, { error: "performed" });
    state = "built";
    return {};
  });
  return {
    sessions: () => [...saved.keys()],
    slotState: async (workoutId: string) => {
      expect(workoutId).toBe(SLOT);
      return state;
    },
    savePerformed: vi.fn(async (performedId: string, payload: PerformedSessionWire) => {
      const body = canonicalJson(payload);
      const prior = saved.get(performedId);
      if (prior) {
        if (prior.body === body) return { status: "same_payload" };
        throw new ApiError(409, { error: "conflict" });
      }
      if ([...saved.values()].some((s) => s.workoutId === payload.workoutId)) throw new ApiError(409, { error: "slot_done" });
      saved.set(performedId, { workoutId: payload.workoutId, body });
      state = "done";
      return { status: "saved", performedId, activityId: performedId, matched: true, notes: [] };
    }),
    unstartSession,
  };
}
type Server = ReturnType<typeof server>;

/** A phone that started the session (Start left the build and its extras on it). */
async function device(): Promise<OfflineDb> {
  const d = await openOfflineDb(new IDBFactory());
  opened.push(d);
  await saveBuild(d, { workoutId: SLOT, build: build(), view: view() } as unknown as SessionDto);
  await saveExtras(d, { workoutId: SLOT, title: "Program one", profiles: profiles(), userId: ME, savedAt: T0 });
  return d;
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const noChimes: Chimes = { unlock: () => undefined, schedule: () => undefined, cancel: () => undefined };

function render(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
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
            createElement(Route, { path: "/session/:workoutId", element: el }),
            createElement(Route, { path: "/", element: createElement("p", null, "today screen") }),
          ),
        ),
      ),
    ),
  );
}
function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

/** The player on `d`, talking to `api` (or to no network at all). */
function player(d: OfflineDb, api: { savePerformed: Server["savePerformed"] | typeof offline; unstartSession?: Server["unstartSession"] }) {
  render(
    createElement(PlayerScreen, {
      workoutId: SLOT,
      deps: {
        db: () => Promise.resolve(d),
        getSession: vi.fn(offline),
        reviewBasis: vi.fn(offline),
        savePerformed: api.savePerformed,
        unstartSession: api.unstartSession ?? vi.fn(offline),
        whoAmI: async () => ME,
        chimes: noChimes,
        wake: () => () => undefined,
        saveWaitMs: 50,
      },
    }),
  );
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
const control = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLElement>("button, a")].find((b) => {
    const t = (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim();
    return typeof name === "string" ? t === name : name.test(t);
  });
async function click(name: string | RegExp) {
  const b = control(name);
  if (!b) throw new Error(`no control ${String(name)}\n${text()}`);
  await act(async () => b.click());
}

/** Two steps played (both sides of the flow held), then ✕ → End and review → Save, and back to Today. */
async function playAndSave() {
  await until(() => text().includes("1 of 9"), "the first step");
  vi.setSystemTime(T0 + 48_000);
  await click("Skip");
  vi.setSystemTime(T0 + 96_000);
  await click("Skip");
  await click("Leave the session");
  await click("End and review");
  await until(() => !!control("Save"), "the review");
  await click("Save");
  await until(() => text().includes("today screen"), "Today");
  unmount();
}

/** Two steps played, then ✕ → Leave: the session stays in progress on the device. */
async function playAndLeave() {
  await until(() => text().includes("1 of 9"), "the first step");
  await click("Skip");
  await click("Skip");
  await until(() => text().includes("3 of 9"), "the third step");
  await click("Leave the session");
  await click("Leave");
  await until(() => text().includes("today screen"), "Today");
  unmount();
}

describe("one slot played on two devices (ruling 2b-R18)", () => {
  it("left in progress on B, saved on A: B's Today never offers Continue — Discard only, which touches nothing on the server", async () => {
    const srv = server();
    const [a, b] = [await device(), await device()];
    // B starts playing first and puts the phone away; A plays the session through and saves it, online.
    player(b, { savePerformed: offline });
    await playAndLeave();
    expect(await readLive(b, SLOT)).toBeDefined();
    player(a, srv);
    await playAndSave();
    expect(srv.sessions()).toHaveLength(1);
    expect(await outboxEntries(a)).toEqual([]);

    // The next day, B's Today: the session in progress there is one the server has as done.
    vi.setSystemTime(Date.parse(`${TOMORROW}T08:00:00Z`));
    render(createElement(SessionsInProgress, { today: TOMORROW, shown: [], userId: ME, db: () => Promise.resolve(b), slotState: srv.slotState }));
    await until(() => text().includes("Saved on another device"), "B's line");
    expect(control("Continue")).toBeUndefined();
    await click("Discard");
    await until(() => !!control("Discard this copy"), "the question");
    await click("Discard this copy");
    // The line goes once the copy is forgotten: the session in progress, and what Start left.
    await until(() => !text().includes("Saved on another device"), "B's line gone");
    expect(await readLive(b, SLOT)).toBeUndefined();
    expect(await loadBuild(b, SLOT)).toBeUndefined();
    expect(await queuedUnstarts(b, ME)).toEqual([]);
    expect(srv.unstartSession).not.toHaveBeenCalled();
    expect(srv.sessions()).toHaveLength(1);
  });

  it("saved on B offline, then on A online: B's queued save becomes a conflict — 'Saved on another device', Discard only — never a second session", async () => {
    const srv = server();
    const [a, b] = [await device(), await device()];
    // B plays and saves with no network: its save waits in B's outbox.
    player(b, { savePerformed: offline });
    await playAndSave();
    const [waiting] = await outboxEntries(b);
    expect(waiting).toMatchObject({ userId: ME, state: "pending", payload: { workoutId: SLOT } });
    // A plays the same started slot and saves it, online: the slot's session.
    player(a, srv);
    await playAndSave();
    expect(srv.sessions()).toHaveLength(1);

    // B back online: its outbox drains, and the server refuses a second session for the slot.
    expect(await drain(b, srv, { userId: ME })).toMatchObject({ saved: 0, conflicts: 1, failed: 0 });
    expect(srv.sessions()).toHaveLength(1);
    expect(srv.sessions()[0]).not.toBe(waiting!.performedId);
    expect(await outboxEntries(b)).toEqual([expect.objectContaining({ state: "conflict", lastError: "slot_done" })]);
    // Never sent again by itself.
    await drain(b, srv, { userId: ME });
    expect(srv.savePerformed.mock.calls.filter(([id]) => id === waiting!.performedId)).toHaveLength(1);

    // Settings → Data on B says why, and offers Discard only.
    render(createElement(UnsyncedSessions, { db: () => Promise.resolve(b), api: srv, userId: ME }));
    await until(() => text().includes("Saved on another device"), "B's row");
    expect(text()).not.toContain("Couldn't sync");
    expect(control("Retry")).toBeUndefined();
    expect(control("Discard")).toBeDefined();
  });
});
