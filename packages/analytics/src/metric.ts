/**
 * Shared result shape for every analytics metric. Either the metric is
 * computable (with an explicit sample size and a plain-language note that
 * explains what was compared), or it is honestly suppressed with the sample
 * size that would be needed.
 */
export type MetricResult<T> =
  | { status: "ok"; value: T; sampleSize: number; comparisonNote: string }
  | { status: "insufficient_data"; needed: number; have: number; explanation: string };

export function ok<T>(value: T, sampleSize: number, comparisonNote: string): MetricResult<T> {
  return { status: "ok", value, sampleSize, comparisonNote };
}

export function insufficient<T>(needed: number, have: number, explanation: string): MetricResult<T> {
  return { status: "insufficient_data", needed, have, explanation };
}
