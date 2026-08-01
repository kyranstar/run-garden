/** Formatting helpers for durations shown in UI and calendar bodies. */

/** "54 min", "1 h 19 min", "45 s" */
export function formatDurationShort(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "7:05 /km" from seconds-per-km. */
export function formatPace(secPerKm: number): string {
  const s = Math.round(secPerKm);
  const min = Math.floor(s / 60);
  const rem = (s % 60).toString().padStart(2, "0");
  return `${min}:${rem} /km`;
}

/** "8.2 km" or "800 m" */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km >= 10 ? km.toFixed(1) : km.toFixed(1)} km`;
}
