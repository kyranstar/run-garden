/**
 * Signing in offline with a session in progress (plan Task 3; spike report 2026-10-07): the service worker keeps
 * the last `/api/auth/me` (cache `rg-me`), and when `me` still cannot be fetched the app takes that cached answer —
 * but only while a session is in progress on this device. Without one, the "Couldn't reach" screen stays as it was;
 * signed out (401) is always signed out; signing out forgets the cached answer.
 */
import { describe, expect, it, vi } from "vitest";
import { ApiError, type MeResponse } from "@rg/api-client";
import { forgetCachedMe, ME_CACHE, meWithOfflineFallback } from "../../src/offline/me.js";

const me = { email: "fixture@example.com", fixtureMode: true } as unknown as MeResponse;

/** A Cache Storage double holding one cache. */
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

  it("offline with nothing in progress: the failure stands (the 'Couldn't reach' screen)", async () => {
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me } });
    await expect(meWithOfflineFallback({ fetchMe: offline, hasLive: async () => false, caches })).rejects.toThrow("Failed to fetch");
  });

  it("signed out is signed out, whatever is in progress or cached", async () => {
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me } });
    const signedOut = () => Promise.reject(new ApiError(401, { error: "unauthenticated" }));
    await expect(meWithOfflineFallback({ fetchMe: signedOut, hasLive: async () => true, caches })).rejects.toMatchObject({ status: 401 });
  });

  it("offline with a session in progress but nothing cached, or no Cache Storage, or no IndexedDB: the failure stands", async () => {
    await expect(meWithOfflineFallback({ fetchMe: offline, hasLive: async () => true, caches: cacheStorage() })).rejects.toThrow();
    await expect(meWithOfflineFallback({ fetchMe: offline, hasLive: async () => true, caches: undefined })).rejects.toThrow();
    const noIdb = async () => Promise.reject(new Error("IndexedDB is unavailable"));
    await expect(
      meWithOfflineFallback({ fetchMe: offline, hasLive: noIdb, caches: cacheStorage({ [ME_CACHE]: { "/api/auth/me": me } }) }),
    ).rejects.toThrow("Failed to fetch");
  });

  it("signing out forgets the cached answer", async () => {
    const caches = cacheStorage({ [ME_CACHE]: { "/api/auth/me": me }, "rg-shell": { "/index.html": {} } });
    await forgetCachedMe(caches);
    expect([...caches.store.keys()]).toEqual(["rg-shell"]);
    await expect(forgetCachedMe(undefined)).resolves.toBeUndefined();
  });
});
