/**
 * Who is signed in, offline (plan Task 3; spike report 2026-10-07; ruling 2b-R6). The service worker keeps the last
 * `/api/auth/me` (cache `rg-me`) and answers an offline launch from it for every account — that is the service
 * worker's route, not this function. When `me` still fails here (the worker could not answer: not in control yet, or
 * a server error passed through), the app takes the cached answer itself only while a session is in progress on this
 * device. Signed out (401) is always signed out — and forgets the account's cached answers (rg-me, rg-read-cache), and
 * nothing else: a sign-in that expired mid-session must not lose the workout (ruling 2b-R6 as amended). Sign-out and
 * delete-all forget the stored builds and live sessions too; delete-all also drops that account's unsynced saves.
 */
import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ApiError, type MeResponse } from "@rg/api-client";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import { forgetCachedMe, forgetOfflineIdentity, ME_CACHE, meWithOfflineFallback, READ_CACHE } from "../../src/offline/me.js";
import { drain, enqueue, outboxEntries, type OutboxApi } from "../../src/offline/outbox.js";
import { newLiveSession, readLive, writeLive } from "../../src/offline/live.js";

const me = { email: "fixture@example.com", fixtureMode: true } as unknown as MeResponse;

/** A Cache Storage double holding named caches. */
function cacheStorage(entries: Record<string, Record<string, unknown>> = {}) {
  const store = new Map(Object.entries(entries).map(([name, urls]) => [name, new Map(Object.entries(urls))]));
  return {
    store,
    match: vi.fn(async (url: string) => {
      for (const c of store.values()) if (c.has(url)) return new Response(JSON.stringify(c.get(url)), { status: 200 });
      return undefined;
    }),
    delete: vi.fn(async (name: string) => store.delete(name)),
  };
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

/** A device with the account's offline traces: both caches, a stored build, a live session, and an unsynced save. */
async function deviceWithTraces(): Promise<{ db: OfflineDb; caches: ReturnType<typeof cacheStorage> }> {
  const db = await openOfflineDb(new IDBFactory());
  await db.put("builds", "w1", { workoutId: "w1" });
  await db.put("live", "w1", { workoutId: "w1", performedId: "p1" });
  await db.put("outbox", "p1:h", { key: "p1:h", userId: "u1" });
  await db.put("outbox", "p2:h", { key: "p2:h", userId: "u2" });
  await db.put("meta", "outbox-drain", { owner: "x", until: 0 });
  const caches = cacheStorage({
    [ME_CACHE]: { "/api/auth/me": me },
    [READ_CACHE]: { "/api/garden": { garden: true } },
    "rg-shell": { "/index.html": {} },
  });
  return { db, caches };
}

describe("me with the offline fallback", () => {
  it("online: the server's answer, the cache never read", async () => {
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": { email: "stale" } } });
    const hasLive = vi.fn(async () => true);
    expect(await meWithOfflineFallback({ fetchMe: async () => me, hasLive, caches })).toBe(me);
    expect(caches.match).not.toHaveBeenCalled();
    expect(hasLive).not.toHaveBeenCalled();
  });

  it("offline with a session in progress: the cached answer", async () => {
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me } });
    expect(await meWithOfflineFallback({ fetchMe: offline, hasLive: async () => true, caches })).toEqual(me);
  });

  it("a server error with a session in progress: the cached answer too", async () => {
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me } });
    const down = () => Promise.reject(new ApiError(503, null));
    expect(await meWithOfflineFallback({ fetchMe: down, hasLive: async () => true, caches })).toEqual(me);
  });

  it("the service worker could not answer and nothing is in progress: the failure stands here (an offline launch normally never gets this far — the worker's rg-me route answers first, for every account: ruling 2b-R6)", async () => {
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me } });
    await expect(meWithOfflineFallback({ fetchMe: offline, hasLive: async () => false, caches })).rejects.toThrow("Failed to fetch");
  });

  it("signed out is signed out, whatever is in progress or cached", async () => {
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me } });
    const signedOut = () => Promise.reject(new ApiError(401, { error: "unauthenticated" }));
    await expect(meWithOfflineFallback({ fetchMe: signedOut, hasLive: async () => true, caches, db: async () => openOfflineDb(new IDBFactory()) })).rejects.toMatchObject({
      status: 401,
    });
  });

  it("a 401 forgets the cached answers only — rg-me and rg-read-cache; the stored builds, the live session and the outbox stay (ruling 2b-R6 as amended; audit 2b-A M-2)", async () => {
    const { db, caches } = await deviceWithTraces();
    const signedOut = () => Promise.reject(new ApiError(401, { error: "unauthenticated" }));
    await expect(meWithOfflineFallback({ fetchMe: signedOut, hasLive: async () => true, caches, db: async () => db })).rejects.toMatchObject({
      status: 401,
    });
    expect([...caches.store.keys()]).toEqual(["rg-shell"]);
    expect(await db.all("builds")).toHaveLength(1);
    expect(await db.all("live")).toHaveLength(1);
    expect(await db.all("outbox")).toHaveLength(2);
    db.close();
  });

  it("offline with a session in progress but nothing cached, or no Cache Storage, or no IndexedDB: the failure stands", async () => {
    await expect(meWithOfflineFallback({ fetchMe: offline, hasLive: async () => true, caches: cacheStorage() })).rejects.toThrow();
    await expect(meWithOfflineFallback({ fetchMe: offline, hasLive: async () => true, caches: undefined })).rejects.toThrow();
    const noIdb = async () => Promise.reject(new Error("IndexedDB is unavailable"));
    await expect(
      meWithOfflineFallback({ fetchMe: offline, hasLive: noIdb, caches: cacheStorage({ [ME_CACHE]: { "/api/auth/me": me } }) }),
    ).rejects.toThrow("Failed to fetch");
  });
});

