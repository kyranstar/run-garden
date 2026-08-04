import type { MetricResult } from "./metric.js";

/**
 * The educational wrapper around a computed metric: what it is, your number, a
 * healthy range and where you fall, a gentle "this tends to suggest…", and an
 * honest sample note. Suppressed metrics keep no value — only the honest note.
 */

export type Band = "low" | "healthy" | "high" | "watch";

/** One lap inside a drilldown run — for the per-lap HR bars. */
export interface MetricLapDetail {
  lapIndex: number;
  avgHr?: number;
  durationSeconds?: number;
  distanceMeters?: number;
  /** True when this lap breached the metric's threshold (highlighted red). */
  over?: boolean;
}

/** One contributing run inside a metric's drilldown. */
export interface MetricRunDetail {
  activityId: string;
  date: string;
  title?: string;
  /** The run's headline number for this metric ("avg 162 bpm", "+12 s/km"). */
  value?: string;
  /** True when this run counted against the metric. */
  over?: boolean;
  /** One-sentence verdict for the run ("above your easy ceiling of 155"). */
  note?: string;
  laps?: MetricLapDetail[];
}

/** The evidence behind a metric: what it's measured against, run by run. */
export interface MetricDetail {
  explain: string;
  threshold?: { label: string; value: number; unit?: string };
  runs: MetricRunDetail[];
}

/**
 * Numeric band edges for a bullet gauge. `min`/`max` are the drawn extent of
 * the track (a value outside them is the renderer's problem to clamp, not a
 * reason to lie about the number); `healthyLo`/`healthyHi` bound the shaded
 * healthy band; `value` is the marker. Present only on banded metrics —
 * a metric with no band has nothing honest to shade.
 */
export interface MetricGauge {
  min: number;
  max: number;
  healthyLo: number;
  healthyHi: number;
  value: number;
}

/** One daily point of a metric's sparkline (resting HR, HRV). */
export interface MetricSeriesPoint {
  date: string;
  value: number;
}

/**
 * One cell of a boolean strip: hard/easy days (hardStack) or per-run
 * easy/over ticks (easyDiscipline). `on` means the highlighted state — a hard
 * day, or an easy run that stayed easy.
 */
export interface MetricStripCell {
  date: string;
  on: boolean;
}

export interface InterpretedMetric {
  id: string;
  title: string;
  status: "ok" | "insufficient_data";
  value?: string;
  band?: Band;
  range?: string;
  meaning: string;
  suggestion?: string;
  sampleNote: string;
  trend?: { direction: "up" | "down" | "flat"; better: "up" | "down" | "either" };
  /** Band edges for the inline bullet gauge; set whenever `band` is set. */
  gauge?: MetricGauge;
  /** Daily sparkline points (recovery metrics). */
  series?: MetricSeriesPoint[];
  /** Boolean strip cells (hardStack days, easyDiscipline run ticks). */
  strip?: MetricStripCell[];
  /**
   * Set when the newest reading is old enough that the headline number
   * describes the past rather than the present. A card with a `staleNote`
   * carries no `band`: it is still shown, but it makes no claim about today.
   */
  staleNote?: string;
  /** Per-run evidence for the drilldown sheet, when the metric has it. */
  detail?: MetricDetail;
}

/** What a metric's `present` callback returns for the "ok" case. */
export interface Presentation {
  value: string;
  band?: Band;
  range?: string;
  meaning: string;
  suggestion?: string;
  trend?: { direction: "up" | "down" | "flat"; better: "up" | "down" | "either" };
  gauge?: MetricGauge;
  series?: MetricSeriesPoint[];
  strip?: MetricStripCell[];
  staleNote?: string;
}

export function interpret<T>(
  id: string,
  title: string,
  m: MetricResult<T>,
  present: (value: T) => Presentation,
): InterpretedMetric {
  if (m.status === "insufficient_data") {
    return {
      id,
      title,
      status: "insufficient_data",
      meaning: m.explanation,
      sampleNote: `Need ${m.needed}; have ${m.have}.`,
    };
  }
  const p = present(m.value);
  return {
    id,
    title,
    status: "ok",
    value: p.value,
    band: p.band,
    range: p.range,
    meaning: p.meaning,
    suggestion: p.suggestion,
    sampleNote: m.comparisonNote,
    trend: p.trend,
    gauge: p.gauge,
    series: p.series,
    strip: p.strip,
    staleNote: p.staleNote,
  };
}
