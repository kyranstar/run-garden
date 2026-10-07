# Offline spike: IndexedDB, service worker, wake lock, audio (2026-10-07)

Phase 2b Task 1 (spec `2026-09-30-phase-2-adaptive-program-design.md` §2b "Spike first"). The desktop half ran in
headless Google Chrome (and Playwright's WebKit, the closest engine to iOS Safari on this machine) against the local
fixture stack serving the **production build** — `wrangler dev` with the built `apps/web/dist` as its assets, one
origin, `FIXTURE_MODE` on, a private D1 state directory, never `--remote`. The service worker only registers in a
production build (`main.tsx` checks `import.meta.env.PROD`), so the Vite dev server cannot answer any of this. The
throwaway scripts lived in a scratch directory and are not kept. The iPhone half needs the owner's phone: its steps
are at the end.

## Results (desktop)

Nothing failed that the spec does not already plan for, so §2b needs no amendment from the desktop half. The iPhone
half (below) is still open and is where the real risks sit: wake lock in a Home Screen app, audio and the silent
switch, and storage eviction.

| Check | Chrome | WebKit | Verdict |
|---|---|---|---|
| IndexedDB survives a relaunch (persistent profile, browser process closed and started again) | yes — the record read back byte-equal | yes | **pass** |
| Storage is persistent (`navigator.storage.persisted()`) | no (best-effort) | no | note — see below |
| Service worker serves the shell offline | yes — `rg-shell` holds `/index.html`; hashed JS/CSS are precached | not run | **pass** |
| Service worker serves `/api/auth/me` offline, **current config** | **no** — the app paints "Couldn't reach Run Garden" | not run | **fail (expected; spec already plans the fix)** |
| …with `/api/auth/me` in a NetworkFirst cache (throwaway build, not committed) | yes — the signed-in app paints offline, on reload and on a relaunch with the server stopped | not run | **pass** |
| `navigator.wakeLock.request("screen")` | acquired (`type: "screen"`, visible page); released on `release()` | acquired | **pass** (desktop) |
| Audio needs a gesture first | headless Chrome does not enforce it (the context starts `running`) | **enforced**: `suspended` before the click, `running` after | **pass** (WebKit shows the rule) |
| Audio unlocked by a click keeps chiming for 30 minutes, screen on | yes — 91 of 91 chimes played, context `running` throughout | 25 s check only | **pass** (desktop) |

### What the current workbox config caches

Read from `navigator.caches` after one signed-in load:

- `workbox-precache-v2-…`: the hashed `assets/index-*.js` and `.css`, the icons, the manifest (`globPatterns`;
  `index.html` is deliberately not precached).
- `rg-shell`: one entry, `/index.html` — every navigation is NetworkFirst (3 s) and shares it.
- `rg-read-cache`: `/api/settings`, `/api/insights`, `/api/plan/today`, `/api/garden` (NetworkFirst, 4 s, 40 entries,
  24 h). `/api/plan/workouts` matches too once requested.
- **Nothing caches `/api/auth/me`.** Offline, `AuthedApp`'s `me` query fails, so the app shows "Couldn't reach Run
  Garden — check your connection." even though the shell, the JS and the day's data are all cached. This is the gap the
  spec's §2b "Service worker" paragraph and plan Task 3 already close; the throwaway build proved that adding one
  NetworkFirst route for `/api/auth/me` is enough for an offline reload and an offline relaunch to reach the signed-in
  app.

### Playwright's offline switch reaches the service worker

With `context.setOffline(true)` the server saw no navigation and no API request — the worker answered the navigation
from `rg-shell` and the API reads failed or came from cache. The only requests that still reached the server were the
browser's own service-worker update checks (`GET /sw.js`, `GET /workbox-*.js`, both 304). So `setOffline` is a fair
stand-in for airplane mode in Tasks 3 and 8, with that one exception (an offline test must not assert that *no*
request reaches the server). A relaunch with the server stopped behaved the same as `setOffline`.

### Audio, 30 minutes

Headless Chrome, page visible throughout, a click on an in-page button resuming the `AudioContext`, then a short
880 Hz chime every 20 s scheduled on the audio clock, for 30 minutes:

- **Pass.** The context stayed `running` at every one of the 30 one-minute samples; 91 chimes were scheduled and all
  91 played to their end (`onended` fired for each).
- The audio clock tracked the wall clock to within 2 s over the 30 minutes, but not smoothly: it matched exactly for
  the first 3 minutes, then fell 2 s behind in one step between minutes 3 and 4 and kept that gap to the end. The
  audio clock can stall briefly, so a chime's start time must be worked out from the wall-clock anchor each time it is
  scheduled (`currentTime + (dueAt − Date.now()) / 1000`), never from an offset taken once at Start.
- Headless Chrome does not enforce the autoplay gate (the context starts `running` before any click, whatever
  `--autoplay-policy` says), so the gesture rule was checked in WebKit instead: there the context is `suspended`
  until the click resumes it, and it then chimed normally for the 25 s check.

### Things the player and outbox must do (from what the spike showed)

1. **Ask for persistent storage at Start.** Both engines report best-effort storage, so the browser may evict
   IndexedDB under storage pressure. `navigator.storage.persist()` at Start is cheap; a refusal changes nothing else.
2. **Re-take the wake lock on `visibilitychange → visible`.** A wake lock is released whenever the page is hidden; it
   is never restored by itself.
3. **Schedule chimes on the audio clock, not on timers.** A chime scheduled with `oscillator.start(at)` on the
   `AudioContext` clock plays on time even when timers are throttled (a background tab clamps `setTimeout` to about
   once a minute after five minutes). The player's wall-clock anchor gives `at`.
4. **Unlock audio inside the Start tap** (create or `resume()` the `AudioContext` in the click handler). WebKit keeps
   a context created earlier `suspended` until a gesture resumes it.
5. **Offline tests use `context.setOffline(true)` against a production build** (the dev server registers no service
   worker). The smoke suite runs against the dev server, so the offline tests need a built-app stack — the fixture
   stack's worker already serves `apps/web/dist` as assets on its own port.

## iPhone half (for the owner)

Needs: the iPhone with Run Garden on the Home Screen, a Mac with Safari, a cable. These steps change nothing on the
server. Steps 4–6 can run today; steps 7–9 only once Task 3 (the `/api/auth/me` cache) is deployed.

**Set up the inspector once**

1. On the iPhone: Settings → Apps → Safari → Advanced (Settings → Safari → Advanced before iOS 18) → turn on **Web Inspector**.
2. On the Mac: Safari → Settings → Advanced → turn on **Show features for web developers**.
3. Plug the iPhone in, open Run Garden from the Home Screen, then on the Mac choose Safari → Develop → *(your
   iPhone)* → **Run Garden**. A Web Inspector window opens; use its **Console** tab for the snippets below.

**IndexedDB survives a relaunch**

4. In the Console, paste and run:
   ```js
   await new Promise((ok, no) => { const r = indexedDB.open("rg-spike", 1); r.onupgradeneeded = () => r.result.createObjectStore("live"); r.onsuccess = () => { const tx = r.result.transaction("live", "readwrite"); tx.objectStore("live").put({ at: Date.now() }, "w1"); tx.oncomplete = () => ok("written"); }; r.onerror = () => no(r.error); });
   ```
5. Swipe Run Garden away in the app switcher, wait 10 seconds, open it again from the Home Screen, reconnect the
   inspector (step 3), and run:
   ```js
   await new Promise((ok) => { const r = indexedDB.open("rg-spike", 1); r.onsuccess = () => { const g = r.result.transaction("live").objectStore("live").get("w1"); g.onsuccess = () => ok(g.result); }; });
   ```
   **Pass:** it prints the `{ at: … }` written in step 4. Also run `await navigator.storage.persist()` and note
   `true`/`false`. Clean up with `indexedDB.deleteDatabase("rg-spike")`.

**The shell offline (today's config)**

6. Turn on Airplane Mode, swipe Run Garden away, open it from the Home Screen. **Expected today:** the app's frame
   appears with "Couldn't reach Run Garden — check your connection." That proves the shell comes from the service
   worker; the message is the `/api/auth/me` gap Task 3 closes. Turn Airplane Mode off.

**Wake lock and audio (screen on for 30 minutes)**

7. Set Settings → Display & Brightness → Auto-Lock to **30 seconds**. Open Run Garden, connect the inspector, run:
   ```js
   window.__wl = await navigator.wakeLock.request("screen"); __wl.type
   ```
   **Pass:** it prints `"screen"` and the screen stays on for 2 minutes untouched. (Wake lock in Home Screen web apps
   needs iOS 18.4 or later; on an older iOS this throws or the screen still dims — note the iOS version.)
8. Run this, then **tap the screen once** (the tap unlocks audio):
   ```js
   window.__ac = new AudioContext(); window.__n = 0; if (navigator.audioSession) navigator.audioSession.type = "playback"; document.addEventListener("click", () => { __ac.resume(); const chime = () => { const o = __ac.createOscillator(), g = __ac.createGain(); o.frequency.value = 880; g.gain.value = 0.2; o.connect(g).connect(__ac.destination); o.onended = () => __n++; o.start(__ac.currentTime + 0.05); o.stop(__ac.currentTime + 0.25); }; chime(); window.__iv = setInterval(chime, 60000); }, { once: true }); "tap the screen now"
   ```
   Leave the phone face up with the screen on (the wake lock from step 7 keeps it on). **Pass:** a short beep every
   minute for 30 minutes; afterwards `__n` reads about 31 and `__ac.state` reads `"running"`. Try it once with the
   ring/silent switch on silent: with `navigator.audioSession.type = "playback"` the beeps should still sound; note
   whether they do.
9. Set Auto-Lock back to what it was. `clearInterval(__iv); __wl.release()`.

**After Task 3 is deployed** (the `/api/auth/me` cache)

10. Open Run Garden once online. Turn on Airplane Mode, swipe it away, open it again. **Pass:** the signed-in app
    appears (Today, Plan) instead of "Couldn't reach".

Anything that fails here changes spec §2b before the player (Task 4) is built: the likely amendments are an
on-screen "keep the screen on" note if wake lock is unavailable (older iOS), and visual-only cues if audio cannot be
unlocked or is muted by the silent switch.
