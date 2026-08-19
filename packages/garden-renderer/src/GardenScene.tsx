import type { CSSProperties, ReactNode } from "react";
import type { GardenPlant } from "@rg/domain";
import type { GardenSnapshot } from "@rg/garden-engine";
import { rng, speciesOrThrow } from "@rg/garden-engine";
import { AtmosphereLayer } from "./AtmosphereLayer";
import type { SceneImpulse } from "./particles";
import { mix, shade } from "./color";
import type { LightHint } from "./organic";
import { describeGarden, plantStateLabel } from "./describe";
import { lightingFor, moonPhase } from "./lighting";
import { Finish, Rainbow, WeatherOverlay } from "./overlays";
import { PlantSprite } from "./PlantSprite";
import { SceneDefs, Sky } from "./sky";
import { displaceFromStreams, FramingGrass, riverSystemFor, smoothOpen, Terrain, type StreamGeometry } from "./terrain";

/** Anchor lookup threaded to wildlife/visitors so perches track both the
 *  hero-tree boost and stream displacement. */
type PlantAnchor = (pl: GardenPlant) => { x: number; y: number; s: number };

/**
 * Ridge silhouettes as pure harmonic functions (tuned to the previous fixed
 * cubics) so river sources can carve V-shaped valley notches into them. The
 * notches align across all three layers with growing depth, so looking into a
 * valley reveals the hazier ridge behind — the misty gap needs no extra art.
 */
const RIDGE_FNS = {
  far: (x: number) => 262 + 18 * Math.sin((x / 1000) * Math.PI * 1.9 + 0.4) + 8 * Math.sin((x / 1000) * Math.PI * 4.3 + 1.1),
  mid: (x: number) => 276 + 14 * Math.sin((x / 1000) * Math.PI * 1.6 + 2.2) + 6 * Math.sin((x / 1000) * Math.PI * 3.7 + 0.4),
  near: (x: number) => 286 + 9 * Math.sin((x / 1000) * Math.PI * 1.3 + 4.4) + 4 * Math.sin((x / 1000) * Math.PI * 3.1 + 2.0),
} as const;

const RIDGE_NOTCH = {
  far: { depth: 15, sigma: 30 },
  mid: { depth: 19, sigma: 23 },
  near: { depth: 24, sigma: 16 },
} as const;

function ridgeTop(kind: keyof typeof RIDGE_FNS, sources: number[]): Array<[number, number]> {
  const { depth, sigma } = RIDGE_NOTCH[kind];
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 50; i++) {
    const x = (i / 50) * 1000;
    let y = RIDGE_FNS[kind](x);
    for (const xs of sources) {
      y += depth * Math.exp(-Math.pow(Math.abs(x - xs) / sigma, 1.3));
    }
    pts.push([x, y]);
  }
  return pts;
}

function ridgePath(kind: keyof typeof RIDGE_FNS, sources: number[], closeY: number): string {
  return `${smoothOpen(ridgeTop(kind, sources))} L1000,${closeY} L0,${closeY} Z`;
}

/**
 * The full scene: sky → hills → ground → plants (far to near) → weather →
 * wildlife. Fully deterministic — every jitter comes from rng() with stable
 * keys — so the same snapshot always renders byte-identical markup.
 */

const n = (x: number): number => Math.round(x * 100) / 100;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Depth mapping: position.y 0 (far) → scene y 290, 1 (near) → 540. */
const GROUND_TOP = 290;
const GROUND_SPAN = 250;
const smooth01 = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};
/**
 * Hero scale: mature trees in the nearer rows outgrow the flat depth curve so
 * a full-grown oak can anchor the composition the way the approved mock's did.
 * Wildlife perches and canopy pools read through this same anchor, so they
 * track the boost automatically. Exported for tests.
 */
export function anchorOf(plant: GardenPlant): { x: number; y: number; s: number } {
  const heroBoost =
    plant.category === "tree" && plant.state !== "dead"
      ? 1 + smooth01(plant.maturity) * (0.35 + 0.6 * plant.position.y)
      : 1;
  return {
    x: plant.position.x * 1000,
    y: GROUND_TOP + plant.position.y * GROUND_SPAN,
    s: (0.65 + 0.45 * plant.position.y) * heroBoost,
  };
}

/** Approximate sprite heights per category, for the invisible tap pads. */
const PAD_H: Record<string, number> = {
  tree: 96,
  shrub: 44,
  flower: 36,
  fern: 26,
  vine: 58,
  grass: 24,
  groundcover: 12,
  fungus: 14,
};

/** Shadow footprint follows the sprite's own growth curve (see PlantSprite's smooth(m))
 *  instead of the species' full-grown planting spacing. */
function shadowGrowthScale(plant: GardenPlant): number {
  if (plant.state === "seed") return 0.2;
  const m = clamp01(plant.maturity);
  const smooth = m * m * (3 - 2 * m);
  return 0.2 + 0.8 * smooth;
}

