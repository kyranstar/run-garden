# Garden Page — UX Audit & Design Options

*2026-08-04 · Produced by a four-agent parallel audit (rendering, engine mechanics, UX/layout, gamification design) on the `garden-ux-audit` worktree (base: `main` @ 9d9f78f — garden code identical to `insights-dashboard`). Raw agent reports are in the appendix files alongside this one.*

---

## The diagnosis in one paragraph

**The engine is ahead of the UI.** The simulation already implements one of the best gentle-loss systems in the genre — 14-day decay windows with grace days, damage that escalates through five visible stages, deaths that compost into habitat and unlock fungi, streak counters, comeback arcs, per-plant workout provenance, and a pure forward-simulable `simulateDay` — and the page surfaces almost none of it. Meanwhile the garden itself renders at a **fixed ~800×448px card on every desktop** (~17% of a 1920px screen) above ~4 screens of stacked cards, with three specific rendering flaws (decal shadows, zero per-instance color variation, no depth fade) that make it read flatter than it is. Most of what you asked for is a *surfacing* project, not a systems project — and the hardest piece (full-bleed immersive rendering) is already proven by the ambient/screensaver mode, which renders the same `GardenScene` edge-to-edge with overlay captions.

---

## 1. Gamifiable metrics that describe the effect

**Rule that survived the brainstorm: a metric earns a slot only if pointing at the garden can prove it.** Four metrics, one per question a runner actually asks:

| Metric | Question it answers | Display | Visible garden consequence |
|---|---|---|---|
| **Condition** | "How is it doing?" | The condition word (exists today) | The whole scene: weather, bloom, ground tone |
| **Forecast** | "What happens next?" | One line: *"rain needed by Thursday, or the soil starts to dry"* | The next weather transition, on schedule |
| **Weekly rhythm** | "Am I consistent?" | Chain of consistent weeks + "longest: N" | Vines literally exist only because of this counter (`consecutiveConsistentWeeks` gates all four vine species) |
| **Collection** | "What have I earned?" | "26 of 46 species" + family bar | Every entry is a plant in the scene |

The three balance bars stay — as a **diagnostic instrument with damage notches** (§2), not a headline score.

**Deliberately killed:** a 0–100 vitality number (the condition word *is* vitality, verbalized; a number re-abstracts the thing the garden exists to de-abstract), adherence % (lives in Insights), daily streaks (the engine forgives days by design — a daily streak would be dishonest and is the genre's #1 anxiety mechanic), pace/distance anything (COROS's job), plant count as a goal (population caps make it a plateau).

---

## 2. The three bars, shrinking toward damage + "days to save it"

### Ground truth (from the engine audit)

- Bars already shrink: `health = clamp01(1 − max(0, days − grace)/14)`, grace = 2 (run) / 3 (lift) / 3 (yoga) → zero at day 16/17/17 (`balance.ts:4–29`). But they update **stepwise, one step per simulated day, lagging wall-clock by up to 2 days** — between app opens the bar is frozen.
- **Bar-zero and garden damage are different clocks.** Real consequences, keyed to `daysSinceCompletedRun`:

| Day | What visibly happens |
|---|---|
| 4 | Dry stage: weather → `dry_spell`/`light_clouds` (a 50/50 per-date coin flip — same stage, not sequential), condition → "a little dry", blooms close at −0.5/day |
| ~10–14 | Plants render *thirsty* (droop) as hydration crosses 0.35 |
| 14 | **Drought**: `mild_drought`, straw patches + cracks appear, passive growth stops |
| 30 | Dormancy waves (2 lowest-hydration non-trees/day) + **wildlife departs** (only if all three discipline clocks ≥ 30) |
| 60 | **Real, irreversible deaths** — 1 plant per 4 days, lowest-health non-tree first, *victim nameable in advance* |
| 120 / 150 | Trees may die / the last plant may die |

- Everything before day 60 **fully recovers**: one planned run = hydration +0.35, health +0.08, dormant plants wake, and the comeback arc deliberately makes returning feel better than never leaving (extra watering, blooms reopen after 2 comeback runs, drought gates the mushroom/phoenix-fern unlocks).

### The design (recommended)

