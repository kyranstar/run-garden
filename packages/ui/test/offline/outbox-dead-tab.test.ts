/**
 * A drain left holding the outbox's lock by a tab that was closed mid-send (Phase 2b Task 8, journey e: Save offline,
 * the app killed at once, opened again online). The lock times out after a minute; the app opened meanwhile must try
 * again when it does — not wait for the next `online` or visible event, which may never come while it stays open.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { performedSessionSaveSchema, type PerformedSessionWire } from "@rg/domain";
import { openOfflineDb } from "../../src/offline/idb.js";
import { drain, enqueue, outboxEntries, startOutboxSync } from "../../src/offline/outbox.js";

afterEach(() => {
  vi.useRealTimers();
});

const wire = (): PerformedSessionWire =>
  performedSessionSaveSchema.parse({
    id: "33333333-3333-4333-8333-333333333333", source: "app", sourceRef: null, workoutId: "w1", buildId: "b1", localDate: "2026-10-08",
    startedAt: "2026-10-08T18:00:00.000Z", endedAt: "2026-10-08T18:30:00.000Z", seconds: 1800, plannedSeconds: 1800, minutes: 30,
    mode: "consistent", theme: null, locationId: "home", blockRef: null, blockNumber: null, completed: true, stepsTotal: 3, stepsDone: 3,
    movesDone: [], note: null, newMove: null, entries: [], checks: [],
  });

describe("a lock left by a tab closed mid-send", () => {
  it("a drain that finds it says when it is free (so the caller can come back then)", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await enqueue(db, wire(), 1000);
    await db.put("meta", "outbox-drain", { owner: "a closed tab", until: 61_000 });
    const savePerformed = vi.fn(async () => ({ status: "saved" }));
    expect(await drain(db, { savePerformed }, { now: () => 2_000 })).toMatchObject({ locked: true, retryAt: 61_000 });
    expect(savePerformed).not.toHaveBeenCalled();
    db.close();
  });

  it("the app opened meanwhile sends it once the lock times out — exactly once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(2_000);
    const db = await openOfflineDb(new IDBFactory());
    await enqueue(db, wire(), 1000);
    await db.put("meta", "outbox-drain", { owner: "a closed tab", until: 61_000 });
    const savePerformed = vi.fn(async () => ({ status: "saved" }));
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const stop = startOutboxSync({ db: () => Promise.resolve(db), api: { savePerformed }, win, doc });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect(savePerformed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => expect(await outboxEntries(db)).toEqual([]));
    expect(savePerformed).toHaveBeenCalledTimes(1);
    stop();
    db.close();
  });
});
