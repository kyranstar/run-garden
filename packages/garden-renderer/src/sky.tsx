import type { CSSProperties, ReactNode } from "react";
import { rng } from "@rg/garden-engine";
import { mix, shade } from "./color";
import type { SceneLight } from "./lighting";
import { blobPath } from "./organic";

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
      <linearGradient id={`${p}-horizonwarm`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={mix(light.skyHorizon, light.sunColor, 0.5)} stopOpacity={0} />
        <stop offset="100%" stopColor={mix(light.skyHorizon, light.sunColor, 0.5)} stopOpacity={1} />
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
      {/* Film grain: seeded so markup and pixels are stable everywhere. The
          contrast boost around mid-gray is what makes soft-light blending read
          as tooth instead of fog; alpha is forced solid so the finish rect's
          opacity alone controls strength. */}
      <filter id={`${p}-grain`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="7" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer>
          <feFuncR type="linear" slope="1.8" intercept="-0.4" />
          <feFuncG type="linear" slope="1.8" intercept="-0.4" />
          <feFuncB type="linear" slope="1.8" intercept="-0.4" />
          <feFuncA type="linear" slope="0" intercept="1" />
        </feComponentTransfer>
      </filter>
      {/* Ground mottle: low-frequency warm noise whose own red/green channels
          drive alpha, so the meadow gradient reads as uneven light. */}
      <filter id={`${p}-mottle`} x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.006 0.012" numOctaves="2" seed="11" />
        <feColorMatrix
          type="matrix"
          values="0 0 0 0 0.42  0 0 0 0 0.36  0 0 0 0 0.18  0.9 0.4 0 0 0"
        />
      </filter>
      {/* True-silhouette selection outline: dilate the sprite's alpha, harden
          it (semi-opaque parts would otherwise ghost), flood, composite.
          Two layers — wide soft cream halo + tight green line — then the art.
          Applied to at most one plant at a time (see GardenScene). */}
      <filter id={`${p}-outline`} x="-40%" y="-40%" width="180%" height="180%">
        <feMorphology in="SourceAlpha" operator="dilate" radius="2.4" result="d1" />
        <feComponentTransfer in="d1" result="s1">
          <feFuncA type="linear" slope="20" intercept="0" />
        </feComponentTransfer>
        <feFlood floodColor="#f7f2dd" floodOpacity="0.9" result="f1" />
        <feComposite in="f1" in2="s1" operator="in" result="halo" />
        <feMorphology in="SourceAlpha" operator="dilate" radius="1.1" result="d2" />
        <feComponentTransfer in="d2" result="s2">
          <feFuncA type="linear" slope="20" intercept="0" />
        </feComponentTransfer>
        <feFlood floodColor="#2c5c3c" floodOpacity="0.95" result="f2" />
        <feComposite in="f2" in2="s2" operator="in" result="line" />
        <feMerge>
          <feMergeNode in="halo" />
          <feMergeNode in="line" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
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

/**
 * Horizontal offset of the shadow disc that occludes the moon, as a function
 * of moon phase (0 = new, 0.5 = full, 1 ≈ new again). At full moon the
 * shadow slides fully clear (+28) for a clean disc; at new moon it sits
 * dead-center (0), covering the moon entirely. Waxing (p < 0.5) shadows
 * recede to the left as they uncover the moon; waning (p > 0.5) shadows
 * advance from the right as they cover it back up.
 */
export function moonShadowOffset(p: number): number {
  return 28 * (1 - 2 * Math.abs(p - 0.5)) * (p < 0.5 ? -1 : 1);
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
    const off = n(moonShadowOffset(light.moonPhaseValue));
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
    const sc = 1.05 + r() * 0.75;
    const style: CSSProperties | undefined = animate
      ? { animationDuration: `${n(62 + r() * 26)}s`, animationDelay: `-${n(r() * 40)}s` }
      : undefined;
    // Fresh per-cloud stream for the blob geometry so the shared position
    // stream above keeps its draw pattern (and existing cloud placements).
    const cr = rng(`weather:clouds:${i}`);
    if (light.cloudShape === "wisp") {
      clouds.push(
        <g key={i} data-cloud="wisp" className={animate ? `${p}-cloud` : undefined} style={style} opacity={0.8}>
          <path d={blobPath(cr, cx, cy, 62 * sc, 4.5 * sc, 0.3, 8)} fill={light.cloudColor} opacity={0.5} />
        </g>,
      );
    } else {
      // Tone-stacked puff: shaded underbelly, main mass, sun-side lit crown.
      const litdx = light.sunX !== null && light.sunX < cx ? -1 : 1;
      const lit = mix(shade(light.cloudColor, 1.05), light.sunColor, 0.2 + 0.45 * light.beamStrength);
      clouds.push(
        <g key={i} data-cloud="puff" className={animate ? `${p}-cloud` : undefined} style={style} opacity={0.85}>
          <path d={blobPath(cr, cx - 8 * sc, cy + 7 * sc, 46 * sc, 10 * sc, 0.2, 8)} fill={shade(light.cloudColor, 0.9)} />
          <path d={blobPath(cr, cx, cy, 54 * sc, 18 * sc, 0.26, 10)} fill={light.cloudColor} />
          <path d={blobPath(cr, cx - 34 * sc * litdx, cy + 3 * sc, 26 * sc, 9 * sc, 0.28, 7)} fill={shade(light.cloudColor, 0.97)} />
          <path d={blobPath(cr, cx + 14 * sc * litdx, cy - 9 * sc, 32 * sc, 11 * sc, 0.26, 8)} fill={lit} />
        </g>,
      );
    }
  }
  return <g data-sky="clouds" pointerEvents="none">{clouds}</g>;
}

export function Sky({ p, light, animate }: { p: string; light: SceneLight; animate: boolean }): ReactNode {
  return (
    <>
      <rect x={0} y={0} width={1000} height={305} fill={`url(#${p}-sky)`} />
      {light.sunX !== null ? (
        <rect data-sky="horizonwarm" x={0} y={230} width={1000} height={75} fill={`url(#${p}-horizonwarm)`} opacity={0.5} />
      ) : null}
      <Stars p={p} light={light} animate={animate} />
      <Celestial p={p} light={light} />
      <Clouds p={p} light={light} animate={animate} />
    </>
  );
}
