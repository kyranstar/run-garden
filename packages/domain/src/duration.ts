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

/**
 * A PRESCRIBED distance, in the words a coach writes it — the companion to
 * `formatStageDuration`, and for the same reason.
 *
 * FOUR formatters used to answer this, and a 262-test cross-surface harness
 * caught all four describing one session (measured 2026-08-17):
 *
 *   approval card (`describeOps`)   800 m · 400 m · 1 km · 1.61 km · 457 m
 *   stored `stage_summary`          0.8km · 0.4km · 1.0km · 1.6km · 0.5km
 *   session sheet (stage rows)      800 m · 400 m · 1 km · 1.6 km · 457 m
 *
 * The stored column is the loudest defect — `(value/1000).toFixed(1) + "km"`
 * is the "0.0km for a 40 m rep" class already fixed for durations, and it is
 * the string Today, the week list AND the coach's own dossier all read, so a
 * 400 m rep was prescribed to the athlete and quoted to the model as "0.4km".
 * The other two differ by one decimal, on the pair that was supposed to agree:
 * a mile reads 1.61 km on the card you approve and 1.6 km on the sheet you
 * open next. Small, and exactly the kind of small that makes an athlete stop
 * and work out which one to run.
 *
 * THE APPROVAL CARD WINS, deliberately: it is the string the athlete agreed
 * to, so every other reader moves to it rather than the other way round.
 *
 * The rule:
 *   under a kilometre → whole metres      "400 m", "800 m", "457 m"
 *   a whole number    → bare kilometres   "1 km", "16 km"
 *   otherwise         → 2 dp, trimmed     "1.6 km", "1.61 km", "3.22 km"
 *
 * Two decimals rather than one because 1600 m and a mile are DIFFERENT
 * prescriptions (nine metres apart, and a track athlete means one of them),
 * and trimmed rather than padded because "1.00 km" states a precision the
 * coach did not. Metres are rounded on the way in: nothing prescribes a
 * fraction of a metre, and `coachRunBlockSchema` already stores whole ones,
 * so 500 yards is 457 m on every surface instead of 457.2 on one of them.
 */
export function formatStageDistance(meters: number): string {
  const m = Math.max(0, Math.round(meters));
  if (m < 1000) return `${m} m`;
  return `${Number((m / 1000).toFixed(2))} km`;
}
