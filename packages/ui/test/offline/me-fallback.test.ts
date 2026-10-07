/**
 * Who is signed in, offline (plan Task 3; spike report 2026-10-07; ruling 2b-R6). The service worker keeps the last
 * `/api/auth/me` (cache `rg-me`) and answers an offline launch from it for every account — that is the service
 * worker's route, not this function. When `me` still fails here (the worker could not answer: not in control yet, or
 * a server error passed through), the app takes the cached answer itself only while a session is in progress on this
 * device. Signed out (401) is always signed out — and forgets the offline identity (rg-me, rg-read-cache, the stored
 * builds and live sessions), as delete-all and sign-out do.
 */
import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { ApiError, type MeResponse } from "@rg/api-client";
import { openOfflineDb, type OfflineDb } from "../../src/offline/idb.js";
import { forgetCachedMe, forgetOfflineIdentity, ME_CACHE, meWithOfflineFallback, READ_CACHE } from "../../src/offline/me.js";

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

  it("a 401 forgets the offline identity: both caches, the stored builds and live sessions — the unsynced saves stay (ruling 2b-R6; audit 2b-A M-2)", async () => {
    const { db, caches } = await deviceWithTraces();
    const signedOut = () => Promise.reject(new ApiError(401, { error: "unauthenticated" }));
    await expect(meWithOfflineFallback({ fetchMe: signedOut, hasLive: async () => true, caches, db: async () => db })).rejects.toMatchObject({
      status: 401,
    });
    expect([...caches.store.keys()]).toEqual(["rg-shell"]);
    expect(await db.all("builds")).toEqual([]);
    expect(await db.all("live")).toEqual([]);
    expect(await db.all("outbox")).toHaveLength(1);
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

describe("forgetOfflineIdentity (ruling 2b-R6: delete-all, sign-out, any 401)", () => {
  it("deletes rg-me and rg-read-cache and empties builds and live; the outbox and its lock stay, and the shell cache", async () => {
    const { db, caches } = await deviceWithTraces();
    await forgetOfflineIdentity({ caches, db: async () => db });
    expect([...caches.store.keys()]).toEqual(["rg-shell"]);
    expect(await db.all("builds")).toEqual([]);
    expect(await db.all("live")).toEqual([]);
    expect(await db.all("outbox")).toEqual([{ key: "p1:h", userId: "u1" }]);
    expect(await db.get("meta", "outbox-drain")).toBeDefined();
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
