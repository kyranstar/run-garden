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
 * What makes that safe is forgetting (ruling 2b-R6 as amended):
 *  - any 401 forgets the account's cached answers, `rg-me` and `rg-read-cache` (`forgetCachedAnswers`) — and NEVER the
 *    live session or the outbox: a sign-in that expired mid-session must not lose the workout; the session resumes and
 *    the outbox drains once the athlete signs in again, under the same account. A 401 that reaches the worker after its
 *    3 s timeout (the cached answer already served) purges both caches there too (apps/web/sw-routes.ts);
 *  - sign-out forgets the offline identity (`forgetOfflineIdentity`): both caches and the stored builds and live
 *    sessions; its unsynced saves stay, tagged with the account, for its next sign-in (outbox.ts);
 *  - delete-all forgets the same, and drops that account's unsynced saves too.
 */
import { api, ApiError, type MeResponse } from "@rg/api-client";
import { offlineDb, type OfflineDb } from "./idb.js";
import { hasLiveSession } from "./live.js";
import { discardAccountEntries } from "./outbox.js";

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
      // Signed out — the session expired, was ended elsewhere, or the account is gone: an offline launch must not open
      // it. The work on this device (a session in progress, unsynced saves) stays for the next sign-in.
      await forgetCachedAnswers({ caches: store });
      throw error;
    }
    const hasLive = deps.hasLive ?? (async () => hasLiveSession(await openDb()));
    // An offline database that never answers must not hold sign-in on a spinner: after the wait, no live session
    // (re-review 2b-A N-2) — the "Couldn't reach" screen, as before.
    const live = await Promise.race([
      hasLive().catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FORGET_DB_WAIT_MS)),
    ]);
    if (!live || !store) throw error;
    const cached = await store.match(ME_URL).catch(() => undefined);
    if (!cached?.ok) throw error;
    return (await cached.json()) as MeResponse;
  }
}

/** How long forgetting waits for the offline database before it lets sign-in or sign-out go on. */
const FORGET_DB_WAIT_MS = 2000;

/** On any 401 (ruling 2b-R6 as amended): the account's cached answers go — `rg-me`, `rg-read-cache` — and nothing else. Never throws. */
export async function forgetCachedAnswers(deps: Pick<OfflineDeps, "caches"> = {}): Promise<void> {
  const store = "caches" in deps ? deps.caches : browserCaches();
  await Promise.all([ME_CACHE, READ_CACHE].map((name) => store?.delete(name).catch(() => false)));
}

/**
 * Sign-out and delete-all (ruling 2b-R6 as amended): forget what lets this device open the account offline — the
 * cached answers (`forgetCachedAnswers`) and the offline database's stored builds and live sessions. The outbox's
 * unsynced saves stay, tagged with their account, unless `dropOutboxOf` names it (delete-all: the account is gone).
 * The outbox's lock stays. Never throws.
 */
export async function forgetOfflineIdentity(deps: OfflineDeps & { dropOutboxOf?: string } = {}): Promise<void> {
  await forgetCachedAnswers(deps);
  const clearStores = async () => {
    const db = await (deps.db ?? offlineDb)();
    await Promise.all([db.clear("builds"), db.clear("live"), ...(deps.dropOutboxOf ? [discardAccountEntries(db, deps.dropOutboxOf)] : [])]);
  };
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  try {
    // Sign-in and sign-out wait for this: a database that never answers (blocked, a broken private mode) must not
    // hold them up.
    await Promise.race([clearStores(), new Promise<void>((resolve) => (giveUp = setTimeout(resolve, FORGET_DB_WAIT_MS)))]);
  } catch {
    // No IndexedDB here (a private window, an old browser): nothing was stored in it either.
  } finally {
    clearTimeout(giveUp);
  }
}

/** @deprecated Sign-out's old name: forgets the whole offline identity now (`forgetOfflineIdentity`). Never throws. */
export async function forgetCachedMe(store: Caches | undefined = browserCaches()): Promise<void> {
  await forgetOfflineIdentity({ caches: store });
}
