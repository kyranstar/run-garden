# Garden Life in the Water — Bundle 3 — Design

*2026-08-05 · Third bundle from `docs/reports/2026-08-05-garden-ux-audit-2.md` (items C1, C2, C3 + canon §1.3's "longest chain"). Engine change: `SIMULATION_VERSION` 3 → 4 (existing `resimulateFrom` rebuilds every garden from stored day inputs on first read — the deliberate, already-shipped upgrade path).*

## Goal

The grounds system finally keeps its 08-04 promise: exclusive species per carved ground, a wildlife affinity for the stream, and the empty achievement gates filled. The rivers get life in them.

**Non-goals:** micro-habitats (zone language); new rare-visitor kinds (renderer art budget goes to the waterlily + ducks); seasonal cosmetic drift; sound.

## §1 New gate kinds + counters (engine)

- `{ kind: "ground"; ground: "stream" | "terrace" | "glade" }` — satisfied when `state.grounds` contains that kind. `describeGate`: "Grows once the stream is carved" / "…the stone terrace is built" / "…the still glade is cleared". `gateProgress`: null (binary — consistent with `dead_wood`; excluded from nudges by existing logic).
- `{ kind: "races"; count: n }` — new counter `state.raceCount` (planned races only), incremented in `applyRun`'s race branch (which keeps its quality-run effects). `describeGate`: "Finish a race".
- `evening_runs` gate kind over the existing `eveningRunCount` counter (+ a `gateProgress` case — fireflies' progress finally displayable too).
- `state.bestConsistentWeeks` — updated wherever `consecutiveConsistentWeeks` increments; `??= 0` migration default. Surfaced on Insights: the chain line gains "· longest {N}" when best > current.
- Old-snapshot field defaults (`raceCount ??= 0`, `bestConsistentWeeks ??= 0`) in `simulateDay`'s migration block; the version bump makes them exact via resimulation anyway.

## §2 Nine new species (46 → 55) — `species.ts`

| id | name | category | rarity | gate | archetype | notes |
|---|---|---|---|---|---|---|
| waterlily | White waterlily | flower | rare | ground:stream | **water_lily (new)** | aquatic: "channel" |
| cattail | Cattail | flower | common | ground:stream | flower_spike | aquatic: "bank" |
| river_reed | River reed | grass | common | ground:stream | grass_tuft | aquatic: "bank" |
| mountain_sage | Mountain sage | shrub | uncommon | ground:terrace | shrub_spike | terracotta palette |
| glade_harebell | Glade harebell | flower | uncommon | ground:glade | flower_cup | violet palette |
| victory_laurel | Victory laurel | shrub | rare | races:1 | shrub_round | gold-accent palette |
| summit_sequoia | Summit sequoia | tree | rare | distance_run:42195 | tree_conifer | the marathon tree |
| old_beech | Old-growth beech | tree | rare | mature_trees:3 | tree_round | wide crown palette |
| moonflower | Moonflower | flower | rare | evening_runs:10 | flower_cup | pale night palette |

- New optional species field `aquatic?: "channel" | "bank"`. Non-aquatic species behave exactly as today.
- Palettes follow grainlight tonality (muted, tone-stacked): exact hexes chosen at implementation, checked visually via the export harness + browser screenshots.

## §3 Aquatic placement (layout + renderer)

Today every plant anchor displaces OUT of stream channels and a test asserts no anchor in water. Aquatic species are the deliberate exception:

- `GardenScene`'s anchor fn: species with `aquatic: "channel"` snap TO the nearest channel point (the widest reachable `t ≥ 0.45` stretch so distant water stays bare, matching the riparian fade rule); `aquatic: "bank"` snap to the channel edge ± half its width (the existing riparian-clump band). No streams unlocked → gate unsatisfied → unplantable, so no fallback needed (but a defensive fallback to normal placement stays).
- Waterlily draws flat: added to `NO_SWAY`; its pad renders under its bloom, both above the water (plants layer above terrain already).
- Invariant test updated: non-aquatic plants still never anchor in water; channel-aquatics must.

## §4 New archetype: `water_lily` (PlantSprite)

Pad = organic ellipse with a notch wedge (blobPath-based, fixed draw counts), `lightHint`-tinted; bloom = small cup at `maturity ≥ 0.5`, opens with `blooming`. Seed state = the universal sprout (consistent with everything else). Deterministic-safe: fresh rng keys only, fixed draw counts.

## §5 Ducks (wildlife)

- `WildlifeKind` gains `"ducks"` (domain union + genesis record + engine `desired` rule): `!inDecline && grounds has stream && moisture > 0.5`. Hint: "A calm stream draws them in."
- Renderer: duck silhouette pair ON the stream (anchor = mid-channel point of the first stream), gentle `-drift`-style bob animation, `pointerEvents="none"` like all wildlife. Codex `WildlifeShelf` gets the kind via the existing map (emoji 🦆).

## §6 Anniversary beat (worker, zero art)

In `buildGardenView`: when today's month-day equals `createdDate`'s (and the garden is ≥ 1 year old), prepend a non-event beat line via the visitor-line slot mechanism: "The garden turns {N} today — it remembers every run." Served as `anniversary: string | null` beside `visitor`; the UI shows it with the same lead-line precedence as the visitor line.

## §7 Version bump + migration

- `SIMULATION_VERSION = 4`. On first read, `advanceGarden` detects the stale version and `resimulateFrom` rebuilds from `gardenDayInputs` — deterministic, already shipped, and the same path the v3 grounds upgrade used.
- Replay changes are exactly: new counters counted, new species become plantable/unlockable once their gates were historically satisfied. Existing plants/events keep identity (event ids are date+seq; resim regenerates the same stream plus any new events at their historical dates — the arrival watermark tolerates this: it is date+seq ordered, and historical dates fall behind the stored watermark, so no ceremony replay storm; NEW unlock events landing at historical dates < watermark stay quiet, and the species appear in the codex organically).

## §8 Testing

- Engine: gate satisfaction per ground kind; race counter; evening gate progress; bestConsistentWeeks tracking; aquatic species never plant without their ground; replay determinism suite still green; version-4 resim of a v3-shaped history produces the new counters.
- Renderer: waterlily archetype renders per state (seed/growing/mature/flowering/dead); channel-aquatic anchors inside a channel, bank-aquatics at edges, non-aquatics still out of water; ducks render only with a stream + their flag; determinism regression (fixed draws).
- Visual: export harness scenes with a stream + aquatics; screenshot via browser and eyeball against grainlight.
- Full suite Node 21, typecheck.

## Rollout

No DB migration (snapshot JSON only). Deploy triggers lazy resimulation per user on first garden read. Commits to `main`, push when green.
