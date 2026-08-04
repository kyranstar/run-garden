import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
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
        // Cache the app shell; runtime-cache read-only GET API responses so
        // recent data is available offline (clearly marked stale in the UI).
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/(plan\/today|plan\/workouts|garden|insights|settings)/,
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