describe("forgetOfflineIdentity (ruling 2b-R6 as amended: sign-out and delete-all)", () => {
  it("sign-out: deletes rg-me and rg-read-cache and empties builds and live; every unsynced save stays, tagged, and the outbox's lock and the shell cache", async () => {
    const { db, caches } = await deviceWithTraces();
    await forgetOfflineIdentity({ caches, db: async () => db });
    expect([...caches.store.keys()]).toEqual(["rg-shell"]);
    expect(await db.all("builds")).toEqual([]);
    expect(await db.all("live")).toEqual([]);
    expect(await db.all("outbox")).toEqual([
      { key: "p1:h", userId: "u1" },
      { key: "p2:h", userId: "u2" },
    ]);
    expect(await db.get("meta", "outbox-drain")).toBeDefined();
    db.close();
  });

  it("delete-all: the same, and the deleted account's unsynced saves go too — another account's stay", async () => {
    const { db, caches } = await deviceWithTraces();
    await forgetOfflineIdentity({ caches, db: async () => db, dropOutboxOf: "u1" });
    expect([...caches.store.keys()]).toEqual(["rg-shell"]);
    expect(await db.all("builds")).toEqual([]);
    expect(await db.all("live")).toEqual([]);
    expect(await db.all("outbox")).toEqual([{ key: "p2:h", userId: "u2" }]);
    db.close();
  });

  it("never throws: no Cache Storage, no IndexedDB, a cache that refuses", async () => {
    const refusing = { match: vi.fn(), delete: vi.fn(async () => Promise.reject(new Error("SecurityError"))) };
    await expect(forgetOfflineIdentity({ caches: undefined, db: async () => Promise.reject(new Error("IndexedDB is unavailable")) })).resolves.toBeUndefined();
    await expect(forgetOfflineIdentity({ caches: refusing, db: async () => Promise.reject(new Error("no")) })).resolves.toBeUndefined();
  });

  it("an offline database that never answers does not hold sign-in up: the caches go, and it gives up on the database after 2 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me }, "rg-shell": {} });
      let done = false;
      const forgetting = forgetOfflineIdentity({ caches, db: () => new Promise<OfflineDb>(() => undefined) }).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await forgetting;
      expect([...caches.store.keys()]).toEqual(["rg-shell"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgetCachedMe (sign-out's old name) forgets the same", async () => {
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me }, [READ_CACHE]: {}, "rg-shell": { "/index.html": {} } });
    await forgetCachedMe(caches);
    expect([...caches.store.keys()]).toEqual(["rg-shell"]);
    await expect(forgetCachedMe(undefined)).resolves.toBeUndefined();
  });
});

describe("a sign-in that expires mid-session (ruling 2b-R6 as amended)", () => {
  it("a 401 mid-session, then signing in again: the session resumes, and its save — and one saved before — each drain once", async () => {
    const db = await openOfflineDb(new IDBFactory());
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me }, [READ_CACHE]: {}, "rg-shell": {} });
    const account = { ...me, userId: "u1" } as MeResponse;
    const payloadOf = (id: string, workoutId: string) => ({
      id,
      source: "app" as const,
      sourceRef: null,
      workoutId,
      buildId: "b1",
      localDate: "2026-10-07",
      startedAt: "2026-10-07T18:00:00.000Z",
      endedAt: "2026-10-07T18:31:00.000Z",
      seconds: 1860,
      plannedSeconds: 1800,
      minutes: 30,
      mode: "consistent" as const,
      theme: null,
      locationId: "home",
      blockRef: null,
      blockNumber: 1,
      completed: true,
      stepsTotal: 24,
      stepsDone: 24,
      note: null,
      newMove: null,
      entries: [{ exerciseId: "goblet-squat", implement: "kettlebell", format: "straight" as const, perSide: false, sets: [{ setIndex: 0, reps: 6, seconds: null, load: { v: 30, u: "lb" as const } }] }],
    });
    // Yesterday's session saved offline, still unsynced; today's in progress at step 7.
    await enqueue(db, payloadOf("yesterday", "w0"), "u1", 1000);
    const live = { ...newLiveSession({ workoutId: "w1", buildId: "b1", recorder: { done: 6 }, now: 2000 }), stepIndex: 7 };
    await writeLive(db, live);

    // The sign-in expires; the reload's me answers 401: signed out, the cached answers forgotten, the work kept.
    const signedOut = () => Promise.reject(new ApiError(401, { error: "unauthenticated" }));
    await expect(meWithOfflineFallback({ fetchMe: signedOut, caches, db: async () => db })).rejects.toMatchObject({ status: 401 });
    expect([...caches.store.keys()]).toEqual(["rg-shell"]);

    // Signed in again (the same account): the player resumes where it was.
    const again = await meWithOfflineFallback({ fetchMe: async () => account, caches, db: async () => db });
    expect(again.userId).toBe("u1");
    expect(await readLive(db, "w1")).toEqual(live);

    // The athlete finishes and saves; the outbox drains under the same account, once each.
    await enqueue(db, payloadOf(live.performedId, "w1"), again.userId, 3000);
    const sent: string[] = [];
    const api: OutboxApi = {
      savePerformed: vi.fn(async (id: string) => {
        sent.push(id);
        return { status: "saved" };
      }),
    };
    expect(await drain(db, api, { userId: again.userId, now: () => 4000 })).toMatchObject({ saved: 2 });
    await drain(db, api, { userId: again.userId, now: () => 5000 });
    expect(sent).toEqual(["yesterday", live.performedId]);
    expect(await outboxEntries(db)).toEqual([]);
    db.close();
  });
});
