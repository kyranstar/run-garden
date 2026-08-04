import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement, RefObject } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/**
 * Chart kit — the shared, dependency-free building blocks every Insights
 * chart is built from. B2/B3/B4 import these exports by name; changing a
 * signature here is a breaking change for those screens.
 *
 * Design-system rules this file exists to enforce (the project's dataviz
 * method, distilled):
 *   - Every color is a CSS custom property (--chart-1/2/3, --chart-grid,
 *     --chart-track, --ink-*). Nothing here hardcodes a hex value.
 *   - Text (labels, values, legends, tooltip copy) always renders in an ink
 *     token, never a series color — only marks/glyphs carry series/valence
 *     color.
 *   - One shared pointer-overlay tooltip implementation (`useChartTooltip`)
 *     for every chart, rendered as an HTML element (`.chart-tip`, styled in
 *     styles.css) positioned over the chart — never an SVG `<title>` (those
 *     are being retired: unreachable on touch, inconsistent across
 *     browsers).
 *
 * ────────────────────────────────────────────────────────────────────────
 * niceTicks(lo, hi, count = 3)
 * ────────────────────────────────────────────────────────────────────────
 * Classic "nice numbers" tick algorithm, extended with a 2.5 step so ticks
 * can land on quarters as well as halves/fifths. The step is chosen from
 * {1, 2, 2.5, 5, 10} x 10^k: whichever candidate the raw step implied by
 * `count` falls under, walking the candidates low to high and cutting over
 * at the geometric mean between neighbours (so the choice is "nearest on a
 * log scale", not "smallest that still covers"). Ticks are
 * `niceLo, niceLo+step, …, niceHi` where niceLo = floor(lo/step)*step and
 * niceHi = ceil(hi/step)*step — i.e. the ticks always fully cover [lo, hi],
 * and may (by design) extend a little past either end so the axis lands on
 * round numbers.
 *
 * Degenerate case: `lo === hi` returns the single-element array `[lo]`.
 * There is no meaningful range to step through, and a caller charting a
 * flat series (every value identical) should treat a one-tick axis as its
 * own display case rather than have this function invent a fake span.
 *
 * `hi < lo` is accepted defensively (swapped internally) so a caller that
 * hasn't sorted its domain yet still gets a sane, ascending result.
 *
 * ────────────────────────────────────────────────────────────────────────
 * dateX(dates, innerW, left)
 * ────────────────────────────────────────────────────────────────────────
 * Returns a mapper from an ISO date string ("YYYY-MM-DD") to an x
 * coordinate, proportional to elapsed time across [min(dates), max(dates)]
 * (parsed as UTC midnight so the mapping is stable regardless of the
 * runtime's local timezone). A zero-span domain — a single distinct date,
 * an empty `dates` array, or every entry sharing the same date — centers
 * every call: `left + innerW / 2`, regardless of the date argument passed
 * to the returned function.
 *
 * ────────────────────────────────────────────────────────────────────────
 * rollingMedian(values, window = 5)
 * ────────────────────────────────────────────────────────────────────────
 * Centered rolling median, same length as the input. `window` should be
 * odd (an even value behaves the same as `window - 1`, since the half-width
 * used is `Math.floor(window / 2)`). At index i the half-width used is
 * `k = min(halfWidth, i, n - 1 - i)` — i.e. the window shrinks
 * *symmetrically*: it never reaches further on one side of i than the
 * shorter side allows, so the slice is always `values[i-k .. i+k]`
 * (2k+1 values, always odd, so the median is always a single sorted middle
 * element — never an average of two).
 *
 * ────────────────────────────────────────────────────────────────────────
 * useChartTooltip()
 * ────────────────────────────────────────────────────────────────────────
 * One pointer-overlay tooltip per chart instance. Usage:
 *
 *   const { wrapperProps, tooltip, registerMarks } = useChartTooltip();
 *   registerMarks([{ x: 10, y: 20, label: "Mon 8/3: 5.2 km" }, ...]);
 *   return (
 *     <div {...wrapperProps}>
 *       <svg viewBox="0 0 560 180" ...>...</svg>
 *       {tooltip}
 *     </div>
 *   );
 *
 * Contract:
 *   - `wrapperProps` spreads onto the div that directly wraps the `<svg>`
 *     — no other element between them, since the hook measures the first
 *     `<svg>` descendant of the wrapper. It carries `position: relative` so
 *     the tooltip (`position: absolute`, and never clipped by the svg) is
 *     positioned against it, plus the pointer handlers below.
 *   - `tooltip` is a plain `ReactElement | null` — `null` when nothing is
 *     active — recomputed each render, not a component to invoke. (Exposing
 *     it as a callable `<TipPortal/>` would give it a fresh function
 *     *identity* every render, and React remounts rather than updates a
 *     JSX child whose component identity changes; a plain element has no
 *     such identity to churn.)
 *   - `registerMarks(marks)` takes every hoverable mark's position **in the
 *     same coordinate units as the `<svg>`'s viewBox** (not CSS pixels) and
 *     a plain-text label to show verbatim in the tooltip. Call it during
 *     render (not inside an effect) — it writes straight into a ref with no
 *     re-render, so it must run on every render to stay current for the
 *     *next* pointer event, but calling it is cheap and side-effect-free.
 *   - A mark may carry an optional `action: { label, onClick }`, which the
 *     tooltip renders as a real `<button>` under the label (e.g. "view run
 *     ›"). A tooltip with an action becomes pointer-interactive
 *     (`.chart-tip-interactive` lifts the default `pointer-events: none`),
 *     and both pointer handlers ignore events whose target is inside the
 *     tooltip — otherwise moving the cursor off the mark and onto the button
 *     would dismiss the tooltip before the click landed, and on touch the
 *     `pointerdown` on the button would unpin it before `click` fired. The
 *     action is an ENHANCEMENT, never the only route to the same navigation:
 *     charts that offer one also give each mark a focusable, labeled hit
 *     target so the keyboard reaches it without the tooltip.
 *   - Desktop (`pointerType !== "touch"` and `!== "pen"`): `pointermove`
 *     shows the tooltip for the nearest registered mark within a 24px hit
 *     radius. Coordinates are mapped between client (pointer-event) space
 *     and the `<svg>`'s own user/viewBox space via the browser's own
 *     Current Transformation Matrix (`svg.getScreenCTM()`/its inverse,
 *     applied through `createSVGPoint()`/`matrixTransform`) — exact under
 *     ANY `preserveAspectRatio`, including the SVG default `xMidYMid meet`
 *     (which letterboxes with a *centering translation*, not just a
 *     uniform stretch — a plain per-axis `getBoundingClientRect()`/viewBox
 *     ratio gets this wrong, not just imprecise, whenever the rendered box
 *     and the viewBox don't share an aspect ratio, e.g. a sparkline
 *     squeezed into a KPI tile) or non-uniform stretching under `"none"`.
 *     There is no requirement that a chart preserve its viewBox aspect
 *     ratio. The hand-rolled per-axis ratio is used only as a fallback
 *     when `getScreenCTM()` is unavailable or throws (e.g. jsdom, which
 *     doesn't implement SVG geometry APIs) — that fallback IS only exact
 *     under `preserveAspectRatio="none"`; leaving the wrapper hides it.
 *   - Touch (`pointerType === "touch"`, `"pen"` treated the same): a tap
 *     (`pointerdown`) shows and *pins* the nearest mark within the hit
 *     radius. A second tap elsewhere moves the pin to the new nearest mark;
 *     tapping the pinned mark again, tapping with no mark in range, or
 *     tapping anywhere outside the wrapper (a document-level listener that
 *     is attached only while pinned, and always removed on unpin/unmount)
 *     unpins it.
 *   - Independent per chart: every `useChartTooltip()` call owns its own
 *     refs/state, so multiple charts on one screen never interfere.
 *   - No listeners outlive the component: the only listener outside the
 *     wrapper element (the pinned-state document `pointerdown`) is
 *     added/removed by an effect keyed on the pinned flag, and is always
 *     cleaned up on unmount.
 *
 * Known limitation: this hook only wires pointer/touch events, per the
 * task's explicit requirements. It does not add keyboard focus handlers to
 * individual marks — screens that need keyboard-reachable tooltip content
 * must additionally expose the same values as visible text (direct labels,
 * a table view, etc.) or as focusable marks with their own `aria-label`,
 * consistent with "tooltips enhance, they never gate."
 *
 * ────────────────────────────────────────────────────────────────────────
 * ReferenceLine / ShadedBand / HatchDefs / useHatchId / TrendChip
 * ────────────────────────────────────────────────────────────────────────
 * Small SVG fragments: `ReferenceLine`/`ShadedBand` render against the
 * recessive `--chart-grid` token (a shaded band is that same token at low
 * opacity — no new hardcoded color); `HatchDefs` renders one `<pattern>` for
 * hatched fills (a partial week, a moved workout) — reference it with
 * `fill={`url(#${id})`}`.
 *
 * The pattern id is a REQUIRED prop, generated per chart instance by
 * `useHatchId()`. It used to be the fixed string "chartHatch", which meant
 * rendering `<HatchDefs />` more than once on a screen produced duplicate DOM
 * ids — and the Insights screen draws three hatch patterns already:
 * `WeeklyDurationChart` (one, for partial weeks) and `OutcomeBar` (two, one
 * per direction, for moved and skipped). `ConsistencyHeatmap` does NOT hatch;
 * its skipped cells carry a drawn slash glyph, not a pattern fill.
 *
 * `useHatchId()` is built on React's `useId`, with the colons stripped: a
 * React id is unique per component instance and stable across renders, but
 * its default form (":r3:") is awkward inside `url(#…)` and unusable with
 * `querySelector` without escaping. The uniqueness `useId` promises is
 * per React ROOT, which is exactly the scope that matters here (this app
 * mounts one) — two independent roots on one page could collide, so mount a
 * second root only with that in mind. Charts therefore stay self-contained —
 * no chart depends on another having rendered the defs first, which would
 * fail OPEN rather than loud (an unresolvable `url(#…)` paints nothing at
 * all). `angle` rotates the hatch, so two patterns on one screen can differ
 * by direction as well as by base fill.
 *
 * `TrendChip` is built on the existing `.pill`/`.pill-ok`/`.pill-danger`/
 * `.pill-neutral` vocabulary: the pill's tinted `color` carries good/bad
 * valence and the glyph inherits it, but the percent *text* is pinned back
 * to the ink token — text never wears a status color (see `.trend-chip` in
 * styles.css).
 */

