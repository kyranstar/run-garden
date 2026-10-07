/**
 * The stored builds and the live sessions (Phase 2 spec §2b "Client storage"): the player reads its build from
 * IndexedDB, never the network, once started; the session in progress is written on every change (debounced 250 ms,
 * flushed when the page is hidden or left), so a reload, a relaunch or a killed tab resumes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { SessionDto } from "@rg/api-client";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import { forgetBuild, loadBuild, saveBuild } from "../../src/offline/builds.js";
import {
  clearLive,
  createLiveWriter,
  hasLiveSession,
  newLiveSession,
  readLive,
  requestPersistentStorage,
  writeLive,
} from "../../src/offline/live.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Just enough of a session for storage: the build and view are stored as they come. */
const session = (workoutId: string, buildId: string | null) =>
  ({
    workoutId,
    build: buildId ? { buildId, version: 1, steps: [{ kind: "rest", seconds: 60 }] } : null,
    view: buildId ? { mode: "consistent", location: { id: "home", name: "Home", equipment: ["mat"], implements: {} } } : null,
  }) as unknown as SessionDto;

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await done()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("timed out waiting");
}

describe("stored builds", () => {
  it("a build saved by the sheet or the player is there after a reopen, with when it was saved", async () => {
    const browser = new IDBFactory();
    const db = await openOfflineDb(browser);
    await saveBuild(db, session("w1", "b1"), 1234);
    db.close();
    const again = await openOfflineDb(browser);
    expect(await loadBuild(again, "w1")).toEqual({
      workoutId: "w1",
      build: session("w1", "b1").build,
      view: session("w1", "b1").view,
      savedAt: 1234,
    });
    await forgetBuild(again, "w1");
    expect(await loadBuild(again, "w1")).toBeUndefined();
    again.close();
  });

  it("a session with no build stores nothing and leaves a stored build alone", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await saveBuild(db, session("w1", "b1"), 1);
    await saveBuild(db, session("w1", null), 2);
    expect((await loadBuild(db, "w1"))?.build).toMatchObject({ buildId: "b1" });
    db.close();
  });
});

describe("live sessions", () => {
  it("Start makes a session with a fresh client id; it survives a reopen and is gone once cleared", async () => {
    const browser = new IDBFactory();
    const db = await openOfflineDb(browser);
    const a = newLiveSession({ workoutId: "w1", buildId: "b1", recorder: { step: 0 }, now: 5000 });
    const b = newLiveSession({ workoutId: "w2", buildId: "b2", recorder: {}, now: 5000 });
    expect(a.performedId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.performedId).not.toBe(b.performedId);
    expect(a).toMatchObject({ workoutId: "w1", buildId: "b1", stepIndex: 0, timerAnchor: null, paused: false, startedAt: 5000 });
    expect(await hasLiveSession(db)).toBe(false);
    await writeLive(db, a);
    db.close();

    const again = await openOfflineDb(browser);
    expect(await hasLiveSession(again)).toBe(true);
    expect(await readLive(again, "w1")).toEqual(a);
    await clearLive(again, "w1");
    expect(await readLive(again, "w1")).toBeUndefined();
    expect(await hasLiveSession(again)).toBe(false);
    again.close();
  });

  it("the writer keeps only the latest of quick changes, 250 ms after the last one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const db = await openOfflineDb(new IDBFactory());
    const puts: number[] = [];
    const counted: OfflineDb = { ...db, put: (store, key, value) => (puts.push((value as { stepIndex: number }).stepIndex), db.put(store, key, value)) };
    const writer = createLiveWriter(counted, { target: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
    const s = newLiveSession({ workoutId: "w1", buildId: "b1", recorder: {}, now: 1 });
    writer.write({ ...s, stepIndex: 1 });
    await vi.advanceTimersByTimeAsync(200);
    writer.write({ ...s, stepIndex: 2 });
    await vi.advanceTimersByTimeAsync(200);
    expect(puts).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    await until(async () => (await readLive(db, "w1"))?.stepIndex === 2);
    expect(puts).toEqual([2]);
    writer.dispose();
    db.close();
  });

  it("a pending change is written at once when the page is hidden or left, and on dispose", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const db = await openOfflineDb(new IDBFactory());
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const writer = createLiveWriter(db, { target, doc });
    const s = newLiveSession({ workoutId: "w1", buildId: "b1", recorder: {}, now: 1 });

    writer.write({ ...s, stepIndex: 3 });
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await until(async () => (await readLive(db, "w1"))?.stepIndex === 3);

    writer.write({ ...s, stepIndex: 4 });
    target.dispatchEvent(new Event("pagehide"));
    await until(async () => (await readLive(db, "w1"))?.stepIndex === 4);

    writer.write({ ...s, stepIndex: 5 });
    writer.dispose();
    await until(async () => (await readLive(db, "w1"))?.stepIndex === 5);
    db.close();
  });

  it("asks the browser to keep the storage, and says so; unsupported or refused is never an error", async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorage({ persist })).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(await requestPersistentStorage({ persist: async () => false })).toBe(false);
    expect(await requestPersistentStorage(undefined)).toBeNull();
    expect(await requestPersistentStorage({ persist: async () => Promise.reject(new Error("denied")) })).toBeNull();
  });
});