function sceneCss(p: string, amp: number): string {
  return `
.${p}-sway{transform-box:fill-box;transform-origin:50% 100%;animation:${p}-sway 7s ease-in-out infinite alternate;}
@keyframes ${p}-sway{from{transform:rotate(-${amp}deg)}to{transform:rotate(${amp}deg)}}
.${p}-rain{animation:${p}-rainfall 0.9s linear infinite;}
@keyframes ${p}-rainfall{from{transform:translateY(0)}to{transform:translateY(560px)}}
.${p}-cloud{animation:${p}-drift 75s ease-in-out infinite alternate;}
@keyframes ${p}-drift{from{transform:translateX(-45px)}to{transform:translateX(45px)}}
.${p}-flutter{animation:${p}-flutter 4s ease-in-out infinite;}
@keyframes ${p}-flutter{0%{transform:translate(0,0) rotate(0deg)}25%{transform:translate(9px,-7px) rotate(6deg)}50%{transform:translate(2px,-13px) rotate(-5deg)}75%{transform:translate(-8px,-6px) rotate(4deg)}100%{transform:translate(0,0) rotate(0deg)}}
.${p}-hover{animation:${p}-hoverbob 3s ease-in-out infinite alternate;}
@keyframes ${p}-hoverbob{from{transform:translate(0,0)}to{transform:translate(4px,-5px)}}
.${p}-pulse{animation:${p}-pulse 2.8s ease-in-out infinite alternate;}
@keyframes ${p}-pulse{from{opacity:0.15}to{opacity:0.9}}
.${p}-leafdrift{animation:${p}-leaffall 11s linear infinite;}
@keyframes ${p}-leaffall{0%{transform:translate(0,0) rotate(0deg);opacity:0}10%{opacity:0.8}85%{opacity:0.55}100%{transform:translate(150px,110px) rotate(140deg);opacity:0}}
.${p}-glide{animation:${p}-glideby 13s ease-in-out infinite alternate;}
@keyframes ${p}-glideby{from{transform:translate(0,0)}to{transform:translate(60px,-14px)}}
.${p}-scamper{animation:${p}-scamper 6s ease-in-out infinite alternate;}
@keyframes ${p}-scamper{from{transform:translate(0,0)}to{transform:translate(24px,-2px)}}
.${p}-hop{animation:${p}-hop 2.8s ease-in-out infinite;}
@keyframes ${p}-hop{0%,100%{transform:translate(0,0)}42%{transform:translate(7px,-7px)}50%{transform:translate(9px,0)}}
.${p}-crawl{animation:${p}-crawl 10s linear infinite;}
@keyframes ${p}-crawl{from{transform:translate(0,0)}to{transform:translate(16px,0)}}
.${p}-twinkle{animation:${p}-twinkle 3.6s ease-in-out infinite alternate;}
@keyframes ${p}-twinkle{from{opacity:0.2}to{opacity:0.95}}
.${p}-croak{animation:${p}-croak 3.2s ease-in-out infinite;}
@keyframes ${p}-croak{0%,90%,100%{transform:scaleY(1)}95%{transform:scaleY(1.12)}}
.${p}-enter>g:last-of-type{transform-box:fill-box;transform-origin:50% 100%;animation:${p}-sprout 600ms cubic-bezier(0.2,0.8,0.3,1) both;}
@keyframes ${p}-sprout{from{transform:scale(0.05);opacity:0.4}}
`;
}

/* ── wildlife ────────────────────────────────────────────────────────────── */

