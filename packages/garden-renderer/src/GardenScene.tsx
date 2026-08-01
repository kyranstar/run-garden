import type { CSSProperties, ReactNode } from "react";
import type { GardenPlant, GardenWeatherState } from "@rg/domain";
import type { GardenSnapshot } from "@rg/garden-engine";
import { rng, speciesOrThrow } from "@rg/garden-engine";
import { desaturate, mix, shade } from "./color";
import { describeGarden, plantStateLabel } from "./describe";
import { PlantSprite } from "./PlantSprite";

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
function anchorOf(plant: GardenPlant): { x: number; y: number; s: number } {
  return {
    x: plant.position.x * 1000,
    y: GROUND_TOP + plant.position.y * GROUND_SPAN,
    s: 0.65 + 0.45 * plant.position.y,
  };
}

function skyColors(weather: GardenWeatherState): [string, string] {
  switch (weather) {
    case "fresh_rain":
    case "recovery_rain":
      // Fresh, cheerful rain — a clear blue sky clearing to soft green, not grey.
      return ["#a2d4ea", "#e6f1d8"];
    case "mild_drought":
      return ["#d9caa6", "#ece2c5"];
    case "dry_spell":
      return ["#ccd1bb", "#e8e6cc"];
    case "light_clouds":
      return ["#c2d4dd", "#e9efde"];
    case "soft_sun":
      return ["#cfe0e8", "#f2f0dc"];
    case "seasonal_breeze":
      return ["#c7dce4", "#ecf1de"];
    case "clear_sun":
      return ["#bcd8e6", "#eef3e0"];
  }
}

function sceneCss(p: string): string {
  return `
.${p}-sway{transform-box:fill-box;transform-origin:50% 100%;animation:${p}-sway 7s ease-in-out infinite alternate;}
@keyframes ${p}-sway{from{transform:rotate(-1.7deg)}to{transform:rotate(1.7deg)}}
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
`;
}

/* ── weather overlays ────────────────────────────────────────────────────── */

function rainOverlay(p: string, animate: boolean, recovery: boolean): ReactNode {
  const r = rng("weather:rain");
  const count = 16;
  const streaks: ReactNode[] = [];
  for (let copy = 0; copy < 2; copy++) {
    for (let i = 0; i < count; i++) {
      const x = n(r() * 1000);
      const y = n(r() * 560) - copy * 560;
      streaks.push(
        <line
          key={`s${copy}-${i}`}
          x1={x}
          y1={n(y)}
          x2={n(x - 4)}
          y2={n(y + 26)}
          stroke={recovery ? "#5fb0d8" : "#57a7d2"}
          strokeWidth={1.2}
          strokeLinecap="round"
          opacity={n(0.24 + r() * 0.2)}
        />,
      );
    }
  }
  return (
    <g data-overlay="rain" pointerEvents="none">
      <g className={animate ? `${p}-rain` : undefined}>{streaks}</g>
    </g>
  );
}

function cloudsOverlay(p: string, animate: boolean, dry: boolean): ReactNode {
  const r = rng("weather:clouds");
  const fill = dry ? "#d6ccba" : "#f1f3ee";
  const clouds: ReactNode[] = [];
  const count = 2 + Math.floor(r() * 2);
  for (let i = 0; i < count; i++) {
    const cx = 140 + r() * 700;
    const cy = 52 + r() * 78;
    const sc = 0.8 + r() * 0.5;
    const style: CSSProperties | undefined = animate
      ? { animationDuration: `${n(62 + r() * 26)}s`, animationDelay: `-${n(r() * 40)}s` }
      : undefined;
    clouds.push(
      <g key={`c${i}`} className={animate ? `${p}-cloud` : undefined} style={style} opacity={dry ? 0.7 : 0.82}>
        <ellipse cx={n(cx)} cy={n(cy)} rx={n(46 * sc)} ry={n(13 * sc)} fill={fill} />
        <ellipse cx={n(cx - 24 * sc)} cy={n(cy + 4 * sc)} rx={n(27 * sc)} ry={n(9 * sc)} fill={fill} />
        <ellipse cx={n(cx + 26 * sc)} cy={n(cy + 5 * sc)} rx={n(30 * sc)} ry={n(10 * sc)} fill={shade(fill, 0.97)} />
      </g>,
    );
  }
  return (
    <g data-overlay="clouds" pointerEvents="none">
      {clouds}
    </g>
  );
}

