# Appendix — SVG Garden Rendering Audit (raw agent report)

All paths relative to the repo root.

---

## 1. Plant sprite anatomy

**Structure.** Every plant is pure inline SVG built from primitives — `<path>`, `<ellipse>`, `<circle>`, `<rect>` — inside nested `<g>`s. `PlantSprite` (packages/garden-renderer/src/PlantSprite.tsx:857-889) emits:

```
<g data-archetype="…">          ← stable outer wrapper
  <g class="{p}-sway" style={duration/delay}>   ← CSS-animated wrapper
    {archetype art}             ← 5–40 primitives, local coords, base at (0,0), grows in −y
  </g>
</g>
```

The scene wraps that in a positioned group `translate(x y) scale(s)` with the shadow ellipse and selection ellipse as siblings *before* the sprite (GardenScene.tsx:417-467).

**Determinism / variation.** All jitter comes from `rng("sprite:"+plant.id)` (PlantSprite.tsx:859) — a mulberry32 PRNG seeded by FNV-1a hash (packages/garden-engine/src/prng.ts). The helper `v(base, pct)` (line 860) varies scalars ±15% by default. Sway duration/delay are consumed *first* (lines 863-864) so geometry stays stable whether or not animation is on. **Variation is geometric only** — counts, angles, lengths, lean. There is **zero per-instance color variation**: every instance of a species uses the identical `species.palette` (paintFor, lines 42-76). Two field poppies differ in shape but are chromatically clones.

**Growth & health.** Maturity `m` drives dimensions via `lerp(min, max, m)`; crowns/foliage use `smooth(m)` (smoothstep, lines 18-21) so saplings keep tiny crowns until mid-maturity. Display state alters paint and posture through `Paint` (lines 25-32, 42-76):
- `thirsty`: desaturate 0.3, shade 0.92, `droop=0.4`; `wilted`: desaturate 0.55, shade 0.8, `droop=0.85` — droop rotates flower heads (flowerCup line 421 `rotate(droop*42)`), flattens crowns (`flat = 1 − droop*0.16`, line 219), bends blades.
- `dormant`: `bare=true`, colors mixed toward brown `#8a7455` — trees swap crowns for `bareBranches()` strokes (lines 103-125).
- `seed`: universal `sprout()` (lines 129-137); `flowering`: `blooming=true` adds petal rings / bloom dots per archetype.
- `dead`: `deadForm()` (lines 172-210) — snags for trees, dry stalks otherwise; `habitatRole` adds moss + mushrooms (`habitatTufts`, lines 146-169).
- Seasonal foliage tint from the color script is mixed in per-channel (line 67), never on dead plants.

**Sway/animation.** One CSS keyframe animation, `.{p}-sway` — `rotate(−amp…+amp)` about `50% 100%` (fill-box), 7s ease-in-out alternate (GardenScene.tsx:45-46); amplitude comes from `light.swayAmpDeg` (0.5-1.5°, weather-modulated). Per-plant duration 6-9s and negative delay keyed to x-position desynchronize plants (PlantSprite.tsx:863-864). Ground-hugging archetypes are excluded via `NO_SWAY` (line 843). No JS animation in the SVG at all.

**Archetype inventory** (20, PlantSprite.tsx:819-840): `tree_round`, `tree_birch`, `tree_weeping`, `tree_conifer`, `tree_fan` (ginkgo), `tree_blossom`, `flower_cup`, `flower_daisy`, `flower_spike` (iris), `flower_cluster`, `fern`, `hosta`, `grass_tuft`, `vine`, `groundcover_patch`, `moss`, `mushroom`, `shelf_fungus`, `shrub_round`, `shrub_spike` (lavender) — mapped from 34+ species in packages/garden-engine/src/species.ts.

---

## 2. Selection / hit UX

