import type { CSSProperties, ReactNode } from "react";
import type { GardenWeatherState } from "@rg/domain";
import { rng } from "@rg/garden-engine";
import type { SceneLight } from "./lighting";

/**
 * Weather overlays (rain / breeze / drought haze — moved verbatim from
 * GardenScene.tsx) plus the "finish": sunbeams, horizon haze, film grain and
 * vignette that sit over the whole composited scene, and the recovery-rain
 * rainbow. All deterministic — same rng-key contract as the rest of the
 * renderer.
 */

const n = (x: number): number => Math.round(x * 100) / 100;

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

export function WeatherOverlay({
  p,
  weather,
  animate,
}: {
  p: string;
  weather: GardenWeatherState;
  animate: boolean;
}): ReactNode {
  switch (weather) {
    case "fresh_rain":
      return rainOverlay(p, animate, false);
    case "recovery_rain":
      return rainOverlay(p, animate, true);
    case "clear_sun":
    case "soft_sun":
    case "light_clouds":
    case "dry_spell":
      return null; // clouds now come from the Sky component, driven by light.cloudCount
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

/* ── finish: beams, haze, grain, vignette ───────────────────────────────── */

/** A wedge of light fanning out from the sun in the direction of the `-beam`
 * gradient (down and to the left, matching SceneDefs' fixed x2 offset). */
function beamPolygon(bx: number, by: number, halfSpreadDeg: number, length: number, angleOffsetDeg: number): string {
  const dirAngle = Math.atan2(560 - by, -380);
  const offset = (angleOffsetDeg * Math.PI) / 180;
  const half = (halfSpreadDeg * Math.PI) / 180;
  const a1 = dirAngle + offset - half;
  const a2 = dirAngle + offset + half;
  const x1 = n(bx + length * Math.cos(a1));
  const y1 = n(by + length * Math.sin(a1));
  const x2 = n(bx + length * Math.cos(a2));
  const y2 = n(by + length * Math.sin(a2));
  return `${n(bx)},${n(by)} ${x1},${y1} ${x2},${y2}`;
}

export function Finish({ p, light }: { p: string; light: SceneLight }): ReactNode {
  const showBeams = light.sunX !== null && light.sunY !== null && light.beamStrength > 0.05;
  return (
    <g data-finish="true" pointerEvents="none">
      {showBeams ? (
        <>
          <polygon
            points={beamPolygon(light.sunX!, light.sunY!, 6, 640, -5)}
            fill={`url(#${p}-beam)`}
            opacity={n(0.65 * light.beamStrength)}
            style={{ mixBlendMode: "screen" }}
          />
          <polygon
            points={beamPolygon(light.sunX!, light.sunY!, 10, 540, 8)}
            fill={`url(#${p}-beam)`}
            opacity={n(0.4 * light.beamStrength)}
            style={{ mixBlendMode: "screen" }}
          />
        </>
      ) : null}
      <ellipse cx={500} cy={300} rx={560} ry={60} fill={light.hazeColor} opacity={n(light.hazeStrength * 0.5)} />
      <rect x={0} y={0} width={1000} height={560} fill={`url(#${p}-vig)`} />
      <rect
        data-finish-grain="true"
        x={0}
        y={0}
        width={1000}
        height={560}
        filter={`url(#${p}-grain)`}
        opacity={0.3}
        style={{ mixBlendMode: "soft-light" }}
      />
    </g>
  );
}

/* ── rainbow ─────────────────────────────────────────────────────────────── */

const RAINBOW_ARCS: Array<{ d: string; stroke: string; opacity: number }> = [
  { d: "M230,320 A270,270 0 0 1 770,320", stroke: "#c86f5a", opacity: 0.13 },
  { d: "M242,320 A258,258 0 0 1 758,320", stroke: "#d99a3d", opacity: 0.1 },
  { d: "M254,320 A246,246 0 0 1 746,320", stroke: "#8f6fae", opacity: 0.08 },
];

export function Rainbow({ light }: { p: string; light: SceneLight }): ReactNode | null {
  if (!light.rainbow) return null;
  return (
    <g data-overlay="rainbow" pointerEvents="none">
      {RAINBOW_ARCS.map((arc) => (
        <path key={arc.d} d={arc.d} stroke={arc.stroke} strokeWidth={10} opacity={arc.opacity} fill="none" />
      ))}
    </g>
  );
}
