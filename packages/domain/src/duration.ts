/** Formatting helpers for durations shown in UI and calendar bodies. */

/**
 * A PRESCRIBED duration, in the words a coach writes it — the one vocabulary
 * for a workout stage's length.
 *
 * It exists because two places rendered that length independently, both as
 * `Math.round(seconds / 60)`: `summarizeStages` (which writes the stored
 * `planned_workouts.stage_summary`) and the client's stage tree. On an
 * interval session that arithmetic fails at exactly the two numbers the
 * session is about:
 *
 *   - a 15-second stride printed "0 min" — a prescription of nothing;
 *   - a 45-second recovery and a 60-second cooldown printed the same "1 min",
 *     so two different prescriptions were one string;
 *   - a 30s-on / 60s-off strides block printed "1 min / 1 min", turning a
 *     1:2 work:rest ratio into 1:1.
 *
 * Measured over the athlete's whole library (2026-08-17, prod): of 244
 * time-based stages, 42 are under a minute (15s ×10, 30s ×10, 45s ×12) and 13
 * are 90s. So 55 of 244 printed a wrong number and 10 printed zero — and the
 * sub-minute stages are all work and recovery inside repeats, i.e. the
 * prescription itself, never the warm-up.
 *
 * The rule:
 *   under a minute            → seconds       "15s", "45s"
 *   a whole number of minutes → minutes       "1 min", "40 min"
 *   90s or less otherwise     → seconds       "90s"   (the interval idiom)
 *   longer and uneven         → mm:ss         "1:45", "2:30"
 *
 * Whole minutes are spelled exactly as they always were — 181 of those 244
 * stages — so this correction only ever changes a number that was wrong.
 * Deliberately no hour rollover: a stage is one step of a session, and the
 * longest one prod has ever stored is 40 min. Session TOTALS are a different
 * quantity with a different formatter (`formatMinutes`, which rolls at 90).
 */
export function formatStageDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s % 60 === 0) return `${s / 60} min`;
  if (s <= 90) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "54 min", "1 h 19 min", "45s" — an ELAPSED span, so it rolls into hours.
 * Sub-minute is spelled by `formatStageDuration`: two spellings of 45 seconds
 * in one file is precisely the drift this module exists to prevent. */
export function formatDurationShort(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return formatStageDuration(s);
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