**Today.**
- Hit target = the positioned `<g>` with `role="button"`, `tabIndex={0}`, `aria-label`, click + Enter/Space handlers (GardenScene.tsx:417-435). Hit area is only *painted pixels* (default `pointer-events: visiblePainted`) — the shadow ellipse sibling luckily fattens the target near the ground, but a thin seedling or grass tuft is a needle-thin click target. SVG background click deselects (line 385).
- Selection highlight = a **flat cream ground disc**: `<ellipse cx=0 cy=3 rx=hw ry=hw*0.3 fill="#f7f3df" opacity=0.45 stroke="#d9d2b2">` (GardenScene.tsx:448-459). `hw = max(14, species.spacing*1000*0.55)` — full-grown footprint, *not* maturity-scaled, so selecting a willow seedling lights up a ~132-unit-wide plate under a 6-unit sprout.
- No CSS classes exist for plant/selection (grep of packages/ui/src/styles.css finds only `.garden-scene-wrap`/`.garden-scene-big`, lines 828, 940). Keyboard focus falls through to the global `:focus-visible` outline (styles.css:147-148), which browsers render as an axis-aligned bbox ring on SVG — visually crude.

**Silhouette-outline techniques assessed:**

**(a) SVG filter chain on the plant group** — `feMorphology operator="dilate" radius≈1.3` on `SourceAlpha` → `feComponentTransfer` (harden alpha; sprites contain 0.55-0.85-opacity ellipses that would otherwise produce a ghost outline) → `feFlood` accent color → `feComposite in` → `feMerge` under `SourceGraphic`.
- *Visual*: exact silhouette hug, including stroke-only geometry (grass blades, willow fronds). feMorphology's box kernel squares off thin diagonals slightly; a 0.4px `feGaussianBlur` before compositing rounds it.
- *Perf*: one filter region on **one selected plant** — trivial. The filter sits above the CSS sway child, so it re-rasterizes each animation frame, but that's a single ~100×150-unit region. Never apply per-plant scene-wide.
- *Support*: SVG 1.1 filters — universal, incl. Safari.
- *Fit*: **zero changes to sprite code**; define once in `SceneDefs` (sky.tsx:8-38), conditionally set `filter=` on the sprite group where the ellipse currently renders. Must widen the filter region (`x="-40%" y="-40%" width="180%" height="180%"`) so wide crowns and sway excursions don't clip.

**(b) Duplicate group with stroke + paint-order** — render `<PlantSprite>` twice (determinism makes the twin byte-identical); underlay copy inside `<g class="rg-halo">` with CSS `.rg-halo * { fill: C; stroke: C; stroke-width: 3; stroke-linejoin: round; }`.
- *Visual*: vector-crisp at any zoom. But the uniform CSS `stroke-width` override interacts unevenly with stroke-only primitives (a 1.6-wide blade re-stroked at 3 gains only 0.7/side vs 1.5/side on fills) — halo thickness is inconsistent by archetype.
- *Perf*: doubles node count for the selected plant only; no filters; sway syncs if the twin gets the same class (it does — same rng).
- *Support*: universal (plain CSS on SVG).
- *Fit*: easy thanks to determinism, but needs a wrapper + CSS additions, and the thickness inconsistency shows on grass/fern/willow.

**(c) Stacked CSS drop-shadows** — `filter: drop-shadow(0 0 1px C) drop-shadow(0 0 1px C) …` on the group.
- *Visual*: soft glow, not a crisp line; washes out over light terrain bands at dawn/golden.
- *Perf*: each drop-shadow is a full blur pass re-run every sway frame; 3-4 stacked is the most expensive of the three per-pixel.
- *Support*: universal.
- *Fit*: one CSS class, no markup change — but lowest quality ceiling.

