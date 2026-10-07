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
import { afterEach, describe, expect, it } from "vitest";
import type { SessionDto } from "@rg/api-client";
import { openOfflineDb, type OfflineDb } from "../src/offline/idb.js";
import { saveBuild } from "../src/offline/builds.js";
import { writeLive } from "../src/offline/live.js";
import { saveExtras } from "../src/player/stored.js";
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

function render(props: { shown?: readonly string[]; userId?: string | null }) {
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
          }),
        ),
      ),
    ),
  );
}
const flush = () => act(async () => void (await new Promise((r) => setImmediate(r))));
async function settle() {
  for (let i = 0; i < 60; i++) await flush();
}
const text = () => (host?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Today: a session in progress on this device (ruling 2b-R16)", () => {
  it("yesterday's, left at midnight: 'Session in progress', its name and day, and Continue to the player", async () => {
    db = await openOfflineDb(new IDBFactory());
    await inProgress("slot-y", YESTERDAY, "user-1");
    render({});
    await settle();
    expect(text()).toContain("Session in progress");
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
    await settle();
    expect(text()).toContain("ready to save");
  });

  it("only the signed-in account's; not one the Today card already shows; nothing at all when there is none", async () => {
    db = await openOfflineDb(new IDBFactory());
    await inProgress("slot-theirs", YESTERDAY, "user-2");
    await inProgress("slot-today", TODAY, "user-1");
    render({ shown: ["slot-today"] });
    await settle();
    expect(host!.innerHTML).toBe("");
    act(() => root?.unmount());
    host?.remove();
    // Before anyone is known to be signed in: nothing.
    render({ userId: null });
    await settle();
    expect(host!.innerHTML).toBe("");
  });
});
