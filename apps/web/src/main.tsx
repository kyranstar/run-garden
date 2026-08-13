import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@rg/ui";
import "@rg/ui/styles.css";

// Plain registration — deliberately not `virtual:pwa-register`, whose
// autoUpdate client force-reloads the page the moment a fresh worker
// activates, yanking it mid-interaction (2026-08 audit P1). Navigations are
// network-first (vite.config.ts), so the new build paints on the next
// normal reload; the refreshed worker just swaps in silently.
//
// An installed PWA resumed from the app switcher performs no navigation, so
// the browser never re-checks sw.js on its own — deploys silently never
// reached the user (2026-08-12 audit finding 5). Check on launch, hourly,
// and every time the app returns to the foreground.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      const check = () => registration.update().catch(() => undefined);
      setInterval(check, 60 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void check();
      });
    })
    .catch(() => undefined); // registration is best-effort
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
