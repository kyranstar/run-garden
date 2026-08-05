# Garden Grainlight Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the garden renderer to the approved Grainlight aesthetic (film-grain gradients, layered haze, multi-tone canopies with rim light, organic edges) with zero engine/interaction changes.

**Architecture:** All changes live in `packages/garden-renderer/src`. Texture comes from two strengthened static SVG filters (grain, mottle); all plant/cloud organicness comes from deterministic procedural path wobble (never filters, so animation stays cheap). A new optional `lightHint` prop tells `PlantSprite` which side the sun is on.

**Tech Stack:** React SVG (renderToStaticMarkup-safe), vitest, playwright CLI for visual checks.

**Reference mock:** `/private/tmp/claude-501/-Users-kyranadams-src/f585f7bf-8066-4f71-9cc6-4cdc0e46c5a9/scratchpad/mocks/grainlight.html` (+ `.png`).

## Global Constraints

- Determinism is contractual: same snapshot → byte-identical markup (existing test enforces). Every random value comes from `rng("<stable-key>")`; every `feTurbulence` gets an explicit `seed`.
- rng draw-count stability: the NUMBER of `r()` calls per sprite/element must not depend on maturity, state, or `lightHint` — always draw, conditionally render.
- No SVG filter may sit inside or contain an animated (`className` keyframe) group, except the existing selection-outline filter. New filters go only on static full-scene rects.
- Path wobble amplitude ≤ 6 scene units so hit pads/outlines still hug the art.
- Health states (thirsty/wilted/dormant/dead) must stay visually distinct: state color adjustments in `paintFor` apply to ALL tone layers.
- Node 21 for tests (`pnpm vitest`), repo default. Run package tests from repo root with `--root packages/garden-renderer`.
- Commit after each task; keep messages `feat(garden): …` / `test(garden): …`.

## File Structure

- `packages/garden-renderer/dev/export-scenes.test.tsx` — NEW, env-gated scene exporter (dev loop).
- `packages/garden-renderer/dev/shots.sh` — NEW, screenshots all exported scenes.
- `packages/garden-renderer/src/organic.ts` — NEW: `blobPath`, `wobbleLine` deterministic geometry helpers + `LightHint` type.
- `packages/garden-renderer/src/sky.tsx` — clouds rebuilt, horizon warmth.
- `packages/garden-renderer/src/GardenScene.tsx` — hills, lightHint derivation.
- `packages/garden-renderer/src/terrain.tsx` — mottle, meadow grading, seed heads.
- `packages/garden-renderer/src/overlays.tsx` — grain finish strength.
- `packages/garden-renderer/src/PlantSprite.tsx` — tone-stacked archetypes.
- `packages/garden-renderer/test/renderer.test.tsx` — new invariants.

---

### Task 1: Scene export harness

**Files:**
- Create: `packages/garden-renderer/dev/export-scenes.test.tsx`
- Create: `packages/garden-renderer/dev/shots.sh`

**Interfaces:**
- Produces: `EXPORT_DIR=<dir> pnpm vitest run dev/export-scenes.test.tsx --root packages/garden-renderer` writes `golden.html`, `noon.html`, `night.html`, `drought.html`; `dev/shots.sh <dir>` writes matching PNGs.

- [ ] **Step 1: Write the exporter** (gated: skips unless `EXPORT_DIR` set)

