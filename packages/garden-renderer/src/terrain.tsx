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
  if (droughtDays >= 3) {
    const pr = rng("terrain:patches");
    const k = Math.min(6, droughtDays - 2);
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
