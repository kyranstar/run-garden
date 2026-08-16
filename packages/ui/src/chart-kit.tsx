import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement, RefObject } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/**
 * Chart kit — the shared, dependency-free building blocks every chart in the
 * app is built from. B2/B3/B4 import these exports by name; changing a
 * signature here is a breaking change for those screens.
 *
 * TWO layers consume this file, not one: `charts.tsx` (Insights) and
 * `screens/plan-charts.tsx` (the studio modal's progressions). Anything both
 * need lives HERE — the sizing layer (`useMeasuredWidth`, `chartWidth`,
 * `svgStyle`, `labelStride`, `labelWidth`), the y axis (`GridLines`), the
 * reference marks (`ReferenceLine`, `VerticalReferenceLine`) — because the two
 * layers drifting apart is exactly how plan-charts.tsx kept a fixed 320-unit
 * viewBox and nine `fontSize="9"` through a migration that was supposed to
 * remove both from the app.
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
 * GridLines / ReferenceLine / VerticalReferenceLine / ShadedBand / HatchDefs /
 * useHatchId / TrendChip
 * ────────────────────────────────────────────────────────────────────────
 * Small SVG fragments: `GridLines` is the y axis (a receding gridline per tick
 * and its value in the left gutter at `CHART_LABEL_PX`);
 * `ReferenceLine`/`ShadedBand` render against the
 * recessive `--chart-grid` token (a shaded band is that same token at low
 * opacity — no new hardcoded color); `VerticalReferenceLine` is the same
 * contract turned ninety degrees, for a landmark on the x axis (race day);
 * `HatchDefs` renders one `<pattern>` for
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

// ── The sizing layer (System 3 §B) ──────────────────────────────────────────

/**
 * ONE type size for every label a chart prints, in CSS pixels — and it really
 * is CSS pixels, because `chartWidth` below makes each chart's viewBox 1:1
 * with the box it renders into.
 *
 * What this replaces: fifteen `fontSize` declarations of 8, 9, 9.5 and 10
 * *viewBox units* inside fixed 560/420-unit viewBoxes that were then scaled
 * by `width: 100%`. The scale factor was the container's width over the
 * viewBox's, so the same label measured 9 CSS px in a one-column layout at
 * 719px, 5.0 CSS px the moment a second column appeared at 720px, and 5.2 CSS
 * px on a phone. A chart got LESS readable as the layout got roomier, which
 * is the exact opposite of what a breakpoint is for.
 */
export const CHART_LABEL_PX = 10;

/**
 * The narrowest viewBox a chart will build. Below this the geometry stops
 * being a chart (a 40px left gutter out of 200 is most of the plot), so the
 * SVG is allowed to scale down instead — the same behaviour as before, but
 * only in a box no real layout produces. The narrowest real container in the
 * app is a 390px phone: 390 − 2×16 shell padding − 2×16 card padding = 326.
 */
export const CHART_MIN_WIDTH = 240;

/**
 * The strip every chart reserves ABOVE its plot, and the text baseline inside
 * it. Annotations that are NOT data — the unit, a reference line's label —
 * live here; nothing else does.
 *
 * Why a reserved strip rather than "put the label somewhere quiet in the
 * plot": now that a chart's geometry shrinks to its container while its type
 * stays at `CHART_LABEL_PX`, a label is a FIXED number of pixels laid over a
 * VARIABLE number of pixels of plot. "4-wk avg 2.8h" is 66px: 12% of a 560px
 * desktop chart and 20% of a 324px phone one. Any in-plot anchor is therefore
 * only as safe as the data behind it happens to be — and the two anchors that
 * look safest (the end of a line, the top of a plot) are exactly where a
 * rising-load bar chart puts its tallest bars.
 *
 * The other two gutters can't take it. The left one is 40 units wide and 34 of
 * those are spoken for by the y tick labels ("2.0h" right-aligned at
 * `M.left − 6`), which leaves 6; the bottom one belongs to the x labels. The
 * top strip is the only place with 250+ units of clear width at EVERY size the
 * layer produces, which is what makes this correct by construction instead of
 * correct for today's fixture.
 *
 * A chart that draws a labelled `ReferenceLine` must therefore start its plot
 * at `CHART_HEADER_H`. `reference labels live outside the plot` in
 * responsive.test.tsx measures that for every chart, at every width.
 */
export const CHART_HEADER_H = 24;

/** 8 units of air between the annotation's baseline and the plot's top edge. */
export const CHART_HEADER_BASELINE = CHART_HEADER_H - 8;

