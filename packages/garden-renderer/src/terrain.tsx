import type { ReactNode } from "react";
import { REGION_BANDS, rng, type EarnedGround } from "@rg/garden-engine";
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
  /** Earned grounds (region expansions) — each carves its band's identity. */
  grounds?: EarnedGround[];
}

/**
 * The earned-ground features: a stream carved by long runs, a stone terrace
 * built by strength, a still glade cleared by yoga, or denser meadow. Static,
 * seeded with fresh keys, drawn under the meadow strokes so plants sit on top.
 */
function groundFeature(g: EarnedGround, light: SceneLight): ReactNode | null {
  const band = REGION_BANDS[g.region];
  if (!band) return null;
  const x0 = band[0] * 1000;
  const x1 = band[1] * 1000;
  const cx = (x0 + x1) / 2;
  const w = x1 - x0;
  const r = rng(`ground:${g.kind}:${g.region}`);
  switch (g.kind) {
    case "stream": {
      // Water leans blue even at low sun — a stream, never a road.
      const water = mix("#7fa8c2", light.skyHorizon, 0.22);
      const deep = shade(water, 0.88);
      const bank = shade(light.grassNear, 0.8);
      const drift = (r() - 0.5) * 55;
      const topW = Math.min(28, w * 0.12);
      const botW = Math.min(120, w * 0.45);
      const leftEdge = `M${n(cx - topW / 2)},302 C${n(cx + drift - topW)},390 ${n(cx + drift - botW * 0.4)},470 ${n(cx - botW / 2)},560`;
      const rightEdge = `M${n(cx + topW / 2)},302 C${n(cx + drift + topW)},390 ${n(cx + drift + botW * 0.4)},470 ${n(cx + botW / 2)},560`;
      const d = `${leftEdge} L${n(cx + botW / 2)},560 C${n(cx + drift + botW * 0.4)},470 ${n(cx + drift + topW)},390 ${n(cx + topW / 2)},302 Z`;
      const mid = `M${n(cx)},306 C${n(cx + drift * 0.8)},395 ${n(cx + drift * 0.5)},470 ${n(cx)},556`;
      const ripples: ReactNode[] = [];
      for (let i = 0; i < 3; i++) {
        const ry = 410 + i * 52 + r() * 18;
        const t = (ry - 302) / 258;
        const rw = topW / 2 + (botW / 2 - topW / 2) * t;
        const rx = cx + drift * (1 - Math.abs(t - 0.5) * 2) * 0.7 + (r() - 0.5) * rw * 0.6;
        ripples.push(
          <path
            key={`r${i}`}
            d={`M${n(rx - rw * 0.22)},${n(ry)} q${n(rw * 0.22)},2.4 ${n(rw * 0.44)},0`}
            stroke={mix(water, "#ffffff", 0.5)}
            strokeWidth={1.1}
            fill="none"
            opacity={0.55}
            strokeLinecap="round"
          />,
        );
      }
      const reedX = cx - botW / 2 + 4 + r() * 8;
      return (
        <g key={`ground-${g.region}`} data-ground-kind="stream">
          <path d={d} fill={water} opacity={0.88} />
          {/* deeper center channel */}
          <path d={mid} stroke={deep} strokeWidth={n(botW * 0.22)} fill="none" opacity={0.4} strokeLinecap="round" />
          <path d={mid} stroke={mix(water, "#ffffff", 0.42)} strokeWidth={2} fill="none" opacity={0.55} />
          {/* soft banks where water meets grass */}
          <path d={leftEdge} stroke={bank} strokeWidth={1.6} fill="none" opacity={0.5} />
          <path d={rightEdge} stroke={bank} strokeWidth={1.6} fill="none" opacity={0.5} />
          {ripples}
          {/* reeds at the near bank */}
          <path
            d={`M${n(reedX)},546 q-1.4,-9 -3.4,-13 M${n(reedX + 3)},547 q0.4,-10 -0.4,-15 m0.4,15 l0,0 M${n(reedX + 6)},546 q1.8,-8 4,-12`}
            stroke={shade(light.grassNear, 0.72)}
            strokeWidth={1.4}
            fill="none"
            strokeLinecap="round"
            opacity={0.85}
          />
          <ellipse cx={n(reedX - 3)} cy={533} rx={1.2} ry={3} fill={shade(light.grassNear, 0.6)} opacity={0.8} />
        </g>
      );
    }
    case "terrace": {
      const stoneBase = mix("#9a8465", light.grassNear, 0.22);
      const rows: ReactNode[] = [];
      for (let row = 0; row < 3; row++) {
        const y = 462 + row * 30;
        const rowW = w * (0.55 + row * 0.08);
        const stones = 4 + (row % 2);
        for (let sIdx = 0; sIdx < stones; sIdx++) {
          const sw = rowW / stones - 4;
          const sx = cx - rowW / 2 + sIdx * (rowW / stones) + (r() - 0.5) * 4;
          rows.push(
            <rect
              key={`t${row}-${sIdx}`}
              x={n(sx)}
              y={n(y + (r() - 0.5) * 2.4)}
              width={n(sw)}
              height={n(8 + r() * 2.5)}
              rx={3}
              fill={shade(stoneBase, 0.9 + r() * 0.22)}
              opacity={0.9}
            />,
          );
        }
      }
      return (
        <g key={`ground-${g.region}`} data-ground-kind="terrace">
          {rows}
        </g>
      );
    }
    case "glade": {
      const pale = shade(light.grassNear, 1.12);
      const stones: ReactNode[] = [];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + r() * 0.5;
        stones.push(
          <circle
            key={`s${i}`}
            cx={n(cx + Math.cos(a) * w * 0.26)}
            cy={n(488 + Math.sin(a) * 22)}
            r={n(2.4 + r() * 1.6)}
            fill="#8a8577"
            opacity={0.8}
          />,
        );
      }
      return (
        <g key={`ground-${g.region}`} data-ground-kind="glade">
          <ellipse cx={n(cx)} cy={488} rx={n(w * 0.32)} ry={26} fill={pale} opacity={0.5} />
          <ellipse cx={n(cx)} cy={488} rx={n(w * 0.18)} ry={14} fill={shade(pale, 1.06)} opacity={0.45} />
          {stones}
        </g>
      );
    }
    case "meadow": {
      const dots: ReactNode[] = [];
      for (let i = 0; i < 14; i++) {
        const x = x0 + r() * w;
        const y = 415 + r() * 130;
        dots.push(
          <circle
            key={`d${i}`}
            cx={n(x)}
            cy={n(y)}
            r={n(1.2 + r() * 1.6)}
            fill={light.meadowAccents[i % light.meadowAccents.length]!}
            opacity={0.8}
          />,
        );
      }
      return (
        <g key={`ground-${g.region}`} data-ground-kind="meadow">
          {dots}
        </g>
      );
    }
  }
}

const BAND_CURVES = [
  "M0,290 C260,280 740,280 1000,290 L1000,560 L0,560 Z",
  "M0,318 C300,306 700,308 1000,316 L1000,560 L0,560 Z",
  "M0,372 C280,358 720,360 1000,370 L1000,560 L0,560 Z",
  "M0,452 C300,438 680,440 1000,450 L1000,560 L0,560 Z",
];

export function Terrain({ light, moisture, soilHealth, floweringDensity, biodiversity, droughtDays, canopy, trees, grounds = [] }: TerrainProps): ReactNode {
  const groundEls = grounds.map((g) => groundFeature(g, light)).filter(Boolean);
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
      {groundEls.length > 0 ? <g data-terrain="grounds" pointerEvents="none">{groundEls}</g> : null}
      {pools.length > 0 ? <g data-terrain="pools" pointerEvents="none">{pools}</g> : null}
      <g data-terrain="meadow" pointerEvents="none">{strokes}</g>
      {flowers.length > 0 ? <g data-terrain="flowers" pointerEvents="none">{flowers}</g> : null}
      {patches.length > 0 ? <g data-terrain="patches" pointerEvents="none">{patches}</g> : null}
    </>
  );
}
