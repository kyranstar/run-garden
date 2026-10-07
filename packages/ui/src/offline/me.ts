/**
 * WHO IS SIGNED IN, OFFLINE (Phase 2 spec §2b "Service worker"; plan Task 3). The service worker keeps the last
 * `/api/auth/me` answer in the `rg-me` cache (NetworkFirst, 3 s), so an offline launch normally gets it from there.
 * When `me` still fails — no network and the worker could not answer, or the server is down — the app takes the
 * cached answer itself, but only while a session is in progress on this device (the player must reopen; everything
 * else may say "Couldn't reach" as before). A 401 is always signed out. Signing out forgets the cached answer.
 */
import { api, ApiError, type MeResponse } from "@rg/api-client";
import { offlineDb } from "./idb.js";
import { hasLiveSession } from "./live.js";

/** The service worker's cache for `/api/auth/me` (apps/web/vite.config.ts). */
export const ME_CACHE = "rg-me";
const ME_URL = "/api/auth/me";

type Caches = Pick<CacheStorage, "match" | "delete">;
const browserCaches = (): Caches | undefined => (typeof caches === "undefined" ? undefined : caches);

export async function meWithOfflineFallback(
  deps: {
    fetchMe?: () => Promise<MeResponse>;
    hasLive?: () => Promise<boolean>;
    caches?: Caches | undefined;
  } = {},
): Promise<MeResponse> {
  const fetchMe = deps.fetchMe ?? api.me;
  try {
    return await fetchMe();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
    const hasLive = deps.hasLive ?? (async () => hasLiveSession(await offlineDb()));
    const store = "caches" in deps ? deps.caches : browserCaches();
    const live = await hasLive().catch(() => false);
    if (!live || !store) throw error;
    const cached = await store.match(ME_URL).catch(() => undefined);
    if (!cached?.ok) throw error;
    return (await cached.json()) as MeResponse;
  }
}

/** On sign-out: an offline launch must not find the account's answer afterwards. Never throws. */
export async function forgetCachedMe(store: Caches | undefined = browserCaches()): Promise<void> {
  await store?.delete(ME_CACHE).catch(() => undefined);
}
