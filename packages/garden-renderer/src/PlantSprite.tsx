import type { CSSProperties, ReactNode } from "react";
import type { GardenPlant } from "@rg/domain";
import type { Species } from "@rg/garden-engine";
import { rng, speciesOrThrow } from "@rg/garden-engine";
import { desaturate, mix, shade } from "./color";

/**
 * One plant, hand-drawn per archetype. Local coordinates: the stem base sits
 * at (0,0) and the plant grows upward (negative y). The scene positions and
 * depth-scales the sprite. All variation comes from rng(`sprite:${plant.id}`),
 * so the same plant id always renders byte-identically.
 */

const n = (x: number): number => Math.round(x * 100) / 100;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);
/** smoothstep — saplings keep tiny crowns until mid-maturity */
const smooth = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

type Rand = () => number;

interface Paint {
  /** foliage */ c1: string;
  /** wood / bloom */ c2: string;
  /** accent bloom */ c3: string;
  /** 0 none … 1 heavy droop */ droop: number;
  /** flowering state */ blooming: boolean;
  /** dormant: bare branches, brown tint */ bare: boolean;
}

interface Ctx {
  r: Rand;
  /** vary a base value ±pct (default ±15%) */
  v: (base: number, pct?: number) => number;
  m: number;
  P: Paint;
}

function paintFor(species: Species, plant: GardenPlant): Paint {
  const raw = {
    c1: species.palette.primary,
    c2: species.palette.secondary,
    c3: species.palette.accent ?? species.palette.secondary,
  };
  let adjust = (c: string) => c;
  let droop = 0;
  let bare = false;
  switch (plant.state) {
    case "thirsty":
      adjust = (c) => shade(desaturate(c, 0.3), 0.92);
      droop = 0.4;
      break;
    case "wilted":
      adjust = (c) => shade(desaturate(c, 0.55), 0.8);
      droop = 0.85;
      break;
    case "dormant":
      adjust = (c) => desaturate(mix(c, "#8a7455", 0.55), 0.4);
      bare = true;
      break;
    default:
      break;
  }
  return {
    c1: adjust(raw.c1),
    c2: adjust(raw.c2),
    c3: adjust(raw.c3),
    droop,
    blooming: plant.state === "flowering",
    bare,
  };
}

/* ── shared geometry ─────────────────────────────────────────────────────── */

function quadPt(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number) {
  const a = 1 - t;
  return { x: a * a * x0 + 2 * a * t * cx + t * t * x1, y: a * a * y0 + 2 * a * t * cy + t * t * y1 };
}

function quadAngle(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number) {
  const dx = 2 * (1 - t) * (cx - x0) + 2 * t * (x1 - cx);
  const dy = 2 * (1 - t) * (cy - y0) + 2 * t * (y1 - cy);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Tapered trunk from base (0,0) up to (lean,-h). */
function trunkPath(h: number, w: number, lean = 0): string {
  return [
    `M${n(-w)},0`,
    `C${n(-w * 0.75)},${n(-h * 0.4)} ${n(lean - w * 0.45)},${n(-h * 0.75)} ${n(lean - w * 0.32)},${n(-h)}`,
    `L${n(lean + w * 0.32)},${n(-h)}`,
    `C${n(lean + w * 0.45)},${n(-h * 0.75)} ${n(w * 0.75)},${n(-h * 0.4)} ${n(w)},0`,
    "Z",
  ].join(" ");
}

/** Bare branch strokes fanning from the trunk top — dormant trees and snags. */
function bareBranches(r: Rand, h: number, spread: number, color: string, count: number, broken: boolean): ReactNode {
  const limbs: ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const a = lerp(-spread, spread, t) + (r() * 10 - 5);
    const len = h * (broken ? 0.22 : 0.38) * (0.8 + r() * 0.4);
    const rad = ((a - 90) * Math.PI) / 180;
    const y0 = -h * (0.66 + 0.3 * r());
    const tipX = Math.cos(rad) * len;
    const tipY = y0 + Math.sin(rad) * len;
    limbs.push(
      <path
        key={`b${i}`}
        d={`M0,${n(y0)} Q${n(tipX * 0.45)},${n(y0 + (tipY - y0) * 0.35)} ${n(tipX)},${n(tipY)}`}
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />,
    );
  }
  return <g>{limbs}</g>;
}

/* ── tiny universal forms ────────────────────────────────────────────────── */

function sprout(P: Paint): ReactNode {
  return (
    <g>
      <path d="M0,0 C0.2,-2.4 0.1,-4.4 0.5,-6.2" stroke={P.c1} strokeWidth={1.2} fill="none" strokeLinecap="round" />
      <ellipse cx={-2.1} cy={-5.6} rx={2.4} ry={1.3} transform="rotate(-28 -2.1 -5.6)" fill={P.c1} />
      <ellipse cx={2.4} cy={-6.6} rx={2.6} ry={1.4} transform="rotate(24 2.4 -6.6)" fill={shade(P.c1, 1.12)} />
    </g>
  );
}

const DEAD_WOOD = "#857a6b";
const DEAD_WOOD_DARK = "#6b6156";
const DEAD_STALK = "#9a8b73";
const HABITAT_MOSS = "#7c9a66";
const HABITAT_CAP = "#c9a878";
const HABITAT_STEM = "#e6d9c2";

