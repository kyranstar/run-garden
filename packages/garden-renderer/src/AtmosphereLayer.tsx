import { useEffect, useRef } from "react";
import type { GardenWeatherState } from "@rg/domain";
import type { SceneLight } from "./lighting";
import { activeSystems, atmosphereKey, GUST_SCALE, initSystem, type ParticleSystem, type Sprite, sampleSystem } from "./particles";
import { mix, shade } from "./color";

export interface AtmosphereLayerProps {
  weather: GardenWeatherState;
  light: SceneLight;
  fireflies: boolean;
  hasFlowering: boolean;
  restMode: boolean;
  idPrefix: string;
}

interface AtmosphereInputs {
  weather: GardenWeatherState;
  light: SceneLight;
  fireflies: boolean;
  hasFlowering: boolean;
  restMode: boolean;
}

/**
 * The Tier-2 canvas: pollen, mist, splashes, gusts — everything the DOM can't
 * animate cheaply. Pure decoration: pointer-events none, aria-hidden, and the
 * scene is complete without it (reducedMotion never mounts it).
 *
 * The RAF loop and its `start` time origin live in ONE long-lived effect,
 * keyed only on `idPrefix` (truly stable identity) — parent re-renders (a
 * plant tap on the garden screen, the ambient screen's 30s clock tick, a
 * cursor-hide toggle) must never tear the loop down and reset every
 * particle's clock, since `light` is a fresh object literal every render.
 * Changing props are mirrored into a ref each render and read fresh inside
 * the frame callback; particle systems are only rebuilt when the gating
 * scalars (weather/period/fireflies/hasFlowering) actually change, per
 * `atmosphereKey` — restMode and light color changes apply instantly on the
 * next frame with no rebuild and no time-origin reset.
 */
export function AtmosphereLayer({ weather, light, fireflies, hasFlowering, restMode, idPrefix }: AtmosphereLayerProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const inputsRef = useRef<AtmosphereInputs>({ weather, light, fireflies, hasFlowering, restMode });
  inputsRef.current = { weather, light, fireflies, hasFlowering, restMode };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return; // graceful: SVG scene stands alone

    const start = performance.now();
    let last = 0;
    let raf = 0;
    let systems: ParticleSystem[] = [];
    let key = "";

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (now - last < 1000 / 30) return; // 30 fps cap
      last = now;
      const t = (now - start) / 1000;

      const cur = inputsRef.current;
      const nextKey = atmosphereKey({
        weather: cur.weather,
        period: cur.light.period,
        fireflies: cur.fireflies,
        hasFlowering: cur.hasFlowering,
      });
      if (nextKey !== key) {
        key = nextKey;
        const kinds = activeSystems({
          weather: cur.weather,
          period: cur.light.period,
          fireflies: cur.fireflies,
          hasFlowering: cur.hasFlowering,
        });
        systems = kinds.map((k) => initSystem(k, `${idPrefix}:${k}`));
      }
      const gustScale = (GUST_SCALE[cur.weather] ?? 1) * (cur.restMode ? 0.6 : 1);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(canvas.clientWidth * dpr);
      const H = Math.round(canvas.clientHeight * dpr);
      if (W === 0 || H === 0) return;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const g = ctx!;
      g.clearRect(0, 0, W, H);
      for (const sys of systems) drawSystem(g, sys, t, W, H, cur.light, gustScale);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [idPrefix]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
}

function drawSystem(
  g: CanvasRenderingContext2D,
  sys: ParticleSystem,
  t: number,
  W: number,
  H: number,
  light: SceneLight,
  gustScale: number,
): void {
  const sprites: Sprite[] = sampleSystem(sys, t);
  switch (sys.kind) {
    case "pollen":
    case "fireflyGlow": {
      g.save();
      g.globalCompositeOperation = "lighter";
      for (const s of sprites) {
        if (s.alpha <= 0.01) continue;
        g.globalAlpha = s.alpha;
        g.fillStyle = light.moteColor;
        g.beginPath();
        g.arc(s.x * W, s.y * H, s.size * (W / 900) * (sys.kind === "fireflyGlow" ? 2.4 : 1), 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
      break;
    }
    case "mist": {
      for (const s of sprites) {
        const rad = s.size * W;
        const grad = g.createRadialGradient(s.x * W, s.y * H, 0, s.x * W, s.y * H, rad);
        grad.addColorStop(0, hexA(light.hazeColor, s.alpha));
        grad.addColorStop(1, hexA(light.hazeColor, 0));
        g.fillStyle = grad;
        g.fillRect(s.x * W - rad, s.y * H - rad, rad * 2, rad * 2);
      }
      break;
    }
    case "cloudShadow": {
      for (const s of sprites) {
        const rad = s.size * W;
        const grad = g.createRadialGradient(s.x * W, s.y * H, 0, s.x * W, s.y * H, rad);
        grad.addColorStop(0, `rgba(28,42,22,${s.alpha})`);
        grad.addColorStop(1, "rgba(28,42,22,0)");
        g.fillStyle = grad;
        g.fillRect(0, H * 0.5, W, H * 0.5);
      }
      break;
    }
    case "rainSplash": {
      g.strokeStyle = "rgba(207,228,240,0.9)";
      for (const s of sprites) {
        if (s.alpha <= 0.02) continue;
        g.globalAlpha = s.alpha;
        g.lineWidth = 1;
        g.beginPath();
        g.ellipse(s.x * W, s.y * H, s.size * W, s.size * W * 0.3, 0, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = 1;
      break;
    }
    case "gustFringe": {
      const base = shade(light.grassNear, 0.6);
      const tip = shade(light.grassNear, 0.85);
      for (const s of sprites) {
        const x = s.x * W;
        const h = s.size * H;
        const bend = s.tilt * gustScale;
        g.strokeStyle = mix(base, tip, s.size * 8);
        g.globalAlpha = 0.8;
        g.lineWidth = Math.max(1.2, W / 700);
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(x, H);
        g.quadraticCurveTo(x + bend * h * 0.4, H - h * 0.6, x + bend * h, H - h);
        g.stroke();
      }
      g.globalAlpha = 1;
      break;
    }
    case "petals": {
      for (const s of sprites) {
        g.save();
        g.translate(s.x * W, s.y * H);
        g.rotate(s.tilt);
        g.globalAlpha = s.alpha;
        g.fillStyle = light.meadowAccents[0] ?? "#e0b23e";
        g.beginPath();
        g.ellipse(0, 0, s.size * (W / 900), s.size * 0.5 * (W / 900), 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      break;
    }
    case "shimmer": {
      for (const s of sprites) {
        g.globalAlpha = s.alpha;
        g.fillStyle = hexA(light.hazeColor, 1);
        g.fillRect(s.x * W, s.y * H, s.size * W, Math.max(1, H / 280));
      }
      g.globalAlpha = 1;
      break;
    }
  }
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const gc = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${gc},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}