**Recommendation: (a)**, as a two-layer filter (large dilate at low opacity for a soft halo + 1.3-unit dilate at full opacity for the crisp line), replacing the cream disc — or keeping a *maturity-scaled* soft disc beneath it as a ground anchor. Pair it with a `:focus-visible` rule that applies the same filter class so keyboard selection stops relying on the ugly bbox ring. Also add an invisible hit-pad (`<ellipse fill="transparent" pointer-events="all">` sized ~`hw × maturity`) so small plants become tappable — the current painted-pixels-only target is the bigger UX defect.

---

## 3. Shadows

**Current mechanics.** One flat ellipse per living plant, sibling *before* the sprite inside the depth-scaled group (GardenScene.tsx:437-447):
- `shadowHw = hw × shadowGrowthScale(plant)` — footprint from species spacing (`hw = max(14, spacing*1000*0.55)`, line 414) times the sprite's own smoothstep growth curve, seeds pinned to 0.2 (lines 36-41).
- `cx = shadowDx × shadowHw × (0.55 + 0.6·shadowLen)`, `cy = 3`, `rx = shadowHw × (0.55 + 0.55·shadowLen)`, `ry = shadowHw × 0.2`, fill **hardcoded `#233a1d`**, `opacity = light.shadowOpacity` (0.04 night … 0.16 clear-sun midday).
- `shadowDx = −(sunX/1000·2 − 1)` — cast away from the sun horizontally; fixed `0.15` for the moon (lighting.ts:228). `shadowLen`/`shadowOpacity` are authored per light period (lighting.ts:82-119: night 0.35/0.04, dawn 1.6/0.10, midday 0.45/0.13, golden 1.5/0.11) and weather-scaled (rain ×0.4, clouds ×0.7, lighting.ts:332, 344, 349, 355). Separately, mature trees get "canopy pool" occlusion ellipses in terrain (terrain.tsx:100-103).

**Why it reads wrong:**
1. **Shape-blind**: a conifer, a birch, a mushroom, and a hosta with similar spacing cast the *same blob*. Size keys off planting **footprint, not height** — a 96-unit birch (spacing 0.09) casts less than a creeping clover patch scaled up.
2. **Symmetric ellipse under directional light**: `rx` grows with `shadowLen` on *both* sides while only `cx` shifts. At mid-morning (`shadowDx≈0.5`, golden `shadowLen=1.5`) a tree's shadow spills ~43 units **toward the sun** (cx=47.9, rx=90.8). Long shadows should elongate away, pinned at the trunk base.
3. **Fixed green `#233a1d`** regardless of terrain or hour — green-on-straw during drought (terrain mixes toward `#b8a468`, lighting.ts:376), and no warm/cool shift dawn↔midday↔dusk. Real outdoor shadows are sky-lit (bluish midday, violet at dusk).
4. **Painter's-order bleed**: each shadow paints inside its plant's group in far→near order, so a near plant's shadow ellipse paints *on top of far plants' foliage*, and overlapping shadows in dense shrub regions double-darken (opacity stacks).
5. **No penumbra**: single hard-edged ellipse — no dark contact core vs soft outer falloff, so plants feel decal-stuck rather than grounded.
6. **Sway decouple** (minor at 0.5-1.5° amplitude): foliage rotates, shadow is frozen.

**Improvement options, ordered by subtlety/effort:**

**S1 — Contact + cast split, sky-tinted (Small).** Replace the single ellipse with two: (i) contact core — small dark ellipse at the base, `rx≈shadowHw×0.45`, `ry≈shadowHw×0.14`, opacity ×1.6, nearly invariant to `shadowLen`; (ii) cast lobe — ellipse **pinned at the base edge**: `cx = shadowDx × rxCast`, `rxCast = shadowHw×(0.5+0.9·shadowLen)`, lower opacity. Add a `shadowColor` token to `SceneLight` computed in lighting.ts, e.g. `mix(shade(grassNear, 0.45), skyTop, 0.25)` — shadows then track drought straw, night blue, dusk violet for free. +1 node/plant (~84 nodes), zero filters. Fixes critiques 2, 3, 5 — the biggest believability jump per line of code.