function habitatTufts(r: Rand, wide: number): ReactNode {
  const mx = (r() - 0.5) * wide;
  const mush = 1 + Math.floor(r() * 2);
  const shrooms: ReactNode[] = [];
  for (let i = 0; i < mush; i++) {
    const x = (r() - 0.5) * wide * 1.4;
    const h = 3 + r() * 3;
    shrooms.push(
      <g key={`hm${i}`} transform={`translate(${n(x)} 0)`}>
        <rect x={-0.8} y={n(-h)} width={1.6} height={n(h)} rx={0.6} fill={HABITAT_STEM} />
        <path d={`M${n(-h * 0.55)},${n(-h)} A${n(h * 0.55)},${n(h * 0.42)} 0 0 1 ${n(h * 0.55)},${n(-h)} Z`} fill={HABITAT_CAP} />
      </g>,
    );
  }
  return (
    <g>
      <path
        d={`M${n(mx - 5)},0 A5,3.2 0 0 1 ${n(mx + 5)},0 Z`}
        fill={desaturate(HABITAT_MOSS, 0.15)}
      />
      {shrooms}
    </g>
  );
}

/** Dead plants stay in the scene: snags for trees, dry stalks for the rest. */
function deadForm(species: Species, plant: GardenPlant, r: Rand, v: Ctx["v"]): ReactNode {
  const isTree = species.category === "tree";
  if (isTree) {
    const h = v(lerp(16, 78, plant.maturity));
    const w = v(lerp(1.6, 4.2, plant.maturity));
    return (
      <g>
        <path d={trunkPath(h, w, (r() - 0.5) * 6)} fill={DEAD_WOOD} stroke={DEAD_WOOD_DARK} strokeWidth={0.8} />
        {bareBranches(r, h, 55, DEAD_WOOD_DARK, 3, true)}
        <path d={`M${n(-w * 0.32)},${n(-h)} L0,${n(-h - 4)} L${n(w * 0.32)},${n(-h)}`} fill={DEAD_WOOD} />
        {plant.habitatRole ? habitatTufts(r, w * 4) : null}
      </g>
    );
  }
  const stalks = 2 + Math.floor(r() * 2);
  const parts: ReactNode[] = [];
  for (let i = 0; i < stalks; i++) {
    const h = v(lerp(5, 22, plant.maturity));
    const x = (i - (stalks - 1) / 2) * 3.4;
    const bend = (r() - 0.5) * 14 + 6;
    parts.push(
      <path
        key={`s${i}`}
        d={`M${n(x)},0 Q${n(x + bend * 0.4)},${n(-h * 0.7)} ${n(x + bend)},${n(-h * 0.86)}`}
        stroke={DEAD_STALK}
        strokeWidth={1.3}
        strokeLinecap="round"
        fill="none"
      />,
      <circle key={`h${i}`} cx={n(x + bend)} cy={n(-h * 0.86)} r={1.3} fill={shade(DEAD_STALK, 0.85)} />,
    );
  }
  return (
    <g>
      {parts}
      {plant.habitatRole ? habitatTufts(r, 8) : null}
    </g>
  );
}

/* ── archetypes ──────────────────────────────────────────────────────────── */

function treeRound({ r, v, m, P }: Ctx): ReactNode {
  const h = v(lerp(14, 88, m));
  const w = v(lerp(1.4, 4.4, m));
  const R = v(lerp(4, 36, smooth(m)));
  const cy = -h - R * 0.42 + P.droop * 5;
  const flat = 1 - P.droop * 0.16;
  return (
    <g>
      <path d={trunkPath(h, w)} fill={P.c2} />
      {P.bare ? (
        bareBranches(r, h, 50, shade(P.c2, 0.85), 4, false)
      ) : (
        <g>
          <ellipse cx={n(-R * 0.72)} cy={n(cy + R * 0.28)} rx={n(R * 0.7)} ry={n(R * 0.62 * flat)} fill={shade(P.c1, 0.9)} />
          <ellipse cx={n(R * 0.72)} cy={n(cy + R * 0.32)} rx={n(R * 0.66)} ry={n(R * 0.58 * flat)} fill={shade(P.c1, 0.95)} />
          <ellipse cx={0} cy={n(cy)} rx={n(R)} ry={n(R * 0.86 * flat)} fill={P.c1} />
          <ellipse cx={n(-R * 0.34)} cy={n(cy - R * 0.3)} rx={n(R * 0.5)} ry={n(R * 0.34)} fill={shade(P.c1, 1.14)} opacity={0.55} />
        </g>
      )}
    </g>
  );
}

/** birch: pale slim trunk with dark dashes and airy small-leaf clusters */
function treeBirch({ r, v, m, P }: Ctx): ReactNode {
  const h = v(lerp(16, 96, m));
  const w = v(lerp(1, 2.6, m));
  const dashes: ReactNode[] = [];
  for (let i = 0; i < 5; i++) {
    const y = -h * (0.12 + 0.16 * i) - r() * 4;
    const dx = (r() - 0.5) * w;
    dashes.push(
      <path key={`d${i}`} d={`M${n(dx - 1.4)},${n(y)} l2.6,-0.6`} stroke={P.c3} strokeWidth={1.1} strokeLinecap="round" />,
    );
  }
  const clusters: ReactNode[] = [];
  const count = 5 + Math.floor(r() * 3);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + r() * 0.8;
    const rad = v(13, 0.3);
    const cx = Math.cos(a) * rad;
    const cyC = -h - 6 - Math.abs(Math.sin(a)) * rad * 0.8 + P.droop * 4;
    clusters.push(
      <circle key={`c${i}`} cx={n(cx)} cy={n(cyC)} r={n(v(6.5, 0.3))} fill={i % 3 === 0 ? shade(P.c1, 1.12) : P.c1} opacity={0.88} />,
    );
  }
  return (
    <g>
      <path d={trunkPath(h, w, (r() - 0.5) * 4)} fill={P.c2} stroke={shade(P.c2, 0.82)} strokeWidth={0.6} />
      {dashes}
      <path d={`M0,${n(-h * 0.62)} Q${n(-9)},${n(-h * 0.78)} ${n(-13)},${n(-h * 0.94)}`} stroke={P.c2} strokeWidth={1.4} fill="none" />
      <path d={`M0,${n(-h * 0.5)} Q${n(8)},${n(-h * 0.66)} ${n(12)},${n(-h * 0.84)}`} stroke={P.c2} strokeWidth={1.4} fill="none" />
      {P.bare ? null : <g>{clusters}</g>}
    </g>
  );
}