// ── niceTicks ──────────────────────────────────────────────────────────────

const NICE_FRACTIONS = [1, 2, 2.5, 5, 10];
// Geometric-mean cutovers between consecutive nice fractions: sqrt(1*2),
// sqrt(2*2.5), sqrt(2.5*5), sqrt(5*10). A residual at or below cutover[i]
// snaps to fraction[i].
const NICE_CUTOVERS = [Math.sqrt(2), Math.sqrt(5), Math.sqrt(12.5), Math.sqrt(50)];

function pickNiceStep(roughStep: number): { step: number; decimals: number } {
  const safe = Math.max(roughStep, Number.EPSILON);
  const exponent = Math.floor(Math.log10(safe));
  const base = 10 ** exponent;
  const residual = safe / base;
  let fraction = NICE_FRACTIONS[NICE_FRACTIONS.length - 1]!;
  for (let i = 0; i < NICE_CUTOVERS.length; i++) {
    if (residual <= NICE_CUTOVERS[i]!) {
      fraction = NICE_FRACTIONS[i]!;
      break;
    }
  }
  // Decimal places needed to represent `fraction * base` exactly: the
  // fraction itself needs one decimal digit only when it's 2.5 (1, 2, 5, 10
  // are integers), then shifted by -exponent (a negative exponent pushes
  // the point left, adding digits; a positive one can only remove digits,
  // never below zero).
  const decimals = Math.max(0, (fraction === 2.5 ? 1 : 0) - exponent);
  return { step: fraction * base, decimals };
}