1. **Bars decay continuously, client-side.** The formula is closed-form and the UI already imports `@rg/garden-engine` — export `projectedBalance(state, asOf)` and add wall-clock fractional days since `lastSimulatedDate`. Display-only; the durable sim is untouched. This delivers your "bars get smaller over time" literally — you can watch them shrink between visits.
2. **Damage notches on each track.** A small tick at the day the *consequence* starts (day 4 run / day 7 lift & yoga soil/life decay, mapped onto the 14-day track). The fill approaching a visible notch communicates "until damage" silently — no extra text per bar.
3. **The Forecast line** — the countdown, whole-garden, weather-native (this is the "days to save it"):
   > *Growing · light clouds — **rain needed by Thursday**, or the soil starts to dry.*
   > *A little dry · **drought in 5 days** — your next run turns it around.*

   Forecast voice, weekday phrasing ("by Thursday" reads as an appointment; "3 days left" reads as a bomb), amber never red, names the garden's need, never the player's deficit. On comeback days the same slot flips positive: *"Recovery rain — 2 more runs and the blooms reopen."* A forecast that is sometimes good news is what keeps it from being a nag.
4. **Per-plant stakes only inside drought (day 14+),** replacing — not joining — the forecast line: *"If the dry spell holds, the sword fern goes dormant this week — one run brings it back."* The engine deterministically picks the victim, so this is honest. Never count down to death before day 60; past day 60 the copy may say "dying (permanent)" because it finally is.
5. **A "do-nothing preview" is nearly free** (see §8, damage preview): `simulateDay` folds forward over future dates deterministically; the emitted events read as narrative — *"in 6 days: drought · in 23 days: 2 plants go dormant · in 41 days: your Field poppy dies."*

### Honesty bugs to fix before shipping any countdown

1. A run done yesterday shows `days: 0` → rendered "today" (sim lags a day; caption lies).
2. **Strength/yoga clocks keep ticking during plan gaps while their neglect damage is gated off** — bars shrink toward a consequence that never fires. Freeze the fill (or caption "plan paused").
3. `balance.overall` pins to 0 for never-practiced disciplines (`days: null` but the clock grows from genesis).
4. UI weather copy implies clouds → dry spell are sequential stages; the engine flips a coin between them at day 4. Align the copy.

### Tone guardrails (from the gamification audit)

- **At most one loss-flavored element speaks at a time** — bars + condition + weather + countdown + banner during a bad week must not stack into five sad signals; the rest stay visual.
- **Rest mode**: hide forecast + notches entirely (banner already owns that state). **Taper**: planned rest days already don't advance the run clock, and the plan is loaded on the page — if no run is due before the threshold, suppress the forecast: *"Taper week — the garden holds its water."* Punishing a taper would be the worst possible failure.
- At drought-eve, the threat moment becomes the compassion moment: *"Going to be away? Rest mode pauses everything."*

---

## 3. Desktop layout — garden as big as possible, species & log on top

### What constrains it today (from the layout audit)

- `.shell-main` caps content at **880px** → the garden is ~800×448 at every desktop width, framed as *a card among cards* (1px border, 12px radius). At 1920×1080 that's ~17% of the screen with ~415px dead margin per side.
- The page is a ~3,200–4,000px single column; the species card alone is ~2,000px. The emotional centerpiece is the first 14% of a 4.5-screen scroll.
- **The full-bleed path already exists**: `ambient.tsx` renders the same `GardenScene` with `position: fixed; inset: 0`, `preserveAspectRatio="xMidYMax slice"`, and text-shadowed overlay captions. Immersion is a CSS/layout project.
- **Free real estate**: plants occupy only y = 290–540 of the 560-unit viewBox. The top ~52% of the artwork is sky and hills — a persistent HUD there occludes zero plants.

### Options

**A — "Big hero"** (low cost, ~1 day): full-main-width garden at `min(78vh, …)` with `slice` fit; condition/weather/bars as glass chips floating in the sky band; page keeps its (reordered) flow below. Doesn't solve the 2,000px tail.

**B — "Game HUD"** (recommended destination): the garden **is** the page — fills everything right of the nav, 100dvh, no scroll. Translucent glass top strip in the sky band (condition · weather · bars · timeline). "Growing next" as a single HUD chip. Today content in a collapsible dock (bottom-left, remembered-collapsed to a pill). **Collection and Log as right-edge glass drawers that slide in over the garden** (a `Drawer` = the existing `Sheet` generalized; Esc/backdrop close). Banners become toasts; the UnresolvedCard keeps its centered sheet since it demands a decision. Mobile falls back to A's stacking with drawers becoming the existing bottom sheet.

