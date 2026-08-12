import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "@rg/ui";
import "@rg/ui/styles.css";

// An installed PWA resumed from the app switcher performs no navigation, so
// the browser never re-checks sw.js on its own — deploys silently never
// reached the user (2026-08-12 audit finding 5). Check on launch, hourly,
// and every time the app returns to the foreground; `autoUpdate` mode
// reloads once the fresh worker takes control.
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    setInterval(() => void registration.update(), 60 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void registration.update();
    });
  },
});
void updateSW;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
