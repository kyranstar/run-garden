/**
 * WHO IS SIGNED IN, OFFLINE (Phase 2 spec §2b "Service worker"; plan Task 3; ruling 2b-R6).
 *
 * The service worker keeps the last `/api/auth/me` answer in the `rg-me` cache (NetworkFirst, 3 s) and answers an
 * offline launch from it — for every account, a session in progress or not (ruling 2b-R6: spec §2b's "an offline
 * launch reaches the app" over the plan's narrower wording). The app then reads its other screens from
 * `rg-read-cache`, read-only in effect.
 *
 * When `me` still fails here — the worker could not answer (not in control yet, nothing cached) or the server's error
 * passed through it — the app takes the cached answer itself, but only while a session is in progress on this device
 * (the player must reopen); otherwise the failure stands ("Couldn't reach").
 *
 * What makes that safe is forgetting: delete-all, sign-out and any 401 forget the offline identity
 * (`forgetOfflineIdentity`): `rg-me`, `rg-read-cache`, and the offline database's stored builds and live sessions. A
 * 401 that reaches the worker after its 3 s timeout (the cached answer already served) purges both caches there too
 * (apps/web/sw-routes.ts). The outbox is kept: its entries are unsynced work, tagged with their account, and never
 * sent under another (outbox.ts).
 */
import { api, ApiError, type MeResponse } from "@rg/api-client";
import { offlineDb, type OfflineDb } from "./idb.js";
import { hasLiveSession } from "./live.js";

/** The service worker's cache for `/api/auth/me` (apps/web/sw-routes.ts). */
export const ME_CACHE = "rg-me";
/** The service worker's cache of read-only API answers (apps/web/sw-routes.ts). */
export const READ_CACHE = "rg-read-cache";
const ME_URL = "/api/auth/me";

type Caches = Pick<CacheStorage, "match" | "delete">;
const browserCaches = (): Caches | undefined => (typeof caches === "undefined" ? undefined : caches);

interface OfflineDeps {
  /** Cache Storage; the browser's own unless given (`undefined`: none). */
  caches?: Caches | undefined;
  /** The offline database; the app's own unless given. */
  db?: () => Promise<OfflineDb>;
}

export async function meWithOfflineFallback(
  deps: OfflineDeps & {
    fetchMe?: () => Promise<MeResponse>;
    hasLive?: () => Promise<boolean>;
  } = {},
): Promise<MeResponse> {
  const fetchMe = deps.fetchMe ?? api.me;
  const store = "caches" in deps ? deps.caches : browserCaches();
  const openDb = deps.db ?? offlineDb;
  try {
    return await fetchMe();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // Signed out — the session expired, was ended elsewhere, or the account is gone: nothing of it opens offline.
      await forgetOfflineIdentity({ caches: store, db: openDb });
      throw error;
    }
    const hasLive = deps.hasLive ?? (async () => hasLiveSession(await openDb()));
    const live = await hasLive().catch(() => false);
    if (!live || !store) throw error;
    const cached = await store.match(ME_URL).catch(() => undefined);
    if (!cached?.ok) throw error;
    return (await cached.json()) as MeResponse;
  }
}

/**
 * Ruling 2b-R6: forget everything that lets this device open the account offline — the service worker's `rg-me` and
 * `rg-read-cache`, and the offline database's stored builds and live sessions. The outbox (unsynced saves, tagged
 * with their account) and its lock stay. Called on delete-all, on sign-out and on any 401. Never throws.
 */
export async function forgetOfflineIdentity(deps: OfflineDeps = {}): Promise<void> {
  const store = "caches" in deps ? deps.caches : browserCaches();
  await Promise.all([ME_CACHE, READ_CACHE].map((name) => store?.delete(name).catch(() => false)));
  try {
    const db = await (deps.db ?? offlineDb)();
    await Promise.all([db.clear("builds"), db.clear("live")]);
  } catch {
    // No IndexedDB here (a private window, an old browser): nothing was stored in it either.
  }
}

/** @deprecated Sign-out's old name: forgets the whole offline identity now (`forgetOfflineIdentity`). Never throws. */
export async function forgetCachedMe(store: Caches | undefined = browserCaches()): Promise<void> {
  await forgetOfflineIdentity({ caches: store });
}