```
┌─side─┬────────────────────────────────────────────────────────┐
│ nav  │ ░ Flourishing · fresh rain      Run▓▓ Lift▓░ Yoga▓░  ░ │ ← glass strip (sky band)
│      │                                          ┌───────────┐ │
│      │        . . . g a r d e n   a r t . . .   │ COLLECTION│ │ ← drawer over the
│      │            (fills viewport, slice)       │ ▦▦▦ 26/46 │ │    right edge
│      │ ┌──────────────────────┐                 └───────────┘ │
│      │ │ Next: Tempo 40min    │   [🌿 1 more                  │
│      │ │ today 6 AM  [View][×]│    long run ▓▓░]              │
│      │ └──────────────────────┘  [Collection][Log][Timeline]  │
└──────┴────────────────────────────────────────────────────────┘
```

**C — "Canvas-first split"** (~70vh stage + persistent bottom shelf of expanding panels): zero occlusion of the art, but the shelf permanently taxes ~30% of vertical space and the garden never truly fills the screen.

**Recommendation: B, staged through A** — commit 1 is A's hero + chips + block reordering (no new components); commit 2 adds the drawer/dock layer. Legibility rule for anything over the SVG: glass panels (`color-mix(...72%, transparent)` + `backdrop-filter: blur`), never raw text over artwork; persistent overlays live in the sky band or hug edges. Watch: full-viewport SVG + atmosphere canvas at 1920×1080 needs a perf check; a slice-crop at very wide aspect needs a max-height guard.

---

## 4. Species organization

Species live in the **Collection drawer**, with "Growing next" as its always-visible HUD teaser (nearest unlock + mini progress bar; click opens the drawer scrolled to it):

1. **Header = the diversity strip, promoted** to a segmented family bar with counts ("26 of 46 · 5 of 8 families"); segments filter/anchor. This unifies the two currently-disconnected taxonomies (strip legend vs flat codex grid — `CATEGORY_ORDER`'s per-family colors never reach the codex today).
2. **Group by family**, section header per family ("Trees · 4 of 9"). Within each: **unlocked** (live sprite card + count + `unlockedOn` — data exists, never shown — with a "New" ring for the last 7 days), **next up** (1–2 nearest locked at full card size with visible hint + progress), **distant locked** (compressed silhouette tiles so 30 far-off species stop dominating).
3. **Rarity as one consistent tier** everywhere (the existing pill + a border tint), instead of today's three different treatments.
4. **Tiles become buttons** opening the same botanical-card popover as tapping a plant (§5). Today codex cards are unfocusable `div`s whose hints are hover-only `title` attributes — invisible on touch and to AT.
5. **Wildlife graduates** from title-tooltip chips to the same card pattern, absent ones showing their visible arrival hint ("Butterflies visit when 3 flowers bloom").

---

## 5. Click cleanup — true silhouette outlines & beautiful popups

### Outlines that hug the artwork

Today: selection = a flat cream **ground disc** sized to the species' *full-grown* footprint (a seedling lights up a huge plate), keyboard focus = the browser's axis-aligned bbox ring, and the hit target is **painted pixels only** — a grass tuft is a needle-thin click target.

**Recommended: SVG filter outline on the selected plant** — `feMorphology dilate` on `SourceAlpha` → harden alpha (sprites contain semi-opaque ellipses that would ghost) → `feFlood` accent → composite under the art. Exact silhouette hug including stroke-only geometry (grass blades, willow fronds); define once in `SceneDefs`; widen the filter region so crowns and sway don't clip; two-layer variant (wide soft halo + 1.3-unit crisp line) looks best. Perf is trivial on the one selected plant — never scene-wide. Alternatives assessed and ranked lower: duplicate-sprite stroke underlay (crisp but uneven halo width on stroke-only archetypes), stacked CSS drop-shadows (blurry, most per-frame cost).

Pair with two fixes that matter as much as the outline: an **invisible hit-pad ellipse** (`pointer-events: all`, maturity-scaled) so small plants are tappable, and a `:focus-visible` rule applying the same filter so keyboard selection stops being a bbox rectangle.

### Popups worth the click

One **botanical card** design serves both surfaces (tap a plant / tap a codex tile): large sprite portrait on the soft-green ground, display-serif name, family + rarity chips, then facts — planted date, **provenance** (*"Planted by your Tuesday 10k, March 3"* — `sourceWorkoutId` exists on every plant; today the sheet says only "planted by one of your workouts"), how it's earned with live progress, wildlife it attracts, habitat story if died back. Fix the `Sheet` while building it: move focus in on open, trap it, restore on close (currently `aria-modal` is declared but Tab walks into the background — the page's biggest a11y gap), add a slide/fade entrance, drop the fake drag-handle on desktop.