function firstById(plants: GardenPlant[], pred: (pl: GardenPlant) => boolean): GardenPlant | undefined {
  return plants
    .filter(pred)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

function birdShapes(p: string, animate: boolean, plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  const tree =
    firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead" && pl.maturity >= 0.6) ??
    firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead");
  const r = rng("wildlife:birds");
  const a = tree ? anchor(tree) : { x: 320, y: 300, s: 0.8 };
  const canopyY = Math.max(120, a.y - (95 + 40 * r()) * a.s);
  const perchX = n(a.x + (r() - 0.5) * 34 * a.s);
  const glideX = n(a.x - 70 - r() * 60);
  const glideY = n(Math.max(70, canopyY - 45 - r() * 30));
  return (
    <g data-wildlife="birds" pointerEvents="none">
      <g transform={`translate(${perchX} ${n(canopyY)})`}>
        <ellipse rx={3.8} ry={2.5} fill="#5c5348" />
        <circle cx={3.1} cy={-1.7} r={1.7} fill="#5c5348" />
        <path d="M-3.5,-0.5 L-6.6,-2.4" stroke="#4c443b" strokeWidth={1.1} strokeLinecap="round" />
        <path d="M4.7,-1.7 l2,0.5 l-2,0.9 Z" fill="#c9a13c" />
      </g>
      <g className={animate ? `${p}-glide` : undefined}>
        <path
          d={`M${glideX - 7},${glideY} Q${glideX - 3},${n(glideY - 5)} ${glideX},${n(glideY - 0.5)} Q${glideX + 3},${n(glideY - 5)} ${glideX + 7},${glideY}`}
          stroke="#5c5348"
          strokeWidth={1.6}
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </g>
  );
}

function beeShapes(p: string, animate: boolean, plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  const flower =
    firstById(plants, (pl) => pl.state === "flowering") ??
    firstById(plants, (pl) => pl.category === "flower" && pl.state !== "dead");
  const r = rng("wildlife:bees");
  const a = flower ? anchor(flower) : { x: 520, y: 460, s: 0.9 };
  const ax = Math.min(940, Math.max(60, a.x));
  const bees: ReactNode[] = [];
  const count = 3;
  for (let i = 0; i < count; i++) {
    const x = n(ax + (r() - 0.5) * 64);
    const y = n(a.y - 14 - r() * 28);
    const style: CSSProperties | undefined = animate
      ? { animationDuration: `${n(2.4 + r() * 1.4)}s`, animationDelay: `-${n(r() * 3)}s` }
      : undefined;
    bees.push(
      <g key={`b${i}`} className={animate ? `${p}-hover` : undefined} style={style} transform={`translate(${x} ${y})`}>
        <ellipse rx={2.6} ry={1.9} fill="#dcb63f" />
        <path d="M-0.9,-1.8 V1.8 M0.8,-1.8 V1.8" stroke="#6b5a2a" strokeWidth={0.7} />
        <ellipse cx={-0.4} cy={-2.5} rx={2} ry={1.1} fill="#ffffff" opacity={0.6} />
      </g>,
    );
  }
  return (
    <g data-wildlife="bees" pointerEvents="none">
      {bees}
    </g>
  );
}

function butterflyShapes(p: string, animate: boolean, plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  const flower =
    firstById(plants, (pl) => pl.state === "flowering") ??
    firstById(plants, (pl) => pl.category === "flower" && pl.state !== "dead");
  const r = rng("wildlife:butterflies");
  const a = flower ? anchor(flower) : { x: 480, y: 440, s: 0.9 };
  const ax = Math.min(920, Math.max(80, a.x));
  const items: ReactNode[] = [];
  const colors: Array<[string, string]> = [
    ["#c9a3cf", "#b58cbd"],
    ["#e3c46f", "#d0ae57"],
  ];
  for (let i = 0; i < 2; i++) {
    const x = n(ax + (r() - 0.5) * 130);
    const y = n(a.y - 34 - r() * 36);
    const [w1, w2] = colors[i]!;
    const style: CSSProperties | undefined = animate ? { animationDelay: `-${n(r() * 4)}s` } : undefined;
    items.push(
      <g key={`f${i}`} className={animate ? `${p}-flutter` : undefined} style={style} transform={`translate(${x} ${y})`}>
        <ellipse cx={-2.9} cy={-0.6} rx={3.1} ry={2.1} transform="rotate(-22 -2.9 -0.6)" fill={w1} opacity={0.9} />
        <ellipse cx={2.9} cy={-0.6} rx={3.1} ry={2.1} transform="rotate(22 2.9 -0.6)" fill={w2} opacity={0.9} />
        <rect x={-0.5} y={-2} width={1} height={4.2} rx={0.5} fill="#5a4a3c" />
      </g>,
    );
  }
  return (
    <g data-wildlife="butterflies" pointerEvents="none">
      {items}
    </g>
  );
}

function fireflyShapes(p: string, animate: boolean): ReactNode {
  const r = rng("wildlife:fireflies");
  const dots: ReactNode[] = [];
  for (let i = 0; i < 5; i++) {
    const x = n(120 + r() * 760);
    const y = n(370 + r() * 150);
    const style: CSSProperties | undefined = animate
      ? { animationDuration: `${n(2.2 + r() * 1.6)}s`, animationDelay: `-${n(r() * 2.8)}s` }
      : undefined;
    dots.push(
      <g
        key={`d${i}`}
        className={animate ? `${p}-pulse` : undefined}
        style={style}
        opacity={animate ? undefined : 0.7}
        transform={`translate(${x} ${y})`}
      >
        <circle r={5.2} fill="#f4d98c" opacity={0.2} />
        <circle r={1.9} fill="#f7e3a1" />
      </g>,
    );
  }
  return (
    <g data-wildlife="fireflies" pointerEvents="none">
      {dots}
    </g>
  );
}

/* ── earned creatures ─────────────────────────────────────────────────────── */

function squirrelShapes(p: string, animate: boolean, plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  const tree =
    firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead" && pl.maturity >= 0.5) ??
    firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead");
  const a = tree ? anchor(tree) : { x: 300, y: 470, s: 0.9 };
  return (
    <g data-wildlife="squirrels" pointerEvents="none">
      <g
        className={animate ? `${p}-scamper` : undefined}
        transform={`translate(${n(a.x + 12 * a.s)} ${n(a.y - 4)}) scale(${n(a.s)})`}
      >
        <path d="M-6,-1 Q-13,-4 -10,-11 Q-6,-9 -5,-4" fill="#8a5a34" />
        <ellipse cx={-2} cy={-2} rx={4.4} ry={3} fill="#96633b" />
        <circle cx={3} cy={-4} r={2.4} fill="#9c6a40" />
        <path d="M2,-6.2 l0.6,-1.6 l1,1.4 Z" fill="#9c6a40" />
        <circle cx={4} cy={-4.3} r={0.5} fill="#2a2018" />
        <path d="M-3,1 v2 M1,1 v2" stroke="#7a5230" strokeWidth={1} strokeLinecap="round" />
      </g>
    </g>
  );
}

function rabbitShapes(p: string, animate: boolean, plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  const gc = firstById(
    plants,
    (pl) => (pl.category === "groundcover" || pl.category === "grass") && pl.state !== "dead",
  );
  const r = rng("wildlife:rabbits");
  const a = gc ? anchor(gc) : { x: 640, y: 490, s: 1 };
  return (
    <g data-wildlife="rabbits" pointerEvents="none">
      <g
        className={animate ? `${p}-hop` : undefined}
        transform={`translate(${n(a.x + (r() - 0.5) * 30)} ${n(a.y - 2)}) scale(${n(a.s)})`}
      >
        <ellipse cx={0} cy={0} rx={5} ry={3.4} fill="#c8bdad" />
        <circle cx={4} cy={-2.4} r={2.4} fill="#cfc4b4" />
        <ellipse cx={3.2} cy={-6} rx={0.9} ry={3.2} fill="#cfc4b4" transform="rotate(-12 3.2 -6)" />
        <ellipse cx={5} cy={-6} rx={0.9} ry={3.2} fill="#cfc4b4" transform="rotate(6 5 -6)" />
        <circle cx={5} cy={-2.6} r={0.5} fill="#3a2f26" />
        <circle cx={-5} cy={0} r={1.4} fill="#e7dccb" />
      </g>
    </g>
  );
}

function frogShapes(p: string, animate: boolean, plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  const fern = firstById(plants, (pl) => pl.category === "fern" && pl.state !== "dead");
  const r = rng("wildlife:frogs");
  const a = fern ? anchor(fern) : { x: 520, y: 500, s: 1 };
  return (
    <g data-wildlife="frogs" pointerEvents="none">
      <g
        className={animate ? `${p}-croak` : undefined}
        style={{ transformBox: "fill-box", transformOrigin: "50% 100%" } as CSSProperties}
        transform={`translate(${n(a.x + (r() - 0.5) * 20)} ${n(a.y + 2)}) scale(${n(a.s)})`}
      >
        <ellipse cx={0} cy={0} rx={4.6} ry={3} fill="#6f9e52" />
        <circle cx={-2.4} cy={-2.8} r={1.5} fill="#7cae5c" />
        <circle cx={2.4} cy={-2.8} r={1.5} fill="#7cae5c" />
        <circle cx={-2.4} cy={-2.8} r={0.6} fill="#243018" />
        <circle cx={2.4} cy={-2.8} r={0.6} fill="#243018" />
        <path d="M-3,1.5 q3,2 6,0" stroke="#3f5c2e" strokeWidth={0.8} fill="none" strokeLinecap="round" />
      </g>
    </g>
  );
}

/** A pair of ducks drifting on the first stream (Bundle 3). Anchored to the
 * channel itself, not a plant — mid-course, where the water is widest. */
function duckShapes(p: string, animate: boolean, channels: StreamGeometry[]): ReactNode {
  const c = channels[0];
  if (!c) return null;
  const r = rng("wildlife:ducks");
  const duck = (key: string, t: number, flip: boolean, scale: number) => {
    const x = c.xc(t) + (r() - 0.5) * c.hw(t);
    const y = c.yTop + t * c.ySpan;
    return (
      <g
        key={key}
        className={animate ? `${p}-hover` : undefined}
        transform={`translate(${n(x)} ${n(y)}) scale(${n(scale * (flip ? -1 : 1))} ${n(scale)})`}
      >
        <ellipse cx={0} cy={0} rx={4.6} ry={2.6} fill="#7a6a52" />
        <path d="M-4.2,-0.6 q-1.6,-0.4 -2.4,0.6 q1.2,0.9 2.6,0.5 Z" fill="#6b5c46" />
        <circle cx={3.4} cy={-3.2} r={1.7} fill="#5c6e58" />
        <path d="M4.9,-3.3 l2.1,0.5 -2.1,0.7 Z" fill="#caa25a" />
        <circle cx={3.8} cy={-3.5} r={0.4} fill="#2c2822" />
        <path d="M-5.4,1.8 q5.4,1.6 10.8,0" stroke="#e8f0f2" strokeWidth={0.6} opacity={0.5} fill="none" />
      </g>
    );
  };
  return (
    <g data-wildlife="ducks" pointerEvents="none">
      {duck("d1", Math.min(c.tEnd, 0.62), false, 1)}
      {duck("d2", Math.min(c.tEnd, 0.74), true, 0.82)}
    </g>
  );
}

function dragonflyShapes(p: string, animate: boolean, plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  const flower =
    firstById(plants, (pl) => pl.state === "flowering") ??
    firstById(plants, (pl) => pl.category === "flower" && pl.state !== "dead");
  const r = rng("wildlife:dragonflies");
  const a = flower ? anchor(flower) : { x: 460, y: 430, s: 0.9 };
  const x = n(Math.min(920, Math.max(80, a.x + (r() - 0.5) * 80)));
  const y = n(a.y - 40 - r() * 30);
  return (
    <g data-wildlife="dragonflies" pointerEvents="none">
      <g className={animate ? `${p}-hover` : undefined} transform={`translate(${x} ${y})`}>
        <rect x={-0.5} y={-1} width={1} height={9} rx={0.5} fill="#3b7f86" />
        <circle cx={0} cy={-1.5} r={1.4} fill="#357b82" />
        <ellipse cx={-3.5} cy={0} rx={4} ry={1.2} fill="#c3e2e8" opacity={0.7} transform="rotate(-8 -3.5 0)" />
        <ellipse cx={3.5} cy={0} rx={4} ry={1.2} fill="#c3e2e8" opacity={0.7} transform="rotate(8 3.5 0)" />
        <ellipse cx={-3.2} cy={2} rx={3.4} ry={1} fill="#c3e2e8" opacity={0.55} transform="rotate(-14 -3.2 2)" />
        <ellipse cx={3.2} cy={2} rx={3.4} ry={1} fill="#c3e2e8" opacity={0.55} transform="rotate(14 3.2 2)" />
      </g>
    </g>
  );
}

function ladybugShapes(p: string, animate: boolean, plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  const leaf = firstById(
    plants,
    (pl) =>
      (pl.category === "shrub" || pl.category === "groundcover" || pl.category === "flower") &&
      pl.state !== "dead",
  );
  const r = rng("wildlife:ladybugs");
  const a = leaf ? anchor(leaf) : { x: 720, y: 470, s: 1 };
  return (
    <g data-wildlife="ladybugs" pointerEvents="none">
      <g
        className={animate ? `${p}-crawl` : undefined}
        transform={`translate(${n(a.x + (r() - 0.5) * 24)} ${n(a.y - 6 - r() * 8)}) scale(${n(a.s)})`}
      >
        <ellipse cx={0} cy={0} rx={2.6} ry={2.2} fill="#cf3b32" />
        <path d="M0,-2.2 V2.2" stroke="#2a1512" strokeWidth={0.5} />
        <circle cx={0} cy={-2.4} r={1} fill="#2a1512" />
        <circle cx={-1.1} cy={-0.4} r={0.4} fill="#2a1512" />
        <circle cx={1.1} cy={-0.4} r={0.4} fill="#2a1512" />
        <circle cx={-0.9} cy={1} r={0.4} fill="#2a1512" />
        <circle cx={0.9} cy={1} r={0.4} fill="#2a1512" />
      </g>
    </g>
  );
}

/* ── dew ──────────────────────────────────────────────────────────────────
   A settled night on a tended garden leaves droplets on the leaves (option
   C, sleep/recovery 0020). Deterministic per plant (`dew:{id}`), non-
   interactive, and deliberately sparse — a glint, not a weather effect. */
function dewGlints(plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  const living = plants.filter((pl) => pl.state !== "dead" && pl.maturity > 0.2);
  const drops: ReactNode[] = [];
  for (const pl of living.slice(0, 16)) {
    const r = rng(`dew:${pl.id}`);
    const a = anchor(pl);
    const count = pl.category === "tree" ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const dx = (r() - 0.5) * 26 * a.s;
      const dy = -(6 + r() * 26) * a.s;
      const rad = 2.2 + r() * 1.6;
      drops.push(
        <g key={`${pl.id}-${i}`} transform={`translate(${n(a.x + dx)} ${n(a.y + dy)})`}>
          <circle r={n(rad)} fill="#dfeaf4" opacity={0.75} />
          <circle r={n(rad * 0.45)} cx={n(-rad * 0.25)} cy={n(-rad * 0.25)} fill="#ffffff" opacity={0.9} />
        </g>,
      );
    }
  }
  return (
    <g data-scene="dew" pointerEvents="none">
      {drops}
    </g>
  );
}

