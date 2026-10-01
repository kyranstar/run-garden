/**
 * AN ADAPTIVE PROGRAM'S SLOTS — where its sessions sit on the calendar (Phase 2 spec §2a "Slot placement",
 * programme spec §9.1).
 *
 * A slot is a planned row like any other (`origin = 'program'`, `content_state = 'outline'`,
 * `coros_sync_state = 'calendar_only'`): the calendar reconciler books it, the athlete moves, skips and removes it
 * with the existing verbs, and its content is built on its day (`session-build.ts`). This file only decides
 * WHICH DAYS hold one.
 *
 * THE RULE, per ISO week from this one to `placementWeeksAhead` weeks ahead:
 *
 *  1. COUNT BY THE DAY A SLOT WAS PLANNED ON (`original_plan_date`), whatever has happened to it since. A slot the
 *     athlete moved to next week still counts for this one; skipped, done and removed slots count. That is what
 *     makes placement safe to run every hour: anything the athlete did to a slot is never undone or re-placed.
 *     The one exception is a slot this file retracted itself (`program_replaced`): it is not the athlete's, and
 *     a later edit that wants that day again brings the same row back.
 *  2. THE WEEK'S GOAL goes on `preferredDays` in order, then the week's other days Monday → Sunday, never before
 *     today, one slot of this program per date.
 *  3. ONLY FLEXIBLE SLOTS MAY GO: a slot that is live, still an outline, unmoved (effective date = planned date),
 *     still scheduled, and after today. Everything else — today's, a moved one, a built one, a past one — is
 *     fixed: it counts toward the goal and stays. Flexible slots on wanted days stay too, so a settled week
 *     writes nothing at all.
 *  4. Flexible slots the pattern no longer wants (goal lowered, a day dropped, the program retired) are archived
 *     through `removeFromPlan` — `archive_reason = 'program_replaced'` and the one `user_removed` calendar
 *     suppression a hand removal gets — and only then are missing days filled.
 *
 * Every writer here is a no-op while a restore is replacing the account (ruling B2).
 */
import { and, eq, gte, lte, or } from "drizzle-orm";
import { calendarEventSuppressions, plannedWorkouts, programs } from "@rg/database";
import { adaptiveConfigSchema, addDays, nowInstant, startOfIsoWeek, todayInZone, type UserPreferences } from "@rg/domain";
import { restoreInProgress } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import { chunkedInsert, type Db } from "./db.js";
import { separateDayCollisions, windowTimeFor } from "./day-placement.js";
import { removeFromPlan } from "./plan-mutations.js";

type WorkoutRow = typeof plannedWorkouts.$inferSelect;
type ProgramRow = typeof programs.$inferSelect;

export interface PlacementResult {
  /** Slots put on the calendar: new rows, and retracted ones brought back. */
  placed: string[];
  /** Slots retracted (`program_replaced`). */
  archived: string[];
}

/** A slot's id: one per program per planned date, so placement can never duplicate one. */
export function slotId(programId: string, date: string): string {
  return `slot-${programId}-${date}`;
}

/**
 * The discipline a slot carries before it is built (programme spec §9.2): the build sets `strength` when the
 * session holds a core lift and `yoga` otherwise; until then, the program's first listed discipline when that is
 * strength, else yoga.
 */
export function defaultDiscipline(program: Pick<ProgramRow, "disciplines">): "strength" | "yoga" {
  return program.disciplines[0] === "strength" ? "strength" : "yoga";
}

/** A slot this file itself retracted — not something the athlete did, so it does not hold its week's place. */
function retracted(r: WorkoutRow): boolean {
  return r.archivedAt !== null && r.archiveReason === "program_replaced";
}

/** Rule 3: the only slots an edit may take away. */
function flexible(r: WorkoutRow, today: string): boolean {
  return (
    r.archivedAt === null &&
    r.completionState === "scheduled" &&
    r.contentState === "outline" &&
    r.effectiveDate === r.originalPlanDate &&
    r.effectiveDate > today
  );
}