function roundToDecimals(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export function niceTicks(lo: number, hi: number, count = 3): number[] {
  if (lo === hi) return [lo];
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const { step, decimals } = pickNiceStep((max - min) / Math.max(1, count - 1));
  // A small epsilon nudges values that float-imprecision placed just to the
  // wrong side of an exact multiple of `step` back onto it before
  // floor/ceil — e.g. 1.0 / 0.1 is 9.999999999999998 in IEEE 754.
  const EPS = 1e-9;
  const startMult = Math.floor(min / step + EPS);
  const endMult = Math.ceil(max / step - EPS);
  const ticks: number[] = [];
  for (let m = startMult; m <= endMult; m++) {
    ticks.push(roundToDecimals(m * step, decimals));
  }
  return ticks;
}

// ── dateX ──────────────────────────────────────────────────────────────────

function parseIsoDateUtc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function dateX(dates: string[], innerW: number, left: number): (date: string) => number {
  const times = dates.map(parseIsoDateUtc);
  const lo = times.length ? Math.min(...times) : 0;
  const hi = times.length ? Math.max(...times) : 0;
  const span = hi - lo;
  const center = left + innerW / 2;
  return (date: string) => {
    if (span <= 0) return center;
    const t = parseIsoDateUtc(date);
    return left + ((t - lo) / span) * innerW;
  };
}

// ── rollingMedian ────────────────────────────────────────────────────────────

export function rollingMedian(values: number[], window = 5): number[] {
  // Clamped so a misuse-only negative/fractional `window` can't turn into a
  // negative half-width, which would make `i-k > i+k+1` and slice() return
  // an empty array — `slice[0]` would then be `undefined`, silently
  // breaking the number[] contract instead of just under/over-smoothing.
  const half = Math.max(0, Math.floor(window / 2));
  const n = values.length;
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.min(half, i, n - 1 - i);
    const slice = values.slice(i - k, i + k + 1).sort((a, b) => a - b);
    out[i] = slice[Math.floor(slice.length / 2)]!;
  }
  return out;
}

