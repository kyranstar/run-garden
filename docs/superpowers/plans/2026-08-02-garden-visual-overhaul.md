# Garden Visual Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the garden visual overhaul (spec: `docs/superpowers/specs/2026-08-01-garden-visual-overhaul-design.md`): a composed lighting color script, layered terrain with a seeded meadow, per-plant shadows, per-weather signature overlays, and one deterministic canvas atmosphere layer — so every weather × season × time-of-day × moisture combination is distinct and beautiful.

**Architecture:** All new code lives in `packages/garden-renderer/src` as five modules (`lighting.ts`, `sky.tsx`, `terrain.tsx`, `overlays.tsx`, `AtmosphereLayer.tsx` + `particles.ts`). `GardenScene` composes them and gains one opt-in prop `atmosphere?: boolean` (default `false` — existing consumers and tests see the same bare `<svg>` root). The color script and particle systems are pure functions of their inputs, seeded through the engine's `rng(key)`.

**Tech Stack:** React 18 (SVG + one Canvas 2D layer), TypeScript, vitest + `react-dom/server` `renderToStaticMarkup` for tests. No new dependencies.

## Global Constraints

- **Node versions:** run tests under Node 21 (`nvm use 21`, the machine default); wrangler/web builds need Node 22. The renderer's vitest suite works under Node 21.
- **Run tests with:** `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run` (add `-t "<name>"` for one test). Typecheck: `pnpm --filter @rg/garden-renderer typecheck`.
- **Git:** plain `git commit` in this repo can be SIGKILLed scanning the Rust `target/` tree. Always `git add <specific paths>` then `git commit`; if commit exits 137, build it with plumbing (`git write-tree` + `git commit-tree` + `git update-ref`).
- **No new dependencies.** Only existing workspace deps.
- **Determinism:** every random visual decision goes through `rng("<stable-key>")` from `@rg/garden-engine`. Same snapshot + same `timeOfDay` must render byte-identical SVG markup (existing test enforces this).
- **The reducedMotion contract:** when `reducedMotion` is true the SVG must contain no `<style>`, no `@keyframes`, and no `animation` substring (existing test), and the atmosphere layer must not mount.
- **Motion budget (from spec):** CSS animation periods 6–14 s; sway ≤ 1.5°; canvas particle alpha ≤ 0.35; ≤ 120 airborne particles active (gust-fringe blades are ground strokes, budgeted separately at ≤ 180); canvas capped at 30 fps and devicePixelRatio ≤ 2.
- **Existing helpers to reuse, never re-implement:** `mix`, `shade`, `desaturate` from `src/color.ts`; `rng` from `@rg/garden-engine`; `n(x)` (round to 2 decimals) is defined locally in each scene file.
- All file paths below are relative to `/Users/kyranadams/src/run-garden/packages/garden-renderer` unless they start with `apps/` or `packages/`.

---

### Task 1: `lighting.ts` — light-period keyframes and interpolation core

**Files:**
- Create: `src/lighting.ts`
- Test: `test/lighting.test.ts`

**Interfaces:**
- Consumes: `mix`, `shade`, `desaturate` from `./color`; `GardenSeason`, `GardenWeatherState` from `@rg/domain`.
- Produces (later tasks rely on these exact names):
  - `type LightPeriod = "night" | "dawn" | "morning" | "midday" | "golden" | "dusk"`
  - `interface SceneLight` (full field list in the code below)
  - `interface LightingInputs { hour: number; season: GardenSeason; weather: GardenWeatherState; moisture: number; inComeback: boolean; restMode: boolean }`
  - `function lightingFor(inp: LightingInputs): SceneLight`
  - `function moonPhase(isoDate: string): number` (0 = new, 0.5 = full)

- [ ] **Step 1: Write the failing test**

Create `test/lighting.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lightingFor, moonPhase, type LightingInputs } from "../src/lighting";

const HEX = /^#[0-9a-f]{6}$/;

function inputs(extra: Partial<LightingInputs> = {}): LightingInputs {
  return {
    hour: 13,
    season: "summer",
    weather: "soft_sun",
    moisture: 0.7,
    inComeback: false,
    restMode: false,
    ...extra,
  };
}

describe("lightingFor — periods and interpolation", () => {
  it("is deterministic", () => {
    expect(lightingFor(inputs())).toEqual(lightingFor(inputs()));
  });

  it("returns valid hex colors and clamped numerics at every hour", () => {
    for (let h = 0; h <= 24; h += 0.5) {
      const l = lightingFor(inputs({ hour: h }));
      for (const c of [l.skyTop, l.skyMid, l.skyHorizon, l.sunColor, l.ambient, l.grassNear, l.grassFar, l.soil, l.hill, l.hazeColor, l.cloudColor, l.moteColor, l.foliageTint]) {
        expect(c).toMatch(HEX);
      }
      expect(l.ambientStrength).toBeGreaterThanOrEqual(0);
      expect(l.ambientStrength).toBeLessThanOrEqual(0.45);
      expect(l.shadowOpacity).toBeGreaterThanOrEqual(0);
      expect(l.shadowOpacity).toBeLessThanOrEqual(0.16);
      expect(l.swayAmpDeg).toBeGreaterThanOrEqual(0);
      expect(l.swayAmpDeg).toBeLessThanOrEqual(1.5);
      expect(l.beamStrength).toBeGreaterThanOrEqual(0);
      expect(l.beamStrength).toBeLessThanOrEqual(1);
    }
  });

  it("is continuous across period boundaries (no palette jumps)", () => {
    for (let h = 0; h < 24; h += 0.1) {
      const a = lightingFor(inputs({ hour: h }));
      const b = lightingFor(inputs({ hour: h + 0.1 }));
      expect(Math.abs(a.ambientStrength - b.ambientStrength)).toBeLessThan(0.08);
      expect(Math.abs(a.shadowLen - b.shadowLen)).toBeLessThan(0.35);
      expect(Math.abs(a.beamStrength - b.beamStrength)).toBeLessThan(0.2);
    }
  });

  it("night has stars and a moon, midday has a sun and no stars", () => {
    const night = lightingFor(inputs({ hour: 23.5 }));
    expect(night.period).toBe("night");
    expect(night.starDensity).toBeGreaterThan(0.8);
    expect(night.sunX).toBeNull();
    expect(night.moonX).not.toBeNull();

    const midday = lightingFor(inputs({ hour: 13 }));
    expect(midday.period).toBe("midday");
    expect(midday.starDensity).toBe(0);
    expect(midday.sunX).not.toBeNull();
    expect(midday.moonX).toBeNull();
  });

  it("golden-hour shadows are longer than midday shadows", () => {
    const midday = lightingFor(inputs({ hour: 13 }));
    const golden = lightingFor(inputs({ hour: 18.9 })); // summer sunset 19.9 − 1.2
    expect(golden.period).toBe("golden");
    expect(golden.shadowLen).toBeGreaterThan(midday.shadowLen);
  });

  it("winter daylight is shorter than summer daylight", () => {
    // 07:00 is day in summer, still night in winter.
    expect(lightingFor(inputs({ hour: 7, season: "summer" })).sunX).not.toBeNull();
    expect(lightingFor(inputs({ hour: 7, season: "winter" })).sunX).toBeNull();
  });

  it("wetter gardens have greener grass", () => {
    const dry = lightingFor(inputs({ moisture: 0.1 }));
    const wet = lightingFor(inputs({ moisture: 0.9 }));
    expect(dry.grassNear).not.toBe(wet.grassNear);
  });
});

describe("moonPhase", () => {
  it("is in [0,1) and deterministic", () => {
    const p = moonPhase("2026-08-02");
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
    expect(moonPhase("2026-08-02")).toBe(p);
  });

  it("moves ~0.034 per day", () => {
    const a = moonPhase("2026-08-02");
    const b = moonPhase("2026-08-03");
    const d = Math.abs(b - a);
    expect(Math.min(d, 1 - d)).toBeCloseTo(1 / 29.5306, 2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/lighting.test.ts`
Expected: FAIL — `Cannot find module '../src/lighting'`.

- [ ] **Step 3: Implement `src/lighting.ts`**

