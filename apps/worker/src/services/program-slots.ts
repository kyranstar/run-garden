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
 *     today, one slot of this program per date. Two limits on a NEW slot (ruling 2a-R11): none on today once
 *     today's window has passed in the athlete's zone, and in THIS week only on the days a full week would use
 *     (the first `weeklyGoal` of that order) — a mid-week start or a raised goal never crams the week. Never on race
 *     day (`prefs.raceDate`): a flexible slot placed there before the race was set moves to the week's next day.
 *  3. ONLY FLEXIBLE SLOTS MAY GO: a slot that is live, still an outline, unmoved (effective date = planned date),
 *     still scheduled, and after today. Everything else — today's, a moved one, a built one, a past one — is
 *     fixed: it counts toward the goal and stays. Flexible slots on wanted days stay too, so a settled week
 *     writes nothing at all.
 *  4. Flexible slots the pattern no longer wants (goal lowered, a day dropped, the program retired) are archived
 *     through `removeFromPlan` — `archive_reason = 'program_replaced'` and the one `user_removed` calendar
 *     suppression a hand removal gets — and only then are missing days filled.
 *  5. A SLOT SAYS WHAT ITS PROGRAM SAYS NOW: a rename, a new length or a new lead discipline reaches the program's
 *     live slots from today on (`refreshSlotContent`); history keeps what it said.
 *
 * Every writer here is a no-op while a restore is replacing the account (ruling B2).
 */
import { and, eq, gt, gte, inArray, isNull, lte, max, ne, or, sql } from "drizzle-orm";
import { calendarEventSuppressions, plannedWorkouts, programs, sessionBuilds } from "@rg/database";
import { adaptiveConfigSchema, addDays, nowInstant, startOfIsoWeek, todayInZone, type UserPreferences } from "@rg/domain";
import { restoreInProgress } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import { chunkedInsert, chunkIds, type Db } from "./db.js";
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

/** Rule 3, as the row reads: the only slots an edit may take away — unless the athlete touched them (`TOUCHED`). */
function flexible(r: WorkoutRow, today: string): boolean {
  return (
    r.archivedAt === null &&
    r.completionState === "scheduled" &&
    r.contentState === "outline" &&
    r.effectiveDate === r.originalPlanDate &&
    r.effectiveDate > today
  );
}

/**
 * Rule 3's other half (ruling 2a-R12): a slot the athlete TOUCHED is fixed, whatever its dates say — it has a
 * schedule override of any kind (re-timed on its own day, moved away and back), or a preview build carrying their
 * overrides or swaps (a sheet customised ahead of the day). Raw SQL over `planned_workouts.id`, so it reads the
 * same inside the SELECT that plans and inside the archive's UPDATE.
 */
const TOUCHED = sql.raw(
  "(exists (select 1 from schedule_overrides so where so.workout_id = planned_workouts.id)" +
    " or exists (select 1 from session_builds sb where sb.workout_id = planned_workouts.id and sb.version = 0" +
    " and (coalesce(json_extract(sb.payload, '$.build.params.overrides'), '{}') <> '{}'" +
    " or coalesce(json_extract(sb.payload, '$.build.params.swaps'), '{}') <> '{}')))",
);

/** Bound per statement for the touched lookup: the ids, nothing else. */
const TOUCHED_ID_CHUNK = 80;

/** Which of these slots the athlete touched (`TOUCHED`). */
async function touchedSlots(db: Db, ids: readonly string[]): Promise<Set<string>> {
  const touched = new Set<string>();
  for (const batch of chunkIds([...ids], TOUCHED_ID_CHUNK)) {
    const rows = await db
      .select({ id: plannedWorkouts.id })
      .from(plannedWorkouts)
      .where(and(inArray(plannedWorkouts.id, batch), TOUCHED));
    for (const r of rows) touched.add(r.id);
  }
  return touched;
}

/**
 * Rule 4's retraction of one slot, re-checked AS IT ARCHIVES (audit 2a-model M4): the archive's UPDATE carries
 * rule 3 whole — live, outline, scheduled, unmoved, after today, untouched — so an athlete's move, re-time,
 * skip or build landing between placement's read and this write keeps the slot, and nothing else of the
 * retraction (suppression, intent) happens. True when it archived the slot.
 */