/** The week's dates in placement order: preferred days as listed, then the rest Monday → Sunday. */
function rankedDays(monday: string, preferredDays: readonly number[]): string[] {
  const rest = [0, 1, 2, 3, 4, 5, 6].filter((d) => !preferredDays.includes(d));
  return [...preferredDays, ...rest].map((d) => addDays(monday, d));
}

/**
 * Place (and re-place) one program's slots. Idempotent: a second run with the same inputs writes nothing.
 * Not this user's program, not adaptive, or a restore in progress → nothing. A program that is not active wants
 * no slots, so its flexible ones are retracted and none are placed.
 */
export async function placeSlots(
  db: Db,
  userId: string,
  programId: string,
  today: string,
  prefs: UserPreferences,
  now: string,
): Promise<PlacementResult> {
  const result: PlacementResult = { placed: [], archived: [] };
  if (await restoreInProgress(db, userId)) return result;
  const [program] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.id, programId), eq(programs.userId, userId)))
    .limit(1);
  if (!program || program.kind !== "adaptive") return result;
  const config = adaptiveConfigSchema.parse(program.config);
  const goal = program.status === "active" ? config.weeklyGoal : 0;

  const firstMonday = startOfIsoWeek(today);
  const lastSunday = addDays(firstMonday, 7 * (config.placementWeeksAhead + 1) - 1);
  // Planned in the window (rule 1's count, and every id a new slot could take), or sitting in it now (a slot
  // moved in from outside still holds its date).
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.planId, programId),
        eq(plannedWorkouts.origin, "program"),
        or(
          and(gte(plannedWorkouts.originalPlanDate, firstMonday), lte(plannedWorkouts.originalPlanDate, lastSunday)),
          and(gte(plannedWorkouts.effectiveDate, firstMonday), lte(plannedWorkouts.effectiveDate, lastSunday)),
        ),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const flexibleIds = new Set(rows.filter((r) => flexible(r, today)).map((r) => r.id));
  // One slot of this program per date: the days a live, fixed slot already sits on.
  const occupied = new Set(
    rows.filter((r) => r.archivedAt === null && !flexibleIds.has(r.id)).map((r) => r.effectiveDate),
  );

  const toArchive: WorkoutRow[] = [];
  const toRevive: WorkoutRow[] = [];
  const toInsert: string[] = [];
  for (let week = 0; week <= config.placementWeeksAhead; week++) {
    const monday = addDays(firstMonday, 7 * week);
    const sunday = addDays(monday, 6);
    const counted = rows.filter((r) => r.originalPlanDate >= monday && r.originalPlanDate <= sunday && !retracted(r));
    const movable = new Map(counted.filter((r) => flexibleIds.has(r.id)).map((r) => [r.effectiveDate, r]));
    const need = Math.max(0, goal - (counted.length - movable.size));

    const want = new Set<string>();
    for (const date of rankedDays(monday, config.preferredDays)) {
      if (want.size >= need) break;
      if (movable.has(date)) {
        want.add(date);
        continue;
      }
      if (date < today || occupied.has(date)) continue;
      // The date's id belongs to a slot the athlete moved away, skipped or removed: that day is spoken for.
      const holder = byId.get(slotId(programId, date));
      if (holder && !retracted(holder)) continue;
      want.add(date);
    }

    for (const [date, r] of movable) if (!want.has(date)) toArchive.push(r);
    for (const date of want) {
      if (movable.has(date)) continue;
      const holder = byId.get(slotId(programId, date));
      if (holder) toRevive.push(holder);
      else toInsert.push(date);
    }
  }

  // Retract first, then fill (spec: archive, then place the new pattern).
  for (const r of toArchive) {
    const removed = await removeFromPlan(db, userId, r.id, {
      now,
      source: "program_replace",
      prefs,
      archiveReason: "program_replaced",
    });
    if (removed.removed) result.archived.push(r.id);
  }

  const discipline = defaultDiscipline(program);
  const seconds = config.defaultMinutes * 60;
  const content = (date: string) => ({
    title: program.name,
    category: discipline,
    sport: discipline,
    effectiveTime: windowTimeFor({ category: discipline, date }, prefs),
    fallbackEstimatedDurationSeconds: seconds,
    calendarBlockDurationSeconds: seconds,
  });

  // Every column, defaulted ones included: `chunkedInsert` sizes batches by the row's own keys, and Drizzle binds
  // a default for any key a row omits (P1-R12).
  const fresh = toInsert.map((date) => {
    const id = slotId(programId, date);
    return {
      id,
      userId,
      planId: programId,
      sourceWorkoutId: id,
      sourceProgramId: null,
      sourceIdInPlan: null,
      qualitySubtype: null,
      originalPlanDate: date,
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      sourceContentFingerprint: "program",
      sourceVersion: null,
      sourceEstimatedDurationSeconds: null,
      durationEstimate: null,
      expectedDistanceMeters: null,
      stageSummary: null,
      structuredJson: null,
      calendarSyncState: "not_created",
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      missingReads: 0,
      snoozedUntil: null,
      resolutionDate: null,
      sanctionedBy: null,
      archivedAt: null,
      archiveReason: null,
      origin: "program",
      contentState: "outline",
      sessionParams: null,
      createdAt: now,
      updatedAt: now,
      ...content(date),
    };
  });
  await chunkedInsert(fresh, (batch) => db.insert(plannedWorkouts).values(batch).onConflictDoNothing());
  result.placed.push(...fresh.map((r) => r.id));

  // A retracted slot whose day is wanted again: the same row comes back, as a fresh outline on its own day.
  for (const r of toRevive) {
    await db
      .update(plannedWorkouts)
      .set({
        ...content(r.originalPlanDate),
        effectiveDate: r.originalPlanDate,
        completionState: "scheduled",
        contentState: "outline",
        sessionParams: null,
        resolutionDate: null,
        snoozedUntil: null,
        missingReads: 0,
        archivedAt: null,
        archiveReason: null,
        ...(r.calendarSyncState === "synced" ? { calendarSyncState: "pending" } : {}),
        updatedAt: now,
      })
      .where(and(eq(plannedWorkouts.id, r.id), eq(plannedWorkouts.userId, userId)));
    // Its suppression goes with the archive it explained, or the calendar would never book it again.
    await db.delete(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, r.id));
    result.placed.push(r.id);
  }

  const placedDates = [...toInsert, ...toRevive.map((r) => r.originalPlanDate)];
  if (placedDates.length > 0) {
    await separateDayCollisions(db, userId, placedDates, prefs, { from: today, now });
  }
  return result;
}