function breezeOverlay(p: string, animate: boolean): ReactNode {
  const r = rng("weather:breeze");
  const leaves: ReactNode[] = [];
  for (let i = 0; i < 4; i++) {
    const x = 80 + r() * 700;
    const y = 90 + r() * 220;
    const style: CSSProperties | undefined = animate
      ? { animationDuration: `${n(9 + r() * 5)}s`, animationDelay: `-${n(r() * 9)}s` }
      : undefined;
    leaves.push(
      <g key={`l${i}`} className={animate ? `${p}-leafdrift` : undefined} style={style} opacity={animate ? undefined : 0.55}>
        <ellipse cx={n(x)} cy={n(y)} rx={4} ry={1.8} transform={`rotate(${n(r() * 70 - 35)} ${n(x)} ${n(y)})`} fill="#a6a86a" />
      </g>,
    );
  }
  return (
    <g data-overlay="breeze" pointerEvents="none">
      {leaves}
    </g>
  );
}

function weatherOverlay(p: string, weather: GardenWeatherState, animate: boolean): ReactNode {
  switch (weather) {
    case "fresh_rain":
      return rainOverlay(p, animate, false);
    case "recovery_rain":
      return rainOverlay(p, animate, true);
    case "clear_sun":
    case "soft_sun":
      return null; // the sun is drawn by the time-of-day celestial layer
    case "light_clouds":
      return cloudsOverlay(p, animate, false);
    case "dry_spell":
      return cloudsOverlay(p, animate, true);
    case "mild_drought":
      return (
        <g data-overlay="haze" pointerEvents="none">
          <rect x={0} y={0} width={1000} height={560} fill="#d8b97a" opacity={0.08} />
          <ellipse cx={500} cy={250} rx={560} ry={130} fill="#e5d3a4" opacity={0.1} />
        </g>
      );
    case "seasonal_breeze":
      return breezeOverlay(p, animate);
  }
}

/* ── wildlife ────────────────────────────────────────────────────────────── */