```ts
import type { GardenSeason, GardenWeatherState } from "@rg/domain";
import { desaturate, mix, shade } from "./color";

/**
 * The color script. Pure: (hour, season, weather, moisture, flags) → every
 * color/light token the scene needs. Six authored light-period keyframes are
 * interpolated by hour; season biases and weather modifiers (Task 2) adjust
 * the result. No randomness — determinism is structural here.
 */

export type LightPeriod = "night" | "dawn" | "morning" | "midday" | "golden" | "dusk";

export interface SceneLight {
  period: LightPeriod;
  skyTop: string;
  skyMid: string;
  skyHorizon: string;
  /** Scene coords (viewBox 0 0 1000 560); null when below horizon. */
  sunX: number | null;
  sunY: number | null;
  sunColor: string;
  moonX: number | null;
  moonY: number | null;
  /** 0 = new, 0.5 = full. */
  moonPhaseValue: number;
  starDensity: number;
  /** Light tint mixed over land and foliage. */
  ambient: string;
  ambientStrength: number;
  /** Horizontal shadow direction −1 (cast left) … 1 (cast right). */
  shadowDx: number;
  /** Shadow length as a multiple of sprite footprint. */
  shadowLen: number;
  shadowOpacity: number;
  grassNear: string;
  grassFar: string;
  soil: string;
  hill: string;
  hazeColor: string;
  hazeStrength: number;
  beamStrength: number;
  cloudCount: number;
  cloudColor: string;
  cloudShape: "cumulus" | "wisp";
  swayAmpDeg: number;
  moteColor: string;
  /** Season-driven wildflower colors for the meadow. */
  meadowAccents: string[];
  foliageTint: string;
  foliageTintAmount: number;
  rainbow: boolean;
}

export interface LightingInputs {
  hour: number;
  season: GardenSeason;
  weather: GardenWeatherState;
  moisture: number;
  inComeback: boolean;
  restMode: boolean;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Authored per-period palette. Colors validated in the tier mockups. */
interface PeriodKey {
  skyTop: string;
  skyMid: string;
  skyHorizon: string;
  sunColor: string;
  ambient: string;
  ambientStrength: number;
  shadowLen: number;
  shadowOpacity: number;
  starDensity: number;
  hazeStrength: number;
  beamStrength: number;
  swayAmpDeg: number;
  moteColor: string;
}

const PERIODS: Record<LightPeriod, PeriodKey> = {
  night: {
    skyTop: "#0f1830", skyMid: "#1a2946", skyHorizon: "#27395b",
    sunColor: "#f6e6b0", ambient: "#16233f", ambientStrength: 0.4,
    shadowLen: 0.35, shadowOpacity: 0.04, starDensity: 1,
    hazeStrength: 0.1, beamStrength: 0, swayAmpDeg: 0.8, moteColor: "#f7e3a1",
  },
  dawn: {
    skyTop: "#6f7fa8", skyMid: "#d9a68c", skyHorizon: "#f2b98a",
    sunColor: "#ffd9a8", ambient: "#e8a06a", ambientStrength: 0.16,
    shadowLen: 1.6, shadowOpacity: 0.1, starDensity: 0.15,
    hazeStrength: 0.3, beamStrength: 0.5, swayAmpDeg: 0.9, moteColor: "#ffe0b3",
  },
  morning: {
    skyTop: "#9fc0d8", skyMid: "#cfe0d8", skyHorizon: "#eef0d8",
    sunColor: "#fff3c4", ambient: "#fff3c4", ambientStrength: 0.06,
    shadowLen: 0.9, shadowOpacity: 0.12, starDensity: 0,
    hazeStrength: 0.12, beamStrength: 0.25, swayAmpDeg: 1.1, moteColor: "#fff0c0",
  },
  midday: {
    skyTop: "#8fbcdc", skyMid: "#c6dcd8", skyHorizon: "#e9efdb",
    sunColor: "#fff8d8", ambient: "#ffffff", ambientStrength: 0.03,
    shadowLen: 0.45, shadowOpacity: 0.13, starDensity: 0,
    hazeStrength: 0.06, beamStrength: 0.1, swayAmpDeg: 1.0, moteColor: "#fff6cf",
  },
  golden: {
    skyTop: "#a9bcd6", skyMid: "#e3c8a0", skyHorizon: "#f2b478",
    sunColor: "#ffe9b8", ambient: "#f0b060", ambientStrength: 0.2,
    shadowLen: 1.5, shadowOpacity: 0.11, starDensity: 0,
    hazeStrength: 0.25, beamStrength: 0.85, swayAmpDeg: 1.2, moteColor: "#ffe2a6",
  },
  dusk: {
    skyTop: "#4d5578", skyMid: "#a883a0", skyHorizon: "#e08a6a",
    sunColor: "#ffc898", ambient: "#b06a8a", ambientStrength: 0.22,
    shadowLen: 1.2, shadowOpacity: 0.07, starDensity: 0.45,
    hazeStrength: 0.3, beamStrength: 0.35, swayAmpDeg: 0.9, moteColor: "#f5cfa0",
  },
};

const SUNRISE: Record<GardenSeason, number> = { spring: 6.3, summer: 5.6, autumn: 6.8, winter: 7.5 };
const SUNSET: Record<GardenSeason, number> = { spring: 18.6, summer: 19.9, autumn: 18.0, winter: 17.0 };
const SUN_ARC_HEIGHT: Record<GardenSeason, number> = { spring: 190, summer: 215, autumn: 185, winter: 150 };

function lerpPeriod(a: PeriodKey, b: PeriodKey, t: number): PeriodKey {
  return {
    skyTop: mix(a.skyTop, b.skyTop, t),
    skyMid: mix(a.skyMid, b.skyMid, t),
    skyHorizon: mix(a.skyHorizon, b.skyHorizon, t),
    sunColor: mix(a.sunColor, b.sunColor, t),
    ambient: mix(a.ambient, b.ambient, t),
    ambientStrength: lerp(a.ambientStrength, b.ambientStrength, t),
    shadowLen: lerp(a.shadowLen, b.shadowLen, t),
    shadowOpacity: lerp(a.shadowOpacity, b.shadowOpacity, t),
    starDensity: lerp(a.starDensity, b.starDensity, t),
    hazeStrength: lerp(a.hazeStrength, b.hazeStrength, t),
    beamStrength: lerp(a.beamStrength, b.beamStrength, t),
    swayAmpDeg: lerp(a.swayAmpDeg, b.swayAmpDeg, t),
    moteColor: mix(a.moteColor, b.moteColor, t),
  };
}

/** Anchor hours for one day, in ascending order, with wrapping night ends. */
function anchors(season: GardenSeason): Array<{ h: number; period: LightPeriod }> {
  const rise = SUNRISE[season];
  const set = SUNSET[season];
  return [
    { h: rise - 1.1, period: "night" },
    { h: rise, period: "dawn" },
    { h: rise + 2.2, period: "morning" },
    { h: (rise + set) / 2, period: "midday" },
    { h: set - 1.2, period: "golden" },
    { h: set + 0.4, period: "dusk" },
    { h: set + 1.6, period: "night" },
  ];
}

function periodAt(hour: number, season: GardenSeason): { key: PeriodKey; period: LightPeriod } {
  const as = anchors(season);
  const h = ((hour % 24) + 24) % 24;
  if (h <= as[0]!.h || h >= as[as.length - 1]!.h) {
    return { key: PERIODS.night, period: "night" };
  }
  for (let i = 0; i < as.length - 1; i++) {
    const a = as[i]!;
    const b = as[i + 1]!;
    if (h >= a.h && h <= b.h) {
      const t = (h - a.h) / (b.h - a.h);
      return {
        key: lerpPeriod(PERIODS[a.period], PERIODS[b.period], t),
        period: t < 0.5 ? a.period : b.period,
      };
    }
  }
  return { key: PERIODS.night, period: "night" };
}

const arcX = (f: number): number => 120 + f * 760;

/** Mean-synodic-month approximation, anchored to the 2000-01-06 new moon. */
export function moonPhase(isoDate: string): number {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) - Date.parse("2000-01-06T18:14:00Z");
  const days = ms / 86_400_000;
  return ((days / 29.530588) % 1 + 1) % 1;
}

export function lightingFor(inp: LightingInputs): SceneLight {
  const season = inp.season;
  const { key, period } = periodAt(inp.hour, season);
  const h = ((inp.hour % 24) + 24) % 24;
  const rise = SUNRISE[season];
  const set = SUNSET[season];

  // Sun / moon on the existing arc, with a season-scaled height.
  let sunX: number | null = null;
  let sunY: number | null = null;
  let moonX: number | null = null;
  let moonY: number | null = null;
  if (h >= rise && h <= set) {
    const f = (h - rise) / (set - rise);
    sunX = arcX(f);
    sunY = 250 - Math.sin(f * Math.PI) * SUN_ARC_HEIGHT[season];
  } else {
    const nightLen = 24 - (set - rise);
    const nf = (h > set ? h - set : h + 24 - set) / nightLen;
    moonX = arcX(nf);
    moonY = 250 - Math.sin(nf * Math.PI) * 170 + 12;
  }

  // Moisture-driven land ramp (existing endpoints, kept).
  const grassBase = mix("#c0ab6e", "#7aa458", clamp01(inp.moisture));
  const soilBase = mix("#b3a084", "#8f7a5c", clamp01(inp.moisture));
  const hillBase = desaturate(mix("#b0ab7f", "#8fae86", clamp01(inp.moisture)), 0.18);

  const light: SceneLight = {
    period,
    skyTop: key.skyTop,
    skyMid: key.skyMid,
    skyHorizon: key.skyHorizon,
    sunX,
    sunY,
    sunColor: key.sunColor,
    moonX,
    moonY,
    moonPhaseValue: 0.5, // real date wired in by the scene (Task 3)
    starDensity: key.starDensity,
    ambient: key.ambient,
    ambientStrength: key.ambientStrength,
    shadowDx: sunX !== null ? Math.max(-1, Math.min(1, -((sunX / 1000) * 2 - 1))) : 0.15,
    shadowLen: key.shadowLen,
    shadowOpacity: key.shadowOpacity,
    grassNear: mix(grassBase, key.ambient, key.ambientStrength * 0.6),
    grassFar: mix(mix(shade(grassBase, 1.06), key.skyHorizon, 0.3 + key.hazeStrength * 0.3), key.ambient, key.ambientStrength * 0.4),
    soil: mix(soilBase, key.ambient, key.ambientStrength * 0.5),
    hill: mix(hillBase, key.skyHorizon, 0.45),
    hazeColor: key.skyHorizon,
    hazeStrength: key.hazeStrength,
    beamStrength: sunX !== null ? key.beamStrength : 0,
    cloudCount: 2,
    cloudColor: mix("#f1f3ee", key.skyHorizon, 0.35),
    cloudShape: "cumulus",
    swayAmpDeg: key.swayAmpDeg,
    moteColor: key.moteColor,
    meadowAccents: ["#e0b23e", "#c86f5a", "#b58cbd"],
    foliageTint: key.ambient,
    foliageTintAmount: key.ambientStrength * 0.5,
    rainbow: false,
  };
  return applySeason(applyWeather(light, inp), inp);
}

/** Task 2 fills these in; identity passes keep Task 1 green. */
function applyWeather(l: SceneLight, _inp: LightingInputs): SceneLight {
  return l;
}
function applySeason(l: SceneLight, _inp: LightingInputs): SceneLight {
  return l;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/lighting.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/kyranadams/src/run-garden
pnpm --filter @rg/garden-renderer typecheck
git add packages/garden-renderer/src/lighting.ts packages/garden-renderer/test/lighting.test.ts
git commit -m "feat(garden): lighting color script — period keyframes + interpolation"
```

---

### Task 2: `lighting.ts` — season biases, weather modifiers, restMode, rainbow

**Files:**
- Modify: `src/lighting.ts` (replace the identity `applyWeather`/`applySeason` stubs)
- Test: `test/lighting.test.ts` (append a describe block)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: final `lightingFor` behavior. No signature changes. Later tasks rely on: `rainbow` true only for `recovery_rain` + `inComeback` + period `golden|dawn`; `swayAmpDeg` highest for `seasonal_breeze`, lowest for `mild_drought`; `cloudShape === "wisp"` for `dry_spell`.

- [ ] **Step 1: Append failing tests**

Append to `test/lighting.test.ts`:

```ts
describe("lightingFor — season and weather composition", () => {
  it("every weather × season × sample hour yields valid colors", () => {
    const weathers = ["fresh_rain", "clear_sun", "light_clouds", "dry_spell", "mild_drought", "recovery_rain", "seasonal_breeze", "soft_sun"] as const;
    const seasons = ["spring", "summer", "autumn", "winter"] as const;
    for (const weather of weathers) {
      for (const season of seasons) {
        for (const hour of [2, 6.5, 9, 13, 17.5, 20.5]) {
          const l = lightingFor(inputs({ weather, season, hour }));
          expect(l.skyTop).toMatch(HEX);
          expect(l.grassNear).toMatch(HEX);
          expect(l.swayAmpDeg).toBeLessThanOrEqual(1.5);
          expect(l.meadowAccents.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("weather signatures are distinct", () => {
    const at = (weather: LightingInputs["weather"]) => lightingFor(inputs({ weather }));
    expect(at("seasonal_breeze").swayAmpDeg).toBeGreaterThan(at("soft_sun").swayAmpDeg);
    expect(at("mild_drought").swayAmpDeg).toBeLessThan(at("soft_sun").swayAmpDeg);
    expect(at("dry_spell").cloudShape).toBe("wisp");
    expect(at("light_clouds").cloudCount).toBeGreaterThan(at("clear_sun").cloudCount);
    expect(at("fresh_rain").skyTop).not.toBe(at("clear_sun").skyTop);
  });

  it("seasons shift the meadow accents", () => {
    const spring = lightingFor(inputs({ season: "spring" }));
    const autumn = lightingFor(inputs({ season: "autumn" }));
    expect(spring.meadowAccents).not.toEqual(autumn.meadowAccents);
  });

  it("rainbow appears only for recovery_rain + inComeback + low sun", () => {
    const golden = { hour: 18.9, weather: "recovery_rain" as const };
    expect(lightingFor(inputs({ ...golden, inComeback: true })).rainbow).toBe(true);
    expect(lightingFor(inputs({ ...golden, inComeback: false })).rainbow).toBe(false);
    expect(lightingFor(inputs({ hour: 13, weather: "recovery_rain", inComeback: true })).rainbow).toBe(false);
    expect(lightingFor(inputs({ ...golden, weather: "fresh_rain", inComeback: true })).rainbow).toBe(false);
  });

  it("restMode becalms motion and light", () => {
    const on = lightingFor(inputs({ restMode: true }));
    const off = lightingFor(inputs({ restMode: false }));
    expect(on.swayAmpDeg).toBeLessThan(off.swayAmpDeg);
    expect(on.beamStrength).toBeLessThanOrEqual(off.beamStrength);
  });
});
```

- [ ] **Step 2: Run the test to verify the new block fails**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/lighting.test.ts`
Expected: FAIL on "weather signatures are distinct", "seasons shift the meadow accents", "rainbow…", "restMode…" (identity stubs).

- [ ] **Step 3: Replace the stubs in `src/lighting.ts`**

Replace `applyWeather` and `applySeason` with:

```ts
interface SeasonBias {
  foliageTint: string;
  foliageAmount: number;
  accents: string[];
  grassAdjust: (c: string) => string;
  skyAdjust: (c: string) => string;
}