---

## 6. Shadows — subtler and more plausible

Today each plant casts **one flat ellipse**: hardcoded `#233a1d` at all hours over all terrain, sized by planting *footprint not height* (a clover patch can out-shadow a birch), growing symmetrically on both sides while only its center shifts — so at long-shadow hours it spills ~40 units **toward the sun** — with no penumbra, painting over farther plants' foliage.

**S1 — ship this (small):** split into **contact core + directional cast lobe**. Contact: small, dark, nearly invariant. Cast: pinned at the base edge (`cx = shadowDx·rx`), elongating only *away* from the sun with `shadowLen`. Add a `shadowColor` token to `SceneLight` mixed from terrain + sky — shadows then track drought straw, night blue, and dusk violet for free. +1 node/plant, zero filters, fixes direction, color, and grounding at once.

**S2 — the tree upgrade (medium):** true **silhouette cast shadows via `<use>`** of the plant's own art group, flattened onto the ground (`skewX(−shadowDx·35) scale(1, −0.25·(0.5+shadowLen))`) through one shared alpha→flood(+blur) filter. A conifer casts a triangle, a birch casts an airy crown — and because the clone carries the sway class, **the shadow sways in sync for free**. Gate to mature trees only (≤13 by engine cap); that stays inside the perf envelope (the audit's rule: filters are fine on 1 selection + ≤13 trees; per-plant filters across 84 animated groups are the cliff).

Skip S3 (multi-lobe canopy mirroring) — lobe geometry is locked inside archetype closures behind a sequential PRNG; S2 delivers strictly more realism without the refactor.

---

## 7. Depth & variety

Depth today = y-sort + 0.65–1.0 depth scale + hazed hills. Color variety today = **zero per-instance variation** — two field poppies are chromatically clones — and terrain is four flat bands plus meadow strokes.

Ranked cheap deterministic wins (the first two are ~10 lines each):

1. **Back-row haze** — scale the *existing* per-plant `tint` prop by `(1 − position.y)` toward the haze color + slight desaturation. The plumbing exists end-to-end; instantly separates rows.
2. **Per-plant hue/sat jitter** — ±6° hue, ±8% lightness in `paintFor`, drawn from a **fresh rng key** (`tint:{plant.id}`). ⚠️ Determinism contract: never extend an existing sprite's sequential PRNG stream — new draws need new keys, or every existing garden's geometry silently reshuffles.
3. **Terrain moisture/soil patches** — seeded soft ellipses mixed from `grassNear`/`soilHealth` (the drought-straw-patch pattern already in `terrain.tsx` is the template). Soil health finally becomes *visible*, which the strength bar can point at.
4. **Soil texture/pebbles** in the front band (grain filter pattern already exists; keep out of animated subtrees so the raster caches).
5. **Earned features** — a stepping-stone path or rocks keyed to `unlockedRegions`/counters; overlaps with the biome work below.

---

## 8. The biome question

Three tiers were pressure-tested against the "does it overwhelm the metaphor?" worry:

