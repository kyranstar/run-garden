import { and, desc, eq, gte, lt } from "drizzle-orm";
import {
  activities,
  activityLaps,
  coachMemory,
  dailyHealth,
  plannedWorkouts,
  plannedWorkoutStages,
  sleepRecords,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  humanizeWorkoutTitle,
  looksLikeCodeTitle,
  sportLabel,
  type ActivityTelemetry,
} from "@rg/domain";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { loadPreferences } from "./calendar-sync.js";
import type { Db } from "./db.js";

/** Storage is °C; the athlete reads their own unit (prefs.temperatureUnit,
 * default °F) and the model must never convert — a converted number is an
 * invented one (the weekly-review rule). */
function tempStr(c: number, unit: "F" | "C", digits = 0): string {
  return unit === "F" ? `${((c * 9) / 5 + 32).toFixed(digits)}°F` : `${c.toFixed(digits)}°C`;
}

/**
 * The effort package (effort-analysis spec §3): everything the coach reads to
 * analyze ONE completed effort, as one terse deterministic document. Eight
 * sections, explicit unknowns, ≤8k tokens. Strength/yoga simply have fewer
 * populated lines — no separate format.
 */

const TOKEN_BUDGET = 8_000;
const MAX_SPLITS = 30;

export interface EffortPackage {
  text: string;
  sections: string[];
  approxTokens: number;
  /** Local calendar date of the effort — cache key context for callers. */
  date: string;
}

type ActivityRow = typeof activities.$inferSelect;

const fmt = (v: number | null | undefined, digits = 0): string =>
  v == null ? "unknown" : v.toFixed(digits);

function mmss(secPerKm: number | null | undefined): string {
  if (secPerKm == null || secPerKm <= 0) return "—";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}

