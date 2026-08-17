import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { activities } from "@rg/database";
import {
  addDays,
  compareTerrain,
  metresPerKm,
  raceMetresPerKm,
  type LocalDate,
  type TerrainComparison,
  type UserPreferences,
} from "@rg/domain";
import type { Db } from "./db.js";

/**
 * Terrain awareness (2026-08-14): how hilly the athlete's running has
 * actually been, and how that sits against the race course they described.
 * Every number is measured — climb comes off the stored activities, the
 * course's climb comes from the athlete — so this never guesses at
 * difficulty.
 */

/** The window that counts as "recent training" — matches the load basis. */
const EXPOSURE_DAYS = 28;
/** Runs shorter than this say more about the walk to the park than terrain. */
const MIN_RUN_METRES = 2000;

export interface TerrainExposure {
  metresPerKm: number;
  runs: number;
  totalClimbMetres: number;
  sinceDate: string;
}

export interface TerrainReport {
  recent: TerrainExposure | null;
  raceMetresPerKm: number | null;
  comparison: TerrainComparison | null;
}

/** Climb per km across the athlete's recent real runs. `today` comes from the
 * caller so the window is the same day the rest of that request (or that wake —
 * see ONE CLOCK PER WAKE in coach-wake.ts) is written against. */
export async function recentTerrainExposure(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  today: LocalDate,
  days = EXPOSURE_DAYS,
): Promise<TerrainExposure | null> {
  const since = addDays(today, -days);
  const rows = await db
    .select({
      climb: activities.elevationGainMeters,
      distance: activities.distanceMeters,
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        eq(activities.sport, "run"),
        isNotNull(activities.elevationGainMeters),
        gte(activities.distanceMeters, MIN_RUN_METRES),
        // Padded UTC bound, exact local-date filter downstream — the same
        // convention the rest of the analytics use.
        sql`substr(COALESCE(${activities.startTimeLocal}, ${activities.startTime}), 1, 10) >= ${since}`,
      ),
    );
  if (rows.length === 0) return null;
  let climb = 0;
  let distance = 0;
  for (const r of rows) {
    climb += r.climb ?? 0;
    distance += r.distance ?? 0;
  }
  const rate = metresPerKm(climb, distance);
  if (rate === null) return null;
  return {
    metresPerKm: Math.round(rate * 10) / 10,
    runs: rows.length,
    totalClimbMetres: Math.round(climb),
    sinceDate: since,
  };
}

/** Recent exposure against the described course — null halves stay null. */
export async function buildTerrainReport(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  today: LocalDate,
): Promise<TerrainReport> {
  const recent = await recentTerrainExposure(db, userId, prefs, today);
  const raceRate = raceMetresPerKm(
    prefs.raceCourseClimbMetres,
    prefs.raceCourseProfile,
    prefs.raceDistanceKm,
  );
  return {
    recent,
    raceMetresPerKm: raceRate === null ? null : Math.round(raceRate * 10) / 10,
    comparison: compareTerrain(recent?.metresPerKm ?? null, raceRate),
  };
}
