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
/**
 * Shared stream-channel geometry: one source of truth for where the water is,
 * used by the stream renderer, the meadow (which must not grow through it),
 * and the scene's plant-anchor displacement. Re-derives its params from the
 * same seeded rng key every time, so all consumers agree byte-for-byte. The
 * source pinches to a quarter width over the first ~12% so the brook emerges
 * thin from the ridge line instead of materializing mid-field.
 */
export interface StreamGeometry {
  xc: (t: number) => number;
  hw: (t: number) => number;
  yTop: number;
  ySpan: number;
  /** Course ends here: 1 for a main stem, < 1 for a tributary at its junction. */
  tEnd: number;
  /** Region of the stem this tributary joins, or null for a main stem. */
  joins: number | null;
  inChannel: (x: number, y: number, margin?: number) => boolean;
  /** rng advanced past the geometry draws — the renderer's decoration stream. */
  r: () => number;
  region: number;
  /** Band center — adjacency test for tributaries. */
  cx0: number;
}

/**
 * The whole river system at once: adjacent streams merge — a later-earned
 * stream whose band sits near an existing stem becomes its tributary, curving
 * into a junction at tJoin, and the stem widens below the confluence (added
 * discharge). Realist perspective spine: meanders are tiny at the horizon and
 * sweep near the viewer (amp ∝ t^1.55, phase ∝ t^0.58); width grows
 * 1.1px → hwMax as t^1.75 with a ±10% modulation that reads as narrows and
 * pools. Deterministic: 4 seeded draws per stream, then decoration draws.
 */
export function riverSystemFor(grounds: EarnedGround[]): StreamGeometry[] {
  const streams = grounds
    .filter((g) => g.kind === "stream")
    .sort((a, b) => a.earnedDate.localeCompare(b.earnedDate) || a.region - b.region);
  const channels: StreamGeometry[] = [];
  const boosts: Array<Array<{ t: number }>> = [];
  for (const g of streams) {
    const band = REGION_BANDS[g.region];
    if (!band) continue;
    const x0 = band[0] * 1000;
    const x1 = band[1] * 1000;
    const cx = (x0 + x1) / 2;
    const w = x1 - x0;
    const r = rng(`ground:stream:${g.region}`);
    const drift = (r() - 0.5) * 44;
    const phase = r() * Math.PI;
    const amp = 15 + r() * 13;
    const T = 1.25 + r() * 0.5;
    const hwMax = Math.min(30, w * 0.17);
    const yTop = 296;
    const ySpan = 264;
    const ownXc = (t: number): number =>
      cx +
      drift * t +
      Math.sin(2 * Math.PI * T * Math.pow(t, 0.58) + phase) * amp * Math.pow(t, 1.55) +
      Math.sin(4.7 * Math.PI * Math.pow(t, 0.6) + phase * 1.7) * amp * 0.22 * Math.pow(t, 1.3);
    const stemIdx = channels.findIndex((c) => c.joins === null && Math.abs(c.cx0 - cx) < 260);
    const myBoosts: Array<{ t: number }> = [];
    let tEnd = 1;
    let joins: number | null = null;
    let xc = ownXc;
    if (stemIdx >= 0) {
      const stem = channels[stemIdx]!;
      const tJoin = 0.5;
      // Hermite-flavored approach: hold your own course, then curve into the
      // stem so position matches exactly at the junction.
      xc = (t: number): number => {
        const s = clamp01((t - tJoin * 0.4) / (tJoin * 0.6));
        const blend = s * s * (3 - 2 * s);
        return ownXc(t) * (1 - blend) + stem.xc(t) * blend;
      };
      tEnd = tJoin;
      joins = stem.region;
      boosts[stemIdx]!.push({ t: tJoin });
    }
    const hw = (t: number): number => {
      let base = 1.1 + (hwMax - 1.1) * Math.pow(t, 1.75);
      base *= 1 + 0.1 * Math.sin(9 * t + phase);
      if (joins !== null) base *= 0.8; // tributaries run slimmer
      for (const b of myBoosts) if (t > b.t) base *= 1.32;
      return base;
    };
    const inChannel = (x: number, y: number, margin = 0): boolean => {
      if (y < yTop + 2) return false;
      const t = (y - yTop) / ySpan;
      if (t > tEnd + 0.02) return false;
      const tc = Math.min(tEnd, Math.min(1, t));
      return Math.abs(x - xc(tc)) < hw(tc) + margin;
    };
    channels.push({ xc, hw, yTop, ySpan, tEnd, joins, inChannel, r, region: g.region, cx0: cx });
    boosts.push(myBoosts);
  }
  return channels;
}

