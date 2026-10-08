// @vitest-environment jsdom
/**
 * A SESSION LEFT IN PROGRESS STAYS REACHABLE (audit 2b-B C-1; ruling 2b-R16). Today lists the program's sessions of
 * today only; a session started in the evening and left at midnight — its sets and its review in IndexedDB — had no
 * way back in. Today now shows "Session in progress" for each session the device holds for the signed-in account,
 * with Continue; the day's own sessions keep their Continue on the card.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@rg/api-client";
import { openOfflineDb, type OfflineDb } from "../src/offline/idb.js";
import { loadBuild, saveBuild } from "../src/offline/builds.js";
import { readLive, writeLive } from "../src/offline/live.js";
import { queuedUnstarts } from "../src/offline/unstarts.js";
import { loadExtras, saveExtras } from "../src/player/stored.js";
import { beginPlayer, endSession, playerData, toLiveSession } from "../src/player/run.js";
import { SessionsInProgress } from "../src/components/sessions-in-progress.js";
import { build, profiles, view } from "./player/fixtures.js";

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
  vi.unstubAllGlobals();
});

const TODAY = "2026-10-09";
const YESTERDAY = "2026-10-08";
const T = Date.UTC(2026, 9, 8, 21, 0, 0);

/** A session started on `date` on this device, for `userId`, two steps in (or ended, waiting on its review). */
async function inProgress(workoutId: string, date: string, userId: string | null, opts: { ended?: boolean } = {}) {
  const b = build({ date });
  await saveBuild(db!, { workoutId, build: b, view: view() } as unknown as SessionDto);
  await saveExtras(db!, { workoutId, title: `Program ${workoutId}`, profiles: profiles(), userId, savedAt: T });
  const src = { workoutId, build: b, view: view(), profiles: ["tmj"] };
  let s = beginPlayer(src, playerData(src), { performedId: `p-${workoutId}`, now: T });
  s = { ...s, index: 2 };
  if (opts.ended) s = endSession(s, T + 60_000);
  await writeLive(db!, toLiveSession(s, T + 60_000));
}

/** The server can't be asked (offline): what every case gets unless it says otherwise. */
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

function render(props: {
  shown?: readonly string[];
  userId?: string | null;
  /** What the server has the slot as (`GET /api/sessions/:id/state`); null: the component's own ask, over `fetch`. */
  slotState?: ((workoutId: string) => Promise<SessionDto["contentState"]>) | null;
  checkWaitMs?: number;
}) {
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
          null,
          createElement(SessionsInProgress, {
            today: TODAY,
            shown: props.shown ?? [],
            userId: props.userId === undefined ? "user-1" : props.userId,
            db: () => Promise.resolve(db!),
            ...(props.slotState === null ? {} : { slotState: props.slotState ?? offline }),
            ...(props.checkWaitMs === undefined ? {} : { checkWaitMs: props.checkWaitMs }),
          }),
        ),
      ),
    ),
  );
}
const continueLink = () => [...host!.querySelectorAll("a")].find((a) => a.textContent === "Continue");
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const flush = () => act(async () => void (await new Promise((r) => setImmediate(r))));
async function settle() {
  for (let i = 0; i < 60; i++) await flush();
}
/** Waits (real time, up to 3 s) for what the IndexedDB and the server check settle into — a fixed number of ticks was
 * not enough on a loaded CI runner. */
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 600 && !check(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  if (!check()) throw new Error(`timed out waiting for: ${what} — ${text()}`);
}
const text = () => (host?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Today: a session in progress on this device (ruling 2b-R16)", () => {
  it("yesterday's, left at midnight: 'Session in progress', its name and day, and Continue to the player", async () => {
    db = await openOfflineDb(new IDBFactory());
    await inProgress("slot-y", YESTERDAY, "user-1");
    render({});
    await until(() => text().includes("Session in progress") && !!continueLink(), "the line and Continue");
    expect(text()).toContain("Program slot-y");
    expect(text()).toContain("step 3 of 9");
    const link = [...host!.querySelectorAll("a")].find((a) => a.textContent === "Continue");
    expect(link?.getAttribute("href")).toBe("/session/slot-y");
    expect([...link!.classList]).toEqual(["btn", "btn-primary"]);
  });

  it("one waiting on its review says so", async () => {
    db = await openOfflineDb(new IDBFactory());
    await inProgress("slot-y", YESTERDAY, "user-1", { ended: true });
    render({});
    await until(() => text().includes("ready to save"), "ready to save");
  });

  it("only the signed-in account's; not one the Today card already shows; nothing at all when there is none", async () => {
    db = await openOfflineDb(new IDBFactory());
    await inProgress("slot-theirs", YESTERDAY, "user-2");
    await inProgress("slot-today", TODAY, "user-1");
    render({ shown: ["slot-today"] });
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(host!.innerHTML).toBe("");
    act(() => root?.unmount());
    host?.remove();
    // Before anyone is known to be signed in: nothing.
    render({ userId: null });
    await settle();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(host!.innerHTML).toBe("");
  });
});

