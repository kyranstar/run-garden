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
            if (response.status === 401) await Promise.all([caches.delete("rg-me"), caches.delete("rg-read-cache")]);
            return response;
          },
        },
      ],
    },
  },
  {
    // Runtime-cache read-only GET API responses so recent data is
    // available offline (clearly marked stale in the UI). Workbox
    // matches RegExp routes against the full href, so a ^\/api\/
    // anchor never fires (2026-08 audit P4) — match pathname instead.
    urlPattern: ({ url }) => url.pathname.match(/^\/api\/(plan\/today|plan\/workouts|garden|insights|settings)/) !== null,
    handler: "NetworkFirst",
    options: {
      cacheName: "rg-read-cache",
      networkTimeoutSeconds: 4,
      expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 },
    },
  },
];
