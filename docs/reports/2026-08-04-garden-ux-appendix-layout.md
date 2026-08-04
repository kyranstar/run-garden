# Appendix — Garden Page Desktop UX Audit (raw agent report)

All paths relative to the repo root.

---

## 1. Current layout inventory

### What constrains the garden's size (the headline finding)

The garden's rendered size is **fixed at ~800 × 448 px on every desktop viewport** — it does not get bigger at 1920 than at 1440. The chain:

| Constraint | Where | Value |
|---|---|---|
| Shell content column | `packages/ui/src/styles.css:265-268` | `.shell-main` at ≥1024px: `max-width: 880px; padding: 2rem 2.5rem 3rem` → **800px content box** |
| Garden hero cap | `packages/ui/src/styles.css:940-944` | `.garden-scene-big { max-width: 900px }` — never binding (880 shell cap wins) |
| SVG aspect ratio | `packages/garden-renderer/src/GardenScene.tsx:379` | `viewBox="0 0 1000 560"`, `width="100%"`, no height → intrinsic 25:14; 800px wide ⇒ **448px tall** |
| Fit mode | `GardenScene.tsx:352` | default `preserveAspectRatio="xMidYMax meet"` — whole scene letterboxed, ground-anchored. A `slice` (full-bleed crop) mode already exists as a prop (`GardenScene.tsx:335-339`) and is used by ambient |
| Card chrome | `packages/ui/src/styles.css:828-834` | `.garden-scene-wrap`: 1px border, 12px radius, `overflow: hidden` — the garden is framed as *a card among cards*, not a stage |

At **1440 × 900** the garden is ~28% of the screen (800×448 in a 1230px-wide main area, ~215px dead margin either side); at **1920 × 1080** it shrinks to ~17% of the screen with ~415px of dead margin per side. The side-nav is 210px (`styles.css:225`).

Overlay-relevant geometry: in the scene's own coordinate space, **plants only occupy y = 290–540 of the 560-unit viewBox** (`GROUND_TOP = 290`, `GardenScene.tsx:23-32`). The top ~52% of the scene is sky and blurred hills (`GardenScene.tsx:390-394`). The top half of the artwork is free real estate; the bottom edge is where the nearest, largest plants live.

### Top-to-bottom inventory (desktop, one flex column — `garden-home`, `styles.css:935-939`, gap 0.9rem)

| # | Element | Source | Approx. height | 1440×900 fold |
|---|---|---|---|---|
| 1 | Garden scene (card-framed SVG) | `garden.tsx:366-375` | **448px** | Above fold |
| 2 | Timeline button / scrubber | `garden.tsx:379-416`, `styles.css:950-1010` | 36px closed, ~80px open | Above fold |
| 3 | BalanceStrip (Run/Lift/Yoga bars) | `garden.tsx:212-246`, `styles.css:1012-1065` | ~50–75px (max-width 660, centered) | Above fold (~y 600) |
| 4 | Garden readout: condition word, "today" line, story, weather sentence, banners | `garden.tsx:421-459`, `styles.css:945-949` | ~130–260px (max-width 660) | **Straddles the fold** |
| 5 | "Growing next" card (unlock nudges) | `garden.tsx:462-466`, codex.tsx:176-207 | ~120–200px | Below fold |
| 6 | NextWorkout hero card (green) | `garden.tsx:469-475`, today.tsx:97-158 | ~260–300px | Below fold |
| 7 | SyncPanel (status + notes feed) | `garden.tsx:476-482`, today.tsx:33-95 | ~25px + ~50px/note | Below fold |
| 8 | Strava / needs-attention banners | `garden.tsx:483-496` | 0–3 × ~40px | Below fold |
| 9 | UnresolvedCard(s) ("Did this run happen?") | `garden.tsx:497-499`, today.tsx:160-199 | ~200px each | Below fold |
| 10 | Readiness card | `garden.tsx:500`, today.tsx:201-236 | ~130–160px | Below fold |
| 11 | EvidenceCard ("Worth knowing") | `garden.tsx:501`, today.tsx:238-260 | ~140–170px | Below fold |
| 12 | `garden-lower` 2-col grid (≥900px, `styles.css:1073-1082`): **Garden log** (12 events) · **Species collection** (DiversityStrip + SpeciesCodex + WildlifeShelf) | log ~520px; species card **~1,700–2,300px** (46 species at ~130px/tile in ~3 columns of a ~390px half-card) | 2–3 screens below fold |