/* ── rare visitors ────────────────────────────────────────────────────────
   One-day guests decided by the worker (see visitors.ts). Each shows only
   during its own hours — an owl announced in the morning beat is found by
   looking at night. Silhouette-styled, muted, never interactive. */

export type SceneVisitor = "deer" | "heron" | "owl" | "fox" | "luna_moth";

const VISITOR_PERIODS: Record<SceneVisitor, ReadonlySet<string>> = {
  deer: new Set(["dawn", "morning"]),
  heron: new Set(["morning", "midday", "golden"]),
  owl: new Set(["night", "dusk"]),
  fox: new Set(["dusk", "golden"]),
  luna_moth: new Set(["dawn", "morning"]),
};

function visitorShapes(kind: SceneVisitor, plants: GardenPlant[], anchor: PlantAnchor): ReactNode {
  switch (kind) {
    case "deer":
      return (
        <g data-visitor="deer" pointerEvents="none" transform="translate(800 310) scale(0.85)" fill="#4a4036" opacity={0.9}>
          {/* body: arched back, deep chest, rounded rump */}
          <path d="M-14,-2 C-12.5,-8 -4,-10.5 4,-9.5 C9,-9 12,-6.5 13,-3.5 C14,-0.5 12,2.5 8,3.6 L-8,3.8 C-12,3 -15,1 -14,-2 Z" />
          {/* neck rising into the head */}
          <path d="M9.5,-6 C12,-9 14,-13 15,-17 L19.5,-16 C18.6,-12 17.6,-8 15.6,-4.4 Z" />
          <path d="M15.5,-17.5 C15.5,-19.6 17,-21 19,-21 C21,-21 22.5,-19.6 22.5,-17.6 C22.5,-15.6 21,-14.5 19,-14.5 C17,-14.5 15.5,-15.5 15.5,-17.5 Z" />
          {/* muzzle + ear */}
          <path d="M21.8,-19 L25.4,-17.4 L21.8,-15.6 Z" />
          <path d="M16.2,-20.6 L14,-24 L17.6,-22.4 Z" />
          {/* antlers: two beams, forward tines */}
          <path
            d="M18,-21 C17.4,-25 18.4,-28.4 21,-30.4 M19,-26 L16.4,-28.6 M20,-29 L18,-31.6 M20.6,-20.6 C21.8,-24.2 23.8,-26.8 26.4,-27.8 M22.2,-24.6 L24.8,-25.8"
            stroke="#4a4036"
            strokeWidth={1.1}
            fill="none"
            strokeLinecap="round"
          />
          {/* legs, a natural stance */}
          <path
            d="M-9,3 L-10.5,16 M-4,3.6 L-4.4,16 M6,3.6 L6.6,16 M11,2 L13.2,15.4"
            stroke="#4a4036"
            strokeWidth={2}
            strokeLinecap="round"
            fill="none"
          />
          {/* tail flick */}
          <path d="M-14,-3 C-16.5,-4.2 -17,-6.2 -15.4,-7.6 C-14.4,-6 -14,-4.4 -14,-3 Z" />
        </g>
      );
    case "heron":
      return (
        <g data-visitor="heron" pointerEvents="none" transform="translate(178 412) scale(0.95)" opacity={0.94}>
          {/* body with folded wing */}
          <path d="M-8,0 C-8,-4 -4,-7 1,-7 C6,-7 9,-4 9,-1 C9,3 5,5.5 0,5.5 C-4,5.5 -8,3.5 -8,0 Z" fill="#6e7f8a" />
          <path d="M-6,-1 C-5,-4 -1,-5.5 3,-5 C1.4,-2.2 -2,-0.2 -6,-1 Z" fill="#5f707b" />
          {/* the S neck herons are known for */}
          <path
            d="M7,-4 C11,-6 12,-10 10,-13 C8.4,-15.6 9,-18 11,-20"
            stroke="#6e7f8a"
            strokeWidth={2.6}
            fill="none"
            strokeLinecap="round"
          />
          {/* head, crest plume, dagger bill */}
          <circle cx={11.6} cy={-21} r={2.3} fill="#6e7f8a" />
          <path d="M9.6,-22.4 L7.4,-24.6" stroke="#3d4750" strokeWidth={1} strokeLinecap="round" />
          <path d="M13.6,-21.7 L20.2,-20.2 L13.8,-19.5 Z" fill="#4c443b" />
          {/* legs — one lifted mid-wade */}
          <path
            d="M-1,5.5 L-1,17 M3.5,5 L4.6,11.6 L4.3,17"
            stroke="#5a6a74"
            strokeWidth={1.3}
            strokeLinecap="round"
            fill="none"
          />
        </g>
      );
    case "owl": {
      const tree =
        firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead" && pl.maturity >= 0.6) ??
        firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead");
      const a = tree ? anchor(tree) : { x: 320, y: 320, s: 0.8 };
      const y = Math.max(120, a.y - 108 * a.s);
      return (
        <g data-visitor="owl" pointerEvents="none" transform={`translate(${n(a.x + 8)} ${n(y)})`} opacity={0.95}>
          {/* the branch it actually sits on */}
          <path d="M-8.5,6.4 L8.5,7.2" stroke="#5a4c3c" strokeWidth={1.6} strokeLinecap="round" />
          {/* body tapering to the perch */}
          <path d="M0,6 C-4.5,6 -6.6,2 -6,-3 C-5.6,-7 -3,-9.5 0,-9.5 C3,-9.5 5.6,-7 6,-3 C6.6,2 4.5,6 0,6 Z" fill="#4e463c" />
          {/* ear tufts */}
          <path d="M-5.4,-6 C-6.4,-8.4 -6,-10.6 -4.2,-12 L-2.8,-8.6 Z M5.4,-6 C6.4,-8.4 6,-10.6 4.2,-12 L2.8,-8.6 Z" fill="#4e463c" />
          {/* facial discs + eyes + beak */}
          <circle cx={-2} cy={-5} r={2.1} fill="#e8dca8" opacity={0.92} />
          <circle cx={2} cy={-5} r={2.1} fill="#e8dca8" opacity={0.92} />
          <circle cx={-2} cy={-5} r={0.8} fill="#2a2418" />
          <circle cx={2} cy={-5} r={0.8} fill="#2a2418" />
          <path d="M0,-4 L0.9,-2.5 L-0.9,-2.5 Z" fill="#c9a13c" />
          {/* folded-wing line */}
          <path d="M-3.6,1 C-2,2.1 2,2.1 3.6,1" stroke="#3c362e" strokeWidth={0.8} fill="none" opacity={0.6} />
        </g>
      );
    }
    case "luna_moth": {
      // Rests on the nearest flowering thing at first light (0020) —
      // pale sage, faint eyespots, the two swept hindwing tails.
      const host =
        firstById(plants, (pl) => pl.category === "flower" && pl.state !== "dead") ??
        firstById(plants, (pl) => pl.state !== "dead");
      const a = host ? anchor(host) : { x: 420, y: 430, s: 1 };
      const y = a.y - 26 * a.s;
      return (
        <g data-visitor="luna_moth" pointerEvents="none" transform={`translate(${n(a.x + 6)} ${n(y)}) scale(0.9)`} opacity={0.92}>
          {/* forewings, swept back */}
          <path d="M-1,-1 C-8,-8 -15,-8.5 -17,-4.5 C-18.5,-1.5 -14,2 -8,2.2 L-1,1.2 Z" fill="#aac9a2" />
          <path d="M1,-1 C8,-8 15,-8.5 17,-4.5 C18.5,-1.5 14,2 8,2.2 L1,1.2 Z" fill="#aac9a2" />
          {/* hindwings with tails */}
          <path d="M-1,1 C-5,5 -7,9 -5.2,13.5 C-4.2,15.8 -2.4,15 -1.8,12 L-0.6,3 Z" fill="#b7d2ae" />
          <path d="M1,1 C5,5 7,9 5.2,13.5 C4.2,15.8 2.4,15 1.8,12 L0.6,3 Z" fill="#b7d2ae" />
          {/* eyespots */}
          <circle cx={-9} cy={-3.4} r={1} fill="#6f8a68" opacity={0.8} />
          <circle cx={9} cy={-3.4} r={1} fill="#6f8a68" opacity={0.8} />
          {/* body + antennae */}
          <ellipse cx={0} cy={1.5} rx={1.3} ry={3.4} fill="#e7efdc" />
          <path d="M-0.6,-2 C-2,-4.5 -3.6,-5.6 -5.2,-5.4 M0.6,-2 C2,-4.5 3.6,-5.6 5.2,-5.4" stroke="#6f8a68" strokeWidth={0.6} fill="none" />
        </g>
      );
    }
    case "fox":
      return (
        <g data-visitor="fox" pointerEvents="none" transform="translate(845 474)" opacity={0.94}>
          {/* the brush: a real tail with a pale tip */}
          <path d="M-9,-1 C-15,-5 -21,-4.2 -23,0 C-24.4,3 -22,6 -18,5.6 C-14,5 -11,3 -9,1 Z" fill="#a4602f" />
          <path d="M-23,0 C-24,2 -23.2,4 -21,4.8 C-19.4,3.6 -19,1.4 -19.8,-0.6 C-21,-0.8 -22.2,-0.6 -23,0 Z" fill="#e8dcc8" />
          {/* low, sleek body */}
          <path d="M-9,2 C-10,-2 -6,-5.5 0,-5.5 C5,-5.5 9,-3.6 10,-0.6 C11,2 9,4.4 5,4.9 L-5,4.9 C-7.4,4.7 -8.7,3.7 -9,2 Z" fill="#ad6a36" />
          {/* head with pointed muzzle */}
          <path d="M9,-2 C9,-4.8 11,-6.6 13.5,-6.6 C15,-6.6 16.3,-5.9 17,-4.8 L20.6,-3.2 L16.8,-1.8 C15.8,-0.6 14,-0.1 12.3,-0.6 C10.4,-1 9,-1.1 9,-2 Z" fill="#ad6a36" />
          {/* upright ears */}
          <path d="M11,-6.2 L10.4,-10 L13.4,-7.4 Z M14.6,-6.4 L16.4,-9.6 L16.9,-6 Z" fill="#8a4f26" />
          {/* chest bib */}
          <path d="M8.6,-3.6 C9.6,-1.6 9.6,0.4 8.6,2 C7.2,1 6.6,-1.4 7.4,-3.2 Z" fill="#e8dcc8" opacity={0.85} />
          <circle cx={15.7} cy={-4} r={0.55} fill="#2a1d12" />
          <circle cx={20.3} cy={-3.2} r={0.7} fill="#2a1d12" />
          {/* legs */}
          <path
            d="M-5,4.9 L-5.5,11 M-1,5 L-1,11 M4,4.9 L4.5,11 M8,3.4 L9.6,10.6"
            stroke="#8a4f26"
            strokeWidth={1.7}
            strokeLinecap="round"
          />
        </g>
      );
  }
}

