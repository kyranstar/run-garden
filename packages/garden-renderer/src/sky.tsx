import type { CSSProperties, ReactNode } from "react";
import { rng } from "@rg/garden-engine";
import { shade } from "./color";
import type { SceneLight } from "./lighting";

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
      <filter id={`${p}-grain`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" />
        <feColorMatrix type="saturate" values="0" />
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
    const off = n(26 * (light.moonPhaseValue * 2 - 1));
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
    const sc = 0.8 + r() * 0.5;
    const style: CSSProperties | undefined = animate
      ? { animationDuration: `${n(62 + r() * 26)}s`, animationDelay: `-${n(r() * 40)}s` }
      : undefined;
    clouds.push(
      <g key={i} className={animate ? `${p}-cloud` : undefined} style={style} opacity={0.8}>
        {light.cloudShape === "wisp" ? (
          <ellipse cx={n(cx)} cy={n(cy)} rx={n(60 * sc)} ry={n(4 * sc)} fill={light.cloudColor} opacity={0.5} />
        ) : (
          <>
            <ellipse cx={n(cx)} cy={n(cy)} rx={n(46 * sc)} ry={n(13 * sc)} fill={light.cloudColor} />
            <ellipse cx={n(cx - 24 * sc)} cy={n(cy + 4 * sc)} rx={n(27 * sc)} ry={n(9 * sc)} fill={light.cloudColor} />
            <ellipse cx={n(cx + 26 * sc)} cy={n(cy + 5 * sc)} rx={n(30 * sc)} ry={n(10 * sc)} fill={shade(light.cloudColor, 0.96)} />
          </>
        )}
      </g>,
    );
  }
  return <g data-sky="clouds" pointerEvents="none">{clouds}</g>;
}

export function Sky({ p, light, animate }: { p: string; light: SceneLight; animate: boolean }): ReactNode {
  return (
    <>
      <rect x={0} y={0} width={1000} height={305} fill={`url(#${p}-sky)`} />
      <Stars p={p} light={light} animate={animate} />
      <Celestial p={p} light={light} />
      <Clouds p={p} light={light} animate={animate} />
    </>
  );
}
