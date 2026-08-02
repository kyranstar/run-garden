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
    beamStrength: key.beamStrength,
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