/** weeping willow: fronds arcing down from the crown */
function treeWeeping({ r, v, m, P }: Ctx): ReactNode {
  const h = v(lerp(12, 66, m));
  const w = v(lerp(1.6, 4.6, m));
  const fronds: ReactNode[] = [];
  const count = 7 + Math.floor(r() * 3);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const sx = lerp(-1, 1, t) * v(lerp(4, 26, smooth(m)));
    const drop = v(lerp(8, 46, smooth(m))) + P.droop * 8;
    const outX = sx * 1.9 + (r() - 0.5) * 6;
    fronds.push(
      <path
        key={`f${i}`}
        d={`M0,${n(-h)} Q${n(sx * 1.5)},${n(-h - 8)} ${n(outX)},${n(-h + drop)}`}
        stroke={P.bare ? shade(P.c2, 0.9) : i % 2 === 0 ? P.c1 : shade(P.c1, 0.86)}
        strokeWidth={P.bare ? 1.1 : 2.3}
        strokeLinecap="round"
        fill="none"
      />,
    );
  }
  return (
    <g>
      <path d={trunkPath(h, w, (r() - 0.5) * 5)} fill={P.c2} />
      {P.bare ? null : <ellipse cx={0} cy={n(-h - 4)} rx={n(lerp(4, 15, smooth(m)))} ry={n(lerp(2.5, 8, smooth(m)))} fill={shade(P.c1, 1.06)} />}
      {fronds}
    </g>
  );
}

/** conifer: stacked triangles (kept even when dormant — just duller) */
function treeConifer({ r, v, m, P }: Ctx): ReactNode {
  const h = v(lerp(16, 92, m));
  const w = v(lerp(1.2, 3, m));
  const tiers = m > 0.65 ? 4 : 3;
  const shapes: ReactNode[] = [];
  for (let i = 0; i < tiers; i++) {
    const f = i / tiers;
    const baseY = -h * (0.22 + 0.72 * f);
    const topY = -h * (0.22 + 0.72 * (f + 1.25 / tiers));
    const half = v(lerp(5, 24, smooth(m)) * (1 - f * 0.62), 0.1) * (1 + P.droop * 0.08);
    shapes.push(
      <path
        key={`t${i}`}
        d={`M0,${n(topY)} L${n(-half)},${n(baseY)} Q0,${n(baseY - 2)} ${n(half)},${n(baseY)} Z`}
        fill={i % 2 === 0 ? P.c1 : shade(P.c1, 0.86)}
      />,
    );
  }
  return (
    <g>
      <path d={trunkPath(h * 0.4, w, (r() - 0.5) * 2)} fill={P.c2} />
      {shapes}
    </g>
  );
}

/** ginkgo: upright branches topped with fan-shaped leaf clusters */
function treeFan({ r, v, m, P }: Ctx): ReactNode {
  const h = v(lerp(14, 84, m));
  const w = v(lerp(1.2, 3.2, m));
  const fanSize = v(lerp(3, 11, smooth(m)));
  const items: ReactNode[] = [];
  const count = 4 + Math.floor(r() * 3);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const a = lerp(-52, 52, t) + (r() - 0.5) * 12;
    const rad = ((a - 90) * Math.PI) / 180;
    const y0 = -h * (0.55 + 0.4 * r());
    const len = h * 0.3 * (0.7 + r() * 0.5);
    const tx = Math.cos(rad) * len;
    const ty = y0 + Math.sin(rad) * len + P.droop * 4;
    items.push(
      <g key={`f${i}`}>
        <path d={`M0,${n(y0)} L${n(tx)},${n(ty)}`} stroke={P.c2} strokeWidth={1.4} strokeLinecap="round" />
        {P.bare ? null : (
          <path
            d={`M${n(tx)},${n(ty)} L${n(tx - fanSize)},${n(ty - fanSize * 1.15)} Q${n(tx)},${n(ty - fanSize * 1.7)} ${n(tx + fanSize)},${n(ty - fanSize * 1.15)} Z`}
            fill={i % 2 === 0 ? P.c1 : shade(P.c1, 1.1)}
          />
        )}
      </g>,
    );
  }
  return (
    <g>
      <path d={trunkPath(h, w)} fill={P.c2} />
      {items}
    </g>
  );
}