**Total page height ≈ 3,200–4,000px — the emotional centerpiece is the first 14% of a 4.5-screen scroll.**

Dead CSS worth noting: `.garden-layout` (a previous sticky-scene two-column layout, `styles.css:914-932`) and `.species-grid`/`.species-tile` (`styles.css:898-912`) are referenced by no TSX — evidence of an earlier layout iteration; the max-height-scroll pattern there (`max-height: 340px; overflow-y: auto`) is a useful precedent for drawers.

### The full-bleed path already exists

`packages/ui/src/screens/ambient.tsx` renders the *same* `GardenScene` full-bleed: `.ambient-root { position: fixed; inset: 0 }` (`styles.css:1766-1776`), `.ambient-scene { position: absolute; inset: 0; width/height: 100% }` (`styles.css:1780-1786`), `preserveAspectRatio="xMidYMax slice"` (`ambient.tsx:183`), with an overlay caption pattern (condition word + stats, text-shadowed, bottom-left; clock top-right — `styles.css:1787-1816`). The renderer's `atmosphere` wrapper is also already `position: relative; width/height: 100%` (`GardenScene.tsx:493`). **Immersive desktop is not a renderer project; it is a CSS/layout project.**

There is **no separate codex route** — `app.tsx:60-68` routes are `/`, `/plan`, `/runs`, `/garden` (same screen), `/insights`, `/settings`. `codex.tsx` components mount only inside `garden.tsx`.

---

## 2. Information architecture