/* ── scene ───────────────────────────────────────────────────────────────── */

export interface GardenSceneProps {
  snapshot: GardenSnapshot;
  reducedMotion?: boolean;
  selectedPlantId?: string | null;
  onSelectPlant?: (plantId: string | null) => void;
  idPrefix?: string;
  className?: string;
  /** Hour of day 0–24 for the sun/moon position. Defaults to midday. */
  timeOfDay?: number;
  /**
   * SVG fit. Defaults to "xMidYMax meet" (whole scene visible, ground-anchored).
   * Pass "xMidYMax slice" for a full-bleed fill that crops extra sky — used by
   * the ambient/screensaver view.
   */
  preserveAspectRatio?: string;
  /** Mount the Tier-2 canvas atmosphere layer above the SVG. */
  atmosphere?: boolean;
  /** Today's rare visitor (worker-decided); rendered only during its hours. */
  visitor?: SceneVisitor | null;
  /** Plants that just arrived — they sprout in with a transform-only
   * entrance (skipped under reducedMotion; never affects geometry). */
  enteringPlantIds?: string[];
  /** System-driven glow (the arrival moment). The user's own selection
   * always wins — the outline filter is applied to at most ONE plant. */
  highlightPlantId?: string | null;
  /** One-shot atmosphere moment (rain front / sparkle); needs `atmosphere`. */
  impulse?: SceneImpulse | null;
}

