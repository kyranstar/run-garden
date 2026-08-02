# Garden Visual Overhaul — Light, Depth, and a Living Atmosphere

**Date:** 2026-08-01
**Scope:** `packages/garden-renderer` (plus two one-line opt-ins in `packages/ui` screens)
**Decision:** Tier 1 (SVG pushed hard) + Tier 2 (one deterministic canvas atmosphere layer). No WebGL. Mockups validated in the "Garden rendering tiers" artifact (2026-08-01).

## Goal

Make the garden genuinely beautiful and alive while staying calm and honest. Every
combination of **weather × season × time of day × moisture** must be visually distinct and
intentionally art-directed — the garden should look different at autumn dusk in a dry spell
than at spring dawn after recovery rain, and both should be lovely.

## Non-goals

- No WebGL / three.js / new dependencies.
- No engine or simulation changes — the renderer consumes existing `GardenSnapshot` fields
  only (`weatherState`, `season`, `moisture`, `soilHealth`, `floweringDensity`,
  `biodiversity`, `canopy`, `droughtDays`, `inComeback`, `restMode`, `wildlife`, `plants`,
  `lastSimulatedDate`).
- No per-species sprite redraw (the 886-line `PlantSprite` archetypes stay; they gain
  shadows and staggered sway only). A sprite art pass is a separate future project.
- No snow system (the engine has no snow weather state — revisit if one is ever added).

## Architecture

All new code lives in `packages/garden-renderer`. The package's public contract
(`GardenSnapshot` in → scene out) is unchanged; `GardenScene` gains one optional prop.

| Module | Responsibility |
|---|---|
| `lighting.ts` | Pure color script: `(hour, season, weather, moisture) → SceneLight` tokens — sky gradient stops, sun/moon position + color, shadow direction/length/opacity, ambient tint, haze, grass/soil/hill color ramps, beam and cloud configs. |
| `terrain.tsx` | Layered ground: 4 depth bands with aerial perspective; seeded meadow texture (static strokes + wildflower drifts); drought patches. |
| `sky.tsx` | Sky gradient, sun/moon (with real moon phase), stars, per-weather clouds, distant birds. |
| `overlays.tsx` | SVG signature effects: screen-blend sunbeams, haze bands, rainbow, film grain, vignette. |
| `AtmosphereLayer.tsx` | The one canvas layer (Tier 2): all particle systems, gated by state, budgeted, 30 fps. |
| `GardenScene.tsx` | Composition + existing selection/interaction, unchanged semantics. |

### The color script (`lighting.ts`)

Rather than hand-authoring hundreds of palettes, compose three small authored sets:

1. **Six light-period keyframes** — night, dawn, morning, midday, golden, dusk — each a full
   `SceneLight` palette. The current hour interpolates between adjacent keyframes
   (piecewise, continuous), replacing today's flat tint overlay. Sunrise/sunset hours shift
   ±1.2 h by season (winter: later dawn, earlier dusk; summer: the reverse).
2. **Four season biases** — hue/value nudges applied to foliage, meadow, and sky ramps:
   spring (cool fresh greens, blossom-white meadow accents), summer (deep saturated),
   autumn (amber/rust meadow, warm foliage shift), winter (desaturated cool, lower sun arc,
   frost tint at dawn).
3. **Eight weather modifiers** — each adjusts the composed palette *and* declares its
   signature effects (see matrix below).

Composition order: period keyframe → season bias → weather modifier → moisture ramp
(existing `mix`-based grass/soil interpolation, retained). ~18 authored ingredients yield
190+ distinct, coherent looks.

### The state matrix — every state's signature

Each weather state gets exactly one *signature* so it is recognizable at a glance:

| Weather | Palette character | Signature (SVG) | Signature (canvas) |
|---|---|---|---|
| `fresh_rain` | silver-blue light, saturated greens | drip glints on leaves | rain streaks + ground splash rings |
| `recovery_rain` | warm gold-through-rain (sun-shower) | **rainbow** when `inComeback` and sun is low | gentler rain + rising mist |
| `clear_sun` | crisp cobalt, high contrast | sparkle glints on flowering plants | active pollen motes |
| `soft_sun` | pastel warmth | wide soft sunbeam | drifting pollen |
| `light_clouds` | gentle neutral | cumulus parade | travelling cloud shadows (dappled ground) |
| `seasonal_breeze` | clear with movement | — (wind is the star) | strongest gust trains + petal/leaf streamers |
| `dry_spell` | straw, thin high haze | sparse stringy clouds | dust motes, harder light |
| `mild_drought` | ochre amber, muted sky | cracked-soil patches, dusty sun halo | horizon heat shimmer (midday hours only) |