describe("Today: a session in progress here that another device saved (ruling 2b-R18, re-review 2b-B N-3)", () => {
  it("the server has the slot as done: no Continue — 'Saved on another device', Discard only, which forgets it here alone", async () => {
    db = await openOfflineDb(new IDBFactory());
    await inProgress("slot-y", YESTERDAY, "user-1");
    const asked: string[] = [];
    render({
      slotState: async (id) => {
        asked.push(id);
        return "done";
      },
    });
    await until(() => text().includes("Saved on another device"), "saved elsewhere");
    expect(asked).toEqual(["slot-y"]);
    expect(text()).toContain("Program slot-y");
    expect(continueLink()).toBeUndefined();
    await act(async () => button("Discard")!.click());
    await until(() => !!button("Discard this copy"), "the confirm");
    await act(async () => button("Discard this copy")!.click());
    await until(() => host!.innerHTML === "", "forgotten here");
    // Gone from the device — the session in progress, its build and what Start kept — and nothing asked of the server
    // (the slot is done there; no un-start is queued).
    expect(await readLive(db, "slot-y")).toBeUndefined();
    expect(await loadBuild(db, "slot-y")).toBeUndefined();
    expect(await loadExtras(db, "slot-y")).toBeUndefined();
    expect(await queuedUnstarts(db, "user-1")).toEqual([]);
    expect(host!.innerHTML).toBe("");
  });

  it("asks the server for the slot's state alone, never the whole session (re-review 2b-B2 M-3)", async () => {
    db = await openOfflineDb(new IDBFactory());
    await inProgress("slot-y", YESTERDAY, "user-1");
    const asked: string[] = [];
    const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(url);
        return url === "/api/sessions/slot-y/state" ? json({ workoutId: "slot-y", contentState: "done" }, 200) : json({ error: "not_found" }, 404);
      }),
    );
    render({ slotState: null });
    await until(() => text().includes("Saved on another device"), "saved elsewhere");
    expect(asked).toEqual(["/api/sessions/slot-y/state"]);
  });

  it("the server has it started still: Continue, as before", async () => {
    db = await openOfflineDb(new IDBFactory());
    await inProgress("slot-y", YESTERDAY, "user-1");
    render({ slotState: async () => "started" });
    await until(() => !!continueLink(), "Continue");
    expect(continueLink()?.getAttribute("href")).toBe("/session/slot-y");
    expect(text()).not.toContain("Saved on another device");
  });

  it("no Continue before the server has answered; one that can't answer in time (a slow network) leaves Continue to the device", async () => {
    db = await openOfflineDb(new IDBFactory());
    await inProgress("slot-y", YESTERDAY, "user-1");
    let answer!: (s: SessionDto["contentState"]) => void;
    render({ slotState: () => new Promise((r) => (answer = r)) });
    await until(() => text().includes("Session in progress") && !!answer, "the line, the server asked");
    expect(continueLink()).toBeUndefined();
    await act(async () => answer("done"));
    await until(() => text().includes("Saved on another device"), "saved elsewhere");
    expect(continueLink()).toBeUndefined();
    act(() => root?.unmount());
    host?.remove();
    // A server that never answers: after the wait, the device's own session is offered as before.
    render({ slotState: () => new Promise(() => undefined), checkWaitMs: 20 });
    await until(() => !!continueLink(), "Continue after the wait");
    expect(continueLink()?.getAttribute("href")).toBe("/session/slot-y");
  });
});