export function GardenScene({
  snapshot,
  reducedMotion = false,
  selectedPlantId = null,
  onSelectPlant,
  idPrefix = "rg-garden",
  className,
  timeOfDay,
  preserveAspectRatio = "xMidYMax meet",
  atmosphere = false,
  visitor = null,
  enteringPlantIds,
  highlightPlantId = null,
  impulse = null,
}: GardenSceneProps) {
  const p = idPrefix;
  const animate = !reducedMotion;
  const entering =
    animate && enteringPlantIds && enteringPlantIds.length > 0 ? new Set(enteringPlantIds) : null;
  const weather = snapshot.state.weatherState;
  const moisture = clamp01(snapshot.state.moisture);
  const desc = describeGarden(snapshot);

  const light = {
    ...lightingFor({
      hour: timeOfDay ?? 13,
      season: snapshot.state.season,
      weather,
      moisture,
      inComeback: snapshot.state.inComeback,
      restMode: snapshot.state.restMode,
    }),
  };
  light.moonPhaseValue = moonPhase(snapshot.state.lastSimulatedDate);

  // Sun-side hint for tone-stacked foliage: shadows stretch away from the
  // sun, so the lit side is the opposite sign of shadowDx. Moonlight gets a
  // faint cool rim instead of a warm one.
  const lightHint: LightHint = {
    dx: light.shadowDx > 0.05 ? -1 : light.shadowDx < -0.05 ? 1 : 0,
    litColor: light.sunX !== null ? light.sunColor : "#c9d4e8",
    amount: light.sunX !== null ? Math.min(1, 0.4 + 0.35 * light.beamStrength) : 0.15,
  };

  // Plants never grow in the water: anchors displace out of stream channels.
  // The river system (confluences included) matches Terrain's byte-for-byte.
  // Aquatic species (Bundle 3) are the deliberate exemption: "channel" snaps
  // onto the waterline, "bank" hugs the edge — both clamped past the
  // riparian fade (t ≥ 0.4) so the distant course stays bare water.
  const channels: StreamGeometry[] = riverSystemFor(snapshot.state.grounds ?? []);
  const sources = channels.map((c) => c.xc(0));
  const anchor: PlantAnchor = (pl) => {
    const sp = speciesOrThrow(pl.speciesId);
    const base = anchorOf(pl);
    if (sp.aquatic && channels.length > 0) {
      const c = channels.reduce((best, ch) =>
        Math.abs(ch.cx0 - base.x) < Math.abs(best.cx0 - base.x) ? ch : best,
      );
      const t = Math.min(c.tEnd, Math.max(0.4, 0.4 + 0.55 * pl.position.y));
      const y = c.yTop + t * c.ySpan;
      if (sp.aquatic === "channel") return { x: c.xc(t), y, s: base.s };
      const side = pl.position.x >= 0.5 ? 1 : -1;
      return { x: c.xc(t) + side * (c.hw(t) + 6), y, s: base.s };
    }
    return displaceFromStreams(base, channels, Math.max(12, sp.spacing * 1000 * 0.45));
  };

  const sorted = [...snapshot.plants].sort(
    (a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id),
  );

  // Vines climb with the consistency chain: each consistent week reaches
  // ~10% further up the host; a broken chain draws them back (recoverable —
  // the plant itself stays). Pure display of tracked state.
  const vineReach = Math.min(1, 0.3 + 0.1 * snapshot.state.consecutiveConsistentWeeks);

  // Dew (sleep/recovery 0020): pure display of tracked state, like the vines.
  // The engine stamps lastDewDate on a morning that earned dew, so a replayed
  // timeline day shows the dew IT earned. Glints render through daylight and
  // are gone by dusk — night dew under moonlight reads as rain.
  const dewToday =
    snapshot.state.lastDewDate != null &&
    snapshot.state.lastDewDate === snapshot.state.lastSimulatedDate;

  const svg = (
    <svg
      viewBox="0 0 1000 560"
      width="100%"
      preserveAspectRatio={preserveAspectRatio}
      role="img"
      aria-label={desc}
      className={className}
      onClick={() => onSelectPlant?.(null)}
    >
      <desc>{desc}</desc>
      {/* The silhouette outline is the ONLY selection affordance: it shows on
          hover, keyboard focus, and click selection. The browser's default
          bounding-box focus ring is suppressed on :focus as well as
          :focus-visible (Chrome draws its blue ring on clicked tabindex SVG
          groups via plain :focus). Always present, unlike animation styles. */}
      <style>{`.${p}-plant{-webkit-tap-highlight-color:transparent}.${p}-plant:focus,.${p}-plant:focus-visible{outline:none}.${p}-plant:hover>g:last-of-type,.${p}-plant:focus-visible>g:last-of-type{filter:url(#${p}-outline)}`}</style>
      {animate ? <style>{sceneCss(p, n(Math.max(0.3, light.swayAmpDeg)))}</style> : null}
      <SceneDefs p={p} light={light} />
      <Sky p={p} light={light} animate={animate} />

      {/* three receding ridges — farther rows haze toward the horizon color,
          the near crest catches a sunlit rim when beams are out */}
      <g data-scene="hills" pointerEvents="none">
        {/* distance = a fixed cool-slate pull, not more horizon wash — the
            hill color already carries 45% skyHorizon and washes out fast.
            River sources notch all three silhouettes (see ridgeTop). */}
        <path
          data-ridge="far"
          d={ridgePath("far", sources, 302)}
          fill={mix(light.hill, "#7d8aa0", 0.5)}
          opacity={0.75}
          filter={`url(#${p}-hillblur)`}
        />
        <path
          data-ridge="mid"
          d={ridgePath("mid", sources, 306)}
          fill={mix(light.hill, "#8b93a2", 0.28)}
          opacity={0.7}
        />
        <path
          data-ridge="near"
          d={ridgePath("near", sources, 310)}
          fill={shade(light.hill, 0.96)}
          opacity={0.85}
        />
        {light.beamStrength > 0.05 ? (
          <path
            d={smoothOpen(ridgeTop("near", sources))}
            fill="none"
            stroke={mix(light.hill, light.sunColor, 0.5)}
            strokeWidth={1.4}
            opacity={n(0.5 * light.beamStrength)}
          />
        ) : null}
      </g>

      {/* ground */}
      <Terrain
        p={p}
        light={light}
        moisture={clamp01(snapshot.state.moisture)}
        soilHealth={clamp01(snapshot.state.soilHealth)}
        floweringDensity={clamp01(snapshot.state.floweringDensity)}
        biodiversity={clamp01(snapshot.state.biodiversity)}
        droughtDays={snapshot.state.droughtDays}
        canopy={clamp01(snapshot.state.canopy)}
        trees={sorted
          .filter((pl) => pl.category === "tree" && pl.state !== "dead" && pl.maturity >= 0.5)
          .map((pl) => anchor(pl))}
        grounds={snapshot.state.grounds ?? []}
      />

      {/* plants, far to near */}
      {sorted.map((plant) => {
        const species = speciesOrThrow(plant.speciesId);
        const a = anchor(plant);
        const hw = Math.max(14, species.spacing * 1000 * 0.55);
        const shadowHw = hw * shadowGrowthScale(plant);
        // Cast lobe pinned just behind the base edge, elongating only away
        // from the sun; contact core stays under the stem. Both take the
        // scene-derived shadowColor so drought/night/dusk read correctly.
        // Low sun stretches shadows further and warms them toward umber.
        const castR = shadowHw * (0.5 + (light.shadowLen > 0.7 ? 1.05 : 0.9) * light.shadowLen);
        const castColor =
          light.beamStrength > 0.3 ? mix(light.shadowColor, "#6b4a2f", 0.25) : light.shadowColor;
        // Aerial perspective: back rows haze toward the horizon color.
        const depth = 1 - plant.position.y;
        const tintColor = mix(light.foliageTint, light.hazeColor, 0.55 * depth);
        const tintAmount = Math.min(0.5, light.foliageTintAmount + 0.2 * depth * depth);
        // Invisible tap pad — painted-pixel hit areas make seedlings and
        // grass tufts needle-thin targets; pad by category height × growth.
        const padH = Math.max(
          14,
          (PAD_H[plant.category] ?? 30) * (0.3 + 0.7 * clamp01(plant.maturity)),
        );
        return (
          <g
            key={plant.id}
            data-plant-id={plant.id}
            className={`${p}-plant${entering?.has(plant.id) ? ` ${p}-enter` : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`${species.name}, ${plantStateLabel(plant)}`}
            transform={`translate(${n(a.x)} ${n(a.y)}) scale(${n(a.s)})`}
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectPlant?.(plant.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onSelectPlant?.(plant.id);
              }
            }}
          >
            <ellipse
              data-hitpad="true"
              cx={0}
              cy={n(-padH / 2)}
              rx={n(Math.max(11, shadowHw * 0.55))}
              ry={n(padH / 2 + 6)}
              fill="transparent"
            />
            {plant.state !== "dead" ? (
              <>
                <ellipse
                  data-shadow="cast"
                  cx={n(light.shadowDx * castR * 0.85)}
                  cy={3.5}
                  rx={n(castR)}
                  ry={n(shadowHw * 0.16)}
                  fill={castColor}
                  opacity={n(light.shadowOpacity * 0.75)}
                />
                <ellipse
                  data-shadow="contact"
                  cx={0}
                  cy={3}
                  rx={n(shadowHw * 0.5)}
                  ry={n(shadowHw * 0.13)}
                  fill={castColor}
                  opacity={n(Math.min(0.35, light.shadowOpacity * 1.7))}
                />
              </>
            ) : null}
            <g
              filter={
                (selectedPlantId ? selectedPlantId === plant.id : highlightPlantId === plant.id)
                  ? `url(#${p}-outline)`
                  : undefined
              }
            >
              <PlantSprite
                plant={plant}
                species={species}
                animate={animate}
                idPrefix={p}
                tint={{ color: tintColor, amount: n(tintAmount) }}
                reach={vineReach}
                lightHint={lightHint}
              />
            </g>
          </g>
        );
      })}

      {/* weather overlay */}
      {/* foreground framing — over the plants, under weather/wildlife */}
      <FramingGrass
        light={light}
        moisture={clamp01(snapshot.state.moisture)}
        soilHealth={clamp01(snapshot.state.soilHealth)}
      />

      {dewToday && (light.period === "dawn" || light.period === "morning" || light.period === "midday")
        ? dewGlints(sorted, anchor)
        : null}

      <WeatherOverlay p={p} weather={weather} animate={animate} />
      <Rainbow p={p} light={light} />

      {/* wildlife */}
      {snapshot.wildlife.birds ? birdShapes(p, animate, sorted, anchor) : null}
      {snapshot.wildlife.bees ? beeShapes(p, animate, sorted, anchor) : null}
      {snapshot.wildlife.butterflies ? butterflyShapes(p, animate, sorted, anchor) : null}
      {snapshot.wildlife.fireflies ? fireflyShapes(p, animate) : null}
      {snapshot.wildlife.squirrels ? squirrelShapes(p, animate, sorted, anchor) : null}
      {snapshot.wildlife.rabbits ? rabbitShapes(p, animate, sorted, anchor) : null}
      {snapshot.wildlife.frogs ? frogShapes(p, animate, sorted, anchor) : null}
      {snapshot.wildlife.dragonflies ? dragonflyShapes(p, animate, sorted, anchor) : null}
      {snapshot.wildlife.ladybugs ? ladybugShapes(p, animate, sorted, anchor) : null}
      {snapshot.wildlife.ducks ? duckShapes(p, animate, channels) : null}

      {/* today's rare visitor — only during its own hours */}
      {visitor && VISITOR_PERIODS[visitor].has(light.period) ? visitorShapes(visitor, sorted, anchor) : null}

      {/* finish: beams, horizon haze, grain, vignette — over everything */}
      <Finish p={p} light={light} />
    </svg>
  );

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
          impulse={impulse}
        />
      )}
    </div>
  );
}