// ── useChartTooltip ──────────────────────────────────────────────────────────

const HIT_RADIUS_PX = 24;

export interface ChartMark {
  x: number;
  y: number;
  label: string;
  /** Optional call-to-action rendered as a button inside the tooltip. */
  action?: { label: string; onClick: () => void };
}

export interface ChartTooltipHandle {
  wrapperProps: {
    // `RefObject<HTMLDivElement>` (not `| null`): React's RefObject is
    // covariant in T, so a `RefObject<HTMLDivElement | null>` is NOT
    // assignable to the `ref` prop of a <div> even though the two are
    // structurally identical — spreading wrapperProps would not typecheck.
    ref: RefObject<HTMLDivElement>;
    className: string;
    style: CSSProperties;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerLeave: (e: ReactPointerEvent<HTMLDivElement>) => void;
  };
  tooltip: ReactElement | null;
  registerMarks: (marks: ChartMark[]) => void;
}

interface ActiveTip {
  mark: ChartMark;
  pinned: boolean;
}

/**
 * Fallback-only per-axis approximation: the `<svg>`'s current on-screen
 * rect and a naive viewBox-per-CSS-px scale computed independently for x
 * and y. This is exact ONLY under `preserveAspectRatio="none"` (a uniform
 * stretch to fill the box) — it ignores the centering translation
 * `xMidYMid meet` (the SVG default) applies when the rendered box's aspect
 * ratio doesn't match the viewBox's, so it's wrong (a real mismatch, not
 * just imprecise) for a letterboxed chart. Used only when `svgCtm` below
 * is unavailable.
 */
interface SvgScale {
  rect: DOMRect;
  vb: SVGRect;
  scaleX: number;
  scaleY: number;
}