/** blossom tree: round clumps that show bloom dots while flowering */
function treeBlossom({ r, v, m, P }: Ctx): ReactNode {
  const h = v(lerp(14, 80, m));
  const w = v(lerp(1.4, 4, m));
  const R = v(lerp(4, 32, smooth(m)));
  const cy = -h - R * 0.4 + P.droop * 5;
  const dots: ReactNode[] = [];
  if (P.blooming) {
    const count = 11 + Math.floor(r() * 5);
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2;
      const rad = Math.sqrt(r()) * R * 0.92;
      dots.push(
        <circle
          key={`p${i}`}
          cx={n(Math.cos(a) * rad)}
          cy={n(cy + Math.sin(a) * rad * 0.75)}
          r={n(1.9 + r() * 1.5)}
          fill={i % 4 === 0 ? shade(P.c3, 1.1) : P.c3}
        />,
      );
    }
  }
  return (
    <g>
      <path d={trunkPath(h, w, (r() - 0.5) * 5)} fill={P.c2} />
      <path d={`M0,${n(-h * 0.7)} Q${n(-8)},${n(-h * 0.9)} ${n(-R * 0.6)},${n(cy + R * 0.4)}`} stroke={P.c2} strokeWidth={1.6} fill="none" />
      {P.bare ? (
        bareBranches(r, h, 55, shade(P.c2, 0.88), 4, false)
      ) : (
        <g>
          <ellipse cx={n(-R * 0.6)} cy={n(cy + R * 0.24)} rx={n(R * 0.62)} ry={n(R * 0.52)} fill={shade(P.c1, 0.92)} />
          <ellipse cx={n(R * 0.62)} cy={n(cy + R * 0.28)} rx={n(R * 0.58)} ry={n(R * 0.5)} fill={shade(P.c1, 0.96)} />
          <ellipse cx={0} cy={n(cy)} rx={n(R * 0.94)} ry={n(R * 0.78)} fill={P.c1} />
          {dots}
        </g>
      )}
    </g>
  );
}

/** poppy/tulip: single stem, cup-shaped bloom that hangs when thirsty */
function flowerCup({ v, m, P }: Ctx): ReactNode {
  const s = v(lerp(6, 34, m));
  const cup = v(5.2, 0.12) * lerp(0.6, 1, m);
  const head = m >= 0.5;
  return (
    <g>
      <path d={`M0,0 C${n(-1.2)},${n(-s * 0.4)} ${n(1)},${n(-s * 0.7)} 0,${n(-s)}`} stroke={P.c1} strokeWidth={1.6} fill="none" />
      <ellipse cx={-3.4} cy={n(-s * 0.34)} rx={3.6} ry={1.4} transform={`rotate(${n(-38 - P.droop * 22)} -3.4 ${n(-s * 0.34)})`} fill={P.c1} />
      <ellipse cx={3.4} cy={n(-s * 0.46)} rx={3.4} ry={1.3} transform={`rotate(${n(36 + P.droop * 22)} 3.4 ${n(-s * 0.46)})`} fill={shade(P.c1, 1.1)} />
      {head ? (
        <g transform={`translate(0 ${n(-s)}) rotate(${n(P.droop * 42)})`}>
          {P.blooming ? (
            <g>
              <path d={`M${n(-cup)},0 C${n(-cup * 1.15)},${n(-cup * 1.7)} ${n(cup * 1.15)},${n(-cup * 1.7)} ${n(cup)},0 Z`} fill={P.c2} />
              <path d={`M${n(-cup * 0.55)},${n(-cup * 0.2)} C${n(-cup * 0.5)},${n(-cup * 1.9)} ${n(cup * 0.5)},${n(-cup * 1.9)} ${n(cup * 0.55)},${n(-cup * 0.2)}`} fill={shade(P.c2, 1.12)} />
              <circle cx={0} cy={-1} r={1.5} fill={P.c3} />
            </g>
          ) : (
            <ellipse cx={0} cy={n(-cup * 0.6)} rx={n(cup * 0.55)} ry={n(cup * 0.85)} fill={shade(P.c2, 0.78)} />
          )}
        </g>
      ) : null}
    </g>
  );
}

/** aster/coneflower/cosmos: radial petals around a bright center */
function flowerDaisy({ r, v, m, P }: Ctx): ReactNode {
  const s = v(lerp(6, 32, m));
  const petals = 7 + Math.floor(r() * 4);
  const plen = v(4.6, 0.15) * lerp(0.55, 1, m);
  const ring: ReactNode[] = [];
  if (P.blooming) {
    for (let i = 0; i < petals; i++) {
      const a = (i * 360) / petals + r() * 6;
      ring.push(
        <ellipse
          key={`p${i}`}
          cx={0}
          cy={n(-plen * 0.72)}
          rx={1.7}
          ry={n(plen * 0.72)}
          transform={`rotate(${n(a)})`}
          fill={i % 2 === 0 ? P.c2 : shade(P.c2, 1.08)}
        />,
      );
    }
  }
  return (
    <g>
      <path d={`M0,0 C${n(1.1)},${n(-s * 0.45)} ${n(-0.8)},${n(-s * 0.7)} 0,${n(-s)}`} stroke={P.c1} strokeWidth={1.5} fill="none" />
      <ellipse cx={-3.2} cy={n(-s * 0.3)} rx={3.2} ry={1.2} transform={`rotate(${n(-34 - P.droop * 24)} -3.2 ${n(-s * 0.3)})`} fill={P.c1} />
      <ellipse cx={3} cy={n(-s * 0.5)} rx={3} ry={1.2} transform={`rotate(${n(30 + P.droop * 24)} 3 ${n(-s * 0.5)})`} fill={shade(P.c1, 0.9)} />
      <g transform={`translate(0 ${n(-s)}) rotate(${n(P.droop * 38)})`}>
        {ring}
        <circle cx={0} cy={0} r={m >= 0.5 ? 2.6 : 1.4} fill={P.blooming ? P.c3 : shade(P.c2, 0.72)} />
      </g>
    </g>
  );
}