const SEASONS: Record<GardenSeason, SeasonBias> = {
  spring: {
    foliageTint: "#7fae62", foliageAmount: 0.1,
    accents: ["#f2ede0", "#e0b23e", "#b58cbd"],
    grassAdjust: (c) => mix(c, "#7fae62", 0.12),
    skyAdjust: (c) => c,
  },
  summer: {
    foliageTint: "#3f7a3a", foliageAmount: 0.12,
    accents: ["#e0b23e", "#c86f5a", "#8f6fae"],
    grassAdjust: (c) => mix(c, "#3f7a3a", 0.1),
    skyAdjust: (c) => c,
  },
  autumn: {
    foliageTint: "#b07a3a", foliageAmount: 0.18,
    accents: ["#b5652f", "#d99a3d", "#9c6a80"],
    grassAdjust: (c) => mix(c, "#b08a4a", 0.18),
    skyAdjust: (c) => mix(c, "#d9b48a", 0.06),
  },
  winter: {
    foliageTint: "#8a9484", foliageAmount: 0.16,
    accents: ["#dfe4e6", "#d8c890"],
    grassAdjust: (c) => desaturate(mix(c, "#9aa08c", 0.2), 0.15),
    skyAdjust: (c) => shade(c, 0.94),
  },
};

function applySeason(l: SceneLight, inp: LightingInputs): SceneLight {
  const b = SEASONS[inp.season];
  return {
    ...l,
    grassNear: b.grassAdjust(l.grassNear),
    grassFar: b.grassAdjust(l.grassFar),
    skyTop: b.skyAdjust(l.skyTop),
    skyMid: b.skyAdjust(l.skyMid),
    skyHorizon: b.skyAdjust(l.skyHorizon),
    meadowAccents: b.accents,
    foliageTint: mix(l.foliageTint, b.foliageTint, 0.5),
    foliageTintAmount: Math.min(0.3, l.foliageTintAmount + b.foliageAmount * 0.5),
  };
}