```tsx
import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import { addDays } from "@rg/domain";
import { replay, simulateDay, type GardenDayInput, type GardenSnapshot } from "@rg/garden-engine";
import { GardenScene } from "../src/index";

const START = "2026-03-02";
const emptyDay = (date: string): GardenDayInput => ({
  date, completedRuns: [], restObserved: false, missedRuns: [], restModeActive: false, planGap: false,
});
function trainingWeeks(startMonday: string, weeks: number): GardenDayInput[] {
  const days: GardenDayInput[] = [];
  for (let w = 0; w < weeks; w++) {
    const mon = addDays(startMonday, w * 7);
    days.push({ ...emptyDay(mon), restObserved: true, weekAdherence: w > 0 ? 1 : undefined });
    days.push({ ...emptyDay(addDays(mon, 1)), completedRuns: [{ workoutId: `w-q${w}`, category: "quality" }] });
    days.push({ ...emptyDay(addDays(mon, 2)), restObserved: true });
    days.push({ ...emptyDay(addDays(mon, 3)), completedRuns: [{ workoutId: `w-e${w}`, category: "easy" }] });
    days.push({ ...emptyDay(addDays(mon, 4)), restObserved: true });
    days.push({ ...emptyDay(addDays(mon, 5)), completedRuns: [{ workoutId: `w-l${w}`, category: "long" }] });
    days.push({ ...emptyDay(addDays(mon, 6)), completedRuns: [{ workoutId: `w-r${w}`, category: "recovery" }] });
  }
  return days;
}
function droughtSnapshot(): GardenSnapshot {
  let s = replay(START, trainingWeeks(START, 4)).snapshot;
  let date = addDays(START, 28);
  for (let i = 0; i < 16; i++) { s = simulateDay(s, emptyDay(date)).snapshot; date = addDays(date, 1); }
  return s;
}
it.runIf(process.env.EXPORT_DIR)("exports grainlight review scenes", () => {
  const healthy = replay(START, trainingWeeks(START, 6)).snapshot;
  const scenes: Array<[string, GardenSnapshot, number]> = [
    ["golden", healthy, 17.5], ["noon", healthy, 13], ["night", healthy, 22.5], ["drought", droughtSnapshot(), 17.5],
  ];
  for (const [name, snap, hour] of scenes) {
    const svg = renderToStaticMarkup(<GardenScene snapshot={snap} timeOfDay={hour} reducedMotion={true} />);
    writeFileSync(`${process.env.EXPORT_DIR}/${name}.html`,
      `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style></head><body>${svg}</body></html>`);
  }
});
```

- [ ] **Step 2: Write `dev/shots.sh`**

```bash
#!/bin/sh
# Screenshot every exported scene HTML in $1 (default: garden-shots under the repo scratch).
set -e
DIR="${1:?usage: shots.sh <dir with exported html>}"
PW="$(dirname "$0")/../../../apps/web/node_modules/.bin/playwright"
for f in "$DIR"/*.html; do
  "$PW" screenshot --viewport-size=1000,560 "file://$f" "${f%.html}.png"
done
```

- [ ] **Step 3: Verify** — run exporter + shots against an empty tmp dir; confirm 4 HTMLs + 4 PNGs; confirm plain `pnpm vitest run --root packages/garden-renderer` still passes (exporter skips).

- [ ] **Step 4: Commit** — `git add packages/garden-renderer/dev && git commit -m "test(garden): env-gated scene export harness for visual review"`

### Task 2: Grain + mottle infrastructure

**Files:**
- Modify: `packages/garden-renderer/src/sky.tsx` (SceneDefs)
- Modify: `packages/garden-renderer/src/overlays.tsx` (Finish)
- Modify: `packages/garden-renderer/src/terrain.tsx` (mottle rect)
- Test: `packages/garden-renderer/test/renderer.test.tsx`

**Interfaces:**
- Produces: defs `#${p}-grain` (strengthened, seeded), `#${p}-mottle` (low-freq warm colorized noise). Finish grain rect at `soft-light` / `opacity 0.3`. Terrain renders `<rect data-terrain="mottle">` clipped to ground.

- [ ] **Step 1: Failing test** — add to `renderer.test.tsx`:

```tsx
it("carries the grainlight texture layers exactly once", () => {
  const markup = renderScene(healthySnapshot());
  expect(markup.match(/data-finish-grain="true"/g)).toHaveLength(1);
  expect(markup.match(/data-terrain="mottle"/g)).toHaveLength(1);
  // every turbulence node is seeded → deterministic across UAs
  const turbs = markup.match(/<feTurbulence[^>]*>/g) ?? [];
  expect(turbs.length).toBeGreaterThanOrEqual(2);
  for (const t of turbs) expect(t).toMatch(/seed="\d+"/);
});
```

- [ ] **Step 2: Run — expect FAIL** (`data-finish-grain` absent).