| Tier | Elements | Verdict for the new layout |
|---|---|---|
| **Daily glance** (worth pixels over the garden) | Condition word + weather sentence; "today" happenings line; balance bars; next workout *summary*; needs-attention count (as a badge) | Persistent HUD chips/panels over the scene. The condition word is the garden's voice — it belongs *on* the artwork, exactly as ambient already does (`ambient.tsx:203-221`) |
| **Pull-forward / progression** | "Growing next" nudges; species collection + wildlife; garden log; timeline scrubber | One compact nudge earns HUD space (it is the game loop's hook); the full collection and log go behind a click — drawers docked over the garden |
| **Maintenance / plumbing** | SyncPanel; Strava/calendar banners; Readiness; EvidenceCard; "how the garden works" | Behind a click, or below the hero. Sync collapses to a dot/one-liner when healthy (it already hides when synced — `SyncStatusLine`, components.tsx:126-155). Full-size UnresolvedCard is the one plumbing item that may interrupt: it needs a decision |

The current page inverts this hierarchy below the fold: plumbing (items 7–11) sits *between* the pull-forward card (5) and the collection (12).

---

## 3. Popups & sheets

**Sheet** (`components.tsx:319-364`, `styles.css:1173-1206`): bottom sheet on mobile, centered modal on desktop (≥1024px). `max-width: 640px`, `max-height: 85dvh/80vh`. Escape closes, backdrop click closes, body scroll locks.

Critique:
- **No focus management.** `aria-modal="true"` is declared (components.tsx:352) but focus is never moved into the dialog, never trapped, never restored on close — keyboard/AT users can Tab straight into the "inert" background. Biggest a11y gap on the page.
- **No entrance animation** despite the design system's otherwise careful motion (`cal-in` keyframe, `styles.css:604-614`).
- The `sheet-handle` drag affordance renders on desktop's centered dialog too (components.tsx:353) — a mobile idiom that reads as clutter and doesn't drag.
- `aria-label={title}` works, but `aria-labelledby` pointing at the visible `<h2>` would be more robust.

**Plant details sheet** (`garden.tsx:526-554`): title = species name; plain text stack — `describePlant` sentence, planted date, "planted by one of your workouts" (no link to *which* workout, though `sourceWorkoutId` is right there, `garden.tsx:535`), host-plant note, died-back/habitat note. No sprite portrait, no family/rarity, no link to its codex entry. The least beautiful surface on the emotional centerpiece.

**Species entries** (codex.tsx:118-173): unlocked = live animated sprite card on green (`.codex-card`, `styles.css:1559-1566`), name, "N living · Rare"; locked = grayscale silhouette (`styles.css:1575-1585`, with a correct dark-mode ghost variant), hint, progress bar + "2 of 6" text. Good bones. Problems:
- **Hints are hover-only `title` attributes** (codex.tsx:133, 155, 234) — invisible on touch and to keyboards/AT.
- **Flat, ungrouped grid**: `CodexEntry.category` exists (codex.tsx:19) and `CATEGORY_ORDER` with per-family colors exists (`garden.tsx:129-138`) but they never meet.
- Rarity is inconsistent: text suffix on unlocked cards, styled pill in nudges, absent on locked cards.
- `unlockedOn` is in the data (codex.tsx:23) but never shown — no "new" moment, no collection history.
- Locked sort by nearest-progress (codex.tsx:122-127) is good, but the single toggle (codex.tsx:145-151) dumps a wall of silhouettes.
- Codex cards are `div`s with `title` — not focusable, no click action, no detail view. The collection is display-only.

Positives to keep: measured-bBox sprite framing (codex.tsx:60-74); plant hit targets in the SVG are real buttons with keyboard support (`GardenScene.tsx:420-435`); balance bars and diversity strip have proper `role="img"` labels.

---

## 4. Desktop immersion — three layout options

Shared prerequisite: a route-level escape from `.shell-main`'s 880px cap (e.g. `.shell-main--immersive`), plus dropping the card border for the hero. Legibility rule: never raw text over artwork; use glass panels — `background: color-mix(in srgb, var(--bg-raised) 72%, transparent); backdrop-filter: blur(10px)` — and keep persistent overlays in the sky band (top ~50%) or hugging edges.

### Option A — "Big hero": full-width garden, floating HUD, page keeps its flow

Garden becomes a `min(78vh, …)` full-main-width hero using `slice` fit; condition + weather + balance become chips floating in the sky; everything else remains a (reordered) stacked page below. No drawers.

- **Mobile:** chips collapse to one condition pill; hero ~48vh; stack unchanged.
- **Migration cost: low.** ~1 day of CSS + reordering. No new components.
- **Risks:** the species/log problem is *not* solved — still a ~2,000px tail; slice-crop at very wide aspect (1920×~700 hero ≈ 2.7:1 vs scene 1.79:1) crops heavily — needs a max-height guard tied to width.

### Option B — "Game HUD": full-bleed garden fills the viewport; collection and log are slide-in drawers over it

The garden *is* the page: fills everything right of the side-nav, 100dvh, no scroll. Translucent top strip (condition + weather + balance + timeline) in the sky band; "Growing next" chip; dismissible Today dock (bottom-left, remembered-collapsed to a pill); **Collection** and **Log** as right-edge glass drawers (Sheet's logic generalized into a side-drawer variant). Banners → toasts; UnresolvedCard keeps the centered Sheet (demands a decision).

```
┌─side─┬────────────────────────────────────────────────────────┐
│ nav  │ ░ Flourishing · fresh rain      Run▓▓ Lift▓░ Yoga▓░  ░ │ ← glass top strip (sky band)
│      │                                          ┌───────────┐ │
│      │        . . . g a r d e n   a r t . . .   │ COLLECTION│ │ ← drawer over right edge
│      │            (fills viewport, slice)       │ ▦▦▦ 12/46 │ │   (glass, scrolls internally)
│      │ ┌common────────────────┐                 └───────────┘ │
│      │ │ Next: Tempo 40min    │   [🌿 1 more                  │
│      │ │ today 6 AM  [View][×]│    long run ▓▓░]              │
│      │ └──────────────────────┘  [Collection][Log][Timeline]  │ ← bottom-right rail
└──────┴────────────────────────────────────────────────────────┘
```

- **Mobile (<1024):** fall back to Option A's stacking; drawers become the existing bottom Sheet. One layout, two breakpoints.
- **Migration cost: medium.** New: `Drawer` (~80 lines), glass utility, shell escape, dock collapse state. Content components move unmodified. Ambient CSS is a copy-paste starting point.
- **Risks:** top-strip contrast over changing skies (glass + `var(--ink)`, not white-on-shadow); dock covering left-edge plants (collapse-to-pill default); hidden unresolved prompt (badge count on strip); perf of full-viewport SVG + atmosphere canvas at 1920×1080 (perf-check; atmosphere re-keys on weather changes).

### Option C — "Canvas-first split": ~70vh stage + persistent bottom shelf whose panels expand in place

Garden ~70vh; beneath it a fixed shelf of collapsed panel headers (Today · Growing next · Collection · Log); clicking one expands it into the remaining ~30vh, scrolling internally.

- **Mobile:** shelf becomes the current stack or swipeable tabs.
- **Migration cost: medium-low.**
- **Risks:** 30vh is cramped for a 46-species grid; the shelf permanently taxes ~30% of vertical space — the garden never truly fills the screen; a click before every piece of content.

### Recommendation: **Option B**, staged through A

Option B is the only one that delivers both stated goals, and the codebase has already paid for its hardest part (ambient.tsx proves full-bleed, `slice` fit, overlay legibility; the sky-band geometry means the HUD occludes zero plants). Ship in two commits: (1) Option A's hero + chips + reordering; (2) the drawer/dock layer. Fold the Sheet fixes (focus trap, initial focus, restore, slide transition, desktop handle removal) into the same Drawer work.

---

## 5. Species organization

Where it lives: the **Collection drawer** (Option B), with "Growing next" as its always-visible HUD teaser (nearest unlock, sprite + mini progress bar; click opens the drawer scrolled to that species).

1. **Header = the diversity strip, promoted.** Reuse `CATEGORY_ORDER` colors (`garden.tsx:129-138`) as a segmented family bar with counts ("12 of 46 · 5 of 8 families"); segments filter/anchor. Unifies the two currently-disconnected taxonomies.
2. **Group by family, in `CATEGORY_ORDER` order.** Section header per family: color dot + "Trees · 4 of 9". Within each, three states: **unlocked** (living sprite card, count, `unlockedOn` + "New" ring ≤7 days), **next up** (1–2 nearest-progress locked at full size with visible hint + progress), **distant locked** (compressed silhouette tiles; hint moves into the detail popover).
3. **Rarity as a consistent tier.** One treatment everywhere: the existing `.rarity` pill (`styles.css:1636-1651`) + card border tint (uncommon = accent, rare = plum); optionally order within family by rarity so rares read as the family "boss".
4. **Make tiles interactive.** Each card a `<button>` opening a **species detail popover** — the same redesigned "botanical card" as the plant sheet: large sprite portrait on `--green-soft`, display-serif name, family + rarity chips, facts (unlocked date, living count, how it's earned with live progress, wildlife it attracts). One card design serves both "tap a plant" and "tap a species"; the plant version links to its source workout (`sourceWorkoutId`) and its species entry.
5. **Wildlife as a final section**, upgraded from `title`-tooltip chips (codex.tsx:230-238) to the same card pattern: present ones animated, absent ones showing their arrival hint.
6. **Counts stay in the drawer trigger:** "Collection · 12/46" — progress always one glance away without occupying the garden.
