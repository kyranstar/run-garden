import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // main.tsx registers the worker by hand (plain registration + update
      // checks, no forced reload), so skip the plugin's injected client.
      injectRegister: false,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Run Garden",
        short_name: "Run Garden",
        description: "Your COROS plan, fitted to your real week.",
        theme_color: "#3e7a52",
        background_color: "#faf8f3",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache hashed assets only. index.html deliberately stays OUT of
        // the precache: with it in there, the controlling worker served every
        // navigation stale-precache-first, so the first load after a deploy
        // always painted the old build (2026-08 audit P1). Navigations go
        // network-first below, with the cached shell as offline fallback.
        globPatterns: ["**/*.{js,css,svg,png,woff2}"],
        // Suppress the plugin's "index.html" default so no precache-bound
        // NavigationRoute is generated (it would throw: not precached).
        navigateFallback: undefined,
        // injectRegister is false above, which disables the plugin's implicit
        // skipWaiting/clientsClaim for autoUpdate — keep them so a fresh
        // worker still takes over promptly (it swaps silently; the new build
        // simply arrives on the next navigation or reload).
        skipWaiting: true,
        clientsClaim: true,
        // NOTE: matcher functions and plugins below are stringified into the
        // generated sw.js — they must stay closure-free.
        runtimeCaching: [
          {
            // Network-first navigations: a normal reload after a deploy paints
            // the new build; offline falls back to the cached shell. Every
            // navigation shares the single "/index.html" cache entry (the
            // worker SPA-fallbacks all app routes to it), so any route works
            // offline once one load has succeeded.
            urlPattern: ({ request, url }) =>
              request.mode === "navigate" && !url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "rg-shell",
              networkTimeoutSeconds: 3,
              plugins: [{ cacheKeyWillBeUsed: async () => "/index.html" }],
            },
          },
          {
            // Runtime-cache read-only GET API responses so recent data is
            // available offline (clearly marked stale in the UI). Workbox
            // matches RegExp routes against the full href, so a ^\/api\/
            // anchor never fires (2026-08 audit P4) — match pathname instead.
            urlPattern: ({ url }) =>
              url.pathname.match(/^\/api\/(plan\/today|plan\/workouts|garden|insights|settings)/) !== null,
            handler: "NetworkFirst",
            options: {
              cacheName: "rg-read-cache",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    // Overridable so parallel checkouts can run side by side.
    port: Number(process.env.RG_WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.RG_API_PORT ?? "8787"}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    sourcemap: true,
    outDir: "dist",
  },
});