/** iris: sword leaves + upright petals with two falls */
function flowerSpike({ r, v, m, P }: Ctx): ReactNode {
  const s = v(lerp(7, 36, m));
  const swords: ReactNode[] = [];
  const count = 3 + Math.floor(r() * 2);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const a = lerp(-26, 26, t) + (r() - 0.5) * 8 + P.droop * lerp(-14, 14, t);
    const lh = s * (0.5 + r() * 0.3);
    swords.push(
      <path
        key={`l${i}`}
        d={`M-1.4,0 L0,${n(-lh)} L1.4,0 Z`}
        transform={`rotate(${n(a)})`}
        fill={i % 2 === 0 ? P.c1 : shade(P.c1, 0.88)}
      />,
    );
  }
  return (
    <g>
      {swords}
      <path d={`M0,0 L0,${n(-s)}`} stroke={shade(P.c1, 0.92)} strokeWidth={1.5} />
      {m >= 0.5 ? (
        <g transform={`translate(0 ${n(-s)}) rotate(${n(P.droop * 30)})`}>
          {P.blooming ? (
            <g>
              <ellipse cx={0} cy={-4.4} rx={2} ry={4.6} fill={P.c2} />
              <ellipse cx={-2.6} cy={-3.4} rx={1.7} ry={3.8} transform="rotate(-18 -2.6 -3.4)" fill={shade(P.c2, 1.08)} />
              <ellipse cx={2.6} cy={-3.4} rx={1.7} ry={3.8} transform="rotate(18 2.6 -3.4)" fill={shade(P.c2, 1.08)} />
              <path d="M-1.2,-0.5 Q-4.6,1.4 -5.2,4" stroke={shade(P.c2, 0.85)} strokeWidth={2} strokeLinecap="round" fill="none" />
              <path d="M1.2,-0.5 Q4.6,1.4 5.2,4" stroke={shade(P.c2, 0.85)} strokeWidth={2} strokeLinecap="round" fill="none" />
            </g>
          ) : (
            <ellipse cx={0} cy={-2.6} rx={1.6} ry={3} fill={shade(mix(P.c1, P.c2, 0.4), 0.85)} />
          )}
        </g>
      ) : null}
    </g>
  );
}

/** dahlia / wildflower mix: fanned stems each topped by a small bloom */
function flowerCluster({ r, v, m, P }: Ctx): ReactNode {
  const stems = 3 + Math.floor(r() * 3);
  const items: ReactNode[] = [];
  for (let i = 0; i < stems; i++) {
    const t = stems === 1 ? 0.5 : i / (stems - 1);
    const a = lerp(-30, 30, t) + (r() - 0.5) * 10;
    const s = v(lerp(5, 26, m), 0.2);
    const rad = ((a - 90) * Math.PI) / 180;
    const tx = Math.cos(rad) * s + P.droop * lerp(-4, 4, t);
    const ty = Math.sin(rad) * s + P.droop * 4;
    const bloom = i % 2 === 0 ? P.c2 : P.c3;
    items.push(
      <g key={`s${i}`}>
        <path d={`M0,0 Q${n(tx * 0.4)},${n(ty * 0.6)} ${n(tx)},${n(ty)}`} stroke={P.c1} strokeWidth={1.3} fill="none" />
        {P.blooming ? (
          <g>
            <circle cx={n(tx)} cy={n(ty)} r={n(v(3.1, 0.18))} fill={bloom} />
            <circle cx={n(tx)} cy={n(ty)} r={1.1} fill={shade(bloom, 0.72)} />
          </g>
        ) : (
          <circle cx={n(tx)} cy={n(ty)} r={1.4} fill={m >= 0.5 ? shade(bloom, 0.7) : P.c1} />
        )}
      </g>,
    );
  }
  return (
    <g>
      <ellipse cx={-2.6} cy={-1.6} rx={3.4} ry={1.4} transform="rotate(-24 -2.6 -1.6)" fill={P.c1} />
      <ellipse cx={2.8} cy={-1.8} rx={3.4} ry={1.4} transform="rotate(22 2.8 -1.8)" fill={shade(P.c1, 0.9)} />
      {items}
    </g>
  );
}

/** fern: arcing fronds with leaflets sampled along each curve */
function fern({ r, v, m, P }: Ctx): ReactNode {
  const fronds = 4 + Math.floor(r() * 3);
  const items: ReactNode[] = [];
  for (let i = 0; i < fronds; i++) {
    const t = fronds === 1 ? 0.5 : i / (fronds - 1);
    const a = lerp(-64, 64, t) + (r() - 0.5) * 10;
    const len = v(lerp(6, 30, m), 0.2);
    const rad = ((a - 90) * Math.PI) / 180;
    const tipX = Math.cos(rad) * len;
    const tipY = Math.sin(rad) * len + P.droop * len * 0.45;
    const cx = tipX * 0.35;
    const cy = tipY * 0.7 - len * 0.28;
    const col = i % 2 === 0 ? P.c1 : shade(P.c1, 0.88);
    const leaflets: ReactNode[] = [];
    for (let k = 0; k < 5; k++) {
      const tt = 0.32 + k * 0.16;
      const pt = quadPt(0, 0, cx, cy, tipX, tipY, tt);
      const ang = quadAngle(0, 0, cx, cy, tipX, tipY, tt);
      const lr = (1 - tt) * len * 0.16 + 1.2;
      leaflets.push(
        <ellipse key={`lf${k}`} cx={n(pt.x)} cy={n(pt.y)} rx={n(lr)} ry={1} transform={`rotate(${n(ang + (k % 2 === 0 ? -34 : 34))} ${n(pt.x)} ${n(pt.y)})`} fill={col} />,
      );
    }
    items.push(
      <g key={`f${i}`}>
        <path d={`M0,0 Q${n(cx)},${n(cy)} ${n(tipX)},${n(tipY)}`} stroke={P.c2} strokeWidth={1} fill="none" />
        {leaflets}
      </g>,
    );
  }
  return <g>{items}</g>;
}

