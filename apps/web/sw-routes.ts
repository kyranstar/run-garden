import type { VitePWAOptions } from "vite-plugin-pwa";

type RuntimeCaching = NonNullable<NonNullable<VitePWAOptions["workbox"]>["runtimeCaching"]>[number];

/**
 * The service worker's runtime routes (vite.config.ts hands them to workbox; test/sw-routes.test.ts).
 *
 * NOTE: matcher functions and plugins below are stringified into the generated sw.js — they must stay closure-free
 * (no imports, no names from this module: a cache name is written out where it is used).
 */
export const runtimeCaching: RuntimeCaching[] = [
  {
    // Network-first navigations: a normal reload after a deploy paints
    // the new build; offline falls back to the cached shell. Every
    // navigation shares the single "/index.html" cache entry (the
    // worker SPA-fallbacks all app routes to it), so any route works
    // offline once one load has succeeded.
    urlPattern: ({ request, url }) => request.mode === "navigate" && !url.pathname.startsWith("/api/"),
    handler: "NetworkFirst",
    options: {
      cacheName: "rg-shell",
      networkTimeoutSeconds: 3,
      plugins: [{ cacheKeyWillBeUsed: async () => "/index.html" }],
    },
  },
  {
    // Who is signed in, for an offline launch: every account's last answer,
    // so an offline launch reaches the app (Phase 2b; ruling 2b-R6). Its own
    // cache, so forgetting the offline identity can drop exactly it
    // (packages/ui/src/offline/me.ts, ME_CACHE). A 401 is never cached:
    // NetworkFirst stores only successful answers — and a 401 purges the
    // account's cached answers here, in the worker, because one that
    // arrives after the 3 s timeout (the cached answer already served) never
    // reaches the app's own forget (audit 2b-A M-2).
    urlPattern: ({ url }) => url.pathname === "/api/auth/me",
    handler: "NetworkFirst",
    options: {
      cacheName: "rg-me",
      networkTimeoutSeconds: 3,
      expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 7 },
      plugins: [
        {
          fetchDidSucceed: async ({ response }) => {
            if (response.status === 401) {
              await Promise.all([caches.delete("rg-me"), caches.delete("rg-read-cache"), caches.delete("rg-doc-cache"), caches.delete("rg-studio-cache")]);
            }
            return response;
          },
        },
      ],
    },
  },
  {
    // What a quick start or a template needs to start OFFLINE (R11 fix round 1): the templates (their documents), the
    // library's view as the Studio reads it (the account's condition profiles — judged by none of their rules, a Start
    // offline is refused), the athlete's own moves (saved-posts import: a template holding one resolves, times and
    // plays) and the profile (the account's zone — the session's day). Kept a week, the outbox's reach, so a jaw release
    // on the second to seventh day offline still judges by the real profiles; in a cache of its own, with the account's
    // other answers forgotten on a 401 (above, and packages/ui/src/offline/me.ts). Only these lists: never a filtered
    // library, one move's or one template's own read.
    urlPattern: ({ url }) =>
      /^\/api\/(templates|profile|library\/personal)$/.test(url.pathname) ||
      (url.pathname === "/api/library" && [...url.searchParams.keys()].every((k) => k === "limit")),
    handler: "NetworkFirst",
    options: {
      cacheName: "rg-studio-cache",
      networkTimeoutSeconds: 4,
      expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 7 },
    },
  },
  {
    // Runtime-cache read-only GET API responses so recent data is
    // available offline (clearly marked stale in the UI). Workbox
    // matches RegExp routes against the full href, so a ^\/api\/
    // anchor never fires (2026-08 audit P4) — match pathname instead.
    // The quick review's basis too (Phase 3; audit 3-B UI-9): Today, from this cache, offers "Log your session" offline,
    // and the sheet it opens reads the basis Today read ahead. Its save re-checks the activity and the build server-side,
    // so a basis from the cache cannot write wrong data. Nothing else of a session is kept.
    // The Studio's other reads too (Stage 2 spec §12): the planned workouts and the places' gear — its templates, the
    // athlete's side of the library and the profile are kept a week in the studio cache (above); the moves themselves
    // are in the bundle. With them a Studio opened offline, a cold start included, knows what it knew online, and a
    // quick start is built at once instead of after its reads fail through their retries. The lists one entry each —
    // the workouts' never a typed search: each query would be an entry of its own, pushing Today out of the 40. Never a
    // workout's document (below).
    urlPattern: ({ url }) =>
      url.pathname.match(/^\/api\/(plan\/today|plan\/workouts|garden|insights|settings)/) !== null ||
      /^\/api\/sessions\/[^/]+\/watch-review$/.test(url.pathname) ||
      url.pathname === "/api/places" ||
      (url.pathname === "/api/workouts" && !url.searchParams.has("q")),
    handler: "NetworkFirst",
    options: {
      cacheName: "rg-read-cache",
      networkTimeoutSeconds: 4,
      expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 },
    },
  },
  {
    // A planned workout's document, so it opens in the builder offline: its save carries the revision it was built on,
    // so a stale copy from here is refused (409), never written over a newer one. One entry a workout, so in a cache of
    // its own and a small one: the documents of many workouts opened never push Today out of the read cache. Forgotten
    // with the account's other answers on a 401 (above, and packages/ui/src/offline/me.ts).
    urlPattern: ({ url }) => /^\/api\/workouts\/[^/]+\/doc$/.test(url.pathname),
    handler: "NetworkFirst",
    options: {
      cacheName: "rg-doc-cache",
      networkTimeoutSeconds: 4,
      expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 },
    },
  },
];
