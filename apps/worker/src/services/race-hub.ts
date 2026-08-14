import { and, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  activities,
  coachMessages,
  coachProposals,
  dailyHealth,
  plannedWorkouts,
} from "@rg/database";
import { addDays, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "./db.js";

/**
 * Race hub (2026-08-14): everything the plan page's race strip renders.
 * All figures are DERIVED — the only stored state is the hand-ticked
 * checklist in prefs. Paces/distances are metric; the client converts to
 * the athlete's display units.
 */

/** Taper length matches the garden's race shelter (raceDate − 21). */
const TAPER_DAYS = 21;
/** The debrief lingers this long after race day, then the strip hides. */
const DEBRIEF_DAYS = 14;
/** A ~50-minute race sits at threshold; the band's slow edge allows the
 * usual field conditions (turns, fueling, pacing error). */
const BAND_WIDTH_SEC_PER_KM = 7;
const RACE_DISTANCE_KM = 10;
/** raceLine staleness — race narrative moves slower than the weekly focus. */
const RACE_LINE_STALE_MS = 7 * 24 * 3600 * 1000;

export interface RaceChecklistItem {
  id: string;
  label: string;
  done: boolean;
  kind: "coach" | "user";
}

export interface RaceHub {
  raceDate: string;
  daysToRace: number;
  taperStartDate: string;
  phase: "build" | "taper" | "race_week" | "post";
  goal: {
    thresholdPaceSecPerKm: number;
    bandLowSecPerKm: number;
    bandHighSecPerKm: number;
    predictedLowSeconds: number;
    predictedHighSeconds: number;
    asOf: string;
  } | null;
  stamina: Array<{ date: string; value: number }>;
  checklist: RaceChecklistItem[];
  raceLine: { text: string; at: string } | null;
  debrief: {
    activityId: string;
    durationSeconds: number;
    distanceMeters: number | null;
    avgPaceSecPerKm: number | null;
  } | null;
}

export const DEFAULT_RACE_CHECKLIST: Array<{ id: string; label: string }> = [
  { id: "bib", label: "Bib pickup / registration sorted" },
  { id: "gear", label: "Race kit laid out and tested" },
  { id: "travel", label: "Morning-of logistics planned" },
];

export async function buildRaceHub(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<RaceHub | null> {
  const raceDate = prefs.raceDate;
  if (!raceDate) return null;
  const today = todayInZone(prefs.timezone);
  const daysToRace = Math.round((Date.parse(raceDate) - Date.parse(today)) / 86_400_000);
  if (daysToRace < -DEBRIEF_DAYS) return null;

  const taperStartDate = addDays(raceDate, -TAPER_DAYS);
  const phase =
    daysToRace < 0
      ? ("post" as const)
      : daysToRace <= 6
        ? ("race_week" as const)
        : today >= taperStartDate
          ? ("taper" as const)
          : ("build" as const);

  const [thresholdRow, staminaRows, raceWeekStrength, approved, raceLineMsg, raceDayRuns] =
    await Promise.all([
      db
        .select({ date: dailyHealth.date, ltsp: dailyHealth.thresholdPaceSecPerKm })
        .from(dailyHealth)
        .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
        .orderBy(desc(dailyHealth.date))
        .limit(1),
      db
        .select({ date: dailyHealth.date, value: dailyHealth.staminaLevel })
        .from(dailyHealth)
        .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.staminaLevel)))
        .orderBy(dailyHealth.date),
      db
        .select({ id: plannedWorkouts.id, seconds: plannedWorkouts.calendarBlockDurationSeconds })
        .from(plannedWorkouts)
        .where(
          and(
            eq(plannedWorkouts.userId, userId),
            eq(plannedWorkouts.sport, "strength"),
            eq(plannedWorkouts.completionState, "scheduled"),
            isNull(plannedWorkouts.archivedAt),
            gte(plannedWorkouts.effectiveDate, addDays(raceDate, -6)),
            lte(plannedWorkouts.effectiveDate, raceDate),
          ),
        ),
      db
        .select({ ops: coachProposals.ops })
        .from(coachProposals)
        .where(and(eq(coachProposals.userId, userId), eq(coachProposals.status, "approved"))),
      db
        .select()
        .from(coachMessages)
        .where(
          and(
            eq(coachMessages.userId, userId),
            eq(coachMessages.role, "coach"),
            sql`json_extract(${coachMessages.refs}, '$.raceLine') IS NOT NULL`,
          ),
        )
        .orderBy(desc(coachMessages.at))
        .limit(1),
      phase === "post"
        ? db
            .select()
            .from(activities)
            .where(
              and(
                eq(activities.userId, userId),
                eq(activities.sport, "run"),
                sql`substr(COALESCE(${activities.startTimeLocal}, ${activities.startTime}), 1, 10) = ${raceDate}`,
              ),
            )
        : Promise.resolve([]),
    ]);

  const ltsp = thresholdRow[0]?.ltsp ?? null;
  const goal =
    ltsp !== null
      ? {
          thresholdPaceSecPerKm: ltsp,
          bandLowSecPerKm: Math.round(ltsp),
          bandHighSecPerKm: Math.round(ltsp + BAND_WIDTH_SEC_PER_KM),
          predictedLowSeconds: Math.round(ltsp * RACE_DISTANCE_KM),
          predictedHighSeconds: Math.round((ltsp + BAND_WIDTH_SEC_PER_KM) * RACE_DISTANCE_KM),
          asOf: thresholdRow[0]!.date,
        }
      : null;

  // Coach item 1: an approved reshape/windDown whose sessions land inside
  // race week means the coach has restructured the final stretch.
  const raceWeekStart = addDays(raceDate, -6);
  const restructured = approved.some((p) =>
    (p.ops as Array<Record<string, unknown>>).some((op) => {
      const kind = op.kind as string;
      if (kind === "windDown" || kind === "reshapeWeek") {
        const sessions = (op.sessions as Array<{ date?: string }> | undefined) ?? [];
        const weekStart = op.weekStart as string | undefined;
        return (
          (weekStart !== undefined && weekStart >= addDays(raceWeekStart, -6) && weekStart <= raceDate) ||
          sessions.some((s) => s.date !== undefined && s.date >= raceWeekStart && s.date <= raceDate)
        );
      }
      return false;
    }),
  );
  // Coach item 2: race week holds no real strength session (≥30min counts
  // as real; a mobility short-block passes).
  const liftsEased = !raceWeekStrength.some((w) => (w.seconds ?? 0) >= 1800);

  const userItems = (prefs.raceChecklist.length > 0
    ? prefs.raceChecklist
    : DEFAULT_RACE_CHECKLIST.map((d) => ({ ...d, done: false }))
  ).map((i) => ({ ...i, kind: "user" as const }));

  const checklist: RaceChecklistItem[] = [
    { id: "coach-restructure", label: "Final week restructured by the coach", done: restructured, kind: "coach" },
    { id: "coach-lifts", label: "Race-week lifts down to mobility", done: liftsEased, kind: "coach" },
    ...userItems,
  ];

  const lineRow = raceLineMsg[0];
  const lineText = (lineRow?.refs as { raceLine?: string } | undefined)?.raceLine;
  const raceLine =
    lineRow && lineText && Date.now() - Date.parse(lineRow.at) < RACE_LINE_STALE_MS
      ? { text: lineText, at: lineRow.at }
      : null;

  // Debrief: the longest run recorded on race day is the race.
  const raceRun = raceDayRuns.sort((a, b) => b.durationSeconds - a.durationSeconds)[0];
  const debrief =
    phase === "post" && raceRun
      ? {
          activityId: raceRun.id,
          durationSeconds: raceRun.durationSeconds,
          distanceMeters: raceRun.distanceMeters,
          avgPaceSecPerKm: raceRun.avgPaceSecPerKm,
        }
      : null;

  return {
    raceDate,
    daysToRace,
    taperStartDate,
    phase,
    goal,
    stamina: staminaRows.filter((r): r is { date: string; value: number } => r.value !== null),
    checklist,
    raceLine,
    debrief,
  };
}
