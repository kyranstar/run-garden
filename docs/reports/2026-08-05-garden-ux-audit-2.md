# Garden UX Audit II — the reward loop, celebrations, and the next content frontier

*2026-08-05 · Follow-up to `2026-08-04-garden-ux-audit.md`, audited at `main` @ e365b4d (grainlight + hybrid rivers). Produced by a four-agent sweep (engine reward model, screen UX, feedback infrastructure, renderer capability) plus direct verification. All file:line refs checked against this tip.*

---

## Where we are

Yesterday's audit prescribed three bundles. **Bundles 1–2 and most of 3 shipped within a day**: the full-viewport HUD stage, silhouette outlines + hit pads, continuous bar decay + damage notches, the forecast line, the overnight beat, the unlock ceremony, timeline chapters + forward scrub, botanical provenance, per-plant tint jitter, earned grounds (stream/terrace/glade/meadow) with real rivers, and deterministic rare visitors. The information layer is now genuinely excellent — few products explain cause→effect this carefully.

**The diagnosis has therefore moved.** The old problem was *surfacing* (the engine knew things the page didn't say). The new problem is **timing and sensation**: the page says the right things, but often a day late, sometimes never, and almost nothing *moves* when something happens. Plus: the shipped systems created content debts (rivers with no aquatic life, grounds without their promised exclusive species, a ceremony that misses its own moment).

Structure: **A** — the reward moment is structurally unreliable · **B** — earned moments that never reach the user · **C** — species/achievement content · **D** — dynamism between events · **E** — core-app quick hits · ranked top 10.

---

## A. The reward moment is structurally unreliable

The product promise is "complete a run and it rains." The data layer delivers that; the presentation layer loses it in four independent ways. These compound: fixing any one still leaves the moment dropped by the others.

### A1. The garden never updates while you look at it — highest-leverage fix in this audit

- `["garden"]` has **no `refetchInterval` and is invalidated by nothing** in any completion path. `MatchSheet`'s match mutation (`packages/ui/src/screens/match-sheet.tsx:23-28`), `UnresolvedCard` skip/defer (`today.tsx:164-169`), and `LinkSheet` link (`runs.tsx:99-104`) all invalidate `today`/`plan`/`runs` — never `garden`. The only blanket invalidation is calendar-choose (`settings.tsx:207`).
- `refetchOnWindowFocus: false`, `staleTime: 15_000` (`app.tsx:15-24`) — so the scene refreshes only on remount.
- The canonical flow is a race the garden loses: open app → `api.readNow()` fires on mount (`garden.tsx:875-877`, result swallowed) → bridge syncs → DB updates *after* the mount fetch already returned. The `today` query polls at 60s (`today.tsx:290`) and sync-status at 30s (`today.tsx:35`), so the user literally watches the **dock** flip to "completed" while the **scene** stays dry until they navigate away and back.

**Fix (small):** invalidate `["garden"]` (and `["garden-timeline"]`) from the SyncPanel poll whenever `lastSyncAt`/pending counts change; add `["garden"]` to the three mutation invalidation lists; optionally give the garden query its own 60s `refetchInterval` while the route is mounted. Everything else in this audit depends on the fresh snapshot actually arriving.

### A2. Same-day feedback silently dies whenever the sim lags

The preview (the only "your run just did this" mechanism) requires the durable sim to be **exactly** at yesterday: `advanceGarden` `break`s on any unresolved day inside its 2-day grace (`apps/worker/src/services/garden-sync.ts:327-331`), and the preview is then skipped with no user-visible trace (`garden-sync.ts:517-533`). One unresolved workout two days ago → today's run produces zero visible change and no explanation.

**Fix:** either preview across the gap (fold `simulateDay` read-only over the unresolved days with neutral inputs), or say so ("The garden is catching up — one workout from Tuesday needs an answer") instead of silence.

### A3. The ceremony misses its own moment

The single genuine celebration (`UnlockCeremony`, `garden.tsx:670-755`) has four failure modes:

1. **Same-day unlocks never ceremony.** `sinceVisit` filters `preview: true` events (`garden.tsx:994-996`), so a species you unlocked with *today's* run degrades to one plain sentence in `todayLines` — capped at 2 (`garden.tsx:973`) so it can be truncated away entirely — and the ceremony fires ~24h later, when you already know.
2. **A refresh destroys it forever.** `lastVisit` is read once from `localStorage["rg-last-visit"]` (`garden.tsx:794-797`) and overwritten on load (`:881-890`). Second page load same day → gone. New device / private window → never fires at all; the unlock becomes a static "New" ring buried in the Collection drawer (`codex.tsx:382`).
3. **Multiple unlocks collapse** to `ceremonyEntries[0]` + an inert `+N more` span (`garden.tsx:737, 1319-1320`).
4. **Route-locked** — unlock while on Plan/Insights and navigate back later: consumed.

**Fix:** move seen-state server-side (a `lastSeenEventSeq` per user — `garden_events` is already durable and ordered), let preview `species_unlocked` events fire the ceremony immediately (dedupe when the durable row lands next day), and queue multiple ceremonies. This also un-links celebration from the Garden route: any screen can carry a small "🌿 1 new species" chip that opens it.

### A4. The two most recency-critical voices compete, and the older one wins

`todayLines` (what your run did *today*) is suppressed entirely whenever `beatLines` (since-last-visit) has content — the ternary at `garden.tsx:1546-1556` / `:1293-1311`. Caps of 2 and 3 with `join(" ")` flatten a big day into truncated prose with no link to the full log. **Fix:** merge into one "arrival" block: ceremony first, then beat lines, then today lines, with "see all → Log."

### A5. Nothing moves when the state changes

Every animation in the product is either an ambient loop or an entrance transition; **zero animations are triggered by product events** (full inventory: feedback-sweep agent; keyframe census `styles.css` + `GardenScene.tsx:110-139`). Concretely:

- A new plant **pops in** fully formed — no sprout/settle (renderer recomputes paths per render; no transitions; confirmed no SMIL, no springs).
- Weather flips **snap** — `fresh_rain` appears with no rain-front arriving; the atmosphere layer *cannot* express an event by construction (every particle is analytic in `t`; system membership is a pure function of weather × period — `particles.ts:33-43, 73-127`; there is no one-shot channel).
- Balance bars **snap** — `.balance-bar-fill` has no width transition (`styles.css:1814-1818`), while the codex progress bar *does* have one (`styles.css:2968`). After a run, the water bar teleports to full.
- No system-driven plant highlight exists — the outline filter (`GardenScene.tsx:748`) is user-selection only.

**Fix path, respecting the two hard constraints** (determinism of rng draw order; filters on ≤1 plant + ≤13 trees — see the 08-04 rendering appendix):

a. **Balance fill transition** — one CSS line. Do this first.
b. **Sprout-in for new plants** — newly-added plant ids are known from `plant_added` preview events; wrap those groups in a transform-only entrance (scale-from-base over ~600ms). Transforms don't touch the rng stream and cost nothing at 1–2 plants/day. This is the 08-04 audit's own unshipped line: *"the new plant literally sprouts during the beat."*
c. **New-plant glow** — apply the existing selection outline, system-driven, to the newest plant for the first viewing (it's sanctioned for one plant at a time, `sky.tsx:64`).
d. **A one-shot impulse channel in AtmosphereLayer** — add an `impulse?: {kind: "rain_front" | "sparkle", at: number}` prop; a system whose particles are analytic in `(t − at)` preserves the pause/resume property. First use: a rain front sweeping across when weather transitions into `fresh_rain` while mounted (i.e., exactly the A1 moment). Second use: a brief golden sparkle over a new rare plant.
e. **Cross-fade between snapshots** — two stacked scenes, opacity swap over ~600ms (full-scene static rects are the sanctioned filter/blend surface). Optional; a/b/d may make it unnecessary.

---

## B. Earned moments that exist in data and never reach the user

The feedback-sweep found the app has **no toast/snackbar system, no positive delivery channel, and zero out-of-app reach** — while `SyncNotesStack` (dismissible, polled 30s, mounted on Garden/Plan/Today/Studio) is reserved for its 4 conflict kinds (`apps/worker/src/services/sync-notes.ts:8-9`). The celebration infrastructure exists; only bad news uses it.

| Moment | Where the data layer knows | What the user gets |
|---|---|---|
| New personal record | `misc.ts:743-744` literally computes `records !== storedRecords` — then discards it | Anonymous `<ul>` bullet on Insights (`insights.tsx:467-479`) |
| Weekly LLM review (with a mandated "what changed in the garden" beat, `llm.ts:120-129`) | Written Mon 20:00 (`index.ts:227`) | Bottom of the 4th nav screen; no unseen-dot, no `seenAt` column, no mention anywhere else |
| Region/ground unlocked | Ceremony-grade copy already written (`garden.tsx:161-169`: "Long runs carved the stream — new ground, new water") | Rendered as a plain sentence; grounds are *rarer than species* |
| First arrival of each wildlife kind | `wildlife_arrived` event | One text line; the renderer draws the animal but there's no arrival moment |
| Rare planting | Rarity known at plant time | `eventSentence` is rarity-blind — "A Garden dahlia took root" reads identically to clover. The 08-04 canon explicitly sanctioned distinct verbs + a sparkle (§1.6); unimplemented |
| Weekly consistency chain | `consecutiveConsistentWeeks` + vines | Visible only inside a vine's botanical card. The canon's §1.3 ("show current + longest, never render a zero") is unimplemented. **Worse: Insights renders a daily streak** (`insights.tsx:325` "{N}-day streak") — the exact mechanic the canon killed as dishonest. Replace it with the weekly chain |
| Wildlife tenure | `gardenWildlife.since` persisted (`garden-sync.ts:132`) | Dropped by `buildGardenView` (`:625-629`). "Bees have been here since March" is free and never shown |
| Fireflies progress | `eveningRunCount` | No `gateProgress` case, no display anywhere — a 10-evening-run requirement with invisible progress |
| New activity imported / auto-matched | `IngestStats.newActivities` (`completion.ts:436`) | Returned only to the sidecar; pills flip silently |

**Fixes, in canon voice (garden asks, never accuses; weight the presentation, not the odds):**

1. **A positive event channel.** Generalize sync-notes into a `moments` feed (or just render positive `garden_events` through the same stack): PR set, review ready, ground carved, first-of-kind wildlife. Dismissible, quiet, one at a time.
2. **PR moments without PR metrics.** The canon keeps pace/distance numbers off the garden — but a record *moment* is not a metric: return `newRecordIds` from the insights route, show a "New" pill on Insights and one beat line. Longest-run records already have garden-native species (`milestone_oak`, `horizon_cedar`) — let the beat say so.
3. **Review surfacing.** Unseen-dot on the Insights nav item + a Monday/Tuesday one-liner on the garden ("The week's story is written — read it →"). Cheapest honest version: client-side last-seen weekStart.
4. **Promote region unlocks (and first-ever wildlife) to the ceremony pattern.** The copy is already written.
5. **Out-of-app reach — the biggest missing retention lever.** Nothing exists: no push, no email, and the desktop tray (`lib.rs:553-568`) is a static menu. Day-13 drought-eve is precisely when the user is *not* opening the app. Start desktop-first (tray already ships): dynamic tray title/tooltip from the forecast + `tauri-plugin-notification` for at most two moments — drought-eve ("Rain needed by Friday") and ceremony-pending. Forecast voice, amber never red, rest/taper always silent. PWA web-push later if ever.

---

## C. Content: the achievement space has obvious empty rooms

46 species / 15 gate kinds / 9 wildlife / 4 visitors / 4 grounds is a real collection. The gaps are specific:

### C1. The rivers have no life in them — grounds shipped without their promised exclusives

The 08-04 plan for earned terrain (§8b) specified "2–4 exclusive species, one wildlife affinity" per ground. What shipped: terrain art + ceremony copy + placement displacement — **no ground-gated species, no ground-tied wildlife**. The newest, most beautiful feature (hybrid rivers) hosts nothing: no waterlily, cattail, reed, marsh marigold; no ducks/fish; the heron visits on a training pattern but has no affinity for the stream it should be wading in. Strength species (stonecrop/ironwood/terrace fern) exist but aren't terrace-linked; yoga species aren't glade-linked.

**Fix:** add a `ground` gate kind (`{kind: "ground", ground: "stream"}`) — deterministic, versioned (`SIMULATION_VERSION` bump), and give riparian species a placement bias toward the bank band that `riverSystemFor` already exposes. 3–4 aquatic species + duck/fish wildlife gated on a stream existing is the single highest-joy content batch available.

### C2. Race day is uncommemorated

`race` is folded into quality (`simulate.ts:476-487`): the emotional peak of a training block plants a generic flower. Add race-gated commemorative species (a "victory laurel" at 1 race; provenance already names the workout — "Planted by 'City Half Marathon'" is built). And `distance_run` gates stop at 21,097m — **there is no marathon species.** Add 42,195.

### C3. Implemented machinery with nothing behind it

- `mature_trees` gate: fully implemented (`unlocks.ts:37,75,117`), **zero species use it**. Natural fit: an old-growth/canopy species ("grow 3 trees to maturity").
- `eveningRunCount`: counter only. A night-bloomer ("moon garden" species) would pair with the existing fireflies + moon-phase rendering.
- `balanced_weeks`: one species at 3 weeks, then the mechanic goes silent forever. Add 8/16-week tiers.
- `total_runs`: stops at 50 (century rose). Add 100/250.
- `comeback`/`dead_wood`/`start` gates return null progress so those species never appear in any nudge surface (`unlocks.ts:133-135`, `codex.tsx:147-168`) — fine for emergent gates, but the codex cards could still carry their hint as a teaser row.
- Garden anniversary: `createdDate` is persisted and never celebrated. One heirloom species or a returning-visitor moment on the garden's birthday.
- Seasonal drift (canon-sanctioned as *cosmetic only*, §9.6): species bloom tints by season, spring blossom weeks — no mechanics, no FOMO.

### C4. Micro-habitats (the 08-04 "ship now" item) remain unbuilt

Zone language ("thriving in the damp corner") for placement + botanical cards. Still the right cheap legibility win, unchanged from yesterday's writeup.

---

## D. Dynamism: the world between events

### D1. The sun is frozen on the garden screen

`hourOfDay` is sampled once per render (`garden.tsx:802`) with no tick — leave the stage open and the light never moves, then jumps on the next interaction. **The ambient screensaver already solves this** (30s interval, `ambient.tsx:107-114`). Port the interval. This is the cheapest "it's alive" win in the codebase, and it makes the desktop stage a true ambient surface.

### D2. The scatter is frozen forever

Every non-plant seed is a constant literal (`terrain:meadow`, `sky:stars`, `weather:clouds`, all nine `wildlife:*` — renderer sweep §6): clouds, stars, meadow strokes, and every bird sit in identical positions every day, for every user, forever. Key a few scatter seeds by date (`sky:stars:{lastSimulatedDate}` daily; meadow weekly) — determinism is preserved (the date is in the snapshot), and each day genuinely looks like a new day. Respect the render-N-draw-K pattern; new keys only.

### D3. The rainbow is functionally unreachable

`recovery_rain && inComeback && period ∈ {golden, dawn}` (`lighting.ts:409-412`) — the crown celebration of a comeback shows only if the user opens the app in two narrow hour bands. Widen to any daylight period on the first comeback day. The comeback is the product's most important emotional beat; its reward should not depend on opening the app at 7am.

### D4. A narration capability is hidden in the accessibility layer

`describeGarden` (`describe.ts:87-128`) writes 2–4 sentences of prose — condition, families, weather, visitors, notable states — and is surfaced **only** as the SVG aria-label. Use it visibly: the ambient caption (currently just counts), a "field notes" line, or the log's daily header.

### D5. The timeline throws away its own story

`buildGardenTimeline` has `result.events` in hand and returns only `{snapshot, condition}` (`garden-sync.ts:643-694`); the client then lossily re-derives chapters by diffing snapshots (`garden.tsx:95-116`) — one generic chapter per day max, no species names, no wildlife/comeback detail. Return event kinds + speciesIds per day: chapters become "The dogwood arrived," replay becomes a narrated story, and "Replay since your last visit" becomes the visual form of the overnight beat (the 08-04 §9.1 vision).

### D6. Ambient screensaver gaps

No `visitor` prop passed (`ambient.tsx:176-184`) — the surface with the longest dwell time never shows the product's one variable reward. Plants render `role="button"` + pointer cursor with no handler (dead tab stops; renderer should drop interactivity when `onSelectPlant` is absent). Sound was canon-sanctioned *for this surface only* and remains unbuilt — a single quiet rain/birdsong bed, default off, is in-bounds.

### D7. Design question to settle (not a recommendation): readiness

The engine has no overtraining concept — more running is monotonically better — while the app already ingests readiness (`Readiness` renders on the garden page). The canon's anti-guilt stance suggests the forecast could *yield* on poor-readiness days ("The garden can wait a day — rest is also tending") rather than pushing rain. Deliberate scope decision; flagging, not prescribing.

---

## E. Core-app quick hits

1. **Onboarding undersells the product.** The garden step is five emoji bullet lines (`onboarding.tsx:306-326`) — no rendered scene, no mention of the collection, rarity, wildlife, visitors, tri-discipline balance, timeline, or provenance. The welcome tagline doesn't mention the garden. Render a real `GardenScene` demo snapshot (the growth-GIF pipeline proves it) and name the collection + balance.
2. **Error states:** garden load failure = bare EmptyState with **no retry** (`garden.tsx:908`, and `!garden.data` conflates error/empty); timeline failure = silently disabled slider (no error branch, `garden.tsx:922,1125`); old cached payloads silently drop the whole BalanceStrip (`garden.tsx:916`).
3. **Links that should exist:** provenance renders the workout title as plain text with the id in hand (`botanical.tsx:92-96`) → make it `Link to /plan?workout=`; garden log rows are inert `<li>`s; activities on `/runs` have zero garden connection (no "grew the foxglove" line, rows aren't clickable, no per-activity route).
4. **Plant sheet shows its date twice** — `describePlant` ends with a raw ISO date and the next row formats it properly (`describe.ts:133` + `botanical.tsx:96`). Drop the date from `describePlant`.
5. **Touch-dead tooltips** in garden surfaces: `CorosPill` explanations, WeekRibbon day-dot titles, matched-pill workout name, DiversityStrip segment counts (`components.tsx:127`, `garden.tsx:641`, `runs.tsx:251`, `garden.tsx:229`) — backlog #15's instances, enumerated.
6. **Dead/vestigial code:** `TodayScreen` + `GardenPreview` unrouted (its `TodayResponse.garden` payload is served on every `/api/today` and consumed by nothing — needs the pending delete-or-reroute decision); `garden.data.nextUnlocks` computed server-side and discarded (`garden.tsx:977` unused var); `NextUnlockNudges` exported, never mounted; `CompletionPill` unreachable second return (`components.tsx:265-270`); codex sprites request sway classes whose keyframes don't exist (`codex.tsx:97` — either inject `sceneCss` or drop `animate`); `usePrefersReducedMotion` never subscribes to changes (`garden.tsx:67-73`); `/` and `/garden` duplicate routes.
7. **`docs/GARDEN_ENGINE.md` is stale** — documents simulation v1 / 34 species; code is v3 / 46 with tri-discipline, grounds, visitors. It will actively mislead future sessions; update or delete.

---

## Ranked top 10 (impact ÷ effort)

| # | What | Size | Why first |
|---|---|---|---|
| 1 | **A1** — invalidate/poll `["garden"]` so the scene updates while watched | S | Every other moment depends on the fresh snapshot arriving |
| 2 | **A5a–c** — balance-fill transition · sprout-in · new-plant glow | S–M | The three cheapest "something happened" sensations |
| 3 | **A3** — same-day ceremony + server-side seen state + queue | M | The best moment in the app currently fires a day late and dies on refresh |
| 4 | **D1** — tick the sun on the garden screen (port ambient's interval) | S | Cheapest alive-ness win in the codebase |
| 5 | **B1/B2** — PR "new" surfacing + weekly-review unseen-dot & garden pull | S–M | Two finished features currently invisible; also fix the canon-violating daily streak on Insights |
| 6 | **C1** — stream/terrace/glade exclusive species + water wildlife (`ground` gate kind, versioned) | M–L | The rivers are the product's face and have nothing living in them |
| 7 | **B3/B4** — region-unlock ceremony + rarity-weighted log verbs/sparkle | S | Copy already written; canon already sanctioned |
| 8 | **A5d** — atmosphere impulse channel (rain-front on completion) | M | The signature moment: watch the rain arrive because you ran |
| 9 | **B7** — dynamic tray + 2 desktop notifications (drought-eve, ceremony-pending) | M | The only out-of-app reach; forecast voice keeps it honest |
| 10 | **C2/C3** — race laurel · marathon cedar · old-growth (`mature_trees`) · night-bloomer · anniversary | M | Fills every implemented-but-empty gate with one batch |

**Canon compliance notes for whoever implements:** no daily streaks (replace the Insights one), no vitality numbers, one loss voice at a time (already enforced — `lossVoiced`, `garden.tsx:1042-1044`), taper/rest always win, weight presentation never odds, all new randomness via fresh seeded keys, engine changes bump `SIMULATION_VERSION`.