/** hosta: broad overlapping leaves fanned from the crown */
function hosta({ r, v, m, P }: Ctx): ReactNode {
  const leaves = 7 + Math.floor(r() * 3);
  const items: ReactNode[] = [];
  for (let i = 0; i < leaves; i++) {
    const t = leaves === 1 ? 0.5 : i / (leaves - 1);
    const a = lerp(-72, 72, t) + (r() - 0.5) * 10;
    const droopA = a * (1 + P.droop * 0.4) + P.droop * lerp(-8, 8, t);
    const len = v(lerp(4, 15, m), 0.18);
    items.push(
      <ellipse
        key={`l${i}`}
        cx={0}
        cy={n(-len * 0.62)}
        rx={n(len * 0.34)}
        ry={n(len * 0.62)}
        transform={`rotate(${n(droopA)})`}
        fill={i % 2 === 0 ? P.c1 : P.c2}
        stroke={shade(P.c1, 0.72)}
        strokeWidth={0.7}
      />,
    );
  }
  return <g>{items}</g>;
}

/** grass tuft: fanned arcing blades */
function grassTuft({ r, v, m, P }: Ctx): ReactNode {
  const blades = 7 + Math.floor(r() * 4);
  const items: ReactNode[] = [];
  for (let i = 0; i < blades; i++) {
    const t = blades === 1 ? 0.5 : i / (blades - 1);
    const bx = lerp(-3.5, 3.5, t);
    const h = v(lerp(4, 24, m), 0.22);
    const bend = lerp(-8, 8, t) + (r() - 0.5) * 5 + P.droop * lerp(-6, 6, t);
    items.push(
      <path
        key={`b${i}`}
        d={`M${n(bx)},0 Q${n(bx + bend * 0.35)},${n(-h * 0.75)} ${n(bx + bend)},${n(-h + P.droop * h * 0.3)}`}
        stroke={i % 2 === 0 ? P.c1 : P.c2}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />,
    );
  }
  return <g>{items}</g>;
}

/** vine: winding stem climbing its host, leaf pairs, small blooms when flowering */
function vine({ r, v, m, P }: Ctx): ReactNode {
  const h = v(lerp(8, 100, m));
  const segs = 4;
  const pts: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  let d = `M0,0`;
  for (let i = 1; i <= segs; i++) {
    const y = (-h * i) / segs;
    const x = (i % 2 === 0 ? -1 : 1) * v(6, 0.3) * (1 - i / (segs + 3));
    const prev = pts[i - 1]!;
    d += ` Q${n(prev.x + (x - prev.x) * 1.4)},${n((prev.y + y) / 2)} ${n(x)},${n(y)}`;
    pts.push({ x, y });
  }
  const leaves: ReactNode[] = [];
  for (let i = 1; i <= segs; i++) {
    const p = pts[i]!;
    const size = v(3.2, 0.2);
    leaves.push(
      <ellipse key={`la${i}`} cx={n(p.x - size)} cy={n(p.y + 1)} rx={n(size)} ry={n(size * 0.5)} transform={`rotate(${n(-30 - P.droop * 24)} ${n(p.x - size)} ${n(p.y + 1)})`} fill={i % 2 === 0 ? P.c1 : shade(P.c1, 0.88)} />,
      <ellipse key={`lb${i}`} cx={n(p.x + size)} cy={n(p.y + 2)} rx={n(size * 0.9)} ry={n(size * 0.45)} transform={`rotate(${n(28 + P.droop * 24)} ${n(p.x + size)} ${n(p.y + 2)})`} fill={shade(P.c1, 1.08)} />,
    );
    if (P.blooming && i >= 2) {
      leaves.push(<circle key={`fl${i}`} cx={n(p.x + (r() - 0.5) * 5)} cy={n(p.y - 2)} r={1.7} fill={P.c2} />);
    }
  }
  return (
    <g>
      <path d={d} stroke={shade(P.c1, 0.78)} strokeWidth={1.8} fill="none" strokeLinecap="round" />
      {leaves}
    </g>
  );
}

/** groundcover: a low spread of small leaves with occasional flower dots */
function groundcoverPatch({ r, v, m, P }: Ctx): ReactNode {
  const w = v(lerp(6, 22, m));
  const leaves = 9 + Math.floor(r() * 4);
  const items: ReactNode[] = [];
  for (let i = 0; i < leaves; i++) {
    const x = (r() * 2 - 1) * w;
    const y = -1 - r() * 3.6;
    items.push(
      <ellipse key={`l${i}`} cx={n(x)} cy={n(y)} rx={n(2 + r() * 1.4)} ry={n(1.1 + r() * 0.7)} transform={`rotate(${n((r() - 0.5) * 50)} ${n(x)} ${n(y)})`} fill={i % 3 === 0 ? shade(P.c1, 1.12) : P.c1} />,
    );
  }
  const dots: ReactNode[] = [];
  const dotCount = P.blooming ? 5 : m > 0.7 ? 2 : 0;
  for (let i = 0; i < dotCount; i++) {
    dots.push(<circle key={`d${i}`} cx={n((r() * 2 - 1) * w * 0.8)} cy={n(-2.5 - r() * 2.5)} r={1.3} fill={P.blooming ? P.c2 : mix(P.c1, P.c2, 0.55)} />);
  }
  return (
    <g>
      {items}
      {dots}
    </g>
  );
}

