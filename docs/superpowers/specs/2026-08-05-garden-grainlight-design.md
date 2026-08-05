# Garden "Grainlight" visual overhaul — design

**Date:** 2026-08-05 · **Branch:** `garden-visuals` · **Status:** approved direction (user picked
Grainlight from 4 mocked art directions; mock at scratchpad `mocks/grainlight.html`)

## Goal

Replace the flat-vector look of the garden scene with the Grainlight aesthetic — calm ambient
painterly light — without touching the garden engine, interaction model, or determinism.
Comprehensive: every scene asset (sky, clouds, hills, terrain, all plant archetypes, shadows,
new grounds/visitors from main) should stop reading as "simple SVG shapes".

## Non-goals

No engine/simulation changes. No new interaction. No canvas/WebGL. AtmosphereLayer (canvas
tier-2) untouched. Wildlife + visitor silhouettes keep their geometry (they already read well);
they only inherit scene grain/lighting.

## The Grainlight recipe (from the approved mock)

1. **Global grain** — one full-scene rect with contrast-boosted `feTurbulence` fractal noise
   (fixed `seed`), `mix-blend-mode: soft-light`, ~0.35 opacity. Mounted as a static top layer
   (below weather/finish, above plants) with `pointer-events: none`, outside every animated
   group so it never re-rasterizes. Degrades to invisible-not-broken if blend modes flatten.
2. **Ground mottle** — low-frequency warm-colorized turbulence patch over the ground bands so
   the single gradient reads as uneven meadow light.
3. **Clouds** — replace ellipse clusters with organic multi-lobe paths (procedurally wobbled
   points, flat-ish base), warm-lit underside stop from `light.sunColor`; wisp variant stays.
4. **Hills** — third ridge layer, haze-mix toward `light.hazeColor` with distance (matches the
   plant aerial-perspective system), plus a thin sunlit crest rim on the nearest ridge.
5. **Canopies & foliage** — trees/shrubs become 2–3 tone blob stacks (shade, mid, lit) with a
   rim-light pass on the sun-facing side. Edge organicness comes from **procedural path wobble**
   (deterministic rng, not filters) so swaying sprites never pay filter re-evaluation cost.
   `PlantSprite` gains an optional `lightHint` prop ({ litColor, dx: -1|0|1, amount }) derived
   in `GardenScene` from `SceneLight`; codex cards pass none and get a neutral top-lit default.
6. **Meadow** — existing depth-graded strokes keep their honesty rules; add warm color grading
   toward the sun azimuth and a sparse field of backlit seed heads (lit-color heads at low
   density) that read as golden-hour sparkle.
7. **Shadows** — existing cast/contact ellipses warm up slightly and lengthen a touch more at
   low sun; opacity curve unchanged.
8. **New main assets** — stream/terrace/glade ground features and rare-visitor silhouettes sit
   under the global grain and pick up the same haze mixing; no per-asset redraw in this pass.

## Constraints

- **Determinism** — byte-identical markup per snapshot stays contractual. All wobble from
  `rng()` stable keys; all `feTurbulence` carries a fixed `seed`. Existing renderer tests keep
  passing; add invariants (grain layer present exactly once, no `Math.random`).
- **States must read** — thirsty/wilted/dormant/dead tone stacks desaturate/droop exactly as
  today (state adjustments apply to all three tones); drought straw patches gain grain, not
  color changes.
- **Perf** — no SVG filter inside animated groups. Filters allowed only on static scenery
  (grain rect). Everything else is plain paths. Target: no measurable frame cost vs today.
- **Tap targets** — hit pads and silhouette-outline selection are untouched; wobble amplitude
  stays ≤ ~6 scene units so outlines still hug the art.

## Rollout stages

1. Scene infrastructure: SceneDefs grain/mottle, sky, clouds, hills, terrain grading.
2. Sprites: tree archetypes first (biggest read), then shrub/flower/fern/vine/grass/
   groundcover/fungus; states verified per archetype.
3. Polish pass: shadows, seed heads, new-ground features, screenshot review vs mock at
   multiple times of day + weather + drought, full test suite.

Each stage: playwright screenshots (golden hour, noon, night, drought) reviewed against the
mock before moving on.
