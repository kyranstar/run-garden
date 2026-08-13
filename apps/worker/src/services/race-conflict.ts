import { and, eq, isNull } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";
import { nowInstant, type UserPreferences } from "@rg/domain";
import { savePreferences } from "./calendar-sync.js";
import type { Db } from "./db.js";

/**
 * Two race truths must never coexist silently (audit#2 #3) — and once
 * surfaced, they must be resolvable in one step (live-observed 2026-08-13:
 * the athlete told the coach the real date and the banner sat there anyway,
 * because neither the banner nor the coach could touch either datum).
 *
 * The conflict is singular by construction: the first live race-category row
 * whose date disagrees with the athlete's stated race day. Both resolution
 * paths (brief banner, coach op) converge the underlying data, so the banner
 * can only reappear for a genuinely new divergence.
 */

export interface RaceConflict {
  workoutId: string;
  plannedDate: string;
  title: string;
  raceDate: string;
}

export async function findRaceConflict(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<RaceConflict | null> {
  if (!prefs.raceDate) return null;
  const [row] = await db
    .select({
      id: plannedWorkouts.id,
      date: plannedWorkouts.effectiveDate,
      title: plannedWorkouts.title,
    })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.category, "race"),
        isNull(plannedWorkouts.archivedAt),
        eq(plannedWorkouts.completionState, "scheduled"),
      ),
    )
    .limit(1);
  return row && row.date !== prefs.raceDate
    ? { workoutId: row.id, plannedDate: row.date, title: row.title, raceDate: prefs.raceDate }
    : null;
}

/**
 * keep "settings" — the athlete's stated day wins: the plan's mislabeled row
 * stays on the calendar as the hard session it is, it just stops claiming to
 * be the race. keep "plan" — the plan was right: race day in Settings moves
 * to the plan's date. Returns the conflict that was resolved, or null if
 * none existed (idempotent — a second click or a stale coach op is a no-op).
 */
export async function resolveRaceConflict(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  keep: "settings" | "plan",
): Promise<RaceConflict | null> {
  const conflict = await findRaceConflict(db, userId, prefs);
  if (!conflict) return null;
  if (keep === "settings") {
    await db
      .update(plannedWorkouts)
      .set({ category: "quality", updatedAt: nowInstant() })
      .where(and(eq(plannedWorkouts.id, conflict.workoutId), eq(plannedWorkouts.userId, userId)));
  } else {
    await savePreferences(db, userId, { ...prefs, raceDate: conflict.plannedDate });
  }
  return conflict;
}