**S2 — Silhouette cast shadows for trees/large shrubs via `<use>` (Medium).** Give the archetype art group an `id={p}-art-{plant.id}`; add before the sprite:
`<use href="#…" transform="translate(0,2) skewX(-shadowDx·35) scale(1, -0.25·(0.5+shadowLen))" filter="url(#p-castflat)"/>`
with **one shared filter def** (`feColorMatrix` → alpha-only flood in `shadowColor` + `feGaussianBlur stdDeviation≈1.2`). Ground-plane flatten via negative-y scale + skew about the base origin gives a conifer a triangular shadow, a birch an airy one. Because the `<use>` clone carries the sway class, the shadow **sways in sync automatically** — but that also means the filter re-rasterizes per frame. Gate it: only `category === "tree"` (max ~13 trees: `regions×2+1`, docs/GARDEN_ENGINE.md) and `maturity ≥ 0.5`, keep S1 ellipses for everything else. Perf: ~13 filtered animated regions — measurable but acceptable; drop the blur (alpha-flood only, opacity for softness) if profiling complains. Moves realism the most.

**S3 — Multi-lobe canopy shadows (Medium-Large, structurally awkward).** Mirror the crown's 3-4 lobe ellipses into the shadow as offset flattened ellipses. **The current code structure fights this**: lobe geometry lives inside archetype closures consuming a sequential PRNG (treeRound lines 227-230), invisible to GardenScene. It would require archetypes to return metadata or a duplicated geometry computation — real refactor, and S2 delivers strictly more realism for similar effort. Only worth it if filters must be avoided entirely.

---

## 4. Depth & variety

**Depth today:**
- **Y-sort painter's order**: plants sorted by `position.y` then id (GardenScene.tsx:373-375); near overlaps far — the only occlusion mechanism.
- **Depth scale**: `s = 0.65 + 0.45·y` (line 30) — far plants 65% size; ground band y∈[290, 540] of the 560-high viewBox (lines 24-25).
- **Terrain bands**: 4 fixed curves filled `mix(grassFar, grassNear, t)` (terrain.tsx:20-35); `grassFar` is already mixed toward `skyHorizon` (aerial perspective, lighting.ts:232).
- **Meadow strokes**: up to 800 seeded blades, near = taller/wider/lower (`d^0.85` bias, terrain.tsx:44-63).
- **Hills**: blurred (`feGaussianBlur 1.6`, sky.tsx:30-32) and sky-mixed (GardenScene.tsx:393-394); horizon haze ellipse + vignette + grain in `Finish` (overlays.tsx:138-140).
- **Not present**: per-plant atmospheric fade — a poppy at y=0 renders in exactly the same saturation as one at y=1; only the uniform `foliageTint` applies (GardenScene.tsx:465).

**Color variety today:** per-plant = none (Section 1). Terrain: meadow blades jitter lightness ±15% (terrain.tsx:53), wildflower dots use 3 season accents (68-78), drought straw patches (82-97), canopy pools (100-103). No soil texture, moisture patches, paths, or rocks. Species palettes are authored per species (species.ts), so cross-species variety is decent; within-species monotony is the gap.

