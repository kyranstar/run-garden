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
  /**
   * The signed magnitude behind `value`, in the metric's own unit — pacing is
   * seconds per kilometre, positive = faded (second half slower). Present so a
   * chart can plot the number instead of parsing it back out of the display
   * string; its sign always agrees with `over`.
   */
  delta?: number;
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

/**
 * The numeric baseline and noise band behind a `series`, for the drilldown's
 * baseline-band chart. **In the same units as `series`** — which is NOT always
 * the units of `gauge`: HRV's gauge is drawn in percent-vs-baseline while its
 * series is milliseconds, so the gauge's `healthyLo`/`healthyHi` cannot be
 * reused as the band and the numbers have to travel separately.
 *
 * `lo`/`hi` are absolute edges rather than a percentage because the two
 * metrics that carry them derive their band differently: HRV's is ±N% of the
 * baseline (N from the reader's own variability), resting HR's is a flat ±5
 * bpm. A single percentage couldn't express both honestly.
 */
export interface MetricBaseline {
  value: number;
  lo: number;
  hi: number;
  unit: string;
}

export interface InterpretedMetric {
  id: string;
  title: string;
  status: "ok" | "insufficient_data";
  value?: string;
  band?: Band;
  /** What the band's pill SAYS, when severity vocabulary would mislead —
   * "Easy-running share 29%" is an alert-level band whose honest label is
   * "Low", not "High". Absent → the UI's default label for the band. */
  bandLabel?: string;
  range?: string;
  meaning: string;
  suggestion?: string;
  sampleNote: string;
  trend?: { direction: "up" | "down" | "flat"; better: "up" | "down" | "either" };
  /** Band edges for the inline bullet gauge; set whenever `band` is set. */
  gauge?: MetricGauge;
  /** Daily sparkline points (recovery metrics). */
  series?: MetricSeriesPoint[];
  /** Baseline + noise band for `series`, in the series' own units. */
  baseline?: MetricBaseline;
  /** Boolean strip cells (hardStack days, easyDiscipline run ticks). */
  strip?: MetricStripCell[];
  /**
   * Set when the newest reading is old enough that the headline number
   * describes the past rather than the present. A card with a `staleNote`
   * carries no `band`: it is still shown, but it makes no claim about today.
   */
  staleNote?: string;
  /**
   * Set when the metric declines to claim a band because the claim would not
   * survive its own input's error bar — e.g. the low-intensity band flips
   * within ±5 bpm of an estimated easy ceiling (audit#2 (a4)). Like
   * `staleNote`, a card carrying this has `band: undefined`: the number is
   * still shown, the verdict is withheld — and the status strip must never
   * headline it.
   */
  bandNote?: string;
  /** Per-run evidence for the drilldown sheet, when the metric has it. */
  detail?: MetricDetail;
  /** Strain & answer (0020): each training day paired with the night that
   * followed it, oldest first. `load` null = no training that day; `value`
   * null = the night went unread. Renders as the two-lane chart. */
  pairs?: Array<{ date: string; load: number | null; value: number | null }>;
  /** Nightly sleep evidence (0020) — duration + stages when known. */
  nights?: Array<{
    date: string;
    totalSeconds: number;
    deepSeconds?: number | null;
    remSeconds?: number | null;
    lightSeconds?: number | null;
  }>;
}

/** What a metric's `present` callback returns for the "ok" case. */
export interface Presentation {
  value: string;
  band?: Band;
  bandLabel?: string;
  range?: string;
  meaning: string;
  suggestion?: string;
  trend?: { direction: "up" | "down" | "flat"; better: "up" | "down" | "either" };
  gauge?: MetricGauge;
  series?: MetricSeriesPoint[];
  baseline?: MetricBaseline;
  strip?: MetricStripCell[];
  staleNote?: string;
  bandNote?: string;
  pairs?: InterpretedMetric["pairs"];
  nights?: InterpretedMetric["nights"];
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
    bandLabel: p.bandLabel,
    range: p.range,
    meaning: p.meaning,
    suggestion: p.suggestion,
    sampleNote: m.comparisonNote,
    trend: p.trend,
    gauge: p.gauge,
    series: p.series,
    baseline: p.baseline,
    strip: p.strip,
    staleNote: p.staleNote,
    bandNote: p.bandNote,
    pairs: p.pairs,
    nights: p.nights,
  };
}