/** Single-stream compatibility wrapper over riverSystemFor. */
export function streamGeometryFor(g: EarnedGround): StreamGeometry | null {
  return riverSystemFor([g])[0] ?? null;
}

/**
 * Nudge an anchor out of any stream channel — plants don't grow in water.
 * `pad` is the plant's visual half-footprint, so foliage clears the bank
 * instead of merely the anchor point.
 */
export function displaceFromStreams(
  a: { x: number; y: number; s: number },
  channels: StreamGeometry[],
  pad = 10,
): { x: number; y: number; s: number } {
  for (const c of channels) {
    const t = (a.y - c.yTop) / c.ySpan;
    if (t < 0.03 || t > Math.min(1, c.tEnd + 0.02)) continue;
    const tc = Math.min(c.tEnd, t);
    const xcv = c.xc(tc);
    const margin = c.hw(tc) + pad;
    if (Math.abs(a.x - xcv) < margin) {
      const side = a.x >= xcv ? 1 : -1;
      return { ...a, x: xcv + side * margin };
    }
  }
  return a;
}

/** Open polyline smoothed through vertex midpoints; endpoints exact. */
export function smoothOpen(pts: Array<[number, number]>): string {
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

function groundFeature(g: EarnedGround, light: SceneLight, p: string, chan?: StreamGeometry): ReactNode | null {
  const band = REGION_BANDS[g.region];
  if (!band) return null;
  const x0 = band[0] * 1000;
  const x1 = band[1] * 1000;
  const cx = (x0 + x1) / 2;
  const w = x1 - x0;
  const r = rng(`ground:${g.kind}:${g.region}`);
  switch (g.kind) {
    case "stream": {
      // Hybrid river — realist spine (sky-mirror water, curvature-driven cut
      // banks, point bars, riffles), impressionist light dabs, a watercolor
      // outer bleed, and an intentionally irregular riparian zone. Geometry
      // (confluences included) comes from the shared river system via `chan`;
      // draw counts are fixed regardless of light or course length.
      const geo = chan;
      if (!geo) return null;
      const gr = geo.r;
      const farWater = mix(mix(light.skyHorizon, light.skyMid, 0.5), "#5b7f8f", 0.15);
      const nearWater = mix(light.skyTop, "#2a4f5e", 0.45);
      const soil = mix("#443826", light.grassNear, 0.28);
      const N = 15;
      const yAt = (t: number): number => geo.yTop + t * geo.ySpan;
      const ts: number[] = [];
      for (let i = 0; i < N; i++) ts.push((i / (N - 1)) * geo.tEnd);
      const edges = (margin: (t: number) => number) => {
        const left: Array<[number, number]> = [];
        const right: Array<[number, number]> = [];
        for (const t of ts) {
          const hwv = geo.hw(t) + margin(t);
          left.push([geo.xc(t) - hwv, yAt(t)]);
          right.push([geo.xc(t) + hwv, yAt(t)]);
        }
        return { left, right };
      };
      const closedChannel = (left: Array<[number, number]>, right: Array<[number, number]>) => {
        let d = smoothOpen(left);
        d += ` L${n(right[N - 1]![0])},${n(right[N - 1]![1])}`;
        const rev = [...right].reverse();
        for (let i = 1; i < rev.length - 1; i++) {
          const mx = (rev[i]![0] + rev[i + 1]![0]) / 2;
          const my = (rev[i]![1] + rev[i + 1]![1]) / 2;
          d += ` Q${n(rev[i]![0])},${n(rev[i]![1])} ${n(mx)},${n(my)}`;
        }
        return `${d} L${n(right[0]![0])},${n(right[0]![1])} Z`;
      };
      const waterE = edges(() => 0);
      const waterPath = closedChannel(waterE.left, waterE.right);
      const bleedE = edges((t) => 2.5 + 6 * t);
      const bleedPath = closedChannel(bleedE.left, bleedE.right);

      // Curvature apexes: where the course bends hardest, banks tell the story.
      const midX = ts.map((t) => geo.xc(t));
      const apexes: Array<{ i: number; outer: 1 | -1 }> = [];
      const scored: Array<{ i: number; k: number }> = [];
      for (let i = 2; i < N - 2; i++) {
        if (ts[i]! < 0.22) continue;
        scored.push({ i, k: midX[i]! * 2 - midX[i - 1]! - midX[i + 1]! });
      }
      scored.sort((a, b) => Math.abs(b.k) - Math.abs(a.k));
      for (const s of scored) {
        if (apexes.length >= 2) break;
        if (apexes.some((a) => Math.abs(a.i - s.i) < 3)) continue;
        apexes.push({ i: s.i, outer: s.k > 0 ? 1 : -1 });
      }
      const bankArt: ReactNode[] = [];
      for (let a = 0; a < apexes.length; a++) {
        const { i, outer } = apexes[a]!;
        const t = ts[i]!;
        const span = [i - 2, i - 1, i, i + 1, i + 2].filter((j) => j >= 0 && j < N);
        const outerPts: Array<[number, number]> = span.map((j) => {
          const e = outer === 1 ? waterE.right[j]! : waterE.left[j]!;
          return [e[0] - outer * 0.4, e[1]];
        });
        const innerPts: Array<[number, number]> = span.map((j) => {
          const e = outer === 1 ? waterE.left[j]! : waterE.right[j]!;
          return [e[0], e[1]];
        });
        bankArt.push(
          <path
            key={`uc${a}`}
            d={smoothOpen(outerPts)}
            stroke={soil}
            strokeWidth={n(0.9 + 1.8 * t)}
            fill="none"
            strokeLinecap="round"
            opacity={0.55}
          />,
          <path
            key={`cl${a}`}
            d={smoothOpen(innerPts)}
            stroke={mix(light.grassNear, "#ffffff", 0.42)}
            strokeWidth={0.9}
            fill="none"
            strokeLinecap="round"
            opacity={0.5}
          />,
        );
        // Point bar: a sand crescent on the inside of the bend.
        const sand = mix("#cbb98a", light.grassNear, 0.35);
        const barPts: Array<[number, number]> = innerPts.map(([bx, by], k) => [
          bx - outer * Math.sin((k / (innerPts.length - 1)) * Math.PI) * (1.5 + 3.5 * t),
          by,
        ]);
        const barPath = `${smoothOpen(innerPts)} ${smoothOpen([...barPts].reverse()).replace(/^M/, "L")} Z`;
        bankArt.push(
          <path key={`pb${a}`} d={barPath} fill={sand} opacity={0.85} />,
          <path key={`pbe${a}`} d={smoothOpen(innerPts)} stroke={shade(sand, 0.82)} strokeWidth={0.6} fill="none" opacity={0.6} />,
        );
      }
      // Riffles: white ticks where the channel pinches.
      let r1i = 3;
      let r2i = N - 4;
      let best1 = Infinity;
      let best2 = Infinity;
      for (let i = 3; i < N - 2; i++) {
        const ratio = geo.hw(ts[i]!) / (0.6 + ts[i]!);
        if (ts[i]! < 0.5 && ratio < best1) {
          best1 = ratio;
          r1i = i;
        } else if (ts[i]! >= 0.5 && ratio < best2) {
          best2 = ratio;
          r2i = i;
        }
      }
      const riffles: ReactNode[] = [r1i, r2i].map((i, k) => {
        const t = ts[i]!;
        const wv = geo.hw(t) * 0.55;
        return (
          <path
            key={`rf${k}`}
            d={`M${n(geo.xc(t) - wv)},${n(yAt(t))} q${n(wv * 0.6)},${n(1 + t)} ${n(wv * 1.4)},0 M${n(geo.xc(t) - wv * 0.4)},${n(yAt(t) + 2.2)} q${n(wv * 0.5)},${n(0.8)} ${n(wv)},0`}
            stroke={mix(farWater, "#ffffff", 0.75)}
            strokeWidth={0.9}
            fill="none"
            strokeLinecap="round"
            opacity={n(0.3 + 0.45 * light.beamStrength)}
          />
        );
      });
      // Impressionist dabs: 26 stratified rows over the full course; near rows
      // carry a second dab. Row draw counts are fixed by row index.
      const skyLight = mix(farWater, "#ffffff", 0.5);
      const deepTone = shade(nearWater, 0.85);
      const greenTone = mix(nearWater, light.grassNear, 0.45);
      const glitterTone = light.sunX !== null ? mix("#ffffff", light.sunColor, 0.4) : skyLight;
      const dabs: ReactNode[] = [];
      for (let row = 0; row < 26; row++) {
        const tR = (row + 0.5) / 26;
        const perRow = row >= 13 ? 2 : 1;
        for (let dIdx = 0; dIdx < perRow; dIdx++) {
          const v = gr() * 2 - 1;
          const lenRoll = gr();
          const toneRoll = gr();
          if (tR > geo.tEnd - 0.01 || tR < 0.06) continue;
          const hwv = geo.hw(tR);
          if (hwv < 2.2) continue;
          const xd = geo.xc(tR) + v * hwv * 0.78;
          const len = (1.5 + 5.5 * tR) * (0.7 + 0.6 * lenRoll);
          const vAbs = Math.abs(v);
          const gx = geo.xc(tR) + (light.sunX !== null && light.sunX > geo.xc(tR) ? 1 : -1) * hwv * 0.28;
          const isGlitter = light.sunX !== null && Math.abs(xd - gx) < hwv * 0.3 && toneRoll < 0.5;
          const tone = isGlitter
            ? glitterTone
            : vAbs > 0.74
              ? greenTone
              : toneRoll < 0.32
                ? deepTone
                : skyLight;
          dabs.push(
            <path
              key={`d${row}-${dIdx}`}
              d={`M${n(xd - len / 2)},${n(yAt(tR))} h${n(len)}`}
              stroke={tone}
              strokeWidth={n(0.9 + 0.9 * tR)}
              strokeLinecap="round"
              opacity={n(isGlitter ? 0.45 + 0.3 * light.beamStrength : 0.38)}
            />,
          );
        }
      }
      // Riparian clumps: irregular by construction — seeded type, size, side
      // and deliberate gaps; extra growth gathers at the bend apexes.
      const clumps: ReactNode[] = [];
      for (let c = 0; c < 12; c++) {
        const tRoll = gr();
        const sideRoll = gr();
        const sizeRoll = gr();
        const typeRoll = gr();
        const jx = (gr() - 0.5) * 5;
        const gapRoll = gr();
        if (gapRoll < 0.2) continue; // gaps: meadow meets water directly
        let t = 0.1 + tRoll * 0.86;
        if (c < 4 && apexes.length > 0) {
          const ap = ts[apexes[c % apexes.length]!.i]!;
          t = t * 0.4 + ap * 0.6;
        }
        if (t > geo.tEnd - 0.02) t = geo.tEnd - 0.02 - tRoll * 0.1;
        if (t < 0.08) continue;
        const side = sideRoll < 0.5 ? -1 : 1;
        const size = 0.7 + sizeRoll * 0.9;
        const bx = geo.xc(t) + side * (geo.hw(t) + 1) + jx * 0.3;
        const by = yAt(t) + 1;
        const lush = shade(light.grassNear, 0.6 + 0.3 * sizeRoll);
        if (typeRoll < 0.42) {
          // tuft cluster
          const lean = -side * (2.5 + 3.5 * size);
          clumps.push(
            <path
              key={`c${c}`}
              d={`M${n(bx)},${n(by)} q${n(lean * 0.5)},${n(-4 * size)} ${n(lean)},${n(-6 * size)} M${n(bx + side * 2)},${n(by + 1)} q${n(lean * 0.4)},${n(-3 * size)} ${n(lean * 0.8)},${n(-4.6 * size)} M${n(bx - side * 1.5)},${n(by + 0.5)} q${n(lean * 0.3)},${n(-2.4 * size)} ${n(lean * 0.6)},${n(-3.6 * size)}`}
              stroke={lush}
              strokeWidth={n(1 + 0.7 * t)}
              fill="none"
              strokeLinecap="round"
              opacity={0.92}
            />,
          );
        } else if (typeRoll < 0.66) {
          // reeds with seed heads
          const rh = (7 + 6 * size) * (0.6 + 0.5 * t);
          clumps.push(
            <g key={`c${c}`} opacity={0.92}>
              <path
                d={`M${n(bx)},${n(by)} q${n(-side * 1.2)},${n(-rh * 0.7)} ${n(-side * 2.6)},${n(-rh)} M${n(bx + side * 2.2)},${n(by + 0.8)} q0.3,${n(-rh * 0.8)} ${n(-side * 0.5)},${n(-rh * 1.15)} M${n(bx + side * 4.2)},${n(by + 0.4)} q${n(side * 1.4)},${n(-rh * 0.55)} ${n(side * 3)},${n(-rh * 0.8)}`}
                stroke={shade(light.grassNear, 0.68)}
                strokeWidth={1.2}
                fill="none"
                strokeLinecap="round"
              />
              <ellipse cx={n(bx - side * 2.6)} cy={n(by - rh)} rx={0.9} ry={2.2} fill={shade("#9a8a5a", 0.95)} />
              <ellipse cx={n(bx + side * 1.7)} cy={n(by + 0.8 - rh * 1.15)} rx={0.8} ry={2} fill="#9a8a5a" />
            </g>,
          );
        } else if (typeRoll < 0.85) {
          // bank flowers
          clumps.push(
            <g key={`c${c}`} opacity={0.9}>
              <circle cx={n(bx + side * 3)} cy={n(by - 3.5 * size)} r={1.4} fill={light.meadowAccents[c % light.meadowAccents.length]!} />
              <circle cx={n(bx + side * 6)} cy={n(by - 2 * size)} r={1.1} fill={light.meadowAccents[(c + 1) % light.meadowAccents.length]!} />
            </g>,
          );
        } else {
          // waterline stones
          const sw = (1.6 + 2 * sizeRoll) * (0.5 + 0.6 * t);
          clumps.push(
            <g key={`c${c}`} opacity={0.85}>
              <ellipse cx={n(bx - side * 1)} cy={n(by)} rx={n(sw)} ry={n(sw * 0.55)} fill={mix("#8a8577", farWater, 0.2)} />
              <ellipse cx={n(bx + side * sw)} cy={n(by + 1)} rx={n(sw * 0.6)} ry={n(sw * 0.35)} fill={mix("#7c776a", farWater, 0.15)} />
            </g>,
          );
        }
      }
      return (
        <g key={`ground-${g.region}`} data-ground-kind="stream">
          <defs>
            <linearGradient
              id={`${p}-water-${g.region}`}
              x1="0"
              y1={n(geo.yTop)}
              x2="0"
              y2={n(geo.yTop + geo.ySpan)}
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0%" stopColor={farWater} stopOpacity={0} />
              <stop offset="7%" stopColor={farWater} stopOpacity={0.85} />
              <stop offset="100%" stopColor={nearWater} />
            </linearGradient>
            <clipPath id={`${p}-rclip-${g.region}`}>
              <path d={waterPath} />
            </clipPath>
          </defs>
          {/* watercolor bleed: moist ground haloing the channel */}
          <path d={bleedPath} fill={mix(shade(light.grassNear, 0.8), nearWater, 0.16)} opacity={0.38} />
          {/* wet seat */}
          <path d={waterPath} fill={shade(light.grassNear, 0.72)} opacity={0.32} transform="translate(0 1.5)" />
          {/* the mirror */}
          <path d={waterPath} fill={`url(#${p}-water-${g.region})`} opacity={0.96} />
          <g clipPath={`url(#${p}-rclip-${g.region})`}>
            {/* ridge reflection near the horizon, sky glare mid-course */}
            <rect x={0} y={n(geo.yTop + 3)} width={1000} height={34} fill={mix(light.hill, farWater, 0.5)} opacity={0.3} />
            <rect
              x={0}
              y={n(yAt(0.45))}
              width={1000}
              height={n(geo.ySpan * 0.16)}
              fill={mix(nearWater, "#ffffff", 0.4)}
              opacity={n(light.sunX !== null ? 0.14 + 0.14 * light.beamStrength : 0.07)}
            />
            {dabs}
            {riffles}
          </g>
          {bankArt}
          {clumps}
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
  // The river system (confluences included) is the single geometry truth for
  // rendering, scatter gating and plant displacement alike.
  const channels = riverSystemFor(grounds);
  const chanByRegion = new Map(channels.map((c) => [c.region, c]));
  const groundEls = grounds
    .map((g) => groundFeature(g, light, p, chanByRegion.get(g.region)))
    .filter(Boolean);
  const inWater = (x: number, y: number, margin = 2): boolean =>
    channels.some((c) => c.inChannel(x, y, margin));
  // Band 0's top edge dips at each river source so the valley mouth opens
  // through to the notched ridges behind (the "misty gap" is just layering).
  const band0Top = (): string => {
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= 50; i++) {
      const x = (i / 50) * 1000;
      let y = 290 - 7.5 * Math.pow(Math.sin((Math.PI * x) / 1000), 1.2);
      for (const c of channels) {
        const xs = c.xc(0);
        y += 16 * Math.exp(-Math.pow(Math.abs(x - xs) / 11, 1.5));
      }
      pts.push([x, y]);
    }
    return `${smoothOpen(pts)} L1000,560 L0,560 Z`;
  };
  const bands = BAND_CURVES.map((d, i) => {
    const t = i / (BAND_CURVES.length - 1);
    const fill = mix(light.grassFar, light.grassNear, t);
    return (
      <path key={`band${i}`} d={i === 0 ? band0Top() : d} fill={fill} data-band={i}
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
    // gate on base AND tip — tall blades below a channel otherwise lean
    // across the water
    if (inWater(x, y, 6) || inWater(x, y - h, 6)) continue;
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
    if (inWater(x, y, 4)) continue;
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
    if (inWater(x, 300 + 250 * d, 4) || inWater(x, 300 + 250 * d - h, 4)) continue;
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
      if (inWater(x, y, 12)) continue;
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