export interface PlacementSweepStats {
  programs: number;
  placed: number;
  archived: number;
  failed: number;
}

/**
 * The hourly pass: every active adaptive program of every user keeps its weeks filled as the days roll on. Each
 * user's today is in their own timezone; an account a restore is replacing is skipped; one program failing does
 * not stop the rest.
 */
export async function placeSlotsForAllPrograms(db: Db, at: Date = new Date()): Promise<PlacementSweepStats> {
  const stats: PlacementSweepStats = { programs: 0, placed: 0, archived: 0, failed: 0 };
  const active = await db
    .select({ id: programs.id, userId: programs.userId })
    .from(programs)
    .where(and(eq(programs.kind, "adaptive"), eq(programs.status, "active")));
  const byUser = new Map<string, string[]>();
  for (const p of active) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p.id]);

  const now = nowInstant(at);
  for (const [userId, programIds] of byUser) {
    if (await restoreInProgress(db, userId)) continue;
    const prefs = await loadPreferences(db, userId);
    const today = todayInZone(prefs.timezone, at);
    for (const programId of programIds) {
      stats.programs += 1;
      try {
        const res = await placeSlots(db, userId, programId, today, prefs, now);
        stats.placed += res.placed.length;
        stats.archived += res.archived.length;
      } catch (e) {
        stats.failed += 1;
        console.error(`slot placement failed for program ${programId}: ${e instanceof Error ? e.message : "unknown"}`);
      }
    }
  }
  return stats;
}