- [ ] **Step 3: Implement.** SceneDefs: add `seed="7" stitchTiles="stitch"` to `-grain`; append contrast boost `<feComponentTransfer><feFuncR type="linear" slope="1.8" intercept="-0.4"/>…same G,B…</feComponentTransfer>`. Add mottle def:

```tsx
<filter id={`${p}-mottle`} x="-5%" y="-5%" width="110%" height="110%">
  <feTurbulence type="fractalNoise" baseFrequency="0.006 0.012" numOctaves="2" seed="11" result="m" />
  <feColorMatrix in="m" type="matrix"
    values="0 0 0 0 0.42  0 0 0 0 0.36  0 0 0 0 0.18  0.9 0.4 0 0 0" />
</filter>
```

Finish: grain rect → `data-finish-grain="true"`, `opacity={0.3}`, `mixBlendMode: "soft-light"`. Terrain: after bands, `<rect data-terrain="mottle" x={0} y={290} width={1000} height={270} filter={`url(#${p}-mottle)`} opacity={0.25} style={{ mixBlendMode: "soft-light" }} pointerEvents="none" />`.

- [ ] **Step 4: Run tests — PASS**, including determinism test.
- [ ] **Step 5: Visual check** — export + shots; grain visible at 100% zoom on sky and ground in `golden.png`, no banding, night not crushed.
- [ ] **Step 6: Commit** — `feat(garden): grainlight texture — seeded scene grain + ground mottle`

### Task 3: Organic geometry helpers

**Files:**
- Create: `packages/garden-renderer/src/organic.ts`
- Test: `packages/garden-renderer/test/organic.test.ts`

**Interfaces:**
- Produces:
  - `blobPath(r: () => number, cx: number, cy: number, rx: number, ry: number, wobble?: number, k?: number): string` — closed smooth organic blob (k jittered radial points, quadratic loop, ≤2-decimal coords). Consumes exactly `k` draws.
  - `wobbleLine(r: () => number, x0,y0,x1,y1, segs?: number, amp?: number): string` — polyline path with perpendicular jitter. Consumes exactly `segs-1` draws.
  - `type LightHint = { dx: -1 | 0 | 1; litColor: string; amount: number }` and `DEFAULT_LIGHT_HINT` (`{ dx: 0, litColor: "#f0e2ae", amount: 0.35 }`).

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { rng } from "@rg/garden-engine";
import { blobPath, wobbleLine } from "../src/organic";

describe("organic helpers", () => {
  it("blobPath is deterministic, closed, and finite", () => {
    const a = blobPath(rng("t:blob"), 0, -40, 30, 22);
    expect(a).toBe(blobPath(rng("t:blob"), 0, -40, 30, 22));
    expect(a.endsWith("Z")).toBe(true);
    expect(a).not.toMatch(/NaN|Infinity/);
  });
  it("blobPath consumes a fixed draw count so neighbors don't reshuffle", () => {
    const r1 = rng("t:count"); blobPath(r1, 0, 0, 10, 10, 0.3, 9);
    const r2 = rng("t:count"); for (let i = 0; i < 9; i++) r2();
    expect(r1()).toBe(r2());
  });
  it("wobbleLine stays within amp of the straight line", () => {
    const d = wobbleLine(rng("t:wl"), 0, 0, 0, -60, 5, 3);
    const ys = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);
    expect(Math.max(...ys.filter((_, i) => i % 2 === 0).map(Math.abs))).toBeLessThanOrEqual(3.5);
  });
});
```

- [ ] **Step 2: Run — FAIL** (module missing). **Step 3: Implement:**

```ts
const n = (x: number): number => Math.round(x * 100) / 100;

export function blobPath(r: () => number, cx: number, cy: number, rx: number, ry: number, wobble = 0.16, k = 9): string {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    const w = 1 - wobble / 2 + r() * wobble;
    pts.push([cx + Math.cos(a) * rx * w, cy + Math.sin(a) * ry * w]);
  }
  const mid = (i: number): [number, number] => {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % k]!;
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  };
  let d = `M${n(mid(k - 1)[0])},${n(mid(k - 1)[1])} `;
  for (let i = 0; i < k; i++) {
    const [mx, my] = mid(i);
    d += `Q${n(pts[i]![0])},${n(pts[i]![1])} ${n(mx)},${n(my)} `;
  }
  return d + "Z";
}