/** moss: low rounded lumps */
function moss({ r, v, m, P }: Ctx): ReactNode {
  const lumps = 3 + Math.floor(r() * 2);
  const items: ReactNode[] = [];
  for (let i = 0; i < lumps; i++) {
    const t = lumps === 1 ? 0.5 : i / (lumps - 1);
    const x = lerp(-1, 1, t) * v(lerp(3, 9, m));
    const rw = v(lerp(3, 8, m), 0.2);
    const rh = rw * (0.55 + r() * 0.15);
    items.push(
      <path key={`m${i}`} d={`M${n(x - rw)},0 A${n(rw)},${n(rh)} 0 0 1 ${n(x + rw)},0 Z`} fill={i % 2 === 0 ? P.c1 : P.c2} />,
    );
  }
  return <g>{items}</g>;
}

/** mushrooms: pale stems, domed caps, spots on the largest */
function mushroom({ r, v, m, P }: Ctx): ReactNode {
  const count = 2 + Math.floor(r() * 2);
  const items: ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = lerp(-1, 1, t) * v(lerp(2, 7, m));
    const h = v(lerp(3, 9, m), 0.25) * (i === 0 ? 1.15 : 0.85);
    const cw = h * 0.78;
    items.push(
      <g key={`u${i}`} transform={`translate(${n(x)} 0)`}>
        <rect x={n(-h * 0.14)} y={n(-h)} width={n(h * 0.28)} height={n(h)} rx={n(h * 0.1)} fill={P.c2} />
        <path d={`M${n(-cw)},${n(-h)} A${n(cw)},${n(cw * 0.72)} 0 0 1 ${n(cw)},${n(-h)} Z`} fill={i % 2 === 0 ? P.c1 : shade(P.c1, 0.9)} />
        <path d={`M${n(-cw)},${n(-h)} L${n(cw)},${n(-h)}`} stroke={shade(P.c1, 0.7)} strokeWidth={0.7} />
        {i === 0 ? (
          <g>
            <circle cx={n(-cw * 0.35)} cy={n(-h - cw * 0.32)} r={0.9} fill={shade(P.c2, 1.06)} />
            <circle cx={n(cw * 0.3)} cy={n(-h - cw * 0.42)} r={0.75} fill={shade(P.c2, 1.06)} />
          </g>
        ) : null}
      </g>,
    );
  }
  return <g>{items}</g>;
}

/** shelf fungus: stacked half-discs on a stub of host wood */
function shelfFungus({ r, v, m, P }: Ctx): ReactNode {
  const h = v(lerp(6, 15, m));
  const shelves = 3 + Math.floor(r() * 2);
  const items: ReactNode[] = [];
  for (let i = 0; i < shelves; i++) {
    const y = -h * (0.25 + (0.65 * i) / Math.max(1, shelves - 1));
    const side = i % 2 === 0 ? 1 : -1;
    const rw = v(lerp(3, 8, m), 0.2) * (1 - i * 0.12);
    const sweep = side === 1 ? 1 : 0;
    items.push(
      <g key={`s${i}`}>
        <path d={`M0,${n(y - 2)} A${n(rw)},${n(rw * 0.55)} 0 0 ${sweep} 0,${n(y + 2.4)} Z`} fill={i % 2 === 0 ? P.c1 : shade(P.c1, 1.08)} />
        <path d={`M0,${n(y + 2.4)} A${n(rw)},${n(rw * 0.2)} 0 0 ${sweep === 1 ? 0 : 1} 0,${n(y + 1.2)}`} stroke={P.c2} strokeWidth={0.8} fill="none" />
      </g>,
    );
  }
  return (
    <g>
      <rect x={-1.6} y={n(-h)} width={3.2} height={n(h)} rx={1.1} fill={mix(P.c2, "#5f5548", 0.55)} />
      {items}
    </g>
  );
}

