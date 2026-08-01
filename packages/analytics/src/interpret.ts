import type { MetricResult } from "./metric.js";

/**
 * The educational wrapper around a computed metric: what it is, your number, a
 * healthy range and where you fall, a gentle "this tends to suggest…", and an
 * honest sample note. Suppressed metrics keep no value — only the honest note.
 */

export type Band = "low" | "healthy" | "high" | "watch";

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
}

/** What a metric's `present` callback returns for the "ok" case. */
export interface Presentation {
  value: string;
  band?: Band;
  range?: string;
  meaning: string;
  suggestion?: string;
  trend?: { direction: "up" | "down" | "flat"; better: "up" | "down" | "either" };
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
  };
}