export async function retractSlot(
  db: Db,
  userId: string,
  slot: Pick<WorkoutRow, "id">,
  today: string,
  prefs: UserPreferences,
  now: string,
): Promise<boolean> {
  const removed = await removeFromPlan(db, userId, slot.id, {
    now,
    source: "program_replace",
    prefs,
    archiveReason: "program_replaced",
    onlyIf: and(
      isNull(plannedWorkouts.archivedAt),
      eq(plannedWorkouts.completionState, "scheduled"),
      eq(plannedWorkouts.contentState, "outline"),
      sql`${plannedWorkouts.effectiveDate} = ${plannedWorkouts.originalPlanDate}`,
      gt(plannedWorkouts.effectiveDate, today),
      sql`not ${TOUCHED}`,
    ),
  });
  return removed.removed;
}

/** The week's dates in placement order: preferred days as listed, then the rest Monday → Sunday. */
function rankedDays(monday: string, preferredDays: readonly number[]): string[] {
  const rest = [0, 1, 2, 3, 4, 5, 6].filter((d) => !preferredDays.includes(d));
  return [...preferredDays, ...rest].map((d) => addDays(monday, d));
}

/** The athlete's wall clock at an instant: their local date and "HH:MM". */
function localClock(instant: string, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** Whether `today`'s session window (`windowTime`) is already behind the athlete at `now`. */
function windowGone(today: string, windowTime: string, now: string, timezone: string): boolean {
  const clock = localClock(now, timezone);
  return clock.date > today || (clock.date === today && clock.time >= windowTime);
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
  // moved in from outside still holds its date). A program that wants no slots also reads every live slot past
  // the window: retiring retracts its flexible future slots wherever an earlier, wider window put them (M2).
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
          goal === 0 ? and(isNull(plannedWorkouts.archivedAt), gt(plannedWorkouts.effectiveDate, lastSunday)) : undefined,
        ),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const discipline = defaultDiscipline(program);
  // Rule 2's two limits on a NEW slot (ruling 2a-R11): never on today once today's window has passed (it would
  // only become a "Did this happen?" and a miss), and in this week only on the days a full week would hold one —
  // a program started (or a goal raised) mid-week does not cram the week's goal into what is left of it.
  const todayGone = windowGone(today, windowTimeFor({ category: discipline, date: today }, prefs), now, prefs.timezone);

  const plan = (flexibleIds: ReadonlySet<string>) => {
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
      const ranked = rankedDays(monday, config.preferredDays);
      const weekDays = week === 0 ? new Set(ranked.slice(0, goal)) : null;

      const want = new Set<string>();
      for (const date of ranked) {
        if (want.size >= need) break;
        // Race day is the race's: no session there, and a flexible one placed before the race was set moves off it.
        if (date === prefs.raceDate) continue;
        if (movable.has(date)) {
          want.add(date);
          continue;
        }
        if (date < today || occupied.has(date)) continue;
        if (weekDays && !weekDays.has(date)) continue;
        if (date === today && todayGone) continue;
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
    // Past the window only a program that wants no slots reads anything: every flexible one there goes.
    for (const r of rows) if (r.effectiveDate > lastSunday && flexibleIds.has(r.id)) toArchive.push(r);
    return { toArchive, toRevive, toInsert };
  };

  // Rule 3 by the row first; the touched check (two lookups) only when the plan would retract something — when
  // it retracts nothing, a touched slot and an untouched one are kept alike and the plan is the same.
  const byRow = rows.filter((r) => flexible(r, today)).map((r) => r.id);
  let planned = plan(new Set(byRow));
  if (planned.toArchive.length > 0) {
    const touched = await touchedSlots(db, byRow);
    if (touched.size > 0) planned = plan(new Set(byRow.filter((id) => !touched.has(id))));
  }
  const { toArchive, toRevive, toInsert } = planned;

  // A restore that began since this pass's first look owns the account now (audit 2a-model M5): slot ids are
  // the file's ids too, so not one write may land. Looked at again right before each kind of write.
  const restoreBegan = () => restoreInProgress(db, userId);

  // Retract first, then fill (spec: archive, then place the new pattern).
  if (toArchive.length > 0 && (await restoreBegan())) return result;
  for (const r of toArchive) {
    if (await retractSlot(db, userId, r, today, prefs, now)) result.archived.push(r.id);
  }

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
  if (fresh.length > 0 && (await restoreBegan())) return result;
  await chunkedInsert(fresh, (batch) => db.insert(plannedWorkouts).values(batch).onConflictDoNothing());
  result.placed.push(...fresh.map((r) => r.id));

  // A retracted slot whose day is wanted again: the same row comes back, as a fresh outline on its own day.
  if (toRevive.length > 0 && (await restoreBegan())) return result;
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

  const refreshedDates = await refreshSlotContent(db, userId, program, { discipline, seconds }, today, now, restoreBegan);
  if (refreshedDates === null) return result;

  const placedDates = [...toInsert, ...toRevive.map((r) => r.originalPlanDate), ...refreshedDates];
  if (placedDates.length > 0) {
    await separateDayCollisions(db, userId, placedDates, prefs, { from: today, now });
  }
  return result;
}

/** A built session's title: the program's name, then the build's theme (Phase 2 spec §2a "Build rules"). */
export function builtSessionTitle(programName: string, themeName: string | null | undefined): string {
  return themeName ? `${programName} · ${themeName}` : programName;
}

/** Bound per statement for the build lookup: the ids plus the query's own version floor. */
const BUILD_ID_CHUNK = 80;

/**
 * Rule 5: a slot shows what its program says NOW. A rename, a new `defaultMinutes` or a new lead discipline reaches
 * every live, still-scheduled slot of the program dated today or later — wherever it sits, moved or not:
 *  - an OUTLINE takes the name, the length and the default discipline (it has no content of its own yet);
 *  - a BUILT, not-started session takes only the name, before its build's theme — its discipline and length are
 *    the build's.
 * Started, done, resolved and past rows are history and keep what they said. Only rows that differ are written,
 * so a settled program writes nothing; a written event is flipped to `pending` so the calendar re-derives it.
 * Returns the dates whose rows changed, for the collision pass — or null, writing nothing, when `restoreBegan`
 * says a restore owns the account now (asked once, before the first write).
 */
async function refreshSlotContent(
  db: Db,
  userId: string,
  program: ProgramRow,
  content: { discipline: "strength" | "yoga"; seconds: number },
  today: string,
  now: string,
  restoreBegan: () => Promise<boolean>,
): Promise<string[] | null> {
  const live = await db
    .select({
      id: plannedWorkouts.id,
      effectiveDate: plannedWorkouts.effectiveDate,
      title: plannedWorkouts.title,
      category: plannedWorkouts.category,
      sport: plannedWorkouts.sport,
      fallbackEstimatedDurationSeconds: plannedWorkouts.fallbackEstimatedDurationSeconds,
      calendarBlockDurationSeconds: plannedWorkouts.calendarBlockDurationSeconds,
      contentState: plannedWorkouts.contentState,
      calendarSyncState: plannedWorkouts.calendarSyncState,
    })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.planId, program.id),
        eq(plannedWorkouts.origin, "program"),
        isNull(plannedWorkouts.archivedAt),
        eq(plannedWorkouts.completionState, "scheduled"),
        gte(plannedWorkouts.effectiveDate, today),
        inArray(plannedWorkouts.contentState, ["outline", "built"]),
      ),
    );

  // A built session's theme, from its latest real build — read in SQL, never by parsing the whole payload.
  const builtIds = live.filter((r) => r.contentState === "built").map((r) => r.id);
  const themeOf = new Map<string, { version: number; theme: string | null }>();
  for (const batch of chunkIds(builtIds, BUILD_ID_CHUNK)) {
    const builds = await db
      .select({
        workoutId: sessionBuilds.workoutId,
        version: sessionBuilds.version,
        theme: sql<string | null>`json_extract(${sessionBuilds.payload}, '$.view.theme.name')`,
      })
      .from(sessionBuilds)
      .where(and(inArray(sessionBuilds.workoutId, batch), gt(sessionBuilds.version, 0)));
    for (const b of builds) {
      const seen = themeOf.get(b.workoutId);
      if (!seen || b.version > seen.version) themeOf.set(b.workoutId, { version: b.version, theme: b.theme });
    }
  }

  const changes: Array<{ r: (typeof live)[number]; want: Partial<typeof plannedWorkouts.$inferInsert> }> = [];
  for (const r of live) {
    let want: Partial<typeof plannedWorkouts.$inferInsert>;
    if (r.contentState === "outline") {
      want = {
        title: program.name,
        category: content.discipline,
        sport: content.discipline,
        fallbackEstimatedDurationSeconds: content.seconds,
        calendarBlockDurationSeconds: content.seconds,
      };
    } else {
      const built = themeOf.get(r.id);
      if (!built) continue; // no build to read the theme from: leave the row as its build wrote it
      want = { title: builtSessionTitle(program.name, built.theme) };
    }
    const differs = (Object.keys(want) as Array<keyof typeof want>).some(
      (k) => want[k] !== (r as Record<string, unknown>)[k],
    );
    if (differs) changes.push({ r, want });
  }
  if (changes.length > 0 && (await restoreBegan())) return null;

  const changedDates: string[] = [];
  for (const { r, want } of changes) {
    await db
      .update(plannedWorkouts)
      .set({
        ...want,
        ...(r.calendarSyncState === "synced" ? { calendarSyncState: "pending" } : {}),
        updatedAt: now,
      })
      .where(and(eq(plannedWorkouts.id, r.id), eq(plannedWorkouts.userId, userId)));
    changedDates.push(r.effectiveDate);
  }
  return changedDates;
}