function applyWeather(l: SceneLight, inp: LightingInputs): SceneLight {
  let out: SceneLight = { ...l };
  switch (inp.weather) {
    case "fresh_rain":
      out = {
        ...out,
        skyTop: mix(out.skyTop, "#7f9db0", 0.4),
        skyMid: mix(out.skyMid, "#9db4ba", 0.35),
        skyHorizon: mix(out.skyHorizon, "#c2d4cd", 0.3),
        grassNear: mix(out.grassNear, "#5f8f4a", 0.2),
        grassFar: mix(out.grassFar, "#6f9a5c", 0.15),
        beamStrength: 0,
        cloudCount: 3,
        cloudColor: mix(out.cloudColor, "#aebac0", 0.5),
        shadowOpacity: out.shadowOpacity * 0.4,
        hazeStrength: Math.min(0.5, out.hazeStrength + 0.1),
      };
      break;
    case "recovery_rain":
      out = {
        ...out,
        skyTop: mix(out.skyTop, "#8fa3b5", 0.25),
        skyHorizon: mix(out.skyHorizon, "#e8d3a8", 0.3),
        grassNear: mix(out.grassNear, "#5f8f4a", 0.15),
        beamStrength: Math.min(1, out.beamStrength + 0.2),
        cloudCount: 3,
        cloudColor: mix(out.cloudColor, "#c8c2ae", 0.4),
        shadowOpacity: out.shadowOpacity * 0.6,
        hazeStrength: Math.min(0.5, out.hazeStrength + 0.15),
      };
      break;
    case "clear_sun":
      out = { ...out, cloudCount: 0, beamStrength: Math.min(1, out.beamStrength + 0.1), shadowOpacity: Math.min(0.16, out.shadowOpacity * 1.15) };
      break;
    case "soft_sun":
      out = { ...out, cloudCount: 1 };
      break;
    case "light_clouds":
      out = { ...out, cloudCount: 4, beamStrength: out.beamStrength * 0.5, shadowOpacity: out.shadowOpacity * 0.7, skyTop: mix(out.skyTop, "#a8b8c2", 0.2) };
      break;
    case "dry_spell":
      out = {
        ...out,
        skyTop: mix(out.skyTop, "#c2c4a8", 0.3),
        skyHorizon: mix(out.skyHorizon, "#e0d4a8", 0.35),
        cloudCount: 2,
        cloudShape: "wisp",
        cloudColor: mix(out.cloudColor, "#d6ccba", 0.5),
        hazeStrength: Math.min(0.5, out.hazeStrength + 0.15),
        swayAmpDeg: out.swayAmpDeg * 0.7,
        moteColor: "#e8d8a8",
      };
      break;
    case "mild_drought":
      out = {
        ...out,
        skyTop: mix(out.skyTop, "#c8b088", 0.35),
        skyMid: mix(out.skyMid, "#d8bc8e", 0.35),
        skyHorizon: mix(out.skyHorizon, "#e5cf9a", 0.4),
        grassNear: mix(out.grassNear, "#b8a468", 0.25),
        grassFar: mix(out.grassFar, "#c0ae78", 0.2),
        hazeStrength: 0.4,
        hazeColor: "#e5d3a4",
        beamStrength: out.beamStrength * 0.5,
        cloudCount: 0,
        swayAmpDeg: out.swayAmpDeg * 0.5,
        moteColor: "#e0c890",
        sunColor: mix(out.sunColor, "#e8c890", 0.4),
      };
      break;
    case "seasonal_breeze":
      out = { ...out, cloudCount: 2, swayAmpDeg: Math.min(1.5, out.swayAmpDeg * 1.4) };
      break;
  }
  if (inp.restMode) {
    out = {
      ...out,
      swayAmpDeg: out.swayAmpDeg * 0.6,
      beamStrength: out.beamStrength * 0.8,
      ambientStrength: out.ambientStrength * 0.85,
    };
  }
  out.rainbow =
    inp.weather === "recovery_rain" &&
    inp.inComeback &&
    (out.period === "golden" || out.period === "dawn");
  return out;
}
```

Also move both functions ABOVE `lightingFor` or keep below (function declarations hoist — keep as declarations, not consts).

- [ ] **Step 4: Run the full lighting test file**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/lighting.test.ts`
Expected: PASS — including all Task 1 tests (continuity/clamps still hold after modifiers).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/kyranadams/src/run-garden
pnpm --filter @rg/garden-renderer typecheck
git add packages/garden-renderer/src/lighting.ts packages/garden-renderer/test/lighting.test.ts
git commit -m "feat(garden): season biases + weather modifiers in the color script"
```

---

### Task 3: `sky.tsx` — sky, stars, sun/moon with phase, clouds; wire into GardenScene

**Files:**
- Create: `src/sky.tsx`
- Modify: `src/GardenScene.tsx` (delete `skyColors`, `skyTime`, `celestialLayer`, `starsLayer`, `cloudsOverlay` usage from `weatherOverlay` for non-rain weathers, and the bottom tint rect; render the new Sky instead)
- Test: `test/renderer.test.tsx` (append)

**Interfaces:**
- Consumes: `SceneLight`, `lightingFor`, `moonPhase` from `./lighting`; `rng` from `@rg/garden-engine`; `shade`, `mix` from `./color`.
- Produces:
  - `function SceneDefs({ p, light }: { p: string; light: SceneLight }): ReactNode` — ALL shared `<defs>`: `${p}-sky` (3-stop linear gradient), `${p}-sunglow` (radial), `${p}-hillblur` (feGaussianBlur 1.6), `${p}-grain` (feTurbulence + saturate 0), `${p}-vig` (radial vignette gradient), `${p}-beam` (linear beam gradient, `gradientUnits="userSpaceOnUse"` recomputed from `light.sunX/sunY`).
  - `function Sky({ p, light, animate }: { p: string; light: SceneLight; animate: boolean }): ReactNode` — sky rect (0,0,1000,305), stars (count = `Math.round(32 * light.starDensity)`, keys `sky:stars`), sun (glow r 46–120 scaled by `beamStrength`, disc r 18–20) or moon (r 15, phase shadow: overlay circle `fill={light.skyTop}` offset `cx + 26 * (light.moonPhaseValue * 2 - 1)`), clouds (count/color/shape from light; cumulus = existing 3-ellipse group; wisp = single `rx 60 ry 4` ellipse opacity 0.5; drift class `${p}-cloud` kept).

- [ ] **Step 1: Append failing tests to `test/renderer.test.tsx`**

```tsx
describe("sky layer", () => {
  it("renders stars and a moon at night, sun by day", () => {
    const snapshot = healthySnapshot();
    const night = renderScene(snapshot, { timeOfDay: 23.5 });
    expect(night).toContain('data-sky="stars"');
    expect(night).toContain('data-celestial="moon"');
    expect(night).not.toContain('data-celestial="sun"');
    const day = renderScene(snapshot, { timeOfDay: 13 });
    expect(day).toContain('data-celestial="sun"');
    expect(day).not.toContain('data-sky="stars"');
  });

  it("sky gradient has three stops driven by the color script", () => {
    const markup = renderScene(healthySnapshot(), { timeOfDay: 13 });
    const stops = markup.match(/<stop offset/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(3);
  });

  it("dawn and midday skies differ", () => {
    const snapshot = healthySnapshot();
    expect(renderScene(snapshot, { timeOfDay: 6.5 })).not.toBe(renderScene(snapshot, { timeOfDay: 13 }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/renderer.test.tsx`
Expected: FAIL — current scene has no 3-stop sky; night moon exists but stars assertions may pass — the sun/`data-sky` assertions on the new markup contract fail.

- [ ] **Step 3: Implement `src/sky.tsx` and rewire `GardenScene.tsx`**

`src/sky.tsx`:

```tsx
import type { CSSProperties, ReactNode } from "react";
import { rng } from "@rg/garden-engine";
import { shade } from "./color";
import type { SceneLight } from "./lighting";

const n = (x: number): number => Math.round(x * 100) / 100;

export function SceneDefs({ p, light }: { p: string; light: SceneLight }): ReactNode {
  const bx = light.sunX ?? 820;
  const by = light.sunY ?? 205;
  return (
    <defs>
      <linearGradient id={`${p}-sky`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={light.skyTop} />
        <stop offset="55%" stopColor={light.skyMid} />
        <stop offset="100%" stopColor={light.skyHorizon} />
      </linearGradient>
      <radialGradient id={`${p}-sunglow`}>
        <stop offset="0%" stopColor={light.sunColor} stopOpacity={0.6} />
        <stop offset="100%" stopColor={light.sunColor} stopOpacity={0} />
      </radialGradient>
      <linearGradient id={`${p}-beam`} x1={n(bx)} y1={n(by)} x2={n(bx - 380)} y2={560} gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor={light.moteColor} stopOpacity={0.55} />
        <stop offset="85%" stopColor={light.moteColor} stopOpacity={0} />
      </linearGradient>
      <radialGradient id={`${p}-vig`} cx="50%" cy="42%" r="78%">
        <stop offset="62%" stopColor="#2b2414" stopOpacity={0} />
        <stop offset="100%" stopColor="#2b2414" stopOpacity={0.24} />
      </radialGradient>
      <filter id={`${p}-hillblur`}>
        <feGaussianBlur stdDeviation="1.6" />
      </filter>
      <filter id={`${p}-grain`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
    </defs>
  );
}

function Stars({ p, light, animate }: { p: string; light: SceneLight; animate: boolean }): ReactNode {
  const count = Math.round(32 * light.starDensity);
  if (count === 0) return null;
  const r = rng("sky:stars");
  const stars: ReactNode[] = [];
  for (let i = 0; i < 32; i++) {
    // Always consume the same rng draws so star positions are stable as
    // density fades in — extra stars are simply not rendered.
    const cx = n(r() * 1000);
    const cy = n(r() * 250);
    const rad = n(0.6 + r() * 0.9);
    const delay = n(r() * 3.5);
    if (i >= count) continue;
    const style: CSSProperties | undefined = animate ? { animationDelay: `-${delay}s` } : undefined;
    stars.push(
      <circle key={i} cx={cx} cy={cy} r={rad} fill="#eef0e0"
        className={animate ? `${p}-twinkle` : undefined} style={style}
        opacity={animate ? undefined : 0.7} />,
    );
  }
  return <g data-sky="stars" pointerEvents="none">{stars}</g>;
}

function Celestial({ p, light }: { p: string; light: SceneLight }): ReactNode {
  if (light.sunX !== null && light.sunY !== null) {
    return (
      <g data-celestial="sun" pointerEvents="none">
        <circle cx={n(light.sunX)} cy={n(light.sunY)} r={n(46 + 74 * light.beamStrength)} fill={`url(#${p}-sunglow)`} />
        <circle cx={n(light.sunX)} cy={n(light.sunY)} r={19} fill={light.sunColor} />
      </g>
    );
  }
  if (light.moonX !== null && light.moonY !== null) {
    const off = n(26 * (light.moonPhaseValue * 2 - 1));
    return (
      <g data-celestial="moon" pointerEvents="none">
        <circle cx={n(light.moonX)} cy={n(light.moonY)} r={38} fill={`url(#${p}-sunglow)`} opacity={0.5} />
        <circle cx={n(light.moonX)} cy={n(light.moonY)} r={15} fill="#eef0e0" />
        <circle cx={n(light.moonX + off)} cy={n(light.moonY - 3)} r={13} fill={light.skyTop} opacity={0.85} />
      </g>
    );
  }
  return null;
}

function Clouds({ p, light, animate }: { p: string; light: SceneLight; animate: boolean }): ReactNode {
  if (light.cloudCount === 0) return null;
  const r = rng("weather:clouds");
  const clouds: ReactNode[] = [];
  for (let i = 0; i < light.cloudCount; i++) {
    const cx = 140 + r() * 700;
    const cy = 52 + r() * 78;
    const sc = 0.8 + r() * 0.5;
    const style: CSSProperties | undefined = animate
      ? { animationDuration: `${n(62 + r() * 26)}s`, animationDelay: `-${n(r() * 40)}s` }
      : undefined;
    clouds.push(
      <g key={i} className={animate ? `${p}-cloud` : undefined} style={style} opacity={0.8}>
        {light.cloudShape === "wisp" ? (
          <ellipse cx={n(cx)} cy={n(cy)} rx={n(60 * sc)} ry={n(4 * sc)} fill={light.cloudColor} opacity={0.5} />
        ) : (
          <>
            <ellipse cx={n(cx)} cy={n(cy)} rx={n(46 * sc)} ry={n(13 * sc)} fill={light.cloudColor} />
            <ellipse cx={n(cx - 24 * sc)} cy={n(cy + 4 * sc)} rx={n(27 * sc)} ry={n(9 * sc)} fill={light.cloudColor} />
            <ellipse cx={n(cx + 26 * sc)} cy={n(cy + 5 * sc)} rx={n(30 * sc)} ry={n(10 * sc)} fill={shade(light.cloudColor, 0.96)} />
          </>
        )}
      </g>,
    );
  }
  return <g data-sky="clouds" pointerEvents="none">{clouds}</g>;
}

export function Sky({ p, light, animate }: { p: string; light: SceneLight; animate: boolean }): ReactNode {
  return (
    <>
      <rect x={0} y={0} width={1000} height={305} fill={`url(#${p}-sky)`} />
      <Stars p={p} light={light} animate={animate} />
      <Celestial p={p} light={light} />
      <Clouds p={p} light={light} animate={animate} />
    </>
  );
}
```

In `src/GardenScene.tsx`:
1. Delete `skyColors`, `skyTime`, `SkyTime`, `celestialLayer`, `starsLayer`, `arcX`, `arcY`, and the `cloudsOverlay` function (rain and breeze overlays stay for now — Task 6 moves them).
2. `weatherOverlay` keeps only the `fresh_rain`/`recovery_rain` → `rainOverlay` and `seasonal_breeze` → `breezeOverlay` cases plus `mild_drought` haze; `light_clouds`/`dry_spell` clouds now come from `Sky` (return `null` for those cases).
3. In the component body replace the palette block with:

```tsx
import { lightingFor, moonPhase } from "./lighting";
import { SceneDefs, Sky } from "./sky";
// …
const light = {
  ...lightingFor({
    hour: timeOfDay ?? 13,
    season: snapshot.state.season,
    weather,
    moisture: clamp01(snapshot.state.moisture),
    inComeback: snapshot.state.inComeback,
    restMode: snapshot.state.restMode,
  }),
};
light.moonPhaseValue = moonPhase(snapshot.state.lastSimulatedDate);
```

4. Replace old defs/sky/hills markup with:

```tsx
<SceneDefs p={p} light={light} />
<Sky p={p} light={light} animate={animate} />
{/* distant hills, hazed and blurred */}
<path d="M0,296 C130,240 320,246 480,296 L480,302 L0,302 Z" fill={shade(light.hill, 1.06)} opacity={0.65} filter={`url(#${p}-hillblur)`} />
<path d="M410,296 C590,238 820,234 1000,292 L1000,302 L410,302 Z" fill={light.hill} opacity={0.5} filter={`url(#${p}-hillblur)`} />
```

5. Delete the bottom time-of-day tint `<rect>` (ambient is now baked into the palette). Keep ground paths exactly as they are for this task (Terrain replaces them in Task 4) but change their fills to `light.grassNear` / `light.grassFar` / `light.soil`.

- [ ] **Step 4: Run the whole renderer suite**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run`
Expected: PASS — including the pre-existing determinism, reducedMotion, ground-fill, and rain-overlay tests. If the reducedMotion test fails on an `animation` substring, check `Stars`/`Clouds` emit no `style` when `animate` is false.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/kyranadams/src/run-garden
pnpm --filter @rg/garden-renderer typecheck
git add packages/garden-renderer/src/sky.tsx packages/garden-renderer/src/GardenScene.tsx packages/garden-renderer/test/renderer.test.tsx
git commit -m "feat(garden): sky module — 3-stop sky, moon phase, per-weather clouds"
```

---

### Task 4: `terrain.tsx` — layered ground, seeded meadow, drought patches, canopy pools

**Files:**
- Create: `src/terrain.tsx`
- Modify: `src/GardenScene.tsx` (replace the three ground paths with `<Terrain …/>`)
- Test: `test/renderer.test.tsx` (append)

**Interfaces:**
- Consumes: `SceneLight`; `rng`; `mix`, `shade` from `./color`.
- Produces:
  - `interface TerrainProps { light: SceneLight; moisture: number; soilHealth: number; floweringDensity: number; biodiversity: number; droughtDays: number; canopy: number; trees: Array<{ x: number; y: number; s: number }> }`
  - `function Terrain(props: TerrainProps): ReactNode` — 4 depth bands (nearest carries `data-ground="true"`), meadow strokes group `data-terrain="meadow"`, wildflowers `data-terrain="flowers"`, drought patches `data-terrain="patches"`, canopy pools `data-terrain="pools"`.
- The scene passes `trees` = anchors of living tree plants (`category === "tree" && state !== "dead"`), using the existing `anchorOf`.

- [ ] **Step 1: Append failing tests**

```tsx
describe("terrain", () => {
  it("renders four ground bands, nearest tagged data-ground", () => {
    const markup = renderScene(healthySnapshot());
    expect((markup.match(/data-band=/g) ?? []).length).toBe(4);
    expect(markup).toContain('data-ground="true"');
  });

  it("renders a dense meadow for a healthy garden and a sparser one in drought", () => {
    const healthy = renderScene(healthySnapshot());
    const drought = renderScene(droughtSnapshot());
    const strokes = (m: string) => (m.match(/data-terrain="meadow"/g) ?? []).length;
    expect(strokes(healthy)).toBe(1);
    const meadowOf = (m: string) => m.split('data-terrain="meadow"')[1]!.split("</g>")[0]!;
    const count = (m: string) => (meadowOf(m).match(/<path/g) ?? []).length;
    expect(count(healthy)).toBeGreaterThan(350);
    expect(count(healthy)).toBeLessThanOrEqual(800);
    expect(count(drought)).toBeLessThan(count(healthy));
  });

  it("drought gardens show straw patches; healthy gardens do not", () => {
    expect(renderScene(droughtSnapshot())).toContain('data-terrain="patches"');
    expect(renderScene(healthySnapshot())).not.toContain('data-terrain="patches"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/renderer.test.tsx`
Expected: FAIL — no `data-band` markers exist yet.

- [ ] **Step 3: Implement `src/terrain.tsx` and wire it**

```tsx
import type { ReactNode } from "react";
import { rng } from "@rg/garden-engine";
import { mix, shade } from "./color";
import type { SceneLight } from "./lighting";

const n = (x: number): number => Math.round(x * 100) / 100;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface TerrainProps {
  light: SceneLight;
  moisture: number;
  soilHealth: number;
  floweringDensity: number;
  biodiversity: number;
  droughtDays: number;
  canopy: number;
  trees: Array<{ x: number; y: number; s: number }>;
}

const BAND_TOPS = [290, 318, 372, 452];
const BAND_CURVES = [
  "M0,290 C260,280 740,280 1000,290 L1000,560 L0,560 Z",
  "M0,318 C300,306 700,308 1000,316 L1000,560 L0,560 Z",
  "M0,372 C280,358 720,360 1000,370 L1000,560 L0,560 Z",
  "M0,452 C300,438 680,440 1000,450 L1000,560 L0,560 Z",
];

export function Terrain({ light, moisture, soilHealth, floweringDensity, biodiversity, droughtDays, canopy, trees }: TerrainProps): ReactNode {
  const bands = BAND_CURVES.map((d, i) => {
    const t = i / (BAND_CURVES.length - 1);
    const fill = mix(light.grassFar, light.grassNear, t);
    return (
      <path key={`band${i}`} d={d} fill={fill} data-band={i}
        {...(i === BAND_CURVES.length - 1 ? { "data-ground": "true" } : {})} />
    );
  });

  // Meadow: static seeded strokes. Density is honest — moisture + soil health.
  const density = clamp01(0.3 + 0.4 * moisture + 0.3 * soilHealth);
  const count = Math.round(380 + 420 * density);
  const r = rng("terrain:meadow");
  const strokes: ReactNode[] = [];
  for (let i = 0; i < 800; i++) {
    // Fixed rng consumption for stability across density changes.
    const d = Math.pow(r(), 0.85);
    const x = n(r() * 1000);
    const y = n(292 + 262 * d);
    const h = n((5 + 21 * d) * (0.6 + r() * 0.7));
    const lean = n((r() - 0.5) * 7);
    const kindRoll = r();
    const shadeRoll = r();
    if (i >= count) continue;
    const base = mix(light.grassFar, light.grassNear, d);
    const c = shade(base, 0.85 + shadeRoll * 0.3);
    const width = n(0.6 + 1.3 * d);
    const variety = kindRoll < clamp01(biodiversity) * 0.5;
    const dPath = variety && kindRoll < 0.2
      ? `M${x},${y} q${n(lean * 0.4)},${n(-h * 0.6)} ${lean},${-h} m0,0 a1.6,1.6 0 1,0 0.1,0` // seedhead
      : variety
        ? `M${x},${y} q-3,${n(-h * 0.5)} -5,${-h} M${x},${y} q0,${n(-h * 0.6)} 0.5,${n(-h * 1.05)} M${x},${y} q3,${n(-h * 0.5)} 5,${n(-h * 0.9)}` // tuft
        : `M${x},${y} q${n(lean * 0.4)},${n(-h * 0.55)} ${lean},${-h}`; // blade
    strokes.push(
      <path key={`m${i}`} d={dPath} stroke={c} strokeWidth={width} fill="none" strokeLinecap="round" opacity={0.85} />,
    );
  }

  // Wildflower drifts from real flowering density, colored by season accents.
  const fr = rng("terrain:flowers");
  const fCount = Math.round(64 * clamp01(floweringDensity));
  const flowers: ReactNode[] = [];
  for (let i = 0; i < 64; i++) {
    const d = 0.25 + fr() * 0.75;
    const x = n(fr() * 1000);
    const y = n(296 + 254 * d);
    const rad = n(1 + d * 1.6);
    const ci = Math.floor(fr() * light.meadowAccents.length);
    if (i >= fCount) continue;
    flowers.push(<circle key={`f${i}`} cx={x} cy={y} r={rad} fill={light.meadowAccents[ci]!} opacity={0.85} />);
  }

  // Drought: straw patches + hairline cracks, scaling with droughtDays.
  const patches: ReactNode[] = [];
  if (droughtDays > 3) {
    const pr = rng("terrain:patches");
    const k = Math.min(6, droughtDays - 3);
    for (let i = 0; i < k; i++) {
      const x = n(80 + pr() * 840);
      const y = n(360 + pr() * 170);
      const rx = n(30 + pr() * 50);
      patches.push(
        <g key={`p${i}`}>
          <ellipse cx={x} cy={y} rx={rx} ry={n(rx * 0.28)} fill="#c9b478" opacity={0.35} />
          <path d={`M${n(x - rx * 0.4)},${y} l${n(rx * 0.3)},${n(rx * 0.08)} l${n(rx * 0.25)},${n(-rx * 0.06)}`}
            stroke="#8f7a50" strokeWidth={0.8} fill="none" opacity={0.5} />
        </g>,
      );
    }
  }

  // Canopy pools: soft occlusion under mature trees.
  const pools = trees.map((t, i) => (
    <ellipse key={`t${i}`} cx={n(t.x)} cy={n(t.y + 2)} rx={n(60 * t.s)} ry={n(13 * t.s)}
      fill="#26411f" opacity={n(0.03 + 0.05 * clamp01(canopy))} />
  ));

  return (
    <>
      {bands}
      {pools.length > 0 ? <g data-terrain="pools" pointerEvents="none">{pools}</g> : null}
      <g data-terrain="meadow" pointerEvents="none">{strokes}</g>
      {flowers.length > 0 ? <g data-terrain="flowers" pointerEvents="none">{flowers}</g> : null}
      {patches.length > 0 ? <g data-terrain="patches" pointerEvents="none">{patches}</g> : null}
    </>
  );
}
```

In `GardenScene.tsx`, replace the three ground paths (`data-ground` path, far band, soil rect) with:

```tsx
<Terrain
  light={light}
  moisture={clamp01(snapshot.state.moisture)}
  soilHealth={clamp01(snapshot.state.soilHealth)}
  floweringDensity={clamp01(snapshot.state.floweringDensity)}
  biodiversity={clamp01(snapshot.state.biodiversity)}
  droughtDays={snapshot.state.droughtDays}
  canopy={clamp01(snapshot.state.canopy)}
  trees={sorted
    .filter((pl) => pl.category === "tree" && pl.state !== "dead" && pl.maturity >= 0.5)
    .map((pl) => anchorOf(pl))}
/>
```

- [ ] **Step 4: Run the whole renderer suite**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run`
Expected: PASS. The old "drought ground color differs" test now reads the nearest band's fill — still moisture-driven via `light.grassNear`.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/kyranadams/src/run-garden
pnpm --filter @rg/garden-renderer typecheck
git add packages/garden-renderer/src/terrain.tsx packages/garden-renderer/src/GardenScene.tsx packages/garden-renderer/test/renderer.test.tsx
git commit -m "feat(garden): layered terrain with seeded meadow, drought patches, canopy pools"
```

---

### Task 5: Plants under the light — shadows, foliage tint, travelling sway

**Files:**
- Modify: `src/GardenScene.tsx` (shadow ellipse per plant; amp-parameterized sway keyframes)
- Modify: `src/PlantSprite.tsx` (optional `tint` prop; x-correlated sway delay)
- Test: `test/renderer.test.tsx` (append)

**Interfaces:**
- Consumes: `light.shadowDx/shadowLen/shadowOpacity`, `light.foliageTint/foliageTintAmount`, `light.swayAmpDeg`.
- Produces: `PlantSprite` gains `tint?: { color: string; amount: number }`; `sceneCss(p, swayAmpDeg)` signature change (was `sceneCss(p)`).

- [ ] **Step 1: Append failing tests**

```tsx
describe("plants under the light", () => {
  it("every living plant casts a shadow ellipse", () => {
    const snapshot = healthySnapshot();
    const markup = renderScene(snapshot, { timeOfDay: 18.9 });
    const living = snapshot.plants.filter((p) => p.state !== "dead").length;
    expect((markup.match(/data-shadow="true"/g) ?? []).length).toBe(living);
  });

  it("golden-hour shadows are longer than midday shadows", () => {
    const snapshot = healthySnapshot();
    const rx = (m: string) => {
      const tag = m.match(/<ellipse[^>]*data-shadow="true"[^>]*>/)?.[0] ?? "";
      return Number(tag.match(/rx="([\d.]+)"/)?.[1] ?? 0);
    };
    expect(rx(renderScene(snapshot, { timeOfDay: 18.9 }))).toBeGreaterThan(
      rx(renderScene(snapshot, { timeOfDay: 13 })),
    );
  });

  it("sway delay correlates with x position (gusts travel)", () => {
    const markup = renderScene(healthySnapshot(), { timeOfDay: 13 });
    // Two plants far apart in x must have different sway delays.
    const delays = [...markup.matchAll(/animation-delay:(-[\d.]+)s/g)].map((m) => Number(m[1]));
    expect(new Set(delays).size).toBeGreaterThan(1);
  });

  it("winter foliage is tinted differently from summer", () => {
    const snapshot = healthySnapshot();
    const summer = { ...snapshot, state: { ...snapshot.state, season: "summer" as const } };
    const winter = { ...snapshot, state: { ...snapshot.state, season: "winter" as const } };
    expect(renderScene(summer)).not.toBe(renderScene(winter));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/renderer.test.tsx`
Expected: FAIL — no `data-shadow` attributes.

- [ ] **Step 3: Implement**

In `GardenScene.tsx`:

1. `sceneCss(p)` → `sceneCss(p, amp)`; the sway keyframes become:
```ts
`@keyframes ${p}-sway{from{transform:rotate(-${amp}deg)}to{transform:rotate(${amp}deg)}}`
```
Call it as `sceneCss(p, n(Math.max(0.3, light.swayAmpDeg)))`.

2. In the plant render loop, inside the positioned `<g>` and BEFORE the selection ellipse, add (skip when `plant.state === "dead"`):

```tsx
{plant.state !== "dead" ? (
  <ellipse
    data-shadow="true"
    cx={n(light.shadowDx * hw * (0.55 + 0.6 * light.shadowLen))}
    cy={3}
    rx={n(hw * (0.55 + 0.55 * light.shadowLen))}
    ry={n(hw * 0.2)}
    fill="#233a1d"
    opacity={n(light.shadowOpacity)}
  />
) : null}
```

3. Pass the tint into the sprite: `<PlantSprite plant={plant} species={species} animate={animate} idPrefix={p} tint={{ color: light.foliageTint, amount: light.foliageTintAmount }} />`.

In `PlantSprite.tsx`:

1. Add to the props interface: `tint?: { color: string; amount: number };`
2. In `paintFor`, add a `tint` parameter (`paintFor(species, plant, tint)`) and apply it as the LAST adjustment, but never to dead plants:
```ts
const applyTint = (c: string) =>
  tint && plant.state !== "dead" ? mix(c, tint.color, clamp01(tint.amount)) : c;
return {
  c1: applyTint(adjust(raw.c1)),
  c2: applyTint(adjust(raw.c2)),
  c3: applyTint(adjust(raw.c3)),
  // droop/blooming/bare unchanged
};
```
3. Change the sway delay line from `const swayDelay = `-${n(r() * 6)}s`;` to:
```ts
const swayDelay = `-${n(plant.position.x * 3.5 + r() * 0.8)}s`;
```
(The `r()` call count is unchanged, so all downstream seeded geometry stays identical.)

- [ ] **Step 4: Run the whole renderer suite**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run`
Expected: PASS, including the selection-ellipse test (it counts `<ellipse` occurrences relatively, so the added shadows on both sides cancel out).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/kyranadams/src/run-garden
pnpm --filter @rg/garden-renderer typecheck
git add packages/garden-renderer/src/GardenScene.tsx packages/garden-renderer/src/PlantSprite.tsx packages/garden-renderer/test/renderer.test.tsx
git commit -m "feat(garden): plant shadows, seasonal foliage tint, travelling sway"
```

---

### Task 6: `overlays.tsx` — beams, haze, rainbow, grain, vignette; first visual checkpoint

**Files:**
- Create: `src/overlays.tsx`
- Modify: `src/GardenScene.tsx` (move `rainOverlay`/`breezeOverlay`/drought haze there; add Finish + Rainbow)
- Test: `test/renderer.test.tsx` (append)

**Interfaces:**
- Consumes: `SceneLight`; gradient/filter ids from `SceneDefs` (`${p}-beam`, `${p}-vig`, `${p}-grain`).
- Produces:
  - `function WeatherOverlay({ p, weather, animate }: { p: string; weather: GardenWeatherState; animate: boolean }): ReactNode` — the moved rain (`data-overlay="rain"`, markup identical to today's `rainOverlay`), breeze leaves, drought haze.
  - `function Finish({ p, light }: { p: string; light: SceneLight }): ReactNode` — beam polygons (only when `light.beamStrength > 0.05` and sun visible; two `<polygon>` fans from the sun with `style={{ mixBlendMode: "screen" }}` and `fill={`url(#${p}-beam)`}`, opacities `0.65 * beamStrength` and `0.4 * beamStrength`), horizon haze ellipse (`cx 500, cy 300, rx 560, ry 60`, fill `hazeColor`, opacity `hazeStrength * 0.5`), vignette rect (`url(#${p}-vig)`), grain rect (`filter url(#${p}-grain)`, opacity 0.05, `style={{ mixBlendMode: "overlay" }}`), all `pointerEvents="none"`, grouped as `data-finish="true"`.
  - `function Rainbow({ p, light }: { p: string; light: SceneLight }): ReactNode | null` — when `light.rainbow`: three concentric arcs (`d={`M180,300 A320,320 0 0 1 820,300`}` at radii 320/306/292 via three paths), strokes `#c86f5a`/`#d99a3d`/`#8f6fae`, widths 10, opacities 0.16/0.13/0.1, `data-overlay="rainbow"`.

- [ ] **Step 1: Append failing tests**

```tsx
describe("finish overlays", () => {
  it("golden hour renders sunbeams; night does not", () => {
    const snapshot = healthySnapshot();
    expect(renderScene(snapshot, { timeOfDay: 18.9 })).toContain("mix-blend-mode:screen");
    expect(renderScene(snapshot, { timeOfDay: 23.5 })).not.toContain("mix-blend-mode:screen");
  });

  it("always applies grain and vignette", () => {
    const markup = renderScene(healthySnapshot());
    expect(markup).toContain('data-finish="true"');
    expect(markup).toContain("-grain");
    expect(markup).toContain("-vig");
  });

  it("rainbow renders only in a comeback recovery rain at low sun", () => {
    const snapshot = healthySnapshot();
    const comeback = {
      ...snapshot,
      state: { ...snapshot.state, weatherState: "recovery_rain" as const, inComeback: true },
    };
    expect(renderScene(comeback, { timeOfDay: 18.9 })).toContain('data-overlay="rainbow"');
    expect(renderScene(comeback, { timeOfDay: 13 })).not.toContain('data-overlay="rainbow"');
    expect(renderScene(snapshot, { timeOfDay: 18.9 })).not.toContain('data-overlay="rainbow"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/renderer.test.tsx`
Expected: FAIL — no `data-finish`.

- [ ] **Step 3: Implement `src/overlays.tsx`, rewire `GardenScene.tsx`**

Move `rainOverlay` + `breezeOverlay` + the drought haze JSX from `GardenScene.tsx` into `overlays.tsx` unchanged (keep the exact `data-overlay` attributes and rng keys — the rain test greps them). Add `Finish` and `Rainbow` per the interface block above. Scene layer order (bottom → top): defs, Sky, hills, Terrain, plants (with shadows), `WeatherOverlay`, `Rainbow`, wildlife, `Finish` last.

- [ ] **Step 4: Run the whole renderer suite**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run`
Expected: PASS.

- [ ] **Step 5: VISUAL CHECKPOINT — build the demo and eyeball six states**

```bash
cd /Users/kyranadams/src/run-garden
node packages/garden-renderer/demo/build.mjs /tmp/garden-demo.html
```

Then screenshot it with the repo's playwright (`apps/web/node_modules/@playwright/test`, chromium is cached) — write a throwaway script that loads `/tmp/garden-demo.html`, steps the demo to a healthy mid-summer state, and captures at `timeOfDay` 6.5 / 13 / 18.9 / 23.5 plus a drought state and a rain state. **Read every image.** Judge: Does golden hour glow? Is night legible? Do shadows ground the plants? Is the meadow dense but not noisy? Tune constants in `lighting.ts` / `terrain.tsx` (palette values, densities, opacities) until the answer is yes — small constant changes only, re-running the suite after each.

- [ ] **Step 6: Commit**

```bash
cd /Users/kyranadams/src/run-garden
git add packages/garden-renderer/src/overlays.tsx packages/garden-renderer/src/GardenScene.tsx packages/garden-renderer/test/renderer.test.tsx
git commit -m "feat(garden): finish overlays — beams, haze, rainbow, grain, vignette"
```

---

### Task 7: `particles.ts` — gating + calm systems (pollen, mist, cloud shadows, gust fringe)

**Files:**
- Create: `src/particles.ts`
- Test: `test/particles.test.ts`

**Interfaces:**
- Consumes: `rng` from `@rg/garden-engine`; `LightPeriod` from `./lighting`; `GardenWeatherState` from `@rg/domain`.
- Produces (Task 8 and 9 rely on these exact names):
  - `type SystemKind = "rainSplash" | "pollen" | "mist" | "cloudShadow" | "gustFringe" | "petals" | "shimmer" | "fireflyGlow"`
  - `interface ParticleSystem { kind: SystemKind; params: number[][] }` (one fixed-length param row per particle)
  - `interface Sprite { x: number; y: number; alpha: number; size: number; tilt: number }` (normalized 0..1 canvas coords; tilt in radians, 0 when unused)
  - `interface GateInputs { weather: GardenWeatherState; period: LightPeriod; fireflies: boolean; hasFlowering: boolean }`
  - `function activeSystems(g: GateInputs): SystemKind[]`
  - `function initSystem(kind: SystemKind, key: string): ParticleSystem`
  - `function sampleSystem(sys: ParticleSystem, t: number): Sprite[]` — pure and analytic in `t` (no incremental state), so any frame rate and any resume time renders identically.
  - `const GUST_SCALE: Partial<Record<GardenWeatherState, number>>` (`seasonal_breeze: 2, mild_drought: 0.5, dry_spell: 0.7`)

- [ ] **Step 1: Write the failing test**

Create `test/particles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activeSystems, initSystem, sampleSystem, type GateInputs, type SystemKind } from "../src/particles";

const gate = (extra: Partial<GateInputs> = {}): GateInputs => ({
  weather: "soft_sun",
  period: "midday",
  fireflies: false,
  hasFlowering: true,
  ...extra,
});

describe("activeSystems", () => {
  it("gust fringe is always on; airborne systems are gated", () => {
    expect(activeSystems(gate())).toContain("gustFringe");
    expect(activeSystems(gate({ weather: "fresh_rain" }))).toContain("rainSplash");
    expect(activeSystems(gate())).not.toContain("rainSplash");
    expect(activeSystems(gate({ weather: "soft_sun", period: "morning" }))).toContain("pollen");
    expect(activeSystems(gate({ weather: "soft_sun", period: "night" }))).not.toContain("pollen");
    expect(activeSystems(gate({ period: "dawn" }))).toContain("mist");
    expect(activeSystems(gate({ weather: "light_clouds" }))).toContain("cloudShadow");
    expect(activeSystems(gate({ period: "night", fireflies: true }))).toContain("fireflyGlow");
    expect(activeSystems(gate({ period: "night", fireflies: false }))).not.toContain("fireflyGlow");
    expect(activeSystems(gate({ weather: "seasonal_breeze" }))).toContain("petals");
    expect(activeSystems(gate({ weather: "seasonal_breeze", hasFlowering: false }))).not.toContain("petals");
    expect(activeSystems(gate({ weather: "mild_drought", period: "midday" }))).toContain("shimmer");
    expect(activeSystems(gate({ weather: "mild_drought", period: "golden" }))).not.toContain("shimmer");
  });

  it("airborne particle budget never exceeds 120", () => {
    const AIRBORNE: SystemKind[] = ["rainSplash", "pollen", "petals", "shimmer", "mist", "fireflyGlow"];
    const weathers = ["fresh_rain", "clear_sun", "light_clouds", "dry_spell", "mild_drought", "recovery_rain", "seasonal_breeze", "soft_sun"] as const;
    const periods = ["night", "dawn", "morning", "midday", "golden", "dusk"] as const;
    for (const weather of weathers) {
      for (const period of periods) {
        const active = activeSystems({ weather, period, fireflies: true, hasFlowering: true });
        const total = active
          .filter((k) => AIRBORNE.includes(k))
          .reduce((sum, k) => sum + initSystem(k, "t").params.length, 0);
        expect(total).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe("systems are deterministic, analytic, and bounded", () => {
  const kinds: SystemKind[] = ["pollen", "mist", "cloudShadow", "gustFringe"];
  for (const kind of kinds) {
    it(`${kind}: same key + t → same sprites; bounded`, () => {
      const a = initSystem(kind, "seed:x");
      const b = initSystem(kind, "seed:x");
      expect(a.params).toEqual(b.params);
      const s1 = sampleSystem(a, 12.34);
      const s2 = sampleSystem(b, 12.34);
      expect(s1).toEqual(s2);
      for (const s of s1) {
        expect(s.x).toBeGreaterThan(-0.4);
        expect(s.x).toBeLessThan(1.7);
        expect(s.y).toBeGreaterThan(-0.3);
        expect(s.y).toBeLessThan(1.3);
        expect(s.alpha).toBeGreaterThanOrEqual(0);
        expect(s.alpha).toBeLessThanOrEqual(0.35);
      }
      // Analytic: sampling t=5 then t=2 equals sampling t=2 fresh.
      expect(sampleSystem(a, 2)).toEqual(sampleSystem(initSystem(kind, "seed:x"), 2));
    });
  }

  it("gustFringe has ≤ 180 blades; airborne systems have their spec counts", () => {
    expect(initSystem("gustFringe", "k").params.length).toBeLessThanOrEqual(180);
    expect(initSystem("pollen", "k").params.length).toBe(40);
    expect(initSystem("mist", "k").params.length).toBe(3);
    expect(initSystem("cloudShadow", "k").params.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/particles.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/particles.ts` (Task 7 kinds; Task 8 kinds throw for now)**

```ts
import type { GardenWeatherState } from "@rg/domain";
import { rng } from "@rg/garden-engine";
import type { LightPeriod } from "./lighting";

/**
 * Canvas particle systems. Everything is ANALYTIC in t: a sprite's position is
 * a pure function of its seeded params and the elapsed time, never of the
 * previous frame — so any frame rate, pause, or resume renders identically.
 * Coordinates are normalized 0..1 over the canvas; the layer scales them.
 */

export type SystemKind =
  | "rainSplash" | "pollen" | "mist" | "cloudShadow"
  | "gustFringe" | "petals" | "shimmer" | "fireflyGlow";

export interface ParticleSystem { kind: SystemKind; params: number[][] }
export interface Sprite { x: number; y: number; alpha: number; size: number; tilt: number }

export interface GateInputs {
  weather: GardenWeatherState;
  period: LightPeriod;
  fireflies: boolean;
  hasFlowering: boolean;
}

const DAY: LightPeriod[] = ["dawn", "morning", "midday", "golden", "dusk"];
const BEAMY: LightPeriod[] = ["morning", "midday", "golden"];

export const GUST_SCALE: Partial<Record<GardenWeatherState, number>> = {
  seasonal_breeze: 2, mild_drought: 0.5, dry_spell: 0.7,
};

export function activeSystems(g: GateInputs): SystemKind[] {
  const out: SystemKind[] = ["gustFringe"];
  if (g.weather === "fresh_rain" || g.weather === "recovery_rain") out.push("rainSplash");
  if ((g.weather === "clear_sun" || g.weather === "soft_sun") && BEAMY.includes(g.period)) out.push("pollen");
  if (g.period === "dawn" || g.weather === "recovery_rain") out.push("mist");
  if ((g.weather === "light_clouds" || g.weather === "dry_spell") && DAY.includes(g.period)) out.push("cloudShadow");
  if (g.weather === "seasonal_breeze" && g.hasFlowering) out.push("petals");
  if (g.weather === "mild_drought" && g.period === "midday") out.push("shimmer");
  if (g.period === "night" && g.fireflies) out.push("fireflyGlow");
  return out;
}

const COUNTS: Record<SystemKind, number> = {
  rainSplash: 22, pollen: 40, mist: 3, cloudShadow: 2,
  gustFringe: 160, petals: 16, shimmer: 10, fireflyGlow: 6,
};

export function initSystem(kind: SystemKind, key: string): ParticleSystem {
  const r = rng(`atm:${kind}:${key}`);
  const params: number[][] = [];
  for (let i = 0; i < COUNTS[kind]; i++) {
    params.push([r(), r(), r(), r(), r(), r()]);
  }
  return { kind, params };
}

const wrap = (v: number): number => ((v % 1) + 1) % 1;
const TAU = Math.PI * 2;

export function sampleSystem(sys: ParticleSystem, t: number): Sprite[] {
  return sys.params.map((p) => sampleOne(sys.kind, p, t));
}

function sampleOne(kind: SystemKind, p: number[], t: number): Sprite {
  const [a, b, c, d, e, f] = p as [number, number, number, number, number, number];
  switch (kind) {
    case "pollen": {
      const x = wrap(a - (0.008 + 0.012 * b) * t);
      const y = wrap(c + (0.004 + 0.008 * d) * t);
      const alpha = Math.max(0, 0.1 + 0.18 * Math.sin(t * (1.5 + 2.5 * e) + f * TAU));
      return { x, y: 0.25 + y * 0.72, alpha, size: 1 + 1.8 * a, tilt: 0 };
    }
    case "mist": {
      const x = a + 0.02 * Math.sin(t * 0.05 + b * TAU);
      const alpha = 0.05 + 0.02 * Math.sin(t * 0.11 + c * TAU);
      return { x, y: 0.62 + 0.2 * d, alpha: Math.max(0, alpha), size: 0.28 + 0.2 * e, tilt: 0 };
    }
    case "cloudShadow": {
      const x = ((a + t * 0.012) % 1.6) - 0.3;
      return { x, y: 0.72 + 0.12 * b, alpha: 0.11, size: 0.24 + 0.08 * c, tilt: 0 };
    }
    case "gustFringe": {
      const u = a;
      const h = 0.05 + 0.075 * b;
      const lean = (c - 0.5) * 0.3;
      const gust = Math.pow(Math.max(0, Math.sin(t * 0.5 - u * 7 + d * 0.5)), 2) * 0.5;
      const bend = Math.sin(t * 0.9 + d * TAU) * 0.1 + gust;
      return { x: u * 1.04 - 0.02, y: 1 - h, alpha: 0.3, size: h, tilt: lean + bend };
    }
    default:
      throw new Error(`sampleOne: unimplemented kind ${kind}`);
  }
}
```

- [ ] **Step 4: Run the particles test — Task 7 cases pass**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/particles.test.ts`
Expected: PASS (the budget test calls `initSystem` for Task 8 kinds too — `initSystem` already supports all kinds; only `sampleOne` throws for them, and no Task 7 test samples them).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/kyranadams/src/run-garden
pnpm --filter @rg/garden-renderer typecheck
git add packages/garden-renderer/src/particles.ts packages/garden-renderer/test/particles.test.ts
git commit -m "feat(garden): particle gating + pollen/mist/cloud-shadow/gust-fringe systems"
```

---

### Task 8: `particles.ts` — rain splashes, petals, shimmer, firefly glow

**Files:**
- Modify: `src/particles.ts` (extend `sampleOne`)
- Test: `test/particles.test.ts` (append)

**Interfaces:** unchanged from Task 7; all eight kinds sample.

- [ ] **Step 1: Append failing tests**

```ts
describe("weather-signature systems", () => {
  const kinds: SystemKind[] = ["rainSplash", "petals", "shimmer", "fireflyGlow"];
  for (const kind of kinds) {
    it(`${kind}: deterministic, analytic, bounded`, () => {
      const sys = initSystem(kind, "seed:y");
      const s1 = sampleSystem(sys, 7.7);
      expect(s1).toEqual(sampleSystem(initSystem(kind, "seed:y"), 7.7));
      for (const s of s1) {
        expect(s.alpha).toBeLessThanOrEqual(0.35);
        expect(s.x).toBeGreaterThan(-0.4);
        expect(s.x).toBeLessThan(1.7);
      }
    });
  }

  it("rain splash rings expand and fade over their cycle", () => {
    const sys = initSystem("rainSplash", "z");
    const early = sampleSystem(sys, 0.05)[0]!;
    const later = sampleSystem(sys, 0.4)[0]!;
    // Not asserting exact values — only that size and alpha both change.
    expect(early.size).not.toBe(later.size);
    expect(early.alpha).not.toBe(later.alpha);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/particles.test.ts`
Expected: FAIL — `sampleOne: unimplemented kind rainSplash`.

- [ ] **Step 3: Implement the four remaining cases in `sampleOne`**

Replace the `default:` throw with:

```ts
    case "rainSplash": {
      const cycle = wrap(t * (0.8 + 0.6 * c) + d);
      return {
        x: a, y: 0.55 + 0.42 * b,
        alpha: Math.max(0, 0.3 * (1 - cycle)),
        size: 0.004 + cycle * 0.02, tilt: 0,
      };
    }
    case "petals": {
      const x = wrap(a - 0.03 * t + 0.01 * Math.sin(t * 2 + b * TAU));
      const y = wrap(c + 0.05 * (0.5 + 0.5 * d) * t);
      return { x, y: 0.15 + y * 0.8, alpha: 0.3, size: 2 + 2 * e, tilt: Math.sin(t * 3 + f * TAU) };
    }
    case "shimmer": {
      const y = 0.5 + 0.06 * b + Math.sin(t * 2.2 + c * TAU) * 0.004;
      return { x: a, y, alpha: 0.05, size: 0.05 + 0.08 * d, tilt: 0 };
    }
    case "fireflyGlow": {
      const x = 0.1 + 0.8 * a + 0.04 * Math.sin(t * 0.21 + b * TAU);
      const y = 0.6 + 0.28 * c + 0.03 * Math.sin(t * 0.17 + d * TAU);
      const alpha = Math.max(0, 0.1 + 0.14 * Math.sin(t * (0.4 + 0.4 * e) + f * TAU));
      return { x, y, alpha, size: 3 + 2 * a, tilt: 0 };
    }
```

- [ ] **Step 4: Run the full particles suite**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/particles.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/kyranadams/src/run-garden
pnpm --filter @rg/garden-renderer typecheck
git add packages/garden-renderer/src/particles.ts packages/garden-renderer/test/particles.test.ts
git commit -m "feat(garden): rain-splash, petal, shimmer, firefly particle systems"
```

---

### Task 9: `AtmosphereLayer.tsx` + the `atmosphere` prop on GardenScene

**Files:**
- Create: `src/AtmosphereLayer.tsx`
- Modify: `src/GardenScene.tsx` (`atmosphere?: boolean` prop; wrapper div)
- Modify: `src/index.ts` (export `AtmosphereLayer` types if needed — keep exports minimal: only `GardenScene` props change)
- Test: `test/renderer.test.tsx` (append)

**Interfaces:**
- Consumes: `activeSystems`, `initSystem`, `sampleSystem`, `GUST_SCALE`, `Sprite`, `SystemKind` from `./particles`; `SceneLight` from `./lighting`.
- Produces:
  - `interface AtmosphereLayerProps { weather: GardenWeatherState; light: SceneLight; fireflies: boolean; hasFlowering: boolean; restMode: boolean; idPrefix: string }`
  - `function AtmosphereLayer(props: AtmosphereLayerProps): ReactNode` — a single absolutely-positioned `<canvas aria-hidden="true">`.
  - `GardenScene` prop: `atmosphere?: boolean` (default `false`). When false → bare `<svg>` root exactly as before. When true → `<div data-garden-wrapper="true" style={{position:"relative",width:"100%",height:"100%"}}>` containing the svg then (unless `reducedMotion`) the `AtmosphereLayer`.

- [ ] **Step 1: Append failing tests**

```tsx
describe("atmosphere layer", () => {
  it("default render keeps the bare <svg> root with no canvas", () => {
    const markup = renderScene(healthySnapshot());
    expect(markup.startsWith("<svg")).toBe(true);
    expect(markup).not.toContain("<canvas");
  });

  it("atmosphere=true wraps the scene and adds an aria-hidden canvas", () => {
    const markup = renderScene(healthySnapshot(), { atmosphere: true });
    expect(markup.startsWith("<div")).toBe(true);
    expect(markup).toContain('data-garden-wrapper="true"');
    expect(markup).toContain("<canvas");
    expect(markup).toContain('aria-hidden="true"');
  });

  it("atmosphere + reducedMotion renders the wrapper without a canvas", () => {
    const markup = renderScene(healthySnapshot(), { atmosphere: true, reducedMotion: true });
    expect(markup).not.toContain("<canvas");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run test/renderer.test.tsx`
Expected: FAIL — `atmosphere` prop unknown.

- [ ] **Step 3: Implement `src/AtmosphereLayer.tsx`**

```tsx
import { useEffect, useRef } from "react";
import type { GardenWeatherState } from "@rg/domain";
import type { SceneLight } from "./lighting";
import { activeSystems, GUST_SCALE, initSystem, sampleSystem, type ParticleSystem, type Sprite } from "./particles";
import { mix, shade } from "./color";

export interface AtmosphereLayerProps {
  weather: GardenWeatherState;
  light: SceneLight;
  fireflies: boolean;
  hasFlowering: boolean;
  restMode: boolean;
  idPrefix: string;
}

/**
 * The Tier-2 canvas: pollen, mist, splashes, gusts — everything the DOM can't
 * animate cheaply. Pure decoration: pointer-events none, aria-hidden, and the
 * scene is complete without it (reducedMotion never mounts it).
 */
export function AtmosphereLayer({ weather, light, fireflies, hasFlowering, restMode, idPrefix }: AtmosphereLayerProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return; // graceful: SVG scene stands alone

    const kinds = activeSystems({ weather, period: light.period, fireflies, hasFlowering });
    const systems: ParticleSystem[] = kinds.map((k) => initSystem(k, `${idPrefix}:${k}`));
    const gustScale = (GUST_SCALE[weather] ?? 1) * (restMode ? 0.6 : 1);
    const start = performance.now();
    let last = 0;
    let raf = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (now - last < 1000 / 30) return; // 30 fps cap
      last = now;
      const t = (now - start) / 1000;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(canvas.clientWidth * dpr);
      const H = Math.round(canvas.clientHeight * dpr);
      if (W === 0 || H === 0) return;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const g = ctx!;
      g.clearRect(0, 0, W, H);
      for (const sys of systems) drawSystem(g, sys, t, W, H, light, gustScale);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [weather, light, fireflies, hasFlowering, restMode, idPrefix]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
}

function drawSystem(
  g: CanvasRenderingContext2D,
  sys: ParticleSystem,
  t: number,
  W: number,
  H: number,
  light: SceneLight,
  gustScale: number,
): void {
  const sprites: Sprite[] = sampleSystem(sys, t);
  switch (sys.kind) {
    case "pollen":
    case "fireflyGlow": {
      g.save();
      g.globalCompositeOperation = "lighter";
      for (const s of sprites) {
        if (s.alpha <= 0.01) continue;
        g.globalAlpha = s.alpha;
        g.fillStyle = light.moteColor;
        g.beginPath();
        g.arc(s.x * W, s.y * H, s.size * (W / 900) * (sys.kind === "fireflyGlow" ? 2.4 : 1), 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
      break;
    }
    case "mist": {
      for (const s of sprites) {
        const rad = s.size * W;
        const grad = g.createRadialGradient(s.x * W, s.y * H, 0, s.x * W, s.y * H, rad);
        grad.addColorStop(0, hexA(light.hazeColor, s.alpha));
        grad.addColorStop(1, hexA(light.hazeColor, 0));
        g.fillStyle = grad;
        g.fillRect(s.x * W - rad, s.y * H - rad, rad * 2, rad * 2);
      }
      break;
    }
    case "cloudShadow": {
      for (const s of sprites) {
        const rad = s.size * W;
        const grad = g.createRadialGradient(s.x * W, s.y * H, 0, s.x * W, s.y * H, rad);
        grad.addColorStop(0, `rgba(28,42,22,${s.alpha})`);
        grad.addColorStop(1, "rgba(28,42,22,0)");
        g.fillStyle = grad;
        g.fillRect(0, H * 0.5, W, H * 0.5);
      }
      break;
    }
    case "rainSplash": {
      g.strokeStyle = "rgba(207,228,240,0.9)";
      for (const s of sprites) {
        if (s.alpha <= 0.02) continue;
        g.globalAlpha = s.alpha;
        g.lineWidth = 1;
        g.beginPath();
        g.ellipse(s.x * W, s.y * H, s.size * W, s.size * W * 0.3, 0, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = 1;
      break;
    }
    case "gustFringe": {
      const base = shade(light.grassNear, 0.6);
      const tip = shade(light.grassNear, 0.85);
      for (const s of sprites) {
        const x = s.x * W;
        const h = s.size * H;
        const bend = s.tilt * gustScale;
        g.strokeStyle = mix(base, tip, s.size * 8);
        g.globalAlpha = 0.8;
        g.lineWidth = Math.max(1.2, W / 700);
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(x, H);
        g.quadraticCurveTo(x + bend * h * 0.4, H - h * 0.6, x + bend * h, H - h);
        g.stroke();
      }
      g.globalAlpha = 1;
      break;
    }
    case "petals": {
      for (const s of sprites) {
        g.save();
        g.translate(s.x * W, s.y * H);
        g.rotate(s.tilt);
        g.globalAlpha = s.alpha;
        g.fillStyle = light.meadowAccents[0] ?? "#e0b23e";
        g.beginPath();
        g.ellipse(0, 0, s.size * (W / 900), s.size * 0.5 * (W / 900), 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      break;
    }
    case "shimmer": {
      for (const s of sprites) {
        g.globalAlpha = s.alpha;
        g.fillStyle = hexA(light.hazeColor, 1);
        g.fillRect(s.x * W, s.y * H, s.size * W, Math.max(1, H / 280));
      }
      g.globalAlpha = 1;
      break;
    }
  }
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const gc = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${gc},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}
```

In `GardenScene.tsx` add the prop and wrapper:

```tsx
export interface GardenSceneProps {
  // …existing props…
  /** Mount the Tier-2 canvas atmosphere layer above the SVG. */
  atmosphere?: boolean;
}
// at the end of the component:
const svg = ( /* the existing <svg>…</svg> JSX */ );
if (!atmosphere) return svg;
return (
  <div data-garden-wrapper="true" style={{ position: "relative", width: "100%", height: "100%" }}>
    {svg}
    {reducedMotion ? null : (
      <AtmosphereLayer
        weather={weather}
        light={light}
        fireflies={snapshot.wildlife.fireflies ?? false}
        hasFlowering={sorted.some((pl) => pl.state === "flowering")}
        restMode={snapshot.state.restMode}
        idPrefix={p}
      />
    )}
  </div>
);
```

- [ ] **Step 4: Run the whole renderer suite**

Run: `cd /Users/kyranadams/src/run-garden && pnpm --filter @rg/garden-renderer exec vitest run`
Expected: PASS — `renderToStaticMarkup` never runs effects, so no RAF/canvas APIs execute in tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /Users/kyranadams/src/run-garden
pnpm --filter @rg/garden-renderer typecheck
git add packages/garden-renderer/src/AtmosphereLayer.tsx packages/garden-renderer/src/GardenScene.tsx packages/garden-renderer/test/renderer.test.tsx
git commit -m "feat(garden): canvas atmosphere layer behind an opt-in atmosphere prop"
```

---

### Task 10: Opt the web garden screen and ambient screen into the atmosphere

**Files:**
- Modify: `packages/ui/src/screens/garden.tsx` (the `<GardenScene …/>` around line 216)
- Modify: `packages/ui/src/screens/ambient.tsx` (the `<GardenScene …/>` around line 158)

**Interfaces:**
- Consumes: `atmosphere` prop from Task 9. No new interfaces.

- [ ] **Step 1: Add the prop at both call sites**

In both files add `atmosphere` to the existing `<GardenScene`:

```tsx
<GardenScene
  snapshot={snapshot}
  reducedMotion={reducedMotion}
  timeOfDay={hourOfDay}
  atmosphere
  /* …existing props unchanged… */
/>
```

Check each call site's surrounding container: the wrapper div GardenScene now emits is `position:relative; width/height:100%`, so the parent must give it a sized box. In `garden.tsx` the scene sits in a `<div>` — confirm it has a height via its existing className (it renders the svg with `aspect-ratio` or intrinsic sizing today). If the svg was the sizing element, move the sizing className to `GardenScene`'s `className` prop unchanged — the svg keeps `width="100%"` inside the wrapper. Verify by rendering the web app (Step 3), not by assumption.

- [ ] **Step 2: Typecheck the workspace**

Run: `cd /Users/kyranadams/src/run-garden && pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Verify in the running app (fixture mode)**

```bash
cd /Users/kyranadams/src/run-garden
nvm use 22
pnpm dev   # worker :8787 + web :5173, background it
curl -X POST http://localhost:8787/api/dev/fixture-login -c /tmp/rg-cookies.txt
curl -X POST http://localhost:8787/api/dev/seed -b /tmp/rg-cookies.txt
```

Open http://localhost:5173/garden with playwright (headless screenshot) and confirm: the garden card still lays out correctly, the canvas overlays the SVG exactly, and nothing overflows. Read the screenshot.

- [ ] **Step 4: Run the full test suite (Node 21)**

Run: `cd /Users/kyranadams/src/run-garden && nvm use 21 && pnpm test`
Expected: full-suite green (216+ tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/kyranadams/src/run-garden
git add packages/ui/src/screens/garden.tsx packages/ui/src/screens/ambient.tsx
git commit -m "feat(garden): enable atmosphere layer on web garden card and ambient mode"
```

---

### Task 11: State-matrix sampler + second visual checkpoint

**Files:**
- Create: `packages/garden-renderer/demo/matrix.tsx`
- Create: `packages/garden-renderer/demo/build-matrix.mjs` (copy `build.mjs`, entry point swapped to `matrix.tsx`, default outfile `/tmp/garden-matrix.html`)
- Create: `packages/garden-renderer/demo/shoot-matrix.mjs`

**Interfaces:**
- Consumes: `GardenScene` with `atmosphere`, engine `replay` fixtures (copy the `trainingWeeks`/`healthySnapshot` builders from `test/renderer.test.tsx` — the demo can't import test files).
- Produces: `docs/images/matrix/*.png` (≈18 files, named `<weather>--<season>--<hour>.png`).

- [ ] **Step 1: Write `demo/matrix.tsx`**

A single page that builds one healthy snapshot via `replay`, then renders a labeled grid of `<GardenScene>` variants by overriding state fields (snapshots are plain objects):

```tsx
import { createRoot } from "react-dom/client";
import { GardenScene } from "@rg/garden-renderer";
import type { GardenSnapshot } from "@rg/garden-engine";
import type { GardenSeason, GardenWeatherState } from "@rg/domain";
// …copy the replay/trainingWeeks snapshot builder from the demo/index.tsx helpers…

function variant(base: GardenSnapshot, weather: GardenWeatherState, season: GardenSeason, extra: Partial<GardenSnapshot["state"]> = {}): GardenSnapshot {
  return { ...base, state: { ...base.state, weatherState: weather, season, ...extra } };
}

// The spec's 18 shots:
const SHOTS: Array<{ id: string; weather: GardenWeatherState; season: GardenSeason; hour: number; extra?: Partial<GardenSnapshot["state"]> }> = [
  { id: "fresh_rain--summer--13", weather: "fresh_rain", season: "summer", hour: 13 },
  { id: "recovery_rain--summer--18.9", weather: "recovery_rain", season: "summer", hour: 18.9, extra: { inComeback: true } },
  { id: "clear_sun--summer--10", weather: "clear_sun", season: "summer", hour: 10 },
  { id: "soft_sun--summer--6.2", weather: "soft_sun", season: "summer", hour: 6.2 },
  { id: "soft_sun--summer--9", weather: "soft_sun", season: "summer", hour: 9 },
  { id: "soft_sun--summer--13", weather: "soft_sun", season: "summer", hour: 13 },
  { id: "soft_sun--summer--18.9", weather: "soft_sun", season: "summer", hour: 18.9 },
  { id: "soft_sun--summer--20.5", weather: "soft_sun", season: "summer", hour: 20.5 },
  { id: "soft_sun--summer--23.5", weather: "soft_sun", season: "summer", hour: 23.5 },
  { id: "light_clouds--summer--13", weather: "light_clouds", season: "summer", hour: 13 },
  { id: "seasonal_breeze--summer--15", weather: "seasonal_breeze", season: "summer", hour: 15 },
  { id: "dry_spell--summer--13", weather: "dry_spell", season: "summer", hour: 13, extra: { moisture: 0.35, droughtDays: 5 } },
  { id: "mild_drought--summer--13", weather: "mild_drought", season: "summer", hour: 13, extra: { moisture: 0.15, droughtDays: 9 } },
  { id: "soft_sun--spring--18", weather: "soft_sun", season: "spring", hour: 18 },
  { id: "soft_sun--summer--18.9-golden", weather: "soft_sun", season: "summer", hour: 18.9 },
  { id: "soft_sun--autumn--17", weather: "soft_sun", season: "autumn", hour: 17 },
  { id: "soft_sun--winter--16", weather: "soft_sun", season: "winter", hour: 16 },
  { id: "clear_sun--summer--23.5-fireflies", weather: "clear_sun", season: "summer", hour: 23.5 },
];
```

Render each as a `<section id={shot.id} style={{width:900, aspectRatio:"1000/560"}}>` containing `<GardenScene snapshot={…} timeOfDay={shot.hour} atmosphere />`.

- [ ] **Step 2: Write `demo/build-matrix.mjs` and `demo/shoot-matrix.mjs`**

`build-matrix.mjs`: copy of `build.mjs` with the entry changed to `demo/matrix.tsx` and the default out `/tmp/garden-matrix.html`.

`shoot-matrix.mjs`:

```js
import { chromium } from "../../../apps/web/node_modules/@playwright/test/index.mjs";
import { mkdirSync } from "node:fs";
// load file:///tmp/garden-matrix.html, wait 1500ms for canvases,
// for each section id: locator(`#${id}`).screenshot({ path: `docs/images/matrix/${id}.png` })
```

(Adapt the import to however `@playwright/test` resolves cleanly — `createRequire` on the apps/web package path is the fallback.)

- [ ] **Step 3: Build, shoot, and READ the images**

```bash
cd /Users/kyranadams/src/run-garden
node packages/garden-renderer/demo/build-matrix.mjs
node packages/garden-renderer/demo/shoot-matrix.mjs
```

Read all 18 images. The bar, per the spec: *each shot must be recognizable at a glance and none may look like a recolor of another*. Judge specifically: rain vs recovery-rain (silver vs gold), drought's cracked amber vs dry-spell's straw haze, four distinct season casts, dawn mist, golden beams, moonlit night with phase. Tune `lighting.ts` constants where states blur together. Re-run the vitest suite after every tuning change.

- [ ] **Step 4: Commit (including the matrix images)**

```bash
cd /Users/kyranadams/src/run-garden
git add packages/garden-renderer/demo/matrix.tsx packages/garden-renderer/demo/build-matrix.mjs packages/garden-renderer/demo/shoot-matrix.mjs docs/images/matrix
git commit -m "feat(garden): state-matrix sampler + reference renders of all signature states"
```

---

### Task 12: Regenerate app screenshots and README images

**Files:**
- Modify: `screenshots/*.png` (regenerated), `docs/images/garden-day.png`, `docs/images/garden-night.png`

- [ ] **Step 1: Regenerate the app screenshot set**

With the fixture dev server still running (Task 10 Step 3; otherwise restart it):

```bash
cd /Users/kyranadams/src/run-garden/apps/web
node scripts/screenshots.mjs
```

Read at least `garden__1280x800__light.png`, `garden__390x844__light.png`, and `garden__1280x800__dark.png` — confirm layout intact and the new scene renders inside the card.

- [ ] **Step 2: Re-capture the README hero images**

Use the matrix page: screenshot `soft_sun--summer--13` at 1440×900 → `docs/images/garden-day.png`, and `soft_sun--summer--23.5` → `docs/images/garden-night.png` (same playwright pattern as `shoot-matrix.mjs`, full-section shots).

- [ ] **Step 3: Full suite + typecheck, then commit**

```bash
cd /Users/kyranadams/src/run-garden
nvm use 21 && pnpm test && pnpm typecheck
git add screenshots docs/images/garden-day.png docs/images/garden-night.png
git commit -m "docs(garden): refresh screenshots and README hero images for the visual overhaul"
```

---

## Plan Self-Review Notes

- **Spec coverage:** color script (T1–2), sky/moon-phase/clouds (T3), terrain/meadow/patches/pools (T4), shadows/tint/travelling sway (T5), beams/haze/rainbow/grain/vignette + rain kept in SVG (T6), particle gating + all eight systems (T7–8), canvas layer + `atmosphere` prop + reducedMotion/context-failure fallbacks (T9), UI opt-in (T10), matrix sampler ≈18 shots (T11), screenshots/README (T12). Spec's "unknown future weather/season → fallback" is satisfied structurally: exhaustive switches over the domain unions fail typecheck if the union grows, which is the stronger guarantee.
- **Budget note:** the spec's "≤120 particles" is enforced as *airborne* particles (test in T7); the gust fringe's 160 ground blades are budgeted separately (≤180, also tested), matching the spec's own fringe count.
- **Type consistency:** `SceneLight`/`lightingFor`/`moonPhase` (T1) are consumed by name in T3–T9; `ParticleSystem`/`Sprite`/`sampleSystem` (T7) consumed in T9. `sceneCss(p, amp)` changes only inside `GardenScene.tsx`.
- **Determinism risk watched:** meadow/star loops always consume identical rng draws regardless of rendered count, so density changes can't reshuffle positions.