**(a) Micro-habitats — ship now, zero metaphor risk.** Name 3–4 zones *inside the existing scene*: **the damp corner** (ferns, mosses, frogs), **the sunny bank** (flowers, thyme, bees), **the rocky edge** (stonecrop, ironwood — lifting literally builds the garden's stonework), **the old log** (the existing dead-wood habitat, formalized). Species get a zone preference biasing the already-seeded placement; plant cards and the diversity strip speak zone language ("thriving in the damp corner"). Mainly *legibility* for the 46 species that exist + a few new zone-flavored ones. This **strengthens** "one place you tend" by giving the place anatomy.

**(b) Earned terrain — the destination.** Re-theme the *existing* region-expansion system (6 regions × 14 plants, unlock at 75% capacity — currently a mute log line): when expansion fires, the **kind** of new ground is chosen deterministically from the dominant training counters since the last expansion — long-run dominance carves **the stream** (willow, wisteria, dragonflies), strength builds **the stone terrace**, yoga clears **the still glade**, balanced weeks open **the meadow**. Each ground: 2–4 exclusive species, one wildlife affinity, and a named ceremony — *"Eight weeks of long runs carved the stream."* Pure function of existing counters → determinism survives; needs a `SIMULATION_VERSION` bump since replay output changes. The real cost is terrain art. This is the strongest possible answer to "clarify the garden's composition" and it unlocks species honestly.

**(c) Full biome progression / seasons-as-mechanics / multiple gardens — don't.** It splits the emotional investment that makes a solo product work (Animal Crossing works because it is *one* island; Finch because it is *one* bird), fights the timeline scrubber's promise (your whole history, one place, one replay), multiplies renderer art combinatorially, and mechanical seasons would introduce FOMO — the one dark pattern the product has completely avoided. The ambition budget is better spent making one garden feel infinitely deep.

---

## 9. Immersion levers beyond metrics (ranked)

1. **The overnight beat** — highest ROI on the page. On open after ≥1 simulated day: a ~3-second arrival moment — sky settles into today's weather, then 2–3 lines: *"Since Tuesday: rain fell twice · the cherry opened · bees returned."* All data exists (`garden_events` since last visit; `eventSentence` already renders them). Unlock ceremonies live here — today a new species is one grey log line; the reveal should BE the reward (the new plant literally sprouts during the beat). This converts determinism's weakness (nothing happens while you watch) into its strength (things *provably happened* while you were away).
2. **Provenance** — "Planted by your Tuesday 10k" (an afternoon of work; permanent investment).
3. **Wildlife as variable reward** — deterministic rare visitations seeded per date (`visitor:{date}`, following the existing `wx:{date}` pattern): a deer at dawn after a long-run week. "Was it there when you looked?" is what daily visits are made of — and it needs zero true randomness.
4. **Timeline scrubber as story replay** — add chapter ticks (unlocks, comebacks, droughts survived, expansions) and a "replay this week" auto-play. The README's growth GIF is the product's best asset; this puts that feeling *in* the product. The same machinery extended **forward** gives the damage preview: scrub past "today" into the do-nothing future and watch the garden dry out — the countdown made visceral, and it's just `simulateDay` folded over future dates (never persisted).
5. **Pre-run pull** — one diegetic line near NextWorkout: *"Tomorrow's long run would be your 8th — the Creek willow arrives."* Converts the codex from museum to quest log with a data join.
6. **Seasonal drift, legible; camera parallax; sound** — ambient polish, in that order; sound only in the desktop screensaver where dwell time is long.

---

## 10. Suggested roadmap

**Bundle 1 — Polish pass (~1–2 days, no refactors, no layout change):**
silhouette outline filter + hit-pads + focus parity · shadow S1 (contact/cast + `shadowColor`) · back-row haze + hue jitter · continuous bar decay + damage notches + forecast line · the four honesty fixes · Sheet a11y/animation + botanical card v1 + provenance.

**Bundle 2 — The immersive stage (~1 week):**
Layout A→B (full-bleed + HUD chips + glass drawers + Today dock) · species drawer reorganization (family sections, three states, rarity, interactive tiles) · overnight beat + unlock ceremonies · timeline chapters.

**Bundle 3 — The living world (larger, stage-able):**
tree silhouette shadows S2 · micro-habitats (biome a) · earned terrain (biome b, versioned engine change) · wildlife visitations · forward-scrub damage preview · terrain patches/paths/soil texture.

**Order argument:** Bundle 1 first — every item is visible the same day and none blocks on layout decisions. Then Bundle 2, which is where "inspiring center of the product" actually lands. Bundle 3's earned-terrain is the headline for a next major version.

---

## Constraints the whole plan honors

- **Determinism**: all randomness via fresh seeded keys; forecast/preview snapshots never persisted; engine changes version-gated.
- **Perf envelope**: ~84 plants / ~2,500–3,000 SVG nodes; the 800-stroke meadow — not the plants — sets the margin; filters only on selection + ≤13 trees; full-viewport rendering needs a Safari repaint check (CSS transforms on SVG are not reliably compositor-offloaded).
- **Tone**: the garden asks, it never accuses — *"rain needed by Thursday"* is a garden with needs; *"3 days left"* is a game with threats. One loss signal at a time; taper and rest mode always win.

## Appendices (raw agent reports)

- `2026-08-04-garden-ux-appendix-rendering.md` — sprite anatomy, outline techniques, shadow mechanics, depth, perf
- `2026-08-04-garden-ux-appendix-engine.md` — decay/threshold math, bar formulas, countdown derivations, metric inventory, forward-sim
- `2026-08-04-garden-ux-appendix-layout.md` — layout constraint chain, IA tiers, sheet/codex critique, wireframes
- `2026-08-04-garden-ux-appendix-gamification.md` — principles audit, countdown framings, metric system, biome tiers, immersion levers