**Cheap deterministic wins, easiest first:**
1. **Back-row haze tint** — in the scene loop, scale the existing `tint` prop by depth: `amount + k·(1−position.y)` toward `hazeColor`, plus slight `desaturate`. The per-plant `tint` plumbing already exists (GardenScene.tsx:465, PlantSprite paintFor line 67) — ~5 lines, instantly separates rows.
2. **Per-plant hue/sat jitter** — in `paintFor`, jitter `c1/c2` ±6° hue, ±8% lightness using a *fresh* key `rng("tint:"+plant.id)` (do **not** draw from the sprite's sequential stream — that would silently reshuffle all existing geometry). `color.ts` already has the hsl machinery (rgbToHsl/hslToRgb, lines 27-62). Kills the clone-stamp look for ~10 lines.
3. **Terrain moisture/soil patches** — seeded low-opacity ellipses (or one soft radialGradient pair) mixed from `grassNear`/soilHealth between the band fills and the meadow; same pattern as the existing drought patches (terrain.tsx:82-97). Static, ~10-20 nodes.
4. **Soil texture strip** — a ground-only `feTurbulence` rect (the grain filter pattern already exists, sky.tsx:33-36) at low opacity near the front band, or a seeded scatter of tiny pebble ellipses. Static content ⇒ raster cached; keep it out of animated subtrees.
5. **Path/rock features** — deterministic props keyed off `state.unlockedRegions`/counters (a stepping-stone path appearing at region 3, etc.). Pure additive scene code; the region model (packages/garden-engine/src/layout.ts:13-20) gives natural anchor bands.

**Easy vs hard given the structure:** anything flowing through `light`/`tint`/per-plant scene props is easy (the color script is a single pure function, lighting.ts:187-248; per-plant tint already threads through). Anything needing *archetype-internal geometry* from outside (lobe positions, exact heights for shadows or inter-plant occlusion shading) is hard — geometry is locked inside closures behind a sequential PRNG. The strict rng-key determinism contract also means any new random draw must use a **new key**, never extend an existing stream.

---

## 5. Performance envelope

- **Plant count**: capacity = `unlockedRegions × 14`, max 6 regions ⇒ **84 plants** (packages/garden-engine/src/types.ts:43-44, simulate.ts:818-819); trees capped at `regions×2+1` ≤ 13, plus per-species caps (docs/GARDEN_ENGINE.md).
- **SVG node budget**: sprites ≈ 5-40 primitives (fern ~36 is the heaviest) ⇒ ~1,200-1,700 plant nodes at full garden; meadow up to **800 stroke paths** (terrain.tsx:39-42) is the single largest block; +64 wildflowers, 32 stars, 32 rain lines, clouds, wildlife. Realistic ceiling ≈ **2,500-3,000 elements** — comfortable for static SVG, but the margin for per-node additions is set by the meadow, not the plants.
- **What animates**: up to ~80 CSS `rotate` sway groups (each with unique duration/delay), rain translate, cloud drift, star twinkle, wildlife loops (GardenScene.tsx:43-71). CSS transforms on SVG elements are **not reliably compositor-offloaded** (Safari especially repaints), so the scene already pays a continuous rasterize cost proportional to node count; `reducedMotion` strips the `<style>` block entirely (line 388) and never mounts the atmosphere canvas.
- **Filters/blends now**: `hillblur` (2 static paths, cached), full-viewport `feTurbulence` grain rect + `mix-blend-mode: overlay` and two `screen` beam polygons (overlays.tsx:124-140). The blend modes over an animated stack force whole-scene recomposite per frame — an existing tax; budget new filter work against it. **Rule of thumb from this audit: filters are fine on 1 selected plant or ≤ 13 trees; per-plant filters across 84 sway-animated groups are the cliff.**
- **AtmosphereLayer**: separate `<canvas>`, RAF capped at 30fps, `document.hidden` guard, DPR capped at 2, analytic particles (no per-frame state) — max ~260 sprites (gustFringe 160 dominant, particles.ts:56-59). Well-isolated; it re-keys only on weather/period/fireflies/flowering (AtmosphereLayer.tsx:76-85) and the garden screen already disables it while scrubbing the timeline (packages/ui/src/screens/garden.tsx:373).
- **Determinism constraint on all options**: every proposal above stays static-markup + seeded-key (`rng(stableKey)`) — no wall-clock, no `Math.random`, matching the byte-identical-render contract (GardenScene.tsx:14-18).

---

## Ranked options

### Goal: selection outline

| # | Option | Mechanics summary | Effort | Visual impact | Risk |
|---|--------|-------------------|--------|---------------|------|
| 1 | Silhouette filter outline (a) | Shared def in SceneDefs: dilate SourceAlpha → harden alpha → flood → composite → merge; conditional `filter=` on selected sprite group; widened filter region; add invisible hit-pad ellipse + `:focus-visible` parity | S-M | High | Low — 1 filtered plant; only pitfalls are region clipping and soft-alpha ghosting, both handled in the chain |
| 2 | Duplicate sprite halo (b) | Render PlantSprite twice (deterministic twin); underlay with CSS fill/stroke override | M | Med-High | Med — uneven halo width on stroke-only archetypes (grass, willow, fern) |
| 3 | Stacked drop-shadow glow (c) | `filter: drop-shadow()×3-4` via one class on the group | S | Med | Med — blurry not crisp; repeated blur passes every sway frame; washes out on light ground |
| 4 | Status quo + polish | Keep cream disc but scale rx by maturity and tint by `shadowColor` | S | Low | None |

### Goal: shadows

| # | Option | Mechanics summary | Effort | Visual impact | Risk |
|---|--------|-------------------|--------|---------------|------|
| 1 | Contact + cast split, sky-tinted (S1) | Two ellipses: dark contact core at base + directional lobe pinned at base edge (`cx = shadowDx·rx`), elongating only away from sun; new `shadowColor` token in lighting.ts mixed from grass/sky | S | Med-High | Low — +84 nodes, no filters; fixes sun-side spill, fixed-green fill, and grounding in one pass |
| 2 | Silhouette `<use>` cast shadows for trees (S2) | `id` on art group; `<use>` with translate+skewX+negative-y-scale flatten, one shared flood/blur filter; sway-synced for free via cloned class; gated to mature trees (≤13) | M | High | Med — ~13 filtered animated regions; drop blur → opacity if Safari profiling complains; needs id plumbing per plant |
| 3 | Multi-lobe canopy shadows (S3) | Offset flattened ellipses mirroring crown lobes | M-L | Med | High — lobe geometry trapped inside archetype closures behind sequential PRNG; requires archetype refactor; S2 supersedes it |

### Goal: depth & variety

| # | Option | Mechanics summary | Effort | Visual impact | Risk |
|---|--------|-------------------|--------|---------------|------|
| 1 | Back-row haze/desaturation | Scale existing per-plant `tint` amount by `(1−position.y)` toward `hazeColor` + slight desaturate — plumbing already exists end-to-end | S | High | Low — pure color math; verify night periods don't over-flatten |
| 2 | Per-plant hue/sat jitter | ±6° hue, ±8% lightness in `paintFor` from a **new** rng key (`tint:{id}`); color.ts hsl helpers already present | S | Med-High | Low — must not extend the sprite's existing rng stream; snapshot appearance shifts once (deterministic thereafter) |
| 3 | Terrain moisture/soil patches | Seeded soft ellipses / gradient pools between bands and meadow, driven by moisture + soilHealth (drought-patch pattern already in terrain.tsx) | S-M | Med | Low — static nodes, tune opacity so meadow strokes still read |
| 4 | Soil texture + pebbles front band | Ground-clipped turbulence rect (grain filter pattern exists) or seeded pebble scatter | S-M | Low-Med | Low-Med — keep filter out of animated subtrees; raster is cached while static |
| 5 | Path/rock earned features | Deterministic props keyed to unlockedRegions/counters, anchored to region bands in layout.ts | M | Med | Low — additive scene code, but art direction needed to avoid clutter |

**Suggested sequencing:** outline #1 + shadows #1 + depth #1/#2 together form a small, low-risk "polish pass" (no refactors, no per-plant filters, ~1 day of changes) that addresses the three most visible flatness cues — bbox-ish selection, decal shadows, clone-stamped color — before committing to the tree silhouette-shadow work.
