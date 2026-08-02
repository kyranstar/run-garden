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
  if ((g.weather === "clear_sun" || g.weather === "soft_sun" || g.weather === "dry_spell") && BEAMY.includes(g.period)) out.push("pollen");
  if (g.period === "dawn" || g.weather === "recovery_rain") out.push("mist");
  if ((g.weather === "light_clouds" || g.weather === "dry_spell") && DAY.includes(g.period)) out.push("cloudShadow");
  if (g.weather === "seasonal_breeze" && g.hasFlowering) out.push("petals");
  if (g.weather === "mild_drought" && g.period === "midday") out.push("shimmer");
  if (g.period === "night" && g.fireflies) out.push("fireflyGlow");
  return out;
}

/**
 * The gating scalars, collapsed to a comparable string. AtmosphereLayer uses
 * this to decide whether its particle systems need rebuilding on a frame —
 * unlike `light` (a fresh object every parent render), this key is stable
 * across re-renders that don't actually change which systems are active, so
 * the canvas RAF loop's time origin never resets from parent churn.
 */
export function atmosphereKey(inp: GateInputs): string {
  return `${inp.weather}|${inp.period}|${inp.fireflies}|${inp.hasFlowering}`;
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
  }
}