/** round shrub: leafy mass on short stems, bloom dots while flowering */
function shrubRound({ r, v, m, P }: Ctx): ReactNode {
  const R = v(lerp(4, 19, smooth(m)));
  const cy = -R * 0.9 + P.droop * 3;
  const flat = 1 - P.droop * 0.18;
  const dots: ReactNode[] = [];
  if (P.blooming) {
    const count = 6 + Math.floor(r() * 4);
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2;
      const rad = Math.sqrt(r()) * R * 0.85;
      dots.push(
        <circle key={`d${i}`} cx={n(Math.cos(a) * rad)} cy={n(cy + Math.sin(a) * rad * 0.7)} r={n(1.8 + r() * 1.2)} fill={i % 3 === 0 ? shade(P.c2, 1.1) : P.c2} />,
      );
    }
  }
  return (
    <g>
      <path d={`M-2.5,0 L${n(-R * 0.3)},${n(cy * 0.6)}`} stroke={shade(P.c1, 0.6)} strokeWidth={1.3} />
      <path d={`M2.5,0 L${n(R * 0.3)},${n(cy * 0.6)}`} stroke={shade(P.c1, 0.6)} strokeWidth={1.3} />
      <ellipse cx={n(-R * 0.5)} cy={n(cy + R * 0.18)} rx={n(R * 0.62)} ry={n(R * 0.5 * flat)} fill={shade(P.c1, 0.9)} />
      <ellipse cx={n(R * 0.52)} cy={n(cy + R * 0.2)} rx={n(R * 0.6)} ry={n(R * 0.48 * flat)} fill={shade(P.c1, 0.95)} />
      <ellipse cx={0} cy={n(cy)} rx={n(R * 0.85)} ry={n(R * 0.66 * flat)} fill={P.c1} />
      <ellipse cx={n(-R * 0.28)} cy={n(cy - R * 0.24)} rx={n(R * 0.4)} ry={n(R * 0.24)} fill={shade(P.c1, 1.13)} opacity={0.6} />
      {dots}
    </g>
  );
}

/** lavender: leafy base, thin stems topped by small purple spikes */
function shrubSpike({ r, v, m, P }: Ctx): ReactNode {
  const stems = 7 + Math.floor(r() * 4);
  const items: ReactNode[] = [];
  for (let i = 0; i < stems; i++) {
    const t = stems === 1 ? 0.5 : i / (stems - 1);
    const bx = lerp(-5, 5, t);
    const h = v(lerp(5, 24, m), 0.18);
    const bend = (r() - 0.5) * 4 + P.droop * lerp(-5, 5, t);
    const tipX = bx + bend;
    const tipY = -h + P.droop * h * 0.2;
    items.push(
      <g key={`s${i}`}>
        <path d={`M${n(bx)},0 Q${n(bx + bend * 0.4)},${n(-h * 0.6)} ${n(tipX)},${n(tipY)}`} stroke={shade(P.c1, 0.94)} strokeWidth={1} fill="none" />
        {P.blooming ? (
          <g>
            <circle cx={n(tipX)} cy={n(tipY)} r={1.3} fill={P.c2} />
            <circle cx={n(tipX)} cy={n(tipY - 2.1)} r={1.15} fill={shade(P.c2, 1.08)} />
            <circle cx={n(tipX)} cy={n(tipY - 4)} r={0.95} fill={shade(P.c2, 1.16)} />
          </g>
        ) : (
          <circle cx={n(tipX)} cy={n(tipY)} r={0.9} fill={m >= 0.5 ? shade(mix(P.c1, P.c2, 0.5), 0.85) : P.c1} />
        )}
      </g>,
    );
  }
  return (
    <g>
      <ellipse cx={0} cy={-1.6} rx={6} ry={2.2} fill={shade(P.c1, 0.86)} />
      {items}
    </g>
  );
}

const ARCHETYPES: Record<Species["archetype"], (ctx: Ctx) => ReactNode> = {
  tree_round: treeRound,
  tree_birch: treeBirch,
  tree_weeping: treeWeeping,
  tree_conifer: treeConifer,
  tree_fan: treeFan,
  tree_blossom: treeBlossom,
  flower_cup: flowerCup,
  flower_daisy: flowerDaisy,
  flower_spike: flowerSpike,
  flower_cluster: flowerCluster,
  fern,
  hosta,
  grass_tuft: grassTuft,
  vine,
  groundcover_patch: groundcoverPatch,
  moss,
  mushroom,
  shelf_fungus: shelfFungus,
  shrub_round: shrubRound,
  shrub_spike: shrubSpike,
};

/** Ground-hugging archetypes do not sway. */
const NO_SWAY = new Set<Species["archetype"]>(["moss", "mushroom", "shelf_fungus", "groundcover_patch"]);

export interface PlantSpriteProps {
  plant: GardenPlant;
  /** Optional pre-resolved species (avoids a lookup); must match plant.speciesId. */
  species?: Species;
  /** When true, foliage gets the scene's sway animation class. */
  animate?: boolean;
  /** Must match the GardenScene idPrefix so animation class names line up. */
  idPrefix?: string;
}

export function PlantSprite({ plant, species, animate = false, idPrefix = "rg-garden" }: PlantSpriteProps) {
  const sp = species ?? speciesOrThrow(plant.speciesId);
  const r = rng(`sprite:${plant.id}`);
  const v: Ctx["v"] = (base, pct = 0.15) => base * (1 + (r() * 2 - 1) * pct);

  // Consume sway timing first so archetype geometry is stable either way.
  const swayDuration = `${n(6 + r() * 3)}s`;
  const swayDelay = `-${n(r() * 6)}s`;

  let art: ReactNode;
  let sways = false;
  if (plant.state === "seed") {
    art = sprout(paintFor(sp, plant));
  } else if (plant.state === "dead") {
    art = deadForm(sp, plant, r, v);
  } else {
    const ctx: Ctx = { r, v, m: clamp01(plant.maturity), P: paintFor(sp, plant) };
    art = ARCHETYPES[sp.archetype](ctx);
    sways = !NO_SWAY.has(sp.archetype);
  }

  const swayClass = animate && sways ? `${idPrefix}-sway` : undefined;
  const swayStyle: CSSProperties | undefined =
    animate && sways ? { animationDuration: swayDuration, animationDelay: swayDelay } : undefined;

  return (
    <g data-archetype={sp.archetype}>
      <g className={swayClass} style={swayStyle}>
        {art}
      </g>
    </g>
  );
}
