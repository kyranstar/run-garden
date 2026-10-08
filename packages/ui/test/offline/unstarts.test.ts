/**
 * DISCARD'S UN-START, OFFLINE (ruling 2b-R9). Discard asks the server to return the slot to `built`
 * (`POST …/unstart`); offline it waits on the device and goes on the outbox's triggers — but never while a save for
 * the slot waits in the outbox (the save decides the slot), and never once the slot is being played again here.
 */
import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ApiError } from "@rg/api-client";
import type { PerformedSessionWireInput } from "@rg/domain";
import { openOfflineDb } from "../../src/offline/idb.js";
import { writeLive, newLiveSession } from "../../src/offline/live.js";
import { enqueue } from "../../src/offline/outbox.js";
import { drainUnstarts, forgetUnstart, queuedUnstarts, queueUnstart } from "../../src/offline/unstarts.js";

const ME = "user-1";

const save = (workoutId: string): PerformedSessionWireInput => ({
  id: "11111111-1111-4111-8111-111111111111", source: "app", sourceRef: null, workoutId, buildId: "b1", localDate: "2026-10-07",
  startedAt: "2026-10-07T18:00:00.000Z", endedAt: "2026-10-07T18:31:00.000Z", seconds: 1860, plannedSeconds: 1800, minutes: 30,
  mode: "consistent", theme: null, locationId: "home", blockRef: null, blockNumber: 1, completed: false, stepsTotal: 9, stepsDone: 2,
  note: null, newMove: null, entries: [],
});

describe("queued un-starts", () => {
  it("are kept per slot and per account; the same Discard twice is one", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await queueUnstart(db, "slot-a", ME, 1000);
    await queueUnstart(db, "slot-a", ME, 2000);
    await queueUnstart(db, "slot-b", "user-2", 3000);
    expect((await queuedUnstarts(db, ME)).map((u) => u.workoutId)).toEqual(["slot-a"]);
    expect((await queuedUnstarts(db, "user-2")).map((u) => u.workoutId)).toEqual(["slot-b"]);
    await forgetUnstart(db, "slot-a");
    expect(await queuedUnstarts(db, ME)).toEqual([]);
    db.close();
  });

  it("go when the server answers; a refusal it will always give (409 performed, 404) drops them too", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await queueUnstart(db, "slot-a", ME);
    await queueUnstart(db, "slot-b", ME);
    await queueUnstart(db, "slot-c", ME);
    const unstartSession = vi.fn(async (id: string) => {
      if (id === "slot-b") throw new ApiError(409, { error: "performed" });
      if (id === "slot-c") throw new ApiError(404, { error: "not_found" });
      return {};
    });
    expect(await drainUnstarts(db, { unstartSession }, { userId: ME })).toEqual({ unstarted: 1 });
    expect(unstartSession.mock.calls.map((c) => c[0]).sort()).toEqual(["slot-a", "slot-b", "slot-c"]);
    expect(await queuedUnstarts(db, ME)).toEqual([]);
    db.close();
  });

  it("wait through a dropped connection, a 5xx, a 401 or a restore (423), for the next trigger", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await queueUnstart(db, "slot-a", ME);
    for (const failure of [new TypeError("Failed to fetch"), new ApiError(503, null), new ApiError(401, null), new ApiError(423, { error: "restore_in_progress" })]) {
      const unstartSession = vi.fn(async () => Promise.reject(failure));
      expect(await drainUnstarts(db, { unstartSession }, { userId: ME })).toEqual({ unstarted: 0 });
      expect((await queuedUnstarts(db, ME)).map((u) => u.workoutId)).toEqual(["slot-a"]);
    }
    db.close();
  });

  it("never go while a save for the slot waits in the outbox — the save decides the slot — and are dropped", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await enqueue(db, save("slot-a"), ME);
    await queueUnstart(db, "slot-a", ME);
    const unstartSession = vi.fn(async () => ({}));
    expect(await drainUnstarts(db, { unstartSession }, { userId: ME })).toEqual({ unstarted: 0 });
    expect(unstartSession).not.toHaveBeenCalled();
    expect(await queuedUnstarts(db, ME)).toEqual([]);
    db.close();
  });

  it("never go once the slot is played again on this device (it was started anew), and are dropped", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await queueUnstart(db, "slot-a", ME);
    await writeLive(db, newLiveSession({ workoutId: "slot-a", buildId: "b1", recorder: {} }));
    const unstartSession = vi.fn(async () => ({}));
    expect(await drainUnstarts(db, { unstartSession }, { userId: ME })).toEqual({ unstarted: 0 });
    expect(unstartSession).not.toHaveBeenCalled();
    expect(await queuedUnstarts(db, ME)).toEqual([]);
    db.close();
  });

  it("send only the signed-in account's", async () => {
    const db = await openOfflineDb(new IDBFactory());
    await queueUnstart(db, "slot-a", "user-2");
    const unstartSession = vi.fn(async () => ({}));
    expect(await drainUnstarts(db, { unstartSession }, { userId: ME })).toEqual({ unstarted: 0 });
    expect(unstartSession).not.toHaveBeenCalled();
    expect(await queuedUnstarts(db, "user-2")).toHaveLength(1);
    db.close();
  });
});
