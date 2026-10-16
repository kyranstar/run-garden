/**
 * A KEY RESULT'S TREND over its window (Stage 3 Task 11), built from the chart kit as every chart in the app is: sized to
 * the box it is in (`useChartTooltip`'s measurement → `chartWidth`, one viewBox unit one CSS pixel), labels at the one
 * size, the target a dashed reference line keyed in the header strip, the unit at the strip's right end, and the shared
 * tooltip over each point.
 *
 * Marks: the key result's points joined in date order (a day's best, or a run); a point whose best came from a set its
 * prescription stopped is drawn open — "at least this" — and says so in its tooltip; the best ever, when it is one of
 * the points, wears a ring (`.obj-best-mark`). Colour is never the only signal: the card says the evidence and the best
 * in words beside the chart, and the SVG's own label reads the trend from its first point to its last.
 */
import type { KeyResultBest, KeyResultMeasure, KeyResultPoint, KeyResultUnit } from "@rg/domain";
import {
  CHART_HEADER_BASELINE,
  CHART_HEADER_H,
  CHART_LABEL_PX,
  chartWidth,
  dateX,
  GridLines,
  labelWidth,
  niceTicks,
  referenceLabelWidth,
  ReferenceLine,
  svgStyle,
  useChartTooltip,
  type ChartMark,
} from "../../chart-kit.js";
import { formatShortDate } from "../../components.js";
import { clock, formatKr } from "./objectives-model.js";

/** The chart's design width: a time series, as the kit's wide charts (a phone measures it narrower). */
const CAP = 560;
const HEIGHT = 128;
const M = { right: 10, bottom: 22, left: 48 };
const LINE = "var(--chart-1)";
const INK_FAINT = "var(--ink-faint)";

const isClockUnit = (unit: KeyResultUnit, m: KeyResultMeasure | null): boolean =>
  unit === "s/km" || unit === "s/mi" || (unit === "s" && (m?.kind === "run_best" || m?.kind === "predicted_time"));

/** A tick: a clock for times and paces, else the number. */
function tick(v: number, unit: KeyResultUnit, m: KeyResultMeasure | null): string {
  return isClockUnit(unit, m) ? clock(v) : String(Math.round(v * 100) / 100);
}

/** The unit printed at the strip's right end. */
function unitWord(unit: KeyResultUnit, m: KeyResultMeasure | null): string {
  if (unit === "s/km") return "/km";
  if (unit === "s/mi") return "/mi";
  if (isClockUnit(unit, m)) return "time";
  return unit === "score" ? "" : unit;
}

/**
 * The y scale over the points and the target, on round ticks — for a time or a pace, round in minutes (a quarter, a
 * half, a whole one…), never 25-second steps; a flat series widened, never divided by zero.
 */
function yScale(values: number[], top: number, innerH: number, clockAxis: boolean): { ticks: number[]; y: (v: number) => number } {
  const per = clockAxis ? 60 : 1;
  const lo = Math.min(...values) / per;
  const hi = Math.max(...values) / per;
  const nudge = Math.max(clockAxis ? 0.25 : 1, Math.abs(lo) * 0.05);
  let steps = niceTicks(lo, hi, 3);
  if (steps.length < 2) steps = niceTicks(lo - nudge, hi + nudge, 3);
  const ticks = steps.map((t) => (clockAxis ? Math.round(t * per) : t));
  const t0 = ticks[0]!;
  const span = ticks[ticks.length - 1]! - t0 || 1;
  return { ticks, y: (v: number) => top + innerH - ((v - t0) / span) * innerH };
}

/** "Wall sit hold: 80 s on Sep 20 to 95 s on Oct 12". */
export function trendWords(label: string, series: readonly KeyResultPoint[], unit: KeyResultUnit, m: KeyResultMeasure | null): string {
  const at = (p: KeyResultPoint) => `${p.capped ? "at least " : ""}${formatKr(p.display, unit, m)} on ${formatShortDate(p.date)}`;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  return series.length === 1 ? `${label}: ${at(first)}` : `${label}: ${at(first)} to ${at(last)}`;
}

export function KrTrendChart({
  label,
  series,
  unit,
  measure,
  target,
  best,
}: {
  label: string;
  series: readonly KeyResultPoint[];
  unit: KeyResultUnit;
  measure: KeyResultMeasure | null;
  target: number | null;
  /** The best ever, marked when it is one of the points. */
  best: KeyResultBest | null;
}) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const width = chartWidth(measured, CAP);
  const top = CHART_HEADER_H;
  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - top - M.bottom;
  const points = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const values = points.map((p) => p.display);
  const { ticks, y } = yScale(target !== null ? [...values, target] : values.length ? values : [0, 1], top, innerH, isClockUnit(unit, measure));
  const x = dateX(
    points.map((p) => p.date),
    innerW,
    M.left,
  );
  const say = (p: KeyResultPoint) => `${formatShortDate(p.date)}: ${p.capped ? "at least " : ""}${formatKr(p.display, unit, measure)}`;
  const marks: ChartMark[] = points.map((p) => ({ x: x(p.date), y: y(p.display), label: say(p) }));
  registerMarks(marks);
  if (points.length === 0) return null;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.date).toFixed(1)},${y(p.display).toFixed(1)}`).join(" ");
  const bestPoint = best ? points.find((p) => p.date === best.date && p.value === best.value) : undefined;
  const targetLabel = target !== null ? `target ${formatKr(target, unit, measure)}` : null;
  const unitText = unitWord(unit, measure);
  // The unit only where the strip has room beside the target's key.
  const unitFits = !targetLabel || referenceLabelWidth(targetLabel) + labelWidth(unitText) + 12 <= width;
  return (
    <div {...wrapperProps}>
      <svg role="img" aria-label={trendWords(label, points, unit, measure)} viewBox={`0 0 ${width} ${HEIGHT}`} style={svgStyle(width)}>
        <GridLines ticks={ticks} y={y} x1={M.left} x2={width - M.right} format={(t) => tick(t, unit, measure)} />
        {target !== null ? <ReferenceLine x1={M.left} x2={width - M.right} y={y(target)} label={targetLabel ?? undefined} dashed /> : null}
        {points.length > 1 ? <path d={path} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" /> : null}
        {points.map((p) => (
          <circle
            key={p.date}
            cx={x(p.date)}
            cy={y(p.display)}
            r={3.5}
            fill={p.capped ? "var(--bg-raised)" : LINE}
            stroke={LINE}
            strokeWidth={p.capped ? 1.5 : 0}
          />
        ))}
        {bestPoint ? (
          <circle className="obj-best-mark" cx={x(bestPoint.date)} cy={y(bestPoint.display)} r={7.5} fill="none" stroke="var(--chart-3)" strokeWidth={1.5} />
        ) : null}
        <text x={x(points[0]!.date)} y={HEIGHT - 6} fontSize={CHART_LABEL_PX} fill={INK_FAINT} textAnchor={points.length > 1 ? "start" : "middle"}>
          {formatShortDate(points[0]!.date)}
        </text>
        {points.length > 1 ? (
          <text x={x(points[points.length - 1]!.date)} y={HEIGHT - 6} textAnchor="end" fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            {formatShortDate(points[points.length - 1]!.date)}
          </text>
        ) : null}
        {unitText && unitFits ? (
          <text x={width - M.right} y={CHART_HEADER_BASELINE} textAnchor="end" fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            {unitText}
          </text>
        ) : null}
      </svg>
      {tooltip}
    </div>
  );
}
