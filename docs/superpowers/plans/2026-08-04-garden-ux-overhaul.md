# Garden UX Overhaul (Bundles 1+2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved garden-page redesign: honest gamified metrics (continuous bars with damage notches + forecast line), rendering polish (silhouette selection, contact/cast shadows, depth haze, hue jitter), redesigned popups (botanical card, fixed Sheet), and the immersive desktop stage (full-viewport garden with a typography-first HUD, Collection/Log drawers, overnight beat, timeline chapters) — then merge to `main`.

**Architecture:** Engine gains two pure display-projection functions (`projectedBalance`, `gardenForecast`) — the durable simulation is untouched, so determinism is preserved. The renderer gains a `shadowColor` token, split shadows, a selection filter, and per-plant tint depth/jitter (all new PRNG draws use fresh keys). The UI restructures `garden.tsx` into a desktop stage (≥1024px) + the existing mobile stack, with drawers generalizing the existing Sheet.

**Tech Stack:** TypeScript, React 18, vitest, SVG/CSS (no new dependencies).

## Global Constraints

- **Determinism:** never extend an existing `rng()` stream — new draws use new keys (`tint:{id}`). No `Math.random`, no wall-clock in the renderer. Projection functions are display-only and never persisted. No `SIMULATION_VERSION` change in this plan (no `simulateDay` behavior changes).
- **Perf:** SVG filters only on the selected plant (+ keyboard focus). No per-plant filters scene-wide. New static nodes ≤ ~2/plant.
- **Tone:** at most one loss-flavored sentence visible at a time; amber (`--warn`), never red/danger, for decay signals; rest mode suppresses forecast + notches; copy names the garden's need, never the user's deficit.
- **HUD quality bar:** typography-on-scene (the `ambient-caption` treatment: `var(--font-display)` + soft text-shadow), NOT boxed chips floating over artwork. Contained surfaces (blurred panels) only for interactive containers (drawers, dock expanded, timeline). Subtle top/bottom scrims for legibility. Nothing persistent overlays the plant band except the dock/rail at the edges.
- **Visual hierarchy spec (desktop stage)** — one dominant element per zone; hierarchy built with scale, weight, opacity, position, grouping, layering, and motion (motion only on transient elements):
  1. The garden scene (the page's subject; max area, nothing competes).
  2. Condition word — sole display-serif headline, top-left, white @ 100%, `clamp(1.5rem,2.4vw,2.1rem)`.
  3. Forecast/weather line — directly under condition, body size, white @ 85% (warm cream `#f4dcae` for the bolded deadline only).
  4. Balance bars — top-right instrument cluster, compact, white @ 80% labels.
  5. Next-workout dock — bottom-left, collapsed to one text line; the page's primary action link lives here.
  6. Rail (Collection · Log · Timeline) — bottom-right, small-caps, letterspaced, white @ 72%; hover → 100%.
  7. Transient lines (today's happenings, overnight beat) — under the condition cluster, fade in once, dismissible.
- Mobile (<1024px) keeps the existing stacked layout, inheriting the component upgrades (bars, forecast, cards) without the stage.
- Run full verify between tasks: `pnpm typecheck && pnpm test`. Commit per task on `worktree-garden-ux-audit`.

---

### Task 1: Engine — `projectedBalance`, damage notches, overall-null fix

**Files:**
- Modify: `packages/garden-engine/src/balance.ts`
- Modify: `packages/garden-engine/src/index.ts` (export)
- Test: `packages/garden-engine/test/balance.test.ts` (create)

**Interfaces (produced):**
```ts
export interface BalanceProjectionInputs {
  /** Days elapsed since state.lastSimulatedDate in the user's tz — may be fractional for smooth decay. */
  daysSinceSimulated: number;
  /** Freeze the run clock (plan gap; run decay pauses on gap days). */
  freezeRun?: boolean;
  /** Freeze all clocks (rest mode). */
  freezeAll?: boolean;
}
export function projectedBalance(state: EngineGardenState, inp: BalanceProjectionInputs): DisciplineBalance;
/** Bar-fraction where visible damage begins (notch position): run day 4, strength/yoga day 7. */
export const DAMAGE_NOTCH: { run: number; strength: number; yoga: number };
// run: 1 − (4−2)/14 = 6/7; strength/yoga: 1 − (7−3)/14 = 5/7
```
`DisciplineBalance.days` stays integer (`Math.floor` of projected). `overall` change in `disciplineBalance` AND `projectedBalance`: exclude axes whose `days` is `null` — `Math.min(run.health, ...(strength.days !== null ? [strength.health] : []), ...(yoga.days !== null ? [yoga.health] : []))`.

- [ ] **Step 1: failing tests** — `balance.test.ts` covering: (a) baseline `disciplineBalance` grace/linear values (run day 2 → 1.0, day 16 → 0); (b) `overall` ignores never-practiced axes (state with `hasStrength: false` and `daysSinceStrength: 200` → overall = run health); (c) `projectedBalance` adds fractional days (run days 1 + 1.5 elapsed → health `1 − 0.5/14`); (d) `freezeRun` keeps run health while strength/yoga advance; (e) `freezeAll` returns baseline; (f) `DAMAGE_NOTCH` values ≈ 6/7 and 5/7. Build a minimal `EngineGardenState` fixture helper (only fields balance reads: the three clocks + `hasStrength`/`hasYoga`).
- [ ] **Step 2:** `pnpm vitest run packages/garden-engine/test/balance.test.ts` → FAIL (missing exports).
- [ ] **Step 3:** implement in `balance.ts`; re-export from `index.ts`.
- [ ] **Step 4:** test passes; `pnpm typecheck`.
- [ ] **Step 5:** commit `feat(garden-engine): projected balance, damage notches, honest overall`.

### Task 2: Engine — `gardenForecast`

**Files:**
- Create: `packages/garden-engine/src/forecast.ts`
- Modify: `packages/garden-engine/src/index.ts`
- Test: `packages/garden-engine/test/forecast.test.ts` (create)

**Interfaces (produced):**
```ts
export type ForecastStage = "dry" | "drought" | "dormancy";
export interface GardenForecast {
  next: { stage: ForecastStage; inDays: number } | null; // null: rest mode, or already past dormancy
  victim: { plantId: string; speciesId: string } | null;  // drought only: next dormancy pick
  recovering: boolean;                                    // state.inComeback
}
export function gardenForecast(snapshot: GardenSnapshot, daysAhead?: number, cfg?: GardenConfig): GardenForecast;
```
Logic (cfg defaults `DEFAULT_GARDEN_CONFIG`): `d = state.daysSinceCompletedRun + Math.floor(daysAhead ?? 0)`. Rest mode → `{next: null, victim: null, recovering: false}`. `d < drynessStartDays` → dry in `4−d`; `< droughtStartDays` → drought in `14−d`; `< dormancyStartDays` → dormancy in `30−d` **and** victim = living non-tree plants sorted by `(hydration, id)` ascending, first entry (mirrors `simulate.ts` dormancy pick); else `next: null` with victim still computed while any living non-tree exists.

- [ ] **Step 1: failing tests** — d=1 → dry in 3; d=4 → drought in 10; d=14 → dormancy in 16 + victim is lowest-hydration non-tree with id tiebreak; d=35 → next null, victim present; restMode → all null; daysAhead shifts d; inComeback → recovering true.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** pass + typecheck. **Step 5:** commit `feat(garden-engine): gardenForecast — days to next visible stage + dormancy victim`.

### Task 3: Renderer — `shadowColor` token + contact/cast split shadows

**Files:**
- Modify: `packages/garden-renderer/src/lighting.ts` (SceneLight + final compose)
- Modify: `packages/garden-renderer/src/GardenScene.tsx:437-447`
- Test: `packages/garden-renderer/test/lighting.test.ts` (extend)

`SceneLight` gains `shadowColor: string`. Compute as the LAST pipeline step (inside `applyNightDarkening`, after grass shading): `shadowColor: mix(shade(l.grassNear, 0.45), l.skyTop, 0.25)` — tracks drought straw, night blue, dusk violet automatically. In `GardenScene`, replace the single ellipse with:
```tsx
{plant.state !== "dead" ? (
  <>
    <ellipse data-shadow="cast"
      cx={n(light.shadowDx * shadowHw * (0.5 + 0.9 * light.shadowLen) * 0.85)} cy={3.5}
      rx={n(shadowHw * (0.5 + 0.9 * light.shadowLen))} ry={n(shadowHw * 0.16)}
      fill={light.shadowColor} opacity={n(light.shadowOpacity * 0.75)} />
    <ellipse data-shadow="contact" cx={0} cy={3}
      rx={n(shadowHw * 0.5)} ry={n(shadowHw * 0.13)}
      fill={light.shadowColor} opacity={n(Math.min(0.35, light.shadowOpacity * 1.7))} />
  </>
) : null}
```
The cast lobe's center offset (×0.85 of rx) pins its near edge just behind the base so it elongates only away from the sun.

- [ ] **Step 1: failing test** — extend `lighting.test.ts`: `shadowColor` exists, differs between midday/night/mild_drought (straw-shifted in drought: red channel > green-only baseline), and is a valid hex.
- [ ] **Step 2-4:** implement, run renderer tests (`renderer.test.tsx` may assert on the old single `data-shadow="true"` — update those assertions to the new two-ellipse contract), typecheck.
- [ ] **Step 5:** commit `feat(garden-renderer): contact+cast split shadows with scene-tinted shadowColor`.

### Task 4: Renderer — silhouette selection outline + hit-pads + focus parity

**Files:**
- Modify: `packages/garden-renderer/src/sky.tsx` (SceneDefs: outline filter)
- Modify: `packages/garden-renderer/src/GardenScene.tsx` (remove cream disc; wrap sprite; hit-pad; class + static style)

SceneDefs gains (two-layer: soft cream halo + green line, both alpha-hardened so semi-opaque sprite parts don't ghost):
```tsx
<filter id={`${p}-outline`} x="-40%" y="-40%" width="180%" height="180%">
  <feMorphology in="SourceAlpha" operator="dilate" radius="2.4" result="d1" />
  <feComponentTransfer in="d1" result="s1"><feFuncA type="linear" slope="20" intercept="0" /></feComponentTransfer>
  <feFlood floodColor="#f7f2dd" floodOpacity="0.9" result="f1" />
  <feComposite in="f1" in2="s1" operator="in" result="halo" />
  <feMorphology in="SourceAlpha" operator="dilate" radius="1.1" result="d2" />
  <feComponentTransfer in="d2" result="s2"><feFuncA type="linear" slope="20" intercept="0" /></feComponentTransfer>
  <feFlood floodColor="#2c5c3c" floodOpacity="0.95" result="f2" />
  <feComposite in="f2" in2="s2" operator="in" result="line" />
  <feMerge><feMergeNode in="halo" /><feMergeNode in="line" /><feMergeNode in="SourceGraphic" /></feMerge>
</filter>
```
Scene changes: delete the `selectedPlantId === plant.id` cream-disc ellipse block; wrap the sprite: `<g filter={selectedPlantId === plant.id ? \`url(#${p}-outline)\` : undefined}><PlantSprite …/></g>`. Add `className={\`${p}-plant\`}` to the positioned group and an always-rendered static `<style>` (separate from the animate block): `.${p}-plant:focus-visible{outline:none}.${p}-plant:focus-visible>g:last-of-type{filter:url(#${p}-outline)}`. Add an invisible hit-pad as first child of the positioned group:
```tsx
const PAD_H: Record<string, number> = { tree: 96, shrub: 44, flower: 36, fern: 26, vine: 58, grass: 24, groundcover: 12, fungus: 14 };
const padH = Math.max(14, (PAD_H[plant.category] ?? 30) * (0.3 + 0.7 * clamp01(plant.maturity)));
<ellipse data-hitpad="true" cx={0} cy={n(-padH / 2)} rx={n(Math.max(11, shadowHw * 0.55))} ry={n(padH / 2 + 6)} fill="transparent" />
```
(`fill="transparent"` is painted for hit-testing under `visiblePainted` — no `pointer-events` attribute needed.)

- [ ] **Steps:** update `renderer.test.tsx` expectations (selected plant renders `filter` attr; hit-pad present; no cream disc), implement, tests + typecheck pass, commit `feat(garden-renderer): true-silhouette selection outline, keyboard parity, tap pads`.

### Task 5: Renderer — depth haze + per-plant hue jitter

**Files:**
- Modify: `packages/garden-renderer/src/GardenScene.tsx` (per-plant tint)
- Modify: `packages/garden-renderer/src/PlantSprite.tsx:42-76` (`paintFor` jitter)

Scene loop, replacing the uniform `tint`:
```tsx
const depth = 1 - plant.position.y; // 0 near … 1 far
const tintColor = mix(light.foliageTint, light.hazeColor, 0.55 * depth);
const tintAmount = Math.min(0.5, light.foliageTintAmount + 0.20 * depth * depth);
… tint={{ color: tintColor, amount: n(tintAmount) }}
```
`paintFor` jitter (fresh key — never touch the `sprite:` stream): after computing `raw`, before state adjust:
```ts
const jr = rng(`tint:${plant.id}`);
const dh = (jr() * 2 - 1) * 6;            // ±6° hue
const dl = 1 + (jr() * 2 - 1) * 0.08;     // ±8% lightness
const jit = (c: string, k = 1) => { const [r0, g0, b0] = hexToRgb(c); const [h, s, l] = rgbToHsl(r0, g0, b0); const [r1, g1, b1] = hslToRgb(h + dh * k, s, clamp01(l * (1 + (dl - 1) * k))); return rgbToHex(r1, g1, b1); };
raw.c1 = jit(raw.c1); raw.c2 = jit(raw.c2, 0.4); raw.c3 = jit(raw.c3);
```
(import `hexToRgb, rgbToHex, rgbToHsl, hslToRgb` from `./color`; export any that aren't yet.) Codex sprites keep jitter (their synthetic ids are stable) — fine.

- [ ] **Steps:** add a determinism test in `renderer.test.tsx` (same snapshot renders identical markup twice; two instances of one species have different `fill`s), implement, verify no other snapshot tests break, commit `feat(garden-renderer): depth haze + deterministic per-plant color variation`.

### Task 6: UI — BalanceStrip v2 (continuous decay, notches, honest captions) + weather copy fix

**Files:**
- Modify: `packages/ui/src/screens/garden.tsx` (BalanceStrip, WEATHER_WHY)
- Modify: `packages/ui/src/styles.css` (notch, low state)

`BalanceStrip` new props: `{ balance, snapshot, today, planActive, restMode }`. Compute `daysSinceSimulated = daysBetween(snapshot.state.lastSimulatedDate, today) + hourFrac` (string-date subtraction via `Date.parse`, `hourFrac = (new Date().getHours() + minutes/60) / 24`); `proj = projectedBalance(snapshot.state, { daysSinceSimulated, freezeRun: !planActive, freezeAll: restMode })`. Track markup gains `<span className="balance-notch" style={{ left: \`${DAMAGE_NOTCH[key] * 100}%\` }} aria-hidden />`; fill gets `balance-low` class (background `var(--warn)`) when `health < DAMAGE_NOTCH[key]`; caption shows projected integer days (`daysCaption(proj[key].days)`) — this fixes the "today"-for-yesterday bug because projection adds elapsed days; caption "plan paused" for run when `!planActive`. CSS: `.balance-bar-track{position:relative;overflow:visible}` (move rounding to fill), `.balance-notch{position:absolute;top:-3px;bottom:-3px;width:2px;border-radius:1px;background:color-mix(in srgb,var(--ink) 38%,transparent)}`, `.balance-bar-fill.balance-low{background:var(--warn)}`. `WEATHER_WHY.light_clouds` / `.dry_spell` reworded to the same-stage truth: both "a few days without a run — the soil is starting to dry."

- [ ] **Steps:** implement; existing UI has no test harness on main — verify via `pnpm typecheck` + Task 13's smoke test; commit `feat(ui): continuous balance decay, damage notches, honest day captions`.

### Task 7: UI — Forecast line

**Files:**
- Modify: `packages/ui/src/screens/garden.tsx` (new `ForecastLine` component + mount in readout)
- Modify: `packages/ui/src/styles.css`

`ForecastLine({ snapshot, today, nextWorkout, restMode })`: null when `restMode` or timeline-scrubbed past day. `f = gardenForecast(snapshot, daysSinceSimulated)`. Rendering rules (ONE sentence, `.forecast-line` amber-tinted text, never a banner):
- `f.recovering` → "Recovery rain — the garden is drinking it in."
- `f.next?.stage === "dry"` → "Rain needed by **{weekday of today+inDays}** — after that the soil starts to dry."
- `"drought"` → "Drought {inDays === 1 ? "tomorrow" : \`in ${inDays} days\`} — your next run turns it around."
- `"dormancy"` + victim → "If the dry spell holds, the {speciesName} goes dormant soon — one run brings it back."
- Taper guard: when `nextWorkout` exists and `nextWorkout.effectiveDate > thresholdDate` and `nextWorkout.category === "rest"` → "Taper week — the garden holds its water." When no `nextWorkout` (plan gap) → render nothing.
- Suppression of stacking: when ForecastLine renders a drought/dormancy line, `BalanceStrip` hides its `WEAKEST_COPY` sentence (pass a `quiet` prop) — one loss voice at a time.
CSS: `.forecast-line{font-size:0.92rem;color:var(--ink-soft)} .forecast-line strong{color:var(--warn);font-weight:650}`.

- [ ] **Steps:** implement + typecheck; commit `feat(ui): garden forecast line — the countdown as a weather forecast`.

### Task 8: UI — Sheet a11y/motion + botanical card

**Files:**
- Modify: `packages/ui/src/components.tsx` (Sheet)
- Create: `packages/ui/src/screens/botanical.tsx`
- Modify: `packages/ui/src/screens/garden.tsx` (plant sheet uses BotanicalCard)
- Modify: `packages/ui/src/styles.css`

Sheet: `ref` on dialog; on open store `document.activeElement`, `dialog.focus()` (add `tabIndex={-1}`); Tab-trap keydown (cycle `dialog.querySelectorAll('a,button,input,select,textarea,[tabindex]:not([tabindex="-1"])')`); restore focus on close; `aria-labelledby` pointing at the `<h2 id>`; entrance animation `@keyframes sheet-in{from{transform:translateY(18px);opacity:0}}` 200ms ease-out (respect reduced-motion via the existing global rule); `.sheet-handle{display:none}` at ≥1024px.

`botanical.tsx` exports:
```tsx
export function BotanicalCard(props: {
  speciesId: string;
  plant?: GardenPlant;           // live plant → renders the actual plant sprite + its story
  entry?: CodexEntry;            // codex context → progress/unlock facts
}): JSX.Element;
```
Layout: portrait pane (measured-bbox sprite — reuse `SpeciesSpriteCard` for species-at-best, or an analogous `PlantSpriteCard` for the live plant) on `--green-soft`, display-serif name (`.bot-name{font-family:var(--font-display)}`), chip row (category label via `CATEGORY_LABELS`-style map, `.rarity` pill when not common), then fact rows (border-top hairline list): planted date; provenance — "Planted by one of your workouts · {formatDayLong(plantedAt)}" upgraded to link `→ /runs` when `sourceWorkoutId` exists and isn't `genesis*`; state sentence (`describePlant`); host-plant / habitat notes (moved from garden.tsx); for codex entries: "How it's earned" with hint + ProgressBar, `unlockedOn` date when unlocked. Garden.tsx's plant Sheet body becomes `<BotanicalCard speciesId={…} plant={selectedPlant} entry={codexById.get(speciesId)} />`.

- [ ] **Steps:** implement; typecheck; manual axe-level sanity (focus cycles, Esc, restore); commit `feat(ui): botanical card + focus-managed animated Sheet`.

### Task 9: UI — Species collection v2 (family sections, three states, interactive tiles)

**Files:**
- Modify: `packages/ui/src/screens/codex.tsx` (SpeciesCodex rewrite, WildlifeShelf upgrade)
- Modify: `packages/ui/src/screens/garden.tsx` (CATEGORY_ORDER export/move so codex can use it; selected-species popover state)
- Modify: `packages/ui/src/styles.css`

`SpeciesCodex` v2: move `CATEGORY_ORDER` into codex.tsx (export; garden.tsx imports it for DiversityStrip). Group entries by `category` in `CATEGORY_ORDER` order; per family a section header (`color dot + "Trees · 4 of 9"`). Within a family: unlocked cards first (existing card + `unlockedOn` line, `NEW` ring when `unlockedOn` within 7 days of `today` prop); then up to 2 nearest-progress locked at full size (current locked treatment with VISIBLE hint text); remaining locked as compact tiles (`.codex-mini`: small silhouette + name only, hint lives in the popover). Rarity: always the `.rarity` pill + `.codex-card` border tint (`.codex-uncommon{border-color:color-mix(in srgb,#3c5f8a 45%,var(--border))}`, `.codex-rare{…#7a4a74…}`). Every card/tile becomes `<button type="button" className="codex-card …" onClick={() => onOpenSpecies(c.speciesId)}>` (new `onOpenSpecies` prop; garden.tsx owns `openSpeciesId` state and renders a Sheet with `BotanicalCard`). WildlifeShelf: same chip row but each is a button with visible state; absent ones show hint text inline under the row when tapped (`aria-expanded` toggle) instead of `title`-only.

- [ ] **Steps:** implement; typecheck; commit `feat(ui): family-grouped interactive species collection`.

### Task 10: UI — desktop stage layout (immersive garden + HUD)

**Files:**
- Modify: `packages/ui/src/shell.tsx` (route-aware `shell-main--immersive` via `useLocation`)
- Modify: `packages/ui/src/screens/garden.tsx` (stage structure)
- Modify: `packages/ui/src/styles.css` (stage, HUD, scrims, rail, dock)

Shell: `const immersive = ["/", "/garden"].includes(pathname)` → `className={"shell-main" + (immersive ? " shell-main--immersive" : "")}`. CSS at ≥1024px: `.shell-main--immersive{max-width:none;padding:0}` (mobile unaffected).

`garden.tsx` desktop structure (matchMedia `(min-width: 1024px)` hook `useIsDesktop`):
```tsx
<div className="garden-stage">                    {/* position:relative; height:100dvh */}
  <div className="stage-scene"><GardenScene … preserveAspectRatio="xMidYMax slice" atmosphere /></div>
  <div className="stage-scrim stage-scrim-top" aria-hidden />
  <div className="stage-scrim stage-scrim-bottom" aria-hidden />
  <div className="hud-topleft">                   {/* hierarchy #2/#3 */}
    <h1 className="hud-condition">{GARDEN_CONDITION_LABELS[displayCondition]}</h1>
    <p className="hud-weather">{weather sentence}</p>
    <ForecastLine … className="hud-forecast" />
    {todayLines/overnight beat → .hud-beat}
  </div>
  <div className="hud-topright"><BalanceStrip variant="hud" … /></div>
  <div className="hud-dock">{collapsed pill ⇄ expanded NextWorkout panel}</div>
  <nav className="hud-rail">
    <button>Collection · {unlockedCount}/{codex.length}{attention badge}</button>
    <button>Log</button><button>Timeline</button>
  </nav>
  {timelineOpen ? <div className="stage-timeline">{existing timeline panel}</div> : null}
</div>
<div className="garden-below">                    {/* normal scroll: sync, banners, unresolved, readiness, evidence, "Growing next" */}
```
Mobile keeps the existing tree exactly (single return with conditional wrappers — extract shared pieces into local components so both layouts reuse them).

Stage CSS (the quality bar — typography-on-scene):
```css
@media (min-width: 1024px) {
  .garden-stage { position: relative; height: 100dvh; overflow: hidden; }
  .stage-scene, .stage-scene > div, .stage-scene svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .stage-scrim { position: absolute; left: 0; right: 0; pointer-events: none; }
  .stage-scrim-top { top: 0; height: 22%; background: linear-gradient(rgba(14,20,15,0.34), transparent); }
  .stage-scrim-bottom { bottom: 0; height: 20%; background: linear-gradient(transparent, rgba(14,20,15,0.38)); }
  .hud-topleft { position: absolute; top: clamp(1.2rem,3vh,2.2rem); left: clamp(1.4rem,3vw,3rem); max-width: 34rem; color: #fff; text-shadow: 0 1px 8px rgba(10,16,10,0.5), 0 1px 2px rgba(10,16,10,0.45); }
  .hud-condition { font-family: var(--font-display); font-size: clamp(1.5rem,2.4vw,2.1rem); font-weight: 650; letter-spacing: -0.01em; }
  .hud-weather { margin-top: 0.2rem; font-size: 0.95rem; opacity: 0.85; }
  .hud-forecast { margin-top: 0.35rem; font-size: 0.95rem; opacity: 0.95; color: #fff; }
  .hud-forecast strong { color: #f4dcae; }
  .hud-rail { position: absolute; right: clamp(1.4rem,3vw,3rem); bottom: clamp(1.1rem,2.6vh,2rem); display: flex; gap: 1.6rem; }
  .hud-rail button { background: none; border: none; cursor: pointer; color: rgba(255,255,255,0.72); font-size: 0.78rem; font-weight: 650; letter-spacing: 0.09em; text-transform: uppercase; text-shadow: 0 1px 6px rgba(10,16,10,0.55); padding: 0.3rem 0; }
  .hud-rail button:hover, .hud-rail button:focus-visible { color: #fff; }
}
```
HUD bars variant: labels/captions white with shadow, track `rgba(255,255,255,0.24)`, notch `rgba(255,255,255,0.65)`, width ~200px. Dock collapsed: one line, same text-on-scene voice, "Next: {title} · {when} — View"; expanded: floating panel `background:color-mix(in srgb, var(--bg-raised) 90%, transparent); backdrop-filter: blur(16px); border:1px solid var(--border); border-radius:14px; box-shadow: 0 18px 44px rgba(10,14,10,0.28)` containing `<NextWorkout/>`; collapse state in `localStorage("rg-dock")`. Unresolved/needs-attention count appears as a small amber dot + count on the dock line (links to the below-stage section). Timeline panel restyled as the same floating-panel treatment bottom-center. `atmosphere` stays disabled while scrubbing (existing behavior).

- [ ] **Steps:** implement; typecheck; visually verify in Task 13; commit `feat(ui): immersive desktop garden stage with typographic HUD`.

### Task 11: UI — Collection & Log drawers

**Files:**
- Create: `packages/ui/src/drawer.tsx`
- Modify: `packages/ui/src/screens/garden.tsx` (drawer state + contents)
- Modify: `packages/ui/src/styles.css`

`Drawer({ open, onClose, title, children })` — Sheet's logic (Esc, backdrop click, scroll lock, focus trap/restore from Task 8 — extract that into a shared `useDialogFocus(ref, open)` hook in components.tsx and reuse) but docked right: backdrop transparent-to-dim, panel `position:fixed; top:1rem; bottom:1rem; right:1rem; width:min(420px,92vw); border-radius:14px; background:color-mix(in srgb,var(--bg-raised) 92%, transparent); backdrop-filter:blur(18px); border:1px solid var(--border); overflow-y:auto; box-shadow:0 24px 60px rgba(10,14,10,0.3);` slide-in `transform:translateX(16px)→0 + opacity` 240ms `cubic-bezier(0.32,0.72,0.28,1)`. Collection drawer body: `DiversityStrip` (as header) + `SpeciesCodex` v2 + `WildlifeShelf` + the "Growing next" `NextUnlockNudges` pinned at top. Log drawer body: the `garden-history` list (full 40 events, not 12). On mobile these render exactly where they do today (cards in `garden-lower`); the drawers exist only in the desktop stage.

- [ ] **Steps:** implement; typecheck; commit `feat(ui): collection and log drawers over the garden stage`.

### Task 12: UI — overnight beat + timeline chapters + replay

**Files:**
- Modify: `packages/ui/src/screens/garden.tsx`
- Modify: `packages/ui/src/styles.css`

**Overnight beat:** `localStorage("rg-last-visit")` stores the last seen `liveDate`. On mount, if stored date < liveDate: collect `events` with `date > stored` (cap 3, prefer `species_unlocked` > `wildlife_arrived` > `plant_added` > weather), render `.hud-beat` under the forecast: "Since {formatDayShort(stored)}: {sentences joined ' · '}" with a dismiss ×; species unlocks bolded; fade-in once (`animation: beat-in 400ms ease 300ms both`; reduced-motion → no animation). Update storage after render. Mobile: same line renders in the readout block.

**Chapters:** derive client-side from consecutive `timelinePoints`: species unlock (`unlockedSpeciesIds.length` delta), region expansion (`unlockedRegions` delta), drought entered/exited (`weatherState` transitions to/from `mild_drought`), first plant death (`plants.filter(dead).length` delta). Render tick marks over the slider (`.timeline-ticks` absolutely positioned spans at `index/maxDayIndex*100%`, color by kind) and, when the scrubbed day has a chapter, a caption line under the slider ("New species unlocked · The garden expanded"). **Replay week:** button in the timeline panel; sets `dayIndexOverride = max(0, maxDayIndex-7)` then steps +1 every 650ms to the end (`setInterval`, cleared on unmount/close; reduced-motion: jump to end).

- [ ] **Steps:** implement; typecheck; commit `feat(ui): overnight beat, timeline chapters, week replay`.

### Task 13: Verify — full suite, smoke render, live visual check

- [ ] `pnpm typecheck && pnpm test && pnpm lint` all green.
- [ ] Boot fixture mode locally (worker `pnpm dev:worker` exposes `/api/health` fixtureMode; if a fixture flag exists use it — check `apps/worker` env handling; else run against the dev DB) on non-default ports to avoid clashing with the concurrent session; `pnpm dev:web` with `--port 5199`.
- [ ] Browser check via claude-in-chrome (invoke the `claude-in-chrome` skill first): desktop 1440×900 — stage fills viewport, HUD hierarchy reads (condition dominant, rail quiet), drawers slide, plant click shows outline + botanical card; night + day (`?` time param unavailable — accept current hour); mobile 390×844 — stacked layout intact. Screenshot both, fix visual defects found (contrast over bright sky, scrim strength, bar legibility) before proceeding.
- [ ] Commit any polish fixes: `fix(ui): stage polish from visual pass`.

### Task 14: Merge to main + ship

- [ ] `git log --oneline main..HEAD` (sanity: only this plan's commits + the docs commit); confirm `main` hasn't moved (`git fetch origin 2>/dev/null; git log main..origin/main` if origin exists).
- [ ] Fast-forward main without leaving the worktree: `git push . HEAD:main` (allowed — no checkout has `main`). If not fast-forward, create a temp worktree on `main`, `git merge --no-ff worktree-garden-ux-audit -m "merge: garden UX overhaul (bundles 1+2)"`, remove temp worktree.
- [ ] "Ship": consult `docs/DEPLOYMENT.md`; if deploy is a scripted `pnpm`/wrangler one-liner with local credentials, run it; otherwise report the exact command for the user.
- [ ] Update the published artifact with a "shipped" addendum; update memory files; final report.

## Self-Review

- Spec coverage: Bundle 1 items → Tasks 1–8 (+6/7 for bars/forecast); Bundle 2 → Tasks 9–12; verification/merge → 13–14. Bundle 3 (tree silhouette shadows S2, biomes, wildlife visitations, forward preview) is explicitly out of scope for this plan — roadmap headline for the next cycle.
- Type consistency: `projectedBalance`/`DAMAGE_NOTCH`/`gardenForecast` signatures used in Tasks 6–7 match Tasks 1–2. `BotanicalCard` props in Task 9 match Task 8. `useDialogFocus` defined Task 8 (extracted in Task 11 note — define it in Task 8 directly to avoid drift).
- Placeholders: none — copy strings, formulas, CSS values are concrete; remaining judgment calls (exact scrim alpha, bar width) are explicitly resolved in the Task 13 visual pass.