Time-of-day signatures on top: **night** — layered indigo sky, stars, moon with real phase
(computed from `lastSimulatedDate`), plants darkened toward silhouette, firefly glow pools
(canvas) when `wildlife.fireflies`; **dawn** — rose light + low mist; **golden** — long soft
shadows + beams; **dusk** — lavender/ember horizon.

Scalar drivers (all continuous, all honest — no faked abundance):

- `moisture` → grass/soil hue (existing) + meadow stroke density + flower vibrancy.
- `soilHealth` → meadow density floor (a cared-for garden never looks threadbare).
- `floweringDensity` → wildflower drift count.
- `biodiversity` → meadow stroke variety (blade/tuft/seedhead shape mix).
- `canopy` → soft ambient-occlusion pools under trees.
- `droughtDays` → straw patch + cracked-soil extent.
- `restMode` → "becalmed": all motion amplitudes ×0.6, quiet palette bias — deliberately
  gentle, never punishing.

### Tier 1 details (SVG)

- **Shadows:** one soft ellipse per plant, direction and length from sun azimuth/elevation
  (long at dawn/golden, short at midday, moon-shadows faint at night). Opacity ≤ 0.15.
- **Ground:** replace the single plane with 4 overlapping bands; far bands mixed toward the
  sky color (aerial perspective). Distant hills get a 1.5 px blur.
- **Meadow texture:** 500–800 static seeded strokes (`rng` keys per index), density from
  moisture/soilHealth, colors from the composed ramp; 30–60 wildflower dots from
  `floweringDensity`. Static nodes only — no animation cost.
- **Sway:** existing sway keyframes, but `animation-delay` staggered by plant x-position so
  gusts read as travelling. Amplitude per weather (breeze strongest, drought stillest).
  Positioning stays on an outer `<g>`; the animated class goes on an inner `<g>` (CSS
  transform animations override the SVG `transform` attribute — verified in mockup).
- **Finish:** `feTurbulence` grain (opacity ≈ 0.05, overlay blend) + soft vignette.
- **Sky:** multi-stop gradients from the color script; clouds shaped/colored per weather;
  stars with per-star twinkle delay at night.

### Tier 2 details (`AtmosphereLayer`)

One `<canvas>` absolutely positioned over the SVG inside a relative wrapper,
`pointer-events: none`, `aria-hidden`. Systems (each independently gated by the state
matrix): rain + splash rings, pollen, mist, cloud shadows, gust fringe (≈180 foreground
blades bending under travelling gusts), petal/leaf streamers, heat shimmer, firefly glow.

- **API:** `GardenScene` gains `atmosphere?: boolean` (default `false`). When true it
  renders the wrapper div + canvas; when false, exactly today's bare `<svg>` — no layout
  change for existing consumers or tests. Both `packages/ui` screens (garden card, ambient)
  opt in.
- **Budget:** ≤ 120 active particles total; 30 fps cap; devicePixelRatio ≤ 2; skips work
  when `document.hidden`; unmounts under `reducedMotion` (fallback = pure SVG scene).
- **Determinism:** particle initial states from seeded `rng` keys; evolution is a pure
  function of elapsed time. The pure step functions are unit-testable without RAF.

## Motion budget (the calm contract)

Periods 6–14 s; sway ≤ 1.5°; particle opacity ≤ 0.35; nothing animates in the top third of
the sky except clouds and star twinkle; every system honors `reducedMotion`; ambient-mode
target < 8% CPU on Apple Silicon at 30 fps. Calm is enforced by these numbers, not by taste.

## Determinism, testing, error handling

- Same snapshot + same hour → byte-identical SVG markup (existing guarantee, preserved).
  `lighting.ts` is pure; unit tests assert continuity across period boundaries, clamped
  color ranges, and monotonic shadow length vs. sun elevation.
- Particle step functions unit-tested as pure functions (seeded init, fixed dt).
- Visual review: extend the existing screenshot script with a matrix sampler page — all
  8 weathers at their most characteristic period, plus each season at golden hour and each
  period for `soft_sun` (≈18 shots) — reviewed by eye, not pixel-asserted.
- Canvas context creation failure → render without the atmosphere layer; SVG unaffected.
- Unknown future weather/season values → exhaustive switches fall back to
  `soft_sun` / `summer` modifiers.
- Accessibility unchanged: `describeGarden` desc, plant buttons, keyboard handlers.

## Rollout

1. `lighting.ts` + tests (pure, no visual change yet).
2. Tier 1 SVG passes (sky → ground/meadow → shadows/sway → finish), screenshot-reviewed
   per pass.
3. `AtmosphereLayer` systems, one at a time, behind the `atmosphere` prop.
4. Opt in both UI screens; regenerate `screenshots/`; update README images last.