function hms(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function localDateOf(a: ActivityRow): string {
  return (a.startTimeLocal ?? a.startTime).slice(0, 10);
}

/** Lap label: a named key shows itself; an opaque COROS key (S4208…) now
 * resolves through COROS's own locale table before being dropped. */
function labelForLap(key: string | null): string {
  if (!key) return "";
  if (!isOpaqueKey(key)) return ` (${key})`;
  const translated = COROS_EXERCISE_NAMES[key];
  return translated ? ` (${translated})` : "";
}

/** Opaque COROS catalog keys (S4208…) that nobody downstream can resolve. */
function isOpaqueKey(key: string): boolean {
  return /^[A-Z]\d+$/.test(key);
}

export async function buildEffortPackage(
  db: Db,
  userId: string,
  activityId: string,
): Promise<EffortPackage | null> {
  const [act] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, activityId), eq(activities.userId, userId)))
    .limit(1);
  if (!act) return null;

  const t: ActivityTelemetry = act.telemetry ?? {};
  const prefs = await loadPreferences(db, userId);
  const tu = prefs.temperatureUnit;
  const date = localDateOf(act);
  const out: string[] = [];
  const sections: string[] = [];
  const push = (name: string, body: string[]) => {
    sections.push(name);
    out.push(`## ${name}`, ...body, "");
  };

  // 1 · THIS EFFORT
  const effortLines = [
    `${act.sport} · "${act.title && !looksLikeCodeTitle(act.title) ? act.title : sportLabel(act.sport)}" · ${date} ${(act.startTimeLocal ?? "").slice(11, 16)}`,
    `moving ${hms(act.durationSeconds)}${act.elapsedSeconds ? ` · elapsed ${hms(act.elapsedSeconds)}` : ""}` +
      `${act.distanceMeters ? ` · ${(act.distanceMeters / 1000).toFixed(2)}km` : ""}` +
      `${act.avgPaceSecPerKm ? ` · avg ${mmss(act.avgPaceSecPerKm)}` : ""}`,
    `HR avg ${fmt(act.avgHeartRate)} / max ${fmt(act.maxHeartRate)}bpm` +
      ` · cadence ${t.avgCadenceSpm ? `${t.avgCadenceSpm}spm (max ${t.maxCadenceSpm ?? "?"})` : "unknown"}` +
      ` · power ${t.avgPowerWatts ? `${t.avgPowerWatts}W (max ${t.maxPowerWatts ?? "?"})` : "unknown"}`,
    `stride ${t.avgStrideLengthCm ? `${t.avgStrideLengthCm}cm` : "unknown"}` +
      ` · elevation +${fmt(act.elevationGainMeters)}m · load ${fmt(act.trainingLoad)}`,
    `training effect: aerobic ${fmt(t.aerobicEffect, 1)} · anaerobic ${fmt(t.anaerobicEffect, 1)} (0–5)` +
      ` · VO2max est ${fmt(t.vo2maxEstimate)}` +
      `${t.staminaLevel7d != null ? ` · COROS stamina ${Math.round(t.staminaLevel7d)}/100 (7d running-fitness gauge)` : ""}`,
    `best km ${t.bestKmSecPerKm ? mmss(t.bestKmSecPerKm) : "unknown"}` +
      ` · pauses ${t.pauseCount != null ? `${t.pauseCount}× / ${hms(t.pauseSeconds ?? 0)} total / longest ${hms(t.longestPauseSeconds ?? 0)}` : t.pauseSeconds != null ? hms(t.pauseSeconds) : "none recorded"}`,
  ];
  push("THIS EFFORT", effortLines);

  // 2 · CONDITIONS
  const condLines: string[] = [];
  if (t.weatherTempC != null) {
    condLines.push(
      `weather ${tempStr(t.weatherTempC, tu, 1)}` +
        `${t.weatherFeelsLikeC != null ? ` (feels ${tempStr(t.weatherFeelsLikeC, tu, 1)})` : ""}` +
        `${t.humidityPercent != null ? ` · humidity ${Math.round(t.humidityPercent)}%` : ""}` +
        `${t.windKph != null ? ` · wind ${t.windKph.toFixed(0)}km/h` : ""}`,
    );
  } else {
    condLines.push(
      "no weather record on this activity (indoor, non-GPS, or COROS attached none — absence of a record, not evidence of conditions)",
    );
  }
  if (t.deviceTempC != null)
    condLines.push(`watch thermometer ${tempStr(t.deviceTempC, tu)} (wrist-warmed, reads high)`);
  condLines.push(
    `self-reported feel: ${t.feelRating != null ? `${t.feelRating}/5 (5 = strongest)` : "not logged"}`,
  );
  if (t.sportNote) condLines.push(`athlete note: "${t.sportNote}"`);
  push("CONDITIONS", condLines);

  // 3 · SPLITS — the workout view leads (it carries the session's shape and
  // exercise keys); when per-km auto-laps ALSO exist (0018 stores both) they
  // ride as one condensed line instead of interleaving two views.
  const allLaps = await db
    .select()
    .from(activityLaps)
    .where(eq(activityLaps.activityId, act.id))
    .orderBy(activityLaps.lapIndex);
  const workoutLaps = allLaps.filter((l) => l.splitType === "workout");
  const laps = workoutLaps.length > 0 ? workoutLaps : allLaps.filter((l) => l.splitType !== "workout");
  const autoKmLaps = workoutLaps.length > 0 ? allLaps.filter((l) => l.splitType === "auto_km") : [];
  const splitLines = laps.slice(0, MAX_SPLITS).map((l, i) => {
    const label =
      l.splitType === "auto_km"
        ? `km ${i + 1}`
        : `lap ${l.lapIndex}${labelForLap(l.exerciseNameKey)}`;
    return (
      `${label}: ${hms(l.durationSeconds)}` +
      `${l.distanceMeters ? ` · ${(l.distanceMeters / 1000).toFixed(2)}km` : ""}` +
      `${l.avgPaceSecPerKm ? ` · ${mmss(l.avgPaceSecPerKm)}` : ""}` +
      `${l.avgHeartRate ? ` · HR ${Math.round(l.avgHeartRate)}${l.minHeartRate && l.maxHeartRate ? ` (${Math.round(l.minHeartRate)}–${Math.round(l.maxHeartRate)})` : ""}` : ""}` +
      `${l.avgCadenceSpm ? ` · ${Math.round(l.avgCadenceSpm)}spm` : ""}` +
      `${l.avgGradePercent != null && l.avgGradePercent !== 0 ? ` · grade ${l.avgGradePercent.toFixed(1)}%` : ""}` +
      `${l.elevGainMeters ? ` · +${Math.round(l.elevGainMeters)}m` : ""}`
    );
  });
  if (laps.length > MAX_SPLITS) splitLines.push(`…and ${laps.length - MAX_SPLITS} more laps`);
  if (autoKmLaps.length > 0) {
    splitLines.push(
      `per-km paces: ${autoKmLaps
        .slice(0, MAX_SPLITS)
        .map((l) => (l.avgPaceSecPerKm ? mmss(l.avgPaceSecPerKm).replace("/km", "") : "—"))
        .join(", ")} (auto 1km splits of the same effort)`,
    );
  }
  push("SPLITS", splitLines.length ? splitLines : ["no splits recorded"]);

  // 4 · PLAN CONTEXT — the matched planned workout with its stage targets, so
  // the analysis can compare workout-splits against what was asked.
  const [match] = await db
    .select()
    .from(workoutCompletionMatches)
    .where(eq(workoutCompletionMatches.activityId, act.id))
    .limit(1);
  const planLines: string[] = [];
  if (match && !match.undoneAt) {
    const [w] = await db
      .select()
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.id, match.workoutId))
      .limit(1);
    if (w) {
      planLines.push(`planned: "${humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype)}" · ${w.category} · ${w.sport} · state ${w.completionState}`);
      const stages = await db
        .select()
        .from(plannedWorkoutStages)
        .where(eq(plannedWorkoutStages.workoutId, w.id))
        .orderBy(plannedWorkoutStages.ord);
      for (const s of stages) {
        const dur =
          s.durationType === "time" && s.durationSeconds
            ? hms(s.durationSeconds)
            : s.durationType === "distance" && s.distanceMeters
              ? `${(s.distanceMeters / 1000).toFixed(2)}km`
              : s.kind === "repeat"
                ? `×${s.repeatCount ?? 1}`
                : "open";
        const target =
          s.targetType === "pace" && s.targetLow
            ? ` @ ${mmss(s.targetLow)}${s.targetHigh ? `–${mmss(s.targetHigh)}` : ""}`
            : s.targetType === "heart_rate" && s.targetLow
              ? ` @ ${s.targetLow}${s.targetHigh ? `–${s.targetHigh}` : ""}bpm`
              : "";
        planLines.push(`  ${s.kind}${s.label ? ` "${s.label}"` : ""}: ${dur}${target}`);
      }
    }
  }
  push("PLAN CONTEXT", planLines.length ? planLines : ["unplanned effort — no workout matched"]);

  // 5 · ZONES
  const zoneLines: string[] = [];
  for (const z of t.hrZones ?? []) {
    if (z.seconds > 0) zoneLines.push(`HR ${z.lo}–${z.hi}bpm: ${(z.seconds / 60).toFixed(1)}min`);
  }
  if (act.sport === "run") {
    for (const z of t.paceZones ?? []) {
      if (z.seconds > 0)
        zoneLines.push(`pace ${mmss(z.loSecPerKm)}–${mmss(z.hiSecPerKm)}: ${(z.seconds / 60).toFixed(1)}min`);
    }
  }
  push("ZONES", zoneLines.length ? zoneLines : ["no zone data"]);

  // 6 · HISTORY — the last 5 same-sport efforts before this one, plus a 90-day
  // best-km reference and that morning's wellness against 30d baselines.
  const prior = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        eq(activities.sport, act.sport),
        lt(activities.startTime, act.startTime),
      ),
    )
    .orderBy(desc(activities.startTime))
    .limit(5);
  const histLines = prior.map((p) => {
    const pt: ActivityTelemetry = p.telemetry ?? {};
    return (
      `${localDateOf(p)} · "${p.title && !looksLikeCodeTitle(p.title) ? p.title : sportLabel(p.sport)}" · ${hms(p.durationSeconds)}` +
      `${p.distanceMeters ? ` · ${(p.distanceMeters / 1000).toFixed(1)}km · ${mmss(p.avgPaceSecPerKm)}` : ""}` +
      `${p.avgHeartRate ? ` · HR ${Math.round(p.avgHeartRate)}` : ""}` +
      `${p.trainingLoad ? ` · load ${Math.round(p.trainingLoad)}` : ""}` +
      `${pt.weatherTempC != null ? ` · ${tempStr(pt.weatherTempC, tu)}` : ""}`
    );
  });
  if (act.sport === "run") {
    const since90 = `${addDays(date, -90)}T00:00:00Z`;
    const recent = await db
      .select({ telemetry: activities.telemetry })
      .from(activities)
      .where(
        and(
          eq(activities.userId, userId),
          eq(activities.sport, "run"),
          gte(activities.startTime, since90),
        ),
      );
    const bestKms = recent
      .map((r) => (r.telemetry ?? {}).bestKmSecPerKm)
      .filter((v): v is number => v != null && v > 0);
    if (bestKms.length > 0) histLines.push(`90d best km: ${mmss(Math.min(...bestKms))}`);
  }
  const since30 = addDays(date, -30);
  const sleep = await db
    .select()
    .from(sleepRecords)
    .where(and(eq(sleepRecords.userId, userId), gte(sleepRecords.date, since30), lt(sleepRecords.date, date)));
  const health = await db
    .select()
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), gte(dailyHealth.date, since30), lt(dailyHealth.date, date)));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const sleepBase = avg(sleep.map((s) => s.durationSeconds / 3600));
  const hrvBase = avg(health.map((h) => h.hrv).filter((v): v is number => v != null));
  const rhrBase = avg(health.map((h) => h.restingHeartRate).filter((v): v is number => v != null));
  const [morning] = await db
    .select()
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), eq(dailyHealth.date, date)))
    .limit(1);
  const [nightBefore] = await db
    .select()
    .from(sleepRecords)
    .where(and(eq(sleepRecords.userId, userId), eq(sleepRecords.date, date)))
    .limit(1);
  histLines.push(
    `that morning: sleep ${nightBefore ? (nightBefore.durationSeconds / 3600).toFixed(1) + "h" : "unknown"}` +
      ` · HRV ${fmt(morning?.hrv)}ms · RHR ${fmt(morning?.restingHeartRate)}bpm`,
    `30d baselines: sleep ${fmt(sleepBase, 1)}h · HRV ${fmt(hrvBase)}ms · RHR ${fmt(rhrBase)}bpm`,
  );
  push("HISTORY", histLines.length ? histLines : ["first recorded effort of this kind"]);

  // 7 · LOAD — trailing windows ending on the effort's date (inclusive).
  const loadRows = await db
    .select({ startTime: activities.startTime, startTimeLocal: activities.startTimeLocal, trainingLoad: activities.trainingLoad })
    .from(activities)
    .where(and(eq(activities.userId, userId), gte(activities.startTime, `${addDays(date, -27)}T00:00:00Z`)));
  const inWindow = (days: number) =>
    loadRows
      .filter((r) => {
        const d = (r.startTimeLocal ?? r.startTime).slice(0, 10);
        return d >= addDays(date, -(days - 1)) && d <= date;
      })
      .reduce((sum, r) => sum + (r.trainingLoad ?? 0), 0);
  const load7 = inWindow(7);
  const load28 = inWindow(28);
  const [effortDayHealth] = await db
    .select({ loadRatio: dailyHealth.loadRatio })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), eq(dailyHealth.date, date)))
    .limit(1);
  push("LOAD", [
    `trailing 7d load ${Math.round(load7)} · 28d ${Math.round(load28)}` +
      ` · 7d/28d weekly ratio ${load28 > 0 ? ((load7 / (load28 / 4))).toFixed(2) : "unknown"}` +
      `${effortDayHealth?.loadRatio != null ? ` · COROS's own acute:chronic ratio that day: ${effortDayHealth.loadRatio.toFixed(2)}` : ""}`,
  ]);

  // 8 · READING THESE NUMBERS — one clause per datapoint, so no figure ever
  // arrives without its meaning. Context, never rules: the athlete's own
  // words and feel outrank any single number here.
  push("READING THESE NUMBERS", [
    "training load: COROS session strain — roughly, under 40 is gentle, 40–80 steady, above 80 strong for THIS athlete's history; compare against their own recent loads, not absolutes",
    "7d/28d weekly ratio (and COROS's acute:chronic): ≈0.8–1.3 reads as steady training; well above is a sharp ramp worth naming, well below is a wind-down or detraining",
    "training effect (0–5): COROS's estimate of how much the session moved aerobic vs anaerobic fitness — 2s maintain, 3s improve, 4+ is a hard stimulus",
    "VO2max est and COROS stamina: watch estimates — directionally useful over weeks, noisy day to day; never diagnose from one reading",
    "HRV/RHR vs baseline: lower HRV or higher RHR than baseline suggests incomplete recovery; a single odd morning is weather, not fate",
    "feel (1–5, 5 = strongest): the athlete's own report — when it disagrees with the watch numbers, say so and weigh the athlete first",
    "RealFeel: humidity/wind-adjusted temperature — pace drifts upward in heat; judge effort by HR, not pace, on hot or humid days",
    "watch thermometer: wrist-warmed, reads a few degrees above the air — trust the weather line over it outdoors",
    "zones: each line already carries its own bounds and time in band — 'zone' means those printed numbers, nothing generic",
    "splits: workout laps are the session's structure; per-km paces (when listed) are the same effort re-cut by distance",
    "these are context, not instructions — weigh them against the plan's intent and the athlete's own words",
  ]);

  // 9 · MEMORY — the coach's standing knowledge, verbatim.
  const memory = await db
    .select()
    .from(coachMemory)
    .where(and(eq(coachMemory.userId, userId), eq(coachMemory.active, true)));
  push(
    "MEMORY",
    memory.length ? memory.map((m) => `${m.kind}: ${m.body}`) : ["none recorded"],
  );

  let text = `# EFFORT PACKAGE · ${date}\n\n${out.join("\n")}`;
  if (text.length / 4 > TOKEN_BUDGET) text = text.slice(0, TOKEN_BUDGET * 4);
  return { text, sections, approxTokens: Math.round(text.length / 4), date };
}