/**
 * The width a chart should build its geometry AND its viewBox at, given the
 * width its wrapper actually measured.
 *
 * The contract, and the whole point of the layer: the returned value is used
 * as BOTH the viewBox width and the SVG's `max-width`, so a chart renders at
 * exactly `width` CSS pixels and one viewBox unit is one CSS pixel. Labels
 * then land at `CHART_LABEL_PX` px regardless of viewport, column count, or
 * which of the three breakpoints is in force.
 *
 * `cap` is the chart's own design width (560 for a wide time series, 420 for
 * a compact one). Measuring can only make a chart NARROWER than that — a
 * 1440px window still gets the 560px line chart it has always got.
 *
 * `measured == null` is the pre-measurement frame (and the server render):
 * fall back to the cap, which is what shipped before this layer existed.
 */
export function chartWidth(measured: number | null, cap: number): number {
  if (measured == null || !Number.isFinite(measured) || measured <= 0) return cap;
  return Math.round(Math.min(cap, Math.max(CHART_MIN_WIDTH, measured)));
}

/**
 * The one style every chart SVG wears. `maxWidth` is ALWAYS the same number as
 * the viewBox width: that identity is what makes one viewBox unit one CSS
 * pixel, and therefore what makes every `fontSize={CHART_LABEL_PX}` land at 10
 * CSS px in a 285px modal column, a 326px phone card and a 560px desktop chart
 * alike.
 *
 * Passing a `maxWidth` that is not the viewBox width re-introduces the scale
 * factor this layer exists to remove; `charts sizing` in responsive.test.tsx
 * pins the two together for both chart layers.
 */
export const svgStyle = (viewBoxWidth: number) =>
  ({ width: "100%", maxWidth: viewBoxWidth, height: "auto", display: "block" }) as const;

/**
 * A GENEROUS advance-width estimate for `text` at `CHART_LABEL_PX`, in viewBox
 * units (= CSS px). The app's UI font measures ~0.50em per glyph at this size;
 * 0.62em is the same over-estimate `chart-annotations.test.ts` uses to draw its
 * text boxes, and for the same reason: everything that consumes this number is
 * deciding whether a label FITS, so erring wide can only add air.
 */
export const CHART_GLYPH_W = 0.62 * CHART_LABEL_PX;

export function labelWidth(text: string): number {
  return text.length * CHART_GLYPH_W;
}

/**
 * What a reference line's header label occupies, swatch and gap included — so
 * a chart with a SECOND thing in the strip (the plan charts print their unit
 * at the right end) can check that the two don't meet before drawing both.
 */
export function referenceLabelWidth(label: string): number {
  return REFERENCE_SWATCH_W + REFERENCE_SWATCH_GAP + labelWidth(label);
}

/**
 * How many labels fit along `innerW` at `CHART_LABEL_PX`, given the widest
 * label a chart prints (`labelW`). Charts used to stride their x labels by a
 * constant ("every ceil(n/8)"), which was tuned for a 560px viewBox and
 * collided the moment the same chart built itself at 326.
 */
export function labelStride(count: number, innerW: number, labelW: number): number {
  const fits = Math.max(2, Math.floor(innerW / labelW));
  return Math.max(1, Math.ceil(count / fits));
}

/**
 * The sizing layer's one measurement: the content width of `ref`'s element in
 * CSS pixels, or `null` before the first measurement (and on the server). Feed
 * it to `chartWidth`.
 *
 * `useLayoutEffect` (not `useEffect`) so the real width lands in the SAME
 * commit the box first paints in — measured in an ordinary effect the chart
 * paints once at its fallback width and then jumps, which on a phone is a
 * visible 560→326 resize of every chart on the page. `ResizeObserver` rather
 * than a window resize listener because most of what changes a chart's box is
 * not a window resize: a column count flipping at a breakpoint, a drilldown
 * sheet opening, the coach window claiming its gutter, a modal animating in.
 *
 * `useChartTooltip` calls this for its own wrapper; a chart with no tooltip
 * (the plan progressions) calls it directly on the box that wraps its `<svg>`.
 * Both get the same number the same way — there is one measurement mechanism
 * in the app, not one per chart layer.
 */
export function useMeasuredWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => {
      // `clientWidth` is the CONTENT box — padding excluded — which is the box
      // the SVG's `width: 100%` resolves against.
      const w = el.clientWidth;
      setMeasured((cur) => (w > 0 && w !== cur ? w : cur));
    };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, [ref]);
  return measured;
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
  /**
   * The wrapper's own content width in CSS pixels, or `null` before the first
   * measurement (and on the server). Feed it to `chartWidth` — see the sizing
   * layer above. It lives on THIS handle rather than in a second hook because
   * the wrapper div is already this hook's: it owns the ref, and a chart that
   * composed two refs onto the same node would be the third place in the file
   * that has to agree about which element is "the chart's box".
   */
  measured: number | null;
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
  // The sizing layer's measurement, on the wrapper this hook already owns.
  const measured = useMeasuredWidth(wrapperRef);

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
    measured,
  };
}

