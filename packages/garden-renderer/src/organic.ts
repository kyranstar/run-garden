/**
 * Deterministic organic-geometry helpers for the grainlight look. All wobble
 * comes from the caller's rng stream — no filters, so animated groups stay
 * cheap — and draw counts are FIXED per call signature: blobPath always takes
 * exactly `k` draws, wobbleLine exactly `segs - 1`, regardless of output.
 */

const n = (x: number): number => Math.round(x * 100) / 100;

/**
 * Closed organic blob: k radial points around (cx,cy) with radius jittered by
 * ±wobble/2, joined as a smooth quadratic loop through segment midpoints.
 */
export function blobPath(
  r: () => number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  wobble = 0.16,
  k = 9,
): string {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    const w = 1 - wobble / 2 + r() * wobble;
    pts.push([cx + Math.cos(a) * rx * w, cy + Math.sin(a) * ry * w]);
  }
  const mid = (i: number): [number, number] => {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % k]!;
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  };
  let d = `M${n(mid(k - 1)[0])},${n(mid(k - 1)[1])} `;
  for (let i = 0; i < k; i++) {
    const [mx, my] = mid(i);
    d += `Q${n(pts[i]![0])},${n(pts[i]![1])} ${n(mx)},${n(my)} `;
  }
  return d.trimEnd() + " Z";
}

/**
 * Straight segment with perpendicular jitter at the interior points; the final
 * point is exact so joints (stem tips, branch forks) stay watertight.
 */
export function wobbleLine(
  r: () => number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  segs = 4,
  amp = 2,
): string {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  let d = `M${n(x0)},${n(y0)}`;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const j = i === segs ? 0 : (r() * 2 - 1) * amp;
    d += ` L${n(x0 + dx * t + px * j)},${n(y0 + dy * t + py * j)}`;
  }
  return d;
}

/** How the scene tells a sprite where the light is coming from. */
export interface LightHint {
  /** Sun-side x direction: -1 sun left of the plant, 1 sun right, 0 top-lit. */
  dx: -1 | 0 | 1;
  /** Highlight color to mix into foliage on lit masses. */
  litColor: string;
  /** 0..1 rim strength; 0 collapses lit masses into the mid tone. */
  amount: number;
}

/** Neutral top-light for hint-less contexts (codex cards, botanical view). */
export const DEFAULT_LIGHT_HINT: LightHint = { dx: 0, litColor: "#f0e2ae", amount: 0.35 };