interface ViewBoxPoint {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

function firstSvg(wrapper: HTMLDivElement | null): SVGSVGElement | null {
  return wrapper?.querySelector("svg") ?? null;
}

/**
 * The `<svg>`'s Current Transformation Matrix — the browser's own mapping
 * between its user space (viewBox coordinates) and screen space (the same
 * coordinate system as pointer events / `getBoundingClientRect`). Exact
 * under ANY `preserveAspectRatio` (it bakes in whatever scale *and*
 * translation `meet`/`slice`/`none` actually produced) and under any
 * ancestor CSS transform — unlike `measureSvgScale`'s hand-rolled ratio.
 * `null` if the element has no box yet, or in an environment that doesn't
 * implement SVG geometry APIs (e.g. jsdom, which throws rather than
 * returning null — caught here so both behave the same way to callers).
 */
function svgCtm(svg: SVGSVGElement): DOMMatrix | null {
  try {
    return svg.getScreenCTM();
  } catch {
    return null;
  }
}

function measureSvgScale(svg: SVGSVGElement): SvgScale | null {
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const vb = svg.viewBox.baseVal;
  const vbWidth = vb.width || rect.width;
  const vbHeight = vb.height || rect.height;
  return { rect, vb, scaleX: vbWidth / rect.width, scaleY: vbHeight / rect.height };
}

function toViewBox(svg: SVGSVGElement, clientX: number, clientY: number): ViewBoxPoint | null {
  const ctm = svgCtm(svg);
  if (ctm) {
    const inv = ctm.inverse();
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const u = pt.matrixTransform(inv);
    // The linear (non-translating) part of the inverse CTM turns a
    // screen-space length into a viewBox-space one, per axis — exact for
    // the scale+translate transforms preserveAspectRatio produces (chart
    // markup never rotates/skews the <svg>).
    return { x: u.x, y: u.y, scaleX: Math.abs(inv.a), scaleY: Math.abs(inv.d) };
  }
  // Fallback (jsdom, or a detached/zero-size svg) — see SvgScale's caveat.
  const s = measureSvgScale(svg);
  if (!s) return null;
  return {
    x: (clientX - s.rect.left) * s.scaleX + s.vb.x,
    y: (clientY - s.rect.top) * s.scaleY + s.vb.y,
    scaleX: s.scaleX,
    scaleY: s.scaleY,
  };
}

function sameMark(a: ChartMark, b: ChartMark): boolean {
  return a.x === b.x && a.y === b.y && a.label === b.label;
}

/** True for a pointer event that originated inside the tooltip itself. */
function fromTooltip(e: ReactPointerEvent): boolean {
  return e.target instanceof Element && e.target.closest(".chart-tip") != null;
}

/**
 * Nearest mark to (x, y), searching only within an elliptical hit radius of
 * `hitRadiusX` by `hitRadiusY` viewBox units — i.e. the per-axis-scaled
 * equivalent of a true circular CSS-pixel hit radius on screen, so a chart
 * with a non-uniform viewBox scale still gets a fair circular hit target.
 */
function nearestMark(
  marks: readonly ChartMark[],
  x: number,
  y: number,
  hitRadiusX: number,
  hitRadiusY: number,
): ChartMark | null {
  let best: ChartMark | null = null;
  let bestD = 1; // normalized distance^2; 1 is exactly at the hit-radius boundary
  for (const m of marks) {
    const nx = (m.x - x) / hitRadiusX;
    const ny = (m.y - y) / hitRadiusY;
    const d = nx * nx + ny * ny;
    if (d <= bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

function isTouchLike(e: ReactPointerEvent): boolean {
  return e.pointerType === "touch" || e.pointerType === "pen";
}

export function useChartTooltip(): ChartTooltipHandle {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const marksRef = useRef<ChartMark[]>([]);
  const [active, setActive] = useState<ActiveTip | null>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);

  const registerMarks = (marks: ChartMark[]): void => {
    marksRef.current = marks;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (isTouchLike(e)) return;
    // Reaching for the tooltip's own action button must not dismiss it.
    if (fromTooltip(e)) return;
    const svg = firstSvg(wrapperRef.current);
    if (!svg) return;
    const pos = toViewBox(svg, e.clientX, e.clientY);
    if (!pos) return;
    const mark = nearestMark(marksRef.current, pos.x, pos.y, HIT_RADIUS_PX * pos.scaleX, HIT_RADIUS_PX * pos.scaleY);
    setActive((cur) => {
      if (!mark) return null;
      // Same mark as last event, still unpinned -> keep the same object
      // reference so React (and the position-measuring effect below, which
      // is keyed on `active`) skip work on every no-op pointermove instead
      // of re-rendering on every single event a mark happens to be under.
      if (cur && !cur.pinned && sameMark(cur.mark, mark)) return cur;
      return { mark, pinned: false };
    });
  };

  const onPointerLeave = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (isTouchLike(e)) return;
    setActive((cur) => (cur && !cur.pinned ? null : cur));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!isTouchLike(e)) return;
    // Tapping the tooltip's action button must not unpin (and unmount) it
    // before the click event that button is waiting for ever fires.
    if (fromTooltip(e)) return;
    const svg = firstSvg(wrapperRef.current);
    const pos = svg ? toViewBox(svg, e.clientX, e.clientY) : null;
    const mark = pos
      ? nearestMark(marksRef.current, pos.x, pos.y, HIT_RADIUS_PX * pos.scaleX, HIT_RADIUS_PX * pos.scaleY)
      : null;
    setActive((cur) => {
      if (cur?.pinned && mark && sameMark(cur.mark, mark)) return null; // tap the pinned mark again -> unpin
      if (mark) return { mark, pinned: true }; // tap a (different) mark -> show + pin it
      return null; // tap with nothing in hit range -> unpin
    });
  };

  // "Tapping ... outside the svg unpins": attached only while pinned, torn
  // down the instant it isn't (including on unmount) — never a listener
  // that outlives the pinned state.
  useEffect(() => {
    if (!active?.pinned) return;
    const handleOutside = (e: PointerEvent): void => {
      const wrapper = wrapperRef.current;
      if (wrapper && e.target instanceof Node && !wrapper.contains(e.target)) {
        setActive(null);
      }
    };
    document.addEventListener("pointerdown", handleOutside);
    return () => document.removeEventListener("pointerdown", handleOutside);
  }, [active?.pinned]);

  // Re-measure the tooltip's screen position whenever the active mark
  // changes — a fresh read, not a stored/stale scale, so a resize between
  // hovers doesn't leave it misplaced. (Since `active` now only changes
  // reference on a genuine mark transition — see onPointerMove above —
  // this effect no longer re-runs on every no-op pointermove either.)
  useLayoutEffect(() => {
    if (!active) {
      setTipPos(null);
      return;
    }
    const wrapper = wrapperRef.current;
    const svg = firstSvg(wrapper);
    if (!wrapper || !svg) {
      setTipPos(null);
      return;
    }
    const wrapperRect = wrapper.getBoundingClientRect();
    const ctm = svgCtm(svg);
    if (ctm) {
      const pt = svg.createSVGPoint();
      pt.x = active.mark.x;
      pt.y = active.mark.y;
      const c = pt.matrixTransform(ctm); // viewBox space -> screen/client space, forward
      setTipPos({ left: c.x - wrapperRect.left, top: c.y - wrapperRect.top });
      return;
    }
    // Fallback (jsdom, or a detached/zero-size svg) — see SvgScale's caveat.
    const s = measureSvgScale(svg);
    if (!s) {
      setTipPos(null);
      return;
    }
    setTipPos({
      left: s.rect.left - wrapperRect.left + (active.mark.x - s.vb.x) / s.scaleX,
      top: s.rect.top - wrapperRect.top + (active.mark.y - s.vb.y) / s.scaleY,
    });
  }, [active]);

  const action = active?.mark.action;
  const tooltip: ReactElement | null =
    active && tipPos ? (
      <div
        className={`chart-tip${action ? " chart-tip-interactive" : ""}`}
        style={{ left: tipPos.left, top: tipPos.top }}
      >
        {active.mark.label}
        {action ? (
          <button type="button" className="chart-tip-action" onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </div>
    ) : null;

  return {
    wrapperProps: {
      ref: wrapperRef,
      className: "chart-tip-wrap",
      style: { position: "relative" },
      onPointerMove,
      onPointerDown,
      onPointerLeave,
    },
    tooltip,
    registerMarks,
  };
}

// ── SVG fragments ────────────────────────────────────────────────────────────

const CHART_GRID = "var(--chart-grid)";

/**
 * `emphasis` lifts the line off the grid: an anchor the reader is meant to
 * measure against (zero, a 4-week average) drawn at grid weight in the grid
 * token is indistinguishable from a gridline, so it stops being a reference
 * at all. Recessive by default — most reference lines are context, not
 * subject.
 */
export function ReferenceLine({
  x1,
  x2,
  y,
  label,
  dashed = false,
  emphasis = false,
}: {
  x1: number;
  x2: number;
  y: number;
  label?: string;
  dashed?: boolean;
  emphasis?: boolean;
}) {
  return (
    <g>
      <line
        x1={x1}
        x2={x2}
        y1={y}
        y2={y}
        stroke={emphasis ? "var(--ink-faint)" : CHART_GRID}
        strokeWidth={emphasis ? 1.5 : 1}
        strokeDasharray={dashed ? "4 3" : undefined}
      />
      {label ? (
        <text x={x2} y={y - 4} textAnchor="end" fontSize={9.5} fill="var(--ink-faint)">
          {label}
        </text>
      ) : null}
    </g>
  );
}

export function ShadedBand({ x1, x2, y1, y2 }: { x1: number; x2: number; y1: number; y2: number }) {
  return (
    <rect
      x={Math.min(x1, x2)}
      y={Math.min(y1, y2)}
      width={Math.abs(x2 - x1)}
      height={Math.abs(y2 - y1)}
      fill={CHART_GRID}
      opacity={0.35}
    />
  );
}

/**
 * A pattern id unique to this component instance — see the file header for
 * why the id can't be a shared constant. `useId` gives uniqueness and
 * render-stability for free; the non-alphanumerics are stripped because
 * React's default form (":r3:") is awkward inside `url(#…)`.
 */
export function useHatchId(): string {
  return `chartHatch${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

/** Reference the pattern via ``fill={`url(#${id})`}``; get `id` from `useHatchId()`. */
export function HatchDefs({
  id,
  angle = 45,
  stroke = CHART_GRID,
}: {
  id: string;
  angle?: number;
  stroke?: string;
}) {
  return (
    <defs>
      <pattern
        id={id}
        width={6}
        height={6}
        patternTransform={`rotate(${angle})`}
        patternUnits="userSpaceOnUse"
      >
        <line x1={0} y1={0} x2={0} y2={6} stroke={stroke} strokeWidth={1.5} />
      </pattern>
    </defs>
  );
}

// ── TrendChip ────────────────────────────────────────────────────────────────

const VALENCE_PILL = { good: "pill-ok", bad: "pill-danger", flat: "pill-neutral" } as const;

export function TrendChip({ pct, betterWhen }: { pct: number; betterWhen: "up" | "down" }) {
  const direction: "up" | "down" | "flat" = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const valence: "good" | "bad" | "flat" =
    direction === "flat" ? "flat" : direction === betterWhen ? "good" : "bad";
  const glyph = direction === "up" ? "▲" : direction === "down" ? "▼" : "–";
  const sign = direction === "up" ? "+" : direction === "down" ? "−" : "";
  const text = `${sign}${Math.abs(pct).toFixed(1)}%`;
  const valenceLabel = valence === "good" ? "improved" : valence === "bad" ? "worsened" : "unchanged";

  return (
    <span className={`pill ${VALENCE_PILL[valence]} trend-chip`} aria-label={`${text}, ${valenceLabel}`}>
      <span className="trend-chip-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="trend-chip-value">{text}</span>
    </span>
  );
}
