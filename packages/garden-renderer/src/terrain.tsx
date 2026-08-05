import type { ReactNode } from "react";
import { REGION_BANDS, rng, type EarnedGround } from "@rg/garden-engine";
import { mix, shade } from "./color";
import type { SceneLight } from "./lighting";

const n = (x: number): number => Math.round(x * 100) / 100;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface TerrainProps {
  /** Scene id prefix, for def/filter references. */
  p: string;
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
/** Open polyline smoothed through vertex midpoints; endpoints exact. */
function smoothOpen(pts: Array<[number, number]>): string {
  let d = `M${n(pts[0]![0])},${n(pts[0]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i]![0] + pts[i + 1]![0]) / 2;
    const my = (pts[i]![1] + pts[i + 1]![1]) / 2;
    d += ` Q${n(pts[i]![0])},${n(pts[i]![1])} ${n(mx)},${n(my)}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` L${n(last[0])},${n(last[1])}`;
  return d;
}

function groundFeature(g: EarnedGround, light: SceneLight, p: string): ReactNode | null {
  const band = REGION_BANDS[g.region];
  if (!band) return null;
  const x0 = band[0] * 1000;
  const x1 = band[1] * 1000;
  const cx = (x0 + x1) / 2;
  const w = x1 - x0;
  const r = rng(`ground:${g.kind}:${g.region}`);
  switch (g.kind) {
    case "stream": {
      // A brook nestled INTO the meadow, not a ribbon on top of it: a narrow
      // meandering channel, water reflecting the sky, darker wet banks, and
      // grass overhanging the edges. Sun side gets glints.
      const water = mix(mix("#7ba7c2", light.skyMid, 0.35), light.grassFar, 0.08);
      const topColor = mix(water, light.skyHorizon, 0.45);
      const botColor = shade(water, 0.85);
      const drift = (r() - 0.5) * 40;
      const phase = r() * Math.PI;
      const amp = 16 + r() * 14;
      const topW = Math.min(14, w * 0.08);
      const botW = Math.min(62, w * 0.3);
      const N = 9;
      const left: Array<[number, number]> = [];
      const right: Array<[number, number]> = [];
      const mid: Array<[number, number]> = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const y = 314 + t * 246;
        const xc = cx + drift * t + Math.sin(t * Math.PI * 1.6 + phase) * amp * (0.25 + 0.75 * t);
        const hw = topW / 2 + (botW / 2 - topW / 2) * Math.pow(t, 1.15);
        left.push([xc - hw, y]);
        right.push([xc + hw, y]);
        mid.push([xc, y]);
      }
      const channel = (() => {
        let d = smoothOpen(left);
        d += ` L${n(right[N - 1]![0])},${n(right[N - 1]![1])}`;
        const rev = [...right].reverse();
        // continue the outline back up the right edge
        for (let i = 1; i < rev.length - 1; i++) {
          const mx = (rev[i]![0] + rev[i + 1]![0]) / 2;
          const my = (rev[i]![1] + rev[i + 1]![1]) / 2;
          d += ` Q${n(rev[i]![0])},${n(rev[i]![1])} ${n(mx)},${n(my)}`;
        }
        return `${d} L${n(right[0]![0])},${n(right[0]![1])} Z`;
      })();
      // Sun glints: short bright dashes, stronger when beams are out.
      const glints: ReactNode[] = [];
      for (let k = 0; k < 5; k++) {
        const t = Math.min(0.95, 0.22 + k * 0.16 + (r() - 0.5) * 0.06);
        const i = Math.round(t * (N - 1));
        const [gx, gy] = mid[i]!;
        const gw = 2.2 + 3.4 * t;
        if (light.sunX === null) continue;
        glints.push(
          <path
            key={`g${k}`}
            d={`M${n(gx - gw + (r() - 0.5) * 6)},${n(gy)} q${n(gw)},1.4 ${n(gw * 2)},0`}
            stroke={mix(water, "#ffffff", 0.7)}
            strokeWidth={1}
            fill="none"
            strokeLinecap="round"
            opacity={n(0.3 + 0.5 * light.beamStrength)}
          />,
        );
      }
      // consume draws even when the sun is down — glint count must not
      // change the stream's geometry
      if (light.sunX === null) for (let k = 0; k < 5; k++) r();
      // Overhanging bank grass: tufts leaning over the water's edge.
      const tufts: ReactNode[] = [];
      for (let j = 0; j < 10; j++) {
        const side = j % 2 === 0 ? -1 : 1;
        const t = Math.min(0.95, 0.15 + j * 0.085 + (r() - 0.5) * 0.05);
        const i = Math.round(t * (N - 1));
        const pts = side === -1 ? left : right;
        const [bx, by] = pts[i]!;
        const lean = -side * (3 + r() * 3);
        tufts.push(
          <path
            key={`t${j}`}
            d={`M${n(bx)},${n(by + 1)} q${n(lean * 0.5)},-3.4 ${n(lean)},-5.2 M${n(bx + side * 2)},${n(by + 1.5)} q${n(lean * 0.4)},-2.6 ${n(lean * 0.8)},-4`}
            stroke={shade(light.grassNear, 0.66 + 0.12 * (j % 3 === 0 ? 1 : 0))}
            strokeWidth={n(1.1 + 0.5 * t)}
            fill="none"
            strokeLinecap="round"
            opacity={0.9}
          />,
        );
      }
      const reedX = mid[N - 2]![0] - botW / 2 + r() * 6;
      return (
        <g key={`ground-${g.region}`} data-ground-kind="stream">
          <defs>
            <linearGradient id={`${p}-water-${g.region}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={topColor} />
              <stop offset="100%" stopColor={botColor} />
            </linearGradient>
          </defs>
          {/* wet darker earth seat so the brook sits IN the meadow */}
          <path d={channel} fill={shade(light.grassNear, 0.72)} opacity={0.35} transform="translate(0 1.6)" />
          <path d={channel} fill={`url(#${p}-water-${g.region})`} opacity={0.95} />
          {/* deeper center */}
          <path d={smoothOpen(mid)} stroke={shade(water, 0.75)} strokeWidth={n(botW * 0.22)} fill="none" opacity={0.3} strokeLinecap="round" />
          {glints}
          {tufts}
          {/* reeds at the near bank */}
          <path
            d={`M${n(reedX)},546 q-1.4,-9 -3.4,-13 M${n(reedX + 3)},547 q0.4,-10 -0.4,-15 M${n(reedX + 6)},546 q1.8,-8 4,-12`}
            stroke={shade(light.grassNear, 0.72)}
            strokeWidth={1.4}
            fill="none"
            strokeLinecap="round"
            opacity={0.85}
          />
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

/**
 * Foreground framing band: tall grass silhouettes hugging the bottom edge,
 * drawn OVER the plants (GardenScene mounts it after them) the way the
 * approved mock framed its composition. Height stays in the bottom ~35px so
 * it only ever overlaps plant bases; pointer events pass straight through.
 * Density follows the same honesty rule as the meadow.
 */
export function FramingGrass({ light, moisture, soilHealth }: { light: SceneLight; moisture: number; soilHealth: number }): ReactNode {
  const density = clamp01(0.35 + 0.35 * clamp01(moisture) + 0.3 * clamp01(soilHealth));
  const count = Math.round(46 + 44 * density);
  const r = rng("terrain:framing");
  const blades: ReactNode[] = [];
  for (let i = 0; i < 90; i++) {
    // Fixed 5 draws per blade for stability across density changes.
    const x = n(r() * 1000);
    const edge = Math.min(Math.abs(x - 0), Math.abs(x - 1000)); // taller near corners
    const hBase = 15 + 20 * r() + (edge < 220 ? (220 - edge) * 0.16 : 0);
    const lean = n((r() - 0.5) * 10);
    const width = n(1.7 + r() * 1.1);
    const shadeRoll = r();
    if (i >= count) continue;
    const y = 562;
    const h = n(hBase);
    const c = shade(light.grassNear, 0.62 + shadeRoll * 0.2);
    blades.push(
      <path
        key={`fb${i}`}
        d={`M${x},${y} q${n(lean * 0.4)},${n(-h * 0.6)} ${lean},${n(-h)}`}
        stroke={c}
        strokeWidth={width}
        fill="none"
        strokeLinecap="round"
        opacity={0.9}
      />,
    );
  }
  return (
    <g data-terrain="framing" pointerEvents="none">
      {blades}
    </g>
  );
}

export function Terrain({ p, light, moisture, soilHealth, floweringDensity, biodiversity, droughtDays, canopy, trees, grounds = [] }: TerrainProps): ReactNode {
  const groundEls = grounds.map((g) => groundFeature(g, light, p)).filter(Boolean);
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
    // Warm grading toward the sun azimuth — light changes color, not density.
    const sunT = light.sunX !== null ? Math.max(0, 1 - Math.abs(x - light.sunX) / 900) : 0;
    const c = mix(shade(base, 0.85 + shadeRoll * 0.3), light.sunColor, 0.18 * sunT);
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

  // Backlit seed heads: sparse tall stems whose heads catch the low sun.
  // Fixed 96 draws (4 × 24); floweringDensity gates rendering, never draws.
  const sr = rng("terrain:seedheads");
  const sCount = Math.round(10 + 8 * clamp01(floweringDensity));
  const seedheads: ReactNode[] = [];
  for (let i = 0; i < 24; i++) {
    const d = 0.3 + sr() * 0.7;
    const x = n(sr() * 1000);
    const h = n((14 + 10 * sr()) * (0.6 + 0.5 * d));
    const leanSh = n((sr() - 0.5) * 6);
    if (i >= sCount) continue;
    const y = n(300 + 250 * d);
    const sunT = light.sunX !== null ? Math.max(0, 1 - Math.abs(x - light.sunX) / 700) : 0;
    const head = light.sunX !== null ? mix(light.grassNear, light.sunColor, 0.55) : shade(light.grassNear, 1.15);
    const stem = mix(shade(mix(light.grassFar, light.grassNear, d), 0.9), head, 0.4 * sunT);
    seedheads.push(
      <g key={`sh${i}`} data-terrain="seedhead">
        <path d={`M${x},${y} q${n(leanSh * 0.5)},${n(-h * 0.6)} ${leanSh},${n(-h)}`} stroke={stem} strokeWidth={0.9} fill="none" strokeLinecap="round" />
        <ellipse cx={n(x + leanSh)} cy={n(y - h)} rx={1.3} ry={2.2} fill={head} opacity={n(0.45 + 0.45 * light.beamStrength)} />
      </g>,
    );
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
      <rect
        data-terrain="mottle"
        x={0}
        y={290}
        width={1000}
        height={270}
        filter={`url(#${p}-mottle)`}
        opacity={0.25}
        style={{ mixBlendMode: "soft-light" }}
        pointerEvents="none"
      />
      {groundEls.length > 0 ? <g data-terrain="grounds" pointerEvents="none">{groundEls}</g> : null}
      {pools.length > 0 ? <g data-terrain="pools" pointerEvents="none">{pools}</g> : null}
      <g data-terrain="meadow" pointerEvents="none">{strokes}</g>
      {seedheads.length > 0 ? <g data-terrain="seedheads" pointerEvents="none">{seedheads}</g> : null}
      {flowers.length > 0 ? <g data-terrain="flowers" pointerEvents="none">{flowers}</g> : null}
      {patches.length > 0 ? <g data-terrain="patches" pointerEvents="none">{patches}</g> : null}
    </>
  );
}
