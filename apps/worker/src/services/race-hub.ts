import { and, desc, eq, gt, gte, isNull, lte, sql } from "drizzle-orm";
import {
  activities,
  coachMessages,
  coachProposals,
  dailyHealth,
  plannedWorkouts,
} from "@rg/database";
import {
  addDays,
  racePrediction,
  type LocalDate,
  type RacePrediction,
  type UserPreferences,
} from "@rg/domain";
import type { Db } from "./db.js";
import { buildTerrainReport, type TerrainReport } from "./terrain.js";

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
/** How far back the fitness trend looks — the same span the strip's arc
 * draws, so "this block" means the block (audit#3-b #4). */
const TREND_DAYS = 63;
/** A race-week strength session longer than this is real lifting, not
 * mobility. Measured on the WORKOUT, never the buffered calendar block
 * (audit#3-b #2). */
const MOBILITY_CEILING_SECONDS = 1800;
/** raceLine staleness — race narrative moves slower than the weekly focus. */
const RACE_LINE_STALE_MS = 7 * 24 * 3600 * 1000;

export interface RaceChecklistItem {
  id: string;
  label: string;
  done: boolean;
  kind: "coach" | "user";
  /** Why a derived item can't be judged yet — shown faintly beside it. */
  note?: string;
}

export interface RaceHub {
  raceDate: string;
  daysToRace: number;
  taperStartDate: string;
  phase: "build" | "taper" | "race_week" | "post";
  goal: {
    thresholdPaceSecPerKm: number;
    asOf: string;
    /** Present only when the athlete has told us the race distance. */
    prediction: RacePrediction | null;
  } | null;
  stamina: Array<{ date: string; value: number }>;
  checklist: RaceChecklistItem[];
  raceLine: { text: string; at: string } | null;
  terrain: TerrainReport;
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

/**
 * `today` is the caller's, not this function's — it is read INSIDE the coach's
 * wake (see ONE CLOCK PER WAKE in coach-wake.ts), and "12 days out · phase
 * taper" printed in a dossier headed with a different date is the whole class of
 * bug that note exists for. Route callers pass `todayInZone(prefs.timezone)`
 * themselves; the compiler enforces it.
 */
export async function buildRaceHub(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  today: LocalDate,
): Promise<RaceHub | null> {
  const raceDate = prefs.raceDate;
  if (!raceDate) return null;
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
        .where(and(eq(dailyHealth.userId, userId), gt(dailyHealth.thresholdPaceSecPerKm, 0)))
        .orderBy(desc(dailyHealth.date))
        .limit(1),
      db
        .select({ date: dailyHealth.date, value: dailyHealth.staminaLevel })
        .from(dailyHealth)
        .where(
          and(
            eq(dailyHealth.userId, userId),
            gt(dailyHealth.staminaLevel, 0),
            gte(dailyHealth.date, addDays(today, -TREND_DAYS)),
          ),
        )
        .orderBy(dailyHealth.date),
      db
        .select({
          id: plannedWorkouts.id,
          // The WORKOUT's own length. calendarBlockDurationSeconds bakes in
          // the athlete's 25 minutes of buffers, which made two ~11-minute
          // mobility sessions read as real lifting (audit#3-b #2).
          sourceSeconds: plannedWorkouts.sourceEstimatedDurationSeconds,
          fallbackSeconds: plannedWorkouts.fallbackEstimatedDurationSeconds,
          calendarSeconds: plannedWorkouts.calendarBlockDurationSeconds,
        })
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

  const terrain = await buildTerrainReport(db, userId, prefs, today);
  const ltsp = thresholdRow[0]?.ltsp ?? null;
  const goal =
    ltsp !== null
      ? {
          thresholdPaceSecPerKm: ltsp,
          asOf: thresholdRow[0]!.date,
          prediction: racePrediction(ltsp, prefs.raceDistanceKm),
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
  const raceWeekPlanned = raceWeekStrength.length > 0;
  const bufferSeconds = (prefs.bufferBeforeMinutes + prefs.bufferAfterMinutes) * 60;
  /** The session's own length: an estimate when stored, otherwise the
   * calendar block with the athlete's buffers taken back off. Never the raw
   * block — 25 minutes of padding made 11-minute mobility read as lifting. */
  const workoutSeconds = (w: { sourceSeconds: number | null; fallbackSeconds: number | null; calendarSeconds: number | null }) =>
    w.sourceSeconds ?? w.fallbackSeconds ?? Math.max(0, (w.calendarSeconds ?? 0) - bufferSeconds);
  const liftsEased =
    raceWeekPlanned &&
    !raceWeekStrength.some((w) => workoutSeconds(w) >= MOBILITY_CEILING_SECONDS);

  // Ticks belong to ONE race: a stored list whose id doesn't match this race
  // date reseeds, so next spring's race never opens pre-ticked (audit#3-b #7).
  // Ticks saved before ids were race-scoped carry no prefix; they belong to
  // the race that was current when they were made — this one.
  const legacy = prefs.raceChecklist.filter((i) => !i.id.includes(":"));
  const storedForThisRace = [
    ...prefs.raceChecklist.filter((i) => i.id.startsWith(`${raceDate}:`)),
    ...legacy.map((i) => ({ ...i, id: `${raceDate}:${i.id}` })),
  ];
  const userItems = (storedForThisRace.length > 0
    ? storedForThisRace
    : DEFAULT_RACE_CHECKLIST.map((d) => ({ ...d, id: `${raceDate}:${d.id}`, done: false }))
  ).map((i) => ({ ...i, kind: "user" as const }));

  const checklist: RaceChecklistItem[] = [
    { id: "coach-restructure", label: "Final week restructured by the coach", done: restructured, kind: "coach" },
    {
      id: "coach-lifts",
      label: "Race-week lifts down to mobility",
      done: liftsEased,
      kind: "coach",
      // An empty race week is "not written yet", never "already eased".
      ...(raceWeekPlanned ? {} : { note: "race week not written yet" }),
    },
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
    terrain,
    stamina: staminaRows.filter((r): r is { date: string; value: number } => r.value !== null),
    checklist,
    raceLine,
    debrief,
  };
}