export interface PlacementSweepStats {
  programs: number;
  placed: number;
  archived: number;
  failed: number;
}

/**
 * The hourly pass: every active adaptive program of every user keeps its weeks filled as the days roll on — and
 * every adaptive program that is NOT active but still owns a flexible-looking slot after its user's today is
 * visited too, so its goal-0 pass retracts it (audit 2a-model M2: a retire racing this pass, which read the
 * program as active and placed the far week after the retire's own pass ran). Each user's today is in their own
 * timezone; an account a restore is replacing is skipped; one program failing does not stop the rest.
 */
export async function placeSlotsForAllPrograms(db: Db, at: Date = new Date()): Promise<PlacementSweepStats> {
  const stats: PlacementSweepStats = { programs: 0, placed: 0, archived: 0, failed: 0 };
  const active = await db
    .select({ id: programs.id, userId: programs.userId })
    .from(programs)
    .where(and(eq(programs.kind, "adaptive"), eq(programs.status, "active")));
  // Every zone's today is at most a day behind UTC's, so a slot still ahead of its athlete is dated on or after
  // UTC's today; each candidate is then held to its own user's today below.
  const lingering = await db
    .select({ id: programs.id, userId: programs.userId, latest: max(plannedWorkouts.effectiveDate) })
    .from(programs)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.planId, programs.id))
    .where(
      and(
        eq(programs.kind, "adaptive"),
        ne(programs.status, "active"),
        eq(plannedWorkouts.userId, programs.userId),
        eq(plannedWorkouts.origin, "program"),
        isNull(plannedWorkouts.archivedAt),
        eq(plannedWorkouts.completionState, "scheduled"),
        eq(plannedWorkouts.contentState, "outline"),
        sql`${plannedWorkouts.effectiveDate} = ${plannedWorkouts.originalPlanDate}`,
        gte(plannedWorkouts.effectiveDate, todayInZone("UTC", at)),
      ),
    )
    .groupBy(programs.id, programs.userId);
  const byUser = new Map<string, Array<{ id: string; latest: string | null }>>();
  for (const p of active) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), { id: p.id, latest: null }]);
  for (const p of lingering) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), { id: p.id, latest: p.latest }]);

  const now = nowInstant(at);
  for (const [userId, candidates] of byUser) {
    if (await restoreInProgress(db, userId)) continue;
    const prefs = await loadPreferences(db, userId);
    const today = todayInZone(prefs.timezone, at);
    // An active program always; one that is not, only while a slot of it is still ahead of today.
    const programIds = candidates.filter((c) => c.latest === null || c.latest > today).map((c) => c.id);
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