export function wobbleLine(r: () => number, x0: number, y0: number, x1: number, y1: number, segs = 4, amp = 2): string {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  let d = `M${n(x0)},${n(y0)}`;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const j = i === segs ? 0 : (r() * 2 - 1) * amp;
    d += ` L${n(x0 + dx * t + px * j)},${n(y0 + dy * t + py * j)}`;
  }
  return d;
}

export interface LightHint { dx: -1 | 0 | 1; litColor: string; amount: number }
export const DEFAULT_LIGHT_HINT: LightHint = { dx: 0, litColor: "#f0e2ae", amount: 0.35 };
```

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** — `feat(garden): deterministic organic geometry helpers`

### Task 4: Sky — organic clouds + horizon warmth

**Files:**
- Modify: `packages/garden-renderer/src/sky.tsx` (Clouds, Sky)
- Test: extend `renderer.test.tsx`

**Interfaces:**
- Consumes: `blobPath` from `../src/organic`; `light.cloudColor/sunColor/cloudShape/cloudCount`.
- Produces: puffy clouds as `<g data-cloud="puff">` = 3 overlapping blobs (base shade, main, lit crown offset toward sun) + flat-bottom mask feel via wider bottom blob; wisps unchanged shape but `blobPath` flattened (ry ≪ rx).

- [ ] **Step 1: Failing test** — `expect(markup).toContain('data-cloud="puff"')` and no `<ellipse` inside puff groups for the healthy golden scene (`cloudCount ≥ 1` there — assert via regex on the puff group's inner markup).
- [ ] **Step 2: Implement.** Per cloud i: `const cr = rng(\`weather:clouds:\${i}\`)`; main = `blobPath(cr, cx, cy, 52*sc, 15*sc, 0.22, 10)` fill cloudColor; under-shade = `blobPath(cr, cx-6*sc, cy+6*sc, 40*sc, 10*sc, 0.2, 8)` fill `shade(cloudColor, 0.94)`; lit crown = `blobPath(cr, cx+10*sc*litdx, cy-7*sc, 30*sc, 9*sc, 0.24, 8)` fill `mix(cloudColor, light.sunColor, 0.35)` where `litdx` = sun side (+1 if `light.sunX > cx` else −1; 0 → +1). Keep drift animation classes on the same outer `<g>`.
- [ ] **Step 3: Sky horizon warmth** — under `Celestial`, add `<rect data-sky="horizonwarm" x=0 y=230 width=1000 height=75 fill={`url(#${p}-horizonwarm)`} opacity={0.5}/>` with a new SceneDefs vertical gradient `transparent → mix(skyHorizon, sunColor, 0.5)`.
- [ ] **Step 4: Tests PASS + visual check** (golden + night: night clouds must not glow warm — scale lit-crown mix by `light.beamStrength`).
- [ ] **Step 5: Commit** — `feat(garden): organic tone-stacked clouds and horizon warmth`

### Task 5: Hills — third ridge, haze mixing, crest rim

**Files:**
- Modify: `packages/garden-renderer/src/GardenScene.tsx` (hills block)
- Test: extend `renderer.test.tsx`

**Interfaces:**
- Consumes: `light.hill/hazeColor/sunColor/beamStrength`; `mix`/`shade` from `./color`.
- Produces: `<g data-scene="hills">` with three ridge paths (far→near: heavier haze mix 0.55/0.35/0.15) and one crest-rim stroke on the near ridge (`stroke=mix(hill, sunColor, 0.5)`, `strokeWidth 1.4`, `opacity 0.5*beamStrength`, `fill="none"`).

- [ ] **Step 1: Failing test** — `expect(markup.match(/data-scene="hills"/g)).toHaveLength(1)` + ridge count 3 via `data-ridge` attrs.
- [ ] **Step 2: Implement** — replace the two existing hill paths; ridge paths get gentle multi-swell curves (fixed coefficients, no rng needed):
far `M0,288 C180,242 390,250 560,282 S840,238 1000,280 L1000,302 L0,302 Z`, mid `M0,296 C150,262 420,256 640,290 S860,258 1000,294 L1000,306 L0,306 Z`, near `M0,300 C220,272 480,268 700,296 S900,272 1000,298 L1000,310 L0,310 Z`; keep `-hillblur` only on far.
- [ ] **Step 3: Tests + visual** (ridges recede; rim only at sunny hours).
- [ ] **Step 4: Commit** — `feat(garden): receding three-ridge horizon with sunlit crest`

### Task 6: PlantSprite — lightHint plumbing + tree archetypes

**Files:**
- Modify: `packages/garden-renderer/src/PlantSprite.tsx`
- Modify: `packages/garden-renderer/src/GardenScene.tsx` (derive + pass hint)
- Modify: `packages/garden-renderer/src/index.ts` (export `LightHint`)
- Test: extend `renderer.test.tsx`

**Interfaces:**
- Consumes: `blobPath`, `LightHint`, `DEFAULT_LIGHT_HINT`.
- Produces: `PlantSprite` accepts `lightHint?: LightHint`. GardenScene passes `{ dx: light.shadowDx > 0.05 ? -1 : light.shadowDx < -0.05 ? 1 : 0, litColor: light.sunX !== null ? light.sunColor : "#c9d4e8", amount: light.sunX !== null ? 0.4 + 0.35 * light.beamStrength : 0.15 }`. Every leafy canopy mass renders as tone stack: shade blob (full, `shade(c1, 0.78)`), mid blob (0.92×, `c1`), lit blob (0.5–0.6×, offset `dx * rx*0.2, -ry*0.16`, `mix(c1, litColor, 0.5 * amount ... clamped)`), all from `blobPath` with the plant's existing `sprite:` rng stream appended AFTER current draws (never interleaved — geometry of trunks must not shift more than the redesign intends).

- [ ] **Step 1: Failing tests**

```tsx
it("tree canopies stack three tones and follow the sun side", () => {
  const oak = SPECIES.find((s) => s.id === "milestone_oak")!;
  const plant = syntheticPlant(oak, "healthy");
  const left = renderToStaticMarkup(<PlantSprite plant={plant} species={oak} idPrefix="t"
    lightHint={{ dx: -1, litColor: "#ffd27f", amount: 0.8 }} />);
  const right = renderToStaticMarkup(<PlantSprite plant={plant} species={oak} idPrefix="t"
    lightHint={{ dx: 1, litColor: "#ffd27f", amount: 0.8 }} />);
  expect(left).toContain('data-tone="lit"');
  expect(left).not.toBe(right); // lit mass flips with the sun
  const tones = [...left.matchAll(/data-tone="(shade|mid|lit)"/g)].map((m) => m[1]);
  expect(new Set(tones)).toEqual(new Set(["shade", "mid", "lit"]));
});
it("state adjustments hit every canopy tone", () => {
  const oak = SPECIES.find((s) => s.id === "milestone_oak")!;
  const healthy = renderToStaticMarkup(<PlantSprite plant={syntheticPlant(oak, "healthy")} species={oak} idPrefix="t" />);
  const wilted = renderToStaticMarkup(<PlantSprite plant={syntheticPlant(oak, "wilted")} species={oak} idPrefix="t" />);
  const fills = (m: string) => [...m.matchAll(/data-tone="[a-z]+"[^>]*fill="(#[0-9a-f]{6})"/g)].map((x) => x[1]);
  expect(fills(wilted)).not.toEqual(fills(healthy));
  expect(fills(wilted)).toHaveLength(fills(healthy).length);
});
```

- [ ] **Step 2: FAIL.** **Step 3: Implement** for the tree archetypes (deciduous/birch/conifer/willow-type — every species the `tree` category renders through): replace single canopy ellipse/blob with the tone stack; conifers stack three jagged `blobPath`s (ry ≫ rx, wobble 0.1) with lit edge on sun side; keep trunks, branches, bloom accents. `paintFor` unchanged (state adjust maps over c1 → tones derive from adjusted c1, so wilted stacks desaturate together).
- [ ] **Step 4: PASS + visual** — golden: oak reads 3-tone with warm crown; noon: subtler; night: cool faint rim; drought scene: wilted trees still clearly sadder than healthy.
- [ ] **Step 5: Commit** — `feat(garden): tone-stacked tree canopies with sun-side rim light`

### Task 7: Remaining archetypes

**Files:**
- Modify: `packages/garden-renderer/src/PlantSprite.tsx`
- Test: extend `renderer.test.tsx`

**Interfaces:** same tone-stack vocabulary at smaller scale:
- shrub: 2 blobs (shade full + lit 0.55× sun-side-top), `data-tone` on both.
- flower: wobbled stem (`wobbleLine`, amp 1.2), petals keep species geometry but get one lit petal overlay (`data-tone="lit"`, opacity `0.6*amount`).
- fern/grass/groundcover: blade paths re-drawn through `wobbleLine` (amp ≤ 1.5); groundcover pads become mini blobs (k=7, wobble 0.2).
- vine: keep lattice, leaves become 2-tone (shade + mid).
- fungus: cap gets lit crescent via smaller offset blob under `data-tone="lit"`.

- [ ] **Step 1: Failing test** — synthetic sprite per category asserts ≥1 `data-tone` node for shrub/flower/vine/fungus, and blade `d` attrs contain ≥2 `L` segments (wobbled) for grass/fern.
- [ ] **Step 2: Implement across archetypes.** **Step 3: PASS + visual** (all four scenes + a codex render with no hint: `DEFAULT_LIGHT_HINT` gives gentle top-light, nothing flat-black).
- [ ] **Step 4: Commit** — `feat(garden): grainlight tone pass across all plant archetypes`

### Task 8: Terrain grading, seed heads, shadows, final matrix

**Files:**
- Modify: `packages/garden-renderer/src/terrain.tsx`, `packages/garden-renderer/src/GardenScene.tsx` (shadow warmth)
- Test: extend `renderer.test.tsx`

**Interfaces:**
- Meadow strokes: blade color additionally mixed toward `light.sunColor` by `0.12 * (1 - |x - sunX|/1000)` when sun is out (guard `sunX !== null`).
- Seed heads: `rng("terrain:seedheads")`, 24 fixed draws, render `Math.round(10 + 8 * floweringDensity)`; each = wobbled stem + 2.2r circle head `fill=mix(grassNear, light.sunColor, 0.55)`, `opacity 0.5 + 0.4 * beamStrength`, `data-terrain="seedhead"`.
- Cast shadows: `shadowColor` warmed `mix(shadowColor, "#6b4a2f", 0.25)` when `beamStrength > 0.3`; `castR` multiplier `0.9 → 1.05` at `shadowLen > 0.7`.

- [ ] **Step 1: Failing test** — `data-terrain="seedhead"` present in golden markup, absent in night markup (`beamStrength` 0 → opacity floor 0.5 still renders… so instead: seedhead HEAD fill differs between golden and night via litColor mix guard `sunX !== null`; assert count stable between the two).
- [ ] **Step 2: Implement.** **Step 3: Full matrix** — export all 4 scenes + screenshot; side-by-side against `grainlight.png` mock; check: grain tooth visible, clouds organic, 3 ridges, tone-stacked plants, seed heads golden hour only, drought reads dry, night reads calm.
- [ ] **Step 4: Full suite from repo root: `pnpm test` (Node 21). Expect all green (1013+ tests).**
- [ ] **Step 5: Commit** — `feat(garden): grainlight terrain grading, backlit seed heads, warm shadows`

## Self-Review

- Spec coverage: recipe items 1–8 map to Tasks 2 (grain/mottle), 4 (clouds), 5 (hills), 6–7 (canopies/foliage), 8 (meadow/seed heads/shadows/new-assets pass-through — stream/visitors inherit grain+haze, no redraw needed per spec).
- The mock's god rays already exist in `Finish` (beams) — no task needed; verified during Task 8 matrix.
- Types: `LightHint` defined once in `organic.ts`, exported through `index.ts` (Task 6), consumed in Tasks 6–7. `blobPath`/`wobbleLine` signatures consistent across Tasks 3, 4, 6, 7.
- No placeholders: every step has code or an exact command.