// ── SVG fragments ────────────────────────────────────────────────────────────

const CHART_GRID = "var(--chart-grid)";
const INK_FAINT = "var(--ink-faint)";

/** The line swatch that ties a header label to the line it names, plus its gap. */
const REFERENCE_SWATCH_W = 12;
const REFERENCE_SWATCH_GAP = 5;

/**
 * Where the header strip starts: the viewBox's own left edge, which — because
 * `svgStyle` pins `maxWidth` to the viewBox width and the SVG is a
 * left-aligned block — is the CARD's left edge, the same origin the HTML
 * series legend (`.chart-legend`) starts at.
 *
 * It used to be the PLOT's left edge (`M.left`, 40), which put a chart's two
 * keys on two different left margins: the series legend flush with the card
 * and the reference strip 40px in. Two keys, two origins, and the strip read
 * as a caption for something else. One left edge instead.
 */
export const CHART_STRIP_X = 0;

/**
 * One y axis, drawn the one way: a receding gridline per tick and its value
 * right-aligned in the left gutter at the ONE type size. It lives here rather
 * than in charts.tsx because both chart layers draw it — the Insights charts
 * and the plan progressions — and a second copy is how the two layers drifted
 * apart in the first place.
 */
export function GridLines({
  ticks,
  y,
  x1,
  x2,
  format,
}: {
  ticks: number[];
  y: (v: number) => number;
  x1: number;
  x2: number;
  format: (v: number) => string;
}) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x1} x2={x2} y1={y(t)} y2={y(t)} stroke={CHART_GRID} strokeWidth={1} />
          <text x={x1 - 6} y={y(t) + 3.5} textAnchor="end" fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            {format(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

interface ReferenceStyle {
  stroke: string;
  strokeWidth: number;
  strokeDasharray: string | undefined;
}

/**
 * A reference line is ALWAYS heavier than the grid: `--ink-faint` at 1.5
 * against the grid's `--chart-grid` at 1. `stroke` overrides the token
 * outright, for the one kind of reference line that is a LANDMARK rather than
 * context (race day, in `--chart-2`); the weight is the same either way.
 *
 * There used to be an `emphasis` flag here, defaulting to FALSE — a reference
 * line drawn in the grid token at grid weight, i.e. indistinguishable from a
 * gridline. Every caller but one passed `emphasis`; the one that didn't was
 * `BaselineBandChart`, whose baseline then sat inside a shaded band looking
 * exactly like the three gridlines around it while the header strip printed
 * "baseline 46" and a swatch in that same invisible stroke. The strip only
 * works if the reader can find the line it names, so the recessive branch is
 * gone rather than defaulted: a line nobody is meant to pick out should not be
 * a `ReferenceLine` at all.
 */
function referenceStyle(dashed: boolean, stroke?: string): ReferenceStyle {
  return {
    stroke: stroke ?? INK_FAINT,
    strokeWidth: 1.5,
    strokeDasharray: dashed ? "4 3" : undefined,
  };
}

/**
 * A reference line's name, printed in the chart's header strip: left-aligned
 * at `x` (`CHART_STRIP_X` — the card's edge, so the strip and the HTML series
 * legend share one left margin), behind a short swatch drawn in the line's
 * exact stroke, with a surface-coloured halo (`paint-order: stroke`) in case a
 * chart ever puts something behind it.
 *
 * The swatch mirrors the line's ORIENTATION — a horizontal dash for a
 * horizontal line, a pair of vertical ticks for a vertical one — so the key
 * says which mark it names without having to sit on it.
 */
function ReferenceLabel({
  x,
  label,
  style,
  vertical = false,
}: {
  x: number;
  label: string;
  style: ReferenceStyle;
  vertical?: boolean;
}) {
  const mid = CHART_HEADER_BASELINE - 3.5;
  return (
    <g>
      {vertical ? (
        <line
          x1={x + REFERENCE_SWATCH_W / 2}
          x2={x + REFERENCE_SWATCH_W / 2}
          y1={mid - 5}
          y2={mid + 5}
          stroke={style.stroke}
          strokeWidth={style.strokeWidth}
          strokeDasharray={style.strokeDasharray}
        />
      ) : (
        <line
          x1={x}
          x2={x + REFERENCE_SWATCH_W}
          y1={mid}
          y2={mid}
          stroke={style.stroke}
          strokeWidth={style.strokeWidth}
          strokeDasharray={style.strokeDasharray}
        />
      )}
      <text
        x={x + REFERENCE_SWATCH_W + REFERENCE_SWATCH_GAP}
        y={CHART_HEADER_BASELINE}
        fontSize={CHART_LABEL_PX}
        fill={INK_FAINT}
        paintOrder="stroke"
        stroke="var(--bg-raised)"
        strokeWidth={3}
        strokeLinejoin="round"
      >
        {label}
      </text>
    </g>
  );
}

/**
 * An anchor the reader is meant to measure against — zero, a 4-week average, a
 * baseline. It is always drawn heavier than the grid (see `referenceStyle`):
 * at grid weight in the grid token it stops being a reference at all, which is
 * exactly what happened to the one caller that left the old `emphasis` flag at
 * its default.
 *
 * The `label` does NOT ride on the line. It prints in the chart's header strip
 * (`CHART_HEADER_H`) at `CHART_STRIP_X` — the card's left edge, shared with the
 * HTML series legend — behind a swatch drawn in the line's exact stroke, so it
 * reads as a key to that line rather than as a stray caption. See
 * `CHART_HEADER_H` for why an in-plot label cannot be made safe now that the
 * plot resizes and the type does not: it used to sit at `x2, y − 4`,
 * right-aligned at the end of the line, and on a 324px phone that 66px caption
 * covered the last two bars of a rising-load chart.
 *
 * The surface-coloured halo (`paint-order: stroke`) is the house treatment for
 * a mark that may land on top of another — a belt, not the braces: the strip
 * is empty by construction, and the halo only pays off if a chart ever puts
 * something behind it.
 */
export function ReferenceLine({
  x1,
  x2,
  y,
  label,
  dashed = false,
}: {
  x1: number;
  x2: number;
  y: number;
  label?: string;
  dashed?: boolean;
}) {
  const style = referenceStyle(dashed);
  return (
    <g>
      <line x1={x1} x2={x2} y1={y} y2={y} {...style} />
      {label ? <ReferenceLabel x={CHART_STRIP_X} label={label} style={style} /> : null}
    </g>
  );
}

/**
 * The same contract turned ninety degrees: a vertical landmark at `x` spanning
 * `y1…y2`, whose label prints in the header strip rather than on the plot.
 *
 * The label goes at `CHART_STRIP_X`, not at the line's own `x`: race day is
 * usually the LAST week, and a label left-aligned at that x runs straight off
 * the right edge of the viewBox — which is what the plan charts did, clipping
 * "race · Aug 24" at every width the layer produces. It is the same origin
 * `ReferenceLine` uses, so a chart carrying both keeps one left edge.
 */
export function VerticalReferenceLine({
  x,
  y1,
  y2,
  label,
  dashed = false,
  stroke,
}: {
  x: number;
  y1: number;
  y2: number;
  label?: string;
  dashed?: boolean;
  /** A CSS custom property, for a landmark that is not grid context. */
  stroke?: string;
}) {
  const style = referenceStyle(dashed, stroke);
  return (
    <g>
      <line x1={x} x2={x} y1={y1} y2={y2} {...style} />
      {label ? <ReferenceLabel x={CHART_STRIP_X} label={label} style={style} vertical /> : null}
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

/**
 * Below this, a trend is flat. The chip prints one decimal place, so anything
 * under 0.05% renders as "0.0%" — and a green ▲ beside "0.0%" is a claim of
 * improvement the number itself doesn't make. `pct > 0` alone put an arrow and
 * a valence colour on 0.004% of drift.
 */
const TREND_FLAT_EPSILON = 0.05;

export function TrendChip({ pct, betterWhen }: { pct: number; betterWhen: "up" | "down" }) {
  const direction: "up" | "down" | "flat" =
    pct >= TREND_FLAT_EPSILON ? "up" : pct <= -TREND_FLAT_EPSILON ? "down" : "flat";
  const valence: "good" | "bad" | "flat" =
    direction === "flat" ? "flat" : direction === betterWhen ? "good" : "bad";
  const glyph = direction === "up" ? "▲" : direction === "down" ? "▼" : "–";
  const sign = direction === "up" ? "+" : direction === "down" ? "−" : "";
  const text = `${sign}${Math.abs(pct).toFixed(1)}%`;
  const valenceLabel = valence === "good" ? "improved" : valence === "bad" ? "worsened" : "no change";

  return (
    <span className={`pill ${VALENCE_PILL[valence]} trend-chip`} aria-label={`${text}, ${valenceLabel}`}>
      <span className="trend-chip-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="trend-chip-value">{text}</span>
    </span>
  );
}