function firstById(plants: GardenPlant[], pred: (pl: GardenPlant) => boolean): GardenPlant | undefined {
  return plants
    .filter(pred)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

function birdShapes(p: string, animate: boolean, plants: GardenPlant[]): ReactNode {
  const tree =
    firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead" && pl.maturity >= 0.6) ??
    firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead");
  const r = rng("wildlife:birds");
  const a = tree ? anchorOf(tree) : { x: 320, y: 300, s: 0.8 };
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

function beeShapes(p: string, animate: boolean, plants: GardenPlant[]): ReactNode {
  const flower =
    firstById(plants, (pl) => pl.state === "flowering") ??
    firstById(plants, (pl) => pl.category === "flower" && pl.state !== "dead");
  const r = rng("wildlife:bees");
  const a = flower ? anchorOf(flower) : { x: 520, y: 460, s: 0.9 };
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

function butterflyShapes(p: string, animate: boolean, plants: GardenPlant[]): ReactNode {
  const flower =
    firstById(plants, (pl) => pl.state === "flowering") ??
    firstById(plants, (pl) => pl.category === "flower" && pl.state !== "dead");
  const r = rng("wildlife:butterflies");
  const a = flower ? anchorOf(flower) : { x: 480, y: 440, s: 0.9 };
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

function squirrelShapes(p: string, animate: boolean, plants: GardenPlant[]): ReactNode {
  const tree =
    firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead" && pl.maturity >= 0.5) ??
    firstById(plants, (pl) => pl.category === "tree" && pl.state !== "dead");
  const a = tree ? anchorOf(tree) : { x: 300, y: 470, s: 0.9 };
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

function rabbitShapes(p: string, animate: boolean, plants: GardenPlant[]): ReactNode {
  const gc = firstById(
    plants,
    (pl) => (pl.category === "groundcover" || pl.category === "grass") && pl.state !== "dead",
  );
  const r = rng("wildlife:rabbits");
  const a = gc ? anchorOf(gc) : { x: 640, y: 490, s: 1 };
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

function frogShapes(p: string, animate: boolean, plants: GardenPlant[]): ReactNode {
  const fern = firstById(plants, (pl) => pl.category === "fern" && pl.state !== "dead");
  const r = rng("wildlife:frogs");
  const a = fern ? anchorOf(fern) : { x: 520, y: 500, s: 1 };
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

function dragonflyShapes(p: string, animate: boolean, plants: GardenPlant[]): ReactNode {
  const flower =
    firstById(plants, (pl) => pl.state === "flowering") ??
    firstById(plants, (pl) => pl.category === "flower" && pl.state !== "dead");
  const r = rng("wildlife:dragonflies");
  const a = flower ? anchorOf(flower) : { x: 460, y: 430, s: 0.9 };
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

function ladybugShapes(p: string, animate: boolean, plants: GardenPlant[]): ReactNode {
  const leaf = firstById(
    plants,
    (pl) =>
      (pl.category === "shrub" || pl.category === "groundcover" || pl.category === "flower") &&
      pl.state !== "dead",
  );
  const r = rng("wildlife:ladybugs");
  const a = leaf ? anchorOf(leaf) : { x: 720, y: 470, s: 1 };
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

/* ── time of day (moving sun / moon / stars) ──────────────────────────────── */

interface SkyTime {
  isNight: boolean;
  sun: { x: number; y: number } | null;
  moon: { x: number; y: number } | null;
  tint: string | null;
  tintOpacity: number;
}

const arcX = (f: number) => 120 + f * 760;
const arcY = (f: number) => 250 - Math.sin(Math.max(0, Math.min(1, f)) * Math.PI) * 205;

function skyTime(hour: number): SkyTime {
  const t = ((hour % 24) + 24) % 24;
  const isDay = t >= 6 && t <= 18.5;
  if (isDay) {
    const f = (t - 6) / 12.5;
    const edge = Math.min(f, 1 - f);
    const warm = edge < 0.16;
    return {
      isNight: false,
      sun: { x: n(arcX(f)), y: n(arcY(f)) },
      moon: null,
      tint: warm ? "#e79a4e" : null,
      tintOpacity: warm ? 0.14 : 0,
    };
  }
  const nt = t > 18.5 ? t - 18.5 : t + 5.5; // 0..11 across the night
  const f = nt / 11;
  return {
    isNight: true,
    sun: null,
    moon: { x: n(arcX(f)), y: n(arcY(f) + 12) },
    tint: "#1b2a4c",
    tintOpacity: 0.42,
  };
}

function celestialLayer(p: string, time: SkyTime): ReactNode {
  if (time.isNight && time.moon) {
    return (
      <g data-celestial="moon" pointerEvents="none">
        <circle cx={time.moon.x} cy={time.moon.y} r={38} fill={`url(#${p}-sunglow)`} opacity={0.5} />
        <circle cx={time.moon.x} cy={time.moon.y} r={15} fill="#eef0e0" />
        <circle cx={time.moon.x + 5} cy={time.moon.y - 3} r={13} fill="#1b2a4c" opacity={0.35} />
      </g>
    );
  }
  if (time.sun) {
    return (
      <g data-celestial="sun" pointerEvents="none">
        <circle cx={time.sun.x} cy={time.sun.y} r={46} fill={`url(#${p}-sunglow)`} />
        <circle cx={time.sun.x} cy={time.sun.y} r={18} fill="#f6e6b0" />
      </g>
    );
  }
  return null;
}

function starsLayer(p: string, animate: boolean): ReactNode {
  const r = rng("sky:stars");
  const stars: ReactNode[] = [];
  for (let i = 0; i < 32; i++) {
    const style: CSSProperties | undefined = animate ? { animationDelay: `-${n(r() * 3.5)}s` } : undefined;
    stars.push(
      <circle
        key={i}
        cx={n(r() * 1000)}
        cy={n(r() * 250)}
        r={n(0.6 + r() * 0.9)}
        fill="#eef0e0"
        className={animate ? `${p}-twinkle` : undefined}
        style={style}
        opacity={animate ? undefined : 0.7}
      />,
    );
  }
  return (
    <g data-sky="stars" pointerEvents="none">
      {stars}
    </g>
  );
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
}

export function GardenScene({
  snapshot,
  reducedMotion = false,
  selectedPlantId = null,
  onSelectPlant,
  idPrefix = "rg-garden",
  className,
  timeOfDay,
}: GardenSceneProps) {
  const p = idPrefix;
  const animate = !reducedMotion;
  const weather = snapshot.state.weatherState;
  const time = skyTime(timeOfDay ?? 13);
  const moisture = clamp01(snapshot.state.moisture);
  const desc = describeGarden(snapshot);

  const [skyTop, skyBottom] = skyColors(weather);
  // Lush greens when moist → desaturated straw in drought, interpolated in code.
  const grass = mix("#c0ab6e", "#7aa458", moisture);
  const grassFar = shade(grass, 1.08);
  const soil = mix("#b3a084", "#8f7a5c", moisture);
  const hill = desaturate(mix("#b0ab7f", "#8fae86", moisture), 0.18);

  const sorted = [...snapshot.plants].sort(
    (a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id),
  );

  return (
    <svg
      viewBox="0 0 1000 560"
      width="100%"
      preserveAspectRatio="xMidYMax meet"
      role="img"
      aria-label={desc}
      className={className}
      onClick={() => onSelectPlant?.(null)}
    >
      <desc>{desc}</desc>
      {animate ? <style>{sceneCss(p)}</style> : null}
      <defs>
        <linearGradient id={`${p}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={skyTop} />
          <stop offset="100%" stopColor={skyBottom} />
        </linearGradient>
        <radialGradient id={`${p}-sunglow`}>
          <stop offset="0%" stopColor="#f6ecc4" stopOpacity={0.55} />
          <stop offset="100%" stopColor="#f6ecc4" stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* sky */}
      <rect x={0} y={0} width={1000} height={300} fill={`url(#${p}-sky)`} />
      {time.isNight ? starsLayer(p, animate) : null}
      {celestialLayer(p, time)}

      {/* distant hills */}
      <path d="M0,296 C130,240 320,246 480,296 L480,300 L0,300 Z" fill={shade(hill, 1.06)} opacity={0.65} />
      <path d="M410,296 C590,238 820,234 1000,292 L1000,300 L410,300 Z" fill={hill} opacity={0.5} />

      {/* ground */}
      <path
        data-ground="true"
        d="M0,288 C260,278 740,278 1000,288 L1000,560 L0,560 Z"
        fill={grass}
      />
      <path d="M0,288 C260,278 740,278 1000,288 L1000,332 L0,332 Z" fill={grassFar} opacity={0.55} />
      <rect x={0} y={500} width={1000} height={60} fill={soil} opacity={0.18} />

      {/* plants, far to near */}
      {sorted.map((plant) => {
        const species = speciesOrThrow(plant.speciesId);
        const a = anchorOf(plant);
        const hw = Math.max(14, species.spacing * 1000 * 0.55);
        return (
          <g
            key={plant.id}
            data-plant-id={plant.id}
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
            {selectedPlantId === plant.id ? (
              <ellipse
                cx={0}
                cy={3}
                rx={n(hw)}
                ry={n(hw * 0.3)}
                fill="#f7f3df"
                opacity={0.45}
                stroke="#d9d2b2"
                strokeWidth={1}
              />
            ) : null}
            <PlantSprite plant={plant} species={species} animate={animate} idPrefix={p} />
          </g>
        );
      })}

      {/* time-of-day tint: warm at dawn/dusk, dusky blue at night */}
      {time.tint && time.tintOpacity > 0 ? (
        <rect x={0} y={0} width={1000} height={560} fill={time.tint} opacity={time.tintOpacity} pointerEvents="none" />
      ) : null}

      {/* weather overlay */}
      {weatherOverlay(p, weather, animate)}

      {/* wildlife */}
      {snapshot.wildlife.birds ? birdShapes(p, animate, sorted) : null}
      {snapshot.wildlife.bees ? beeShapes(p, animate, sorted) : null}
      {snapshot.wildlife.butterflies ? butterflyShapes(p, animate, sorted) : null}
      {snapshot.wildlife.fireflies ? fireflyShapes(p, animate) : null}
      {snapshot.wildlife.squirrels ? squirrelShapes(p, animate, sorted) : null}
      {snapshot.wildlife.rabbits ? rabbitShapes(p, animate, sorted) : null}
      {snapshot.wildlife.frogs ? frogShapes(p, animate, sorted) : null}
      {snapshot.wildlife.dragonflies ? dragonflyShapes(p, animate, sorted) : null}
      {snapshot.wildlife.ladybugs ? ladybugShapes(p, animate, sorted) : null}
    </svg>
  );
}
