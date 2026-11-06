/**
 * A COURSE'S SESSION, WRITTEN ON ITS DAY (plans with a purpose, spec §4.2 and §4.4).
 *
 * A course's sessions ahead are outlines (`program-slots.ts`): a title and a booked length, no document. On its day the
 * first of the hourly pass (`writeCourseSessionsDue`) and the session being opened (`openCourseOutline`, from
 * `session-build.ts`) writes it, once, and from then on it is an ordinary document workout. Nothing here names a course:
 * all of it reads `CourseDefinition`.
 *
 * THE NUMBER (`n`) is the plan's sessions actually done, plus one (`courseSessionsDone`), so a skipped or missed session
 * changes nothing and a workout the coach filed under the plan doesn't advance it. Two outlines on one day (one moved in)
 * are both written as the same `n`: each is the next session to do.
 *
 * DUE (`courseSessionDue`) means the row is live and scheduled, its effective date is today in the athlete's zone (so a
 * slot moved off today isn't and one moved onto it is), and its plan is running and not paused. A pause writes nothing: an
 * outline that survived its retraction (moved in, re-timed) stays an outline. So does a stopped course's, and one whose
 * definition is gone.
 *
 * THE WRITE (`writeDue`). The document is judged for its day (`judgeDoc`, with what the validator reads when only its errors
 * matter, since there's no one to show a warning to); an error writes nothing, logs by code only and leaves one note a day
 * for that session (`course_session_refused`, dismiss only), which goes when the day later allows the write. Otherwise, in
 * one atomic batch: the row flips to `origin = 'studio'` with the document, revision, title, category, sport, booked length
 * and its number (`course_session`), `easeNext` is cleared if this session used it, and the mirror is marked owed. Every
 * statement holds to one condition (`stillDue`), read against the rows as they stand inside the batch, so the batch is the
 * guard that makes it once only: a writer that lost the race, or a pause, a stop or a restore landing since the read,
 * changes nothing at all, and an easing asked for since the read waits for the next session. A
 * longer or shorter session than its outline booked then runs its day's collision pass. Its calendar event is left to the
 * half-hourly sync, as a placed slot's is: a written one is marked `pending`, and no request here pays for the calendar.
 *
 * WHAT IT COSTS: `COURSE_WRITE_COST` statements (cron-limits.ts), pinned in course-sessions.test.ts. The hourly pass reads
 * everything it needs in one statement (its rows, plans and the athletes' preferences) and writes at most
 * `COURSE_WRITES_PER_PASS`, whatever the accounts and plans; what doesn't fit waits for the next hour or an open. A session
 * the day refused goes last, so it can't hold the others up.
 *
 * A session ahead is previewed by computing it (`coursePreviewDoc`, through the build's `docOverride`), never stored on the
 * row. A session completed without being written is `course-number.ts`.
 */
import { and, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { plannedWorkouts, programs, syncNotes, userPreferences, workoutDocRevisions } from "@rg/database";
import { addDays, courseConfigSchema, nowInstant, todayInZone, userPreferencesSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { courseDefinition, deriveDoc, type CourseDefinition } from "@rg/workout";
import { loadAccountLibrary } from "./account-library.js";
import { restoreInProgress } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import { COURSE_WRITES_PER_PASS } from "./cron-limits.js";
import { runAtomicallyClaim, type Db } from "./db.js";
import { separateDayCollisions } from "./day-placement.js";
import { dayValidateCtx, judgeDoc } from "./doc-build.js";
import { markMirrorOwedIf } from "./mirror-owed.js";
import { courseSessionsDone, pausedOn } from "./program-slots.js";
import { activeProfilesOf, bookedSeconds, loadSlot, slotChecks, type BuildCtx } from "./session-build.js";
import { postSyncNote } from "./sync-notes.js";
import { revisionInsert, updateDocColumns } from "./workout-doc-store.js";

type SlotRow = typeof plannedWorkouts.$inferSelect;
type ProgramRow = typeof programs.$inferSelect;

/** An outline of a course: its plan, the definition that makes its sessions, and whether the next one is eased. */
export interface CourseOutline {
  program: ProgramRow;
  /** Null when there's no making it: an old id a plan still holds, or settings that don't read. It is never the engine's. */
  definition: CourseDefinition | null;
  easeNext: boolean;
}

/** An outline's row, by what makes it one: the slot's origin, with nothing built on it. */
const isOutline = (row: Pick<SlotRow, "origin" | "contentState">): boolean => row.origin === "program" && (row.contentState === null || row.contentState === "outline");

/** The plan as a course, or null when it's another kind. Logs by code when a running course can't be made. */
function courseOfPlan(program: ProgramRow): CourseOutline | null {
  if (program.kind !== "course") return null;
  const config = courseConfigSchema.safeParse(program.config);
  const definition = config.success ? courseDefinition(config.data.course) : null;
  if (!definition && program.status === "active") console.error(`course_definition_missing: program ${program.id}`);
  return { program, definition, easeNext: config.success && config.data.easeNext };
}

/**
 * The outline's course, or null for anything but an outline of a course (with no statement for a row that isn't a
 * programme's: the one read of its plan is only for `origin = 'program'`).
 */
export async function courseOf(db: Db, userId: string, row: Pick<SlotRow, "origin" | "contentState" | "planId">): Promise<CourseOutline | null> {
  if (!isOutline(row)) return null;
  const [program] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.id, row.planId), eq(programs.userId, userId)))
    .limit(1);
  return program ? courseOfPlan(program) : null;
}

/** Whether an outline of this plan is due today (the header's DUE). */
export function courseSessionDue(
  row: Pick<SlotRow, "archivedAt" | "completionState" | "effectiveDate">,
  program: Pick<ProgramRow, "status" | "pausedUntil">,
  today: string,
): boolean {
  return row.archivedAt === null && row.completionState === "scheduled" && row.effectiveDate === today && program.status === "active" && !pausedOn(program.pausedUntil, today);
}

/**
 * `courseSessionDue` and `courseOf` as the rows stand now, in SQL, for every statement of the write's batch. Raw names and
 * aliases, because it also runs inside an UPDATE of these very tables.
 */
const stillDue = (workoutId: string, userId: string, today: string): SQL =>
  sql`exists (select 1 from planned_workouts w join programs p on p.id = w.plan_id and p.user_id = w.user_id
    where w.id = ${workoutId} and w.user_id = ${userId} and w.origin = 'program' and coalesce(w.content_state, 'outline') = 'outline' and w.archived_at is null
      and w.completion_state = 'scheduled' and w.effective_date = ${today}
      and p.kind = 'course' and p.status = 'active' and (p.paused_until is null or p.paused_until < ${today})
      and not exists (select 1 from account_state a where a.user_id = w.user_id and coalesce(a.restore_id, '') <> ''))`;

/** The note a session the day refuses leaves: one a day for it, so the hourly pass doesn't pile them up, and a dismissal holds. */
const refusalNoteId = (workoutId: string, date: string): string => `course-refused-${workoutId}-${date}`;

/** The header's THE WRITE, of an outline already found due. True when this call wrote it. */
async function writeDue(db: Db, userId: string, row: SlotRow, course: CourseOutline, definition: CourseDefinition, n: number, ctx: BuildCtx): Promise<boolean> {
  if (await restoreInProgress(db, userId)) return false;
  const doc = definition.sessionDoc(n, { ease: course.easeNext });
  const [profiles, library] = await Promise.all([activeProfilesOf(db, userId), loadAccountLibrary(db, userId)]);
  const checks = await slotChecks(db, userId, row.id, ctx.today, ctx.today, profiles);
  const { errors } = judgeDoc(doc, dayValidateCtx({ library: library.all, offered: library.offered, profiles, checks, date: ctx.today, today: ctx.today }));
  if (errors.length > 0) {
    console.error(`course_session_refused: program ${course.program.id} ${[...new Set(errors.map((e) => e.code))].sort().join(",")}`);
    // Looked at again: the judging read a good deal, and a restore that began since owns the account now.
    if (!(await restoreInProgress(db, userId))) {
      await postSyncNote(db, { id: refusalNoteId(row.id, ctx.today), userId, workoutId: row.id, kind: "course_session_refused", payload: { sessionTitle: row.title, date: ctx.today } });
    }
    return false;
  }

  const derived = deriveDoc(doc, library.all);
  const seconds = derived.estimatedMinutes * 60;
  const booked = bookedSeconds(seconds);
  const pw = plannedWorkouts;
  const due = stillDue(row.id, userId, ctx.today);
  // The ones gated on `due` read the outline before the flip below takes it away, so all of them land or none does.
  const claimed = await runAtomicallyClaim(db, [
    // Only an easing this session used: one asked for since the read is the next session's.
    ...(course.easeNext
      ? [
          db
            .update(programs)
            .set({ config: sql`json_set(${programs.config}, '$.easeNext', json('false'))`, updatedAt: ctx.now })
            .where(and(eq(programs.id, course.program.id), eq(programs.userId, userId), due)),
        ]
      : []),
    // What it said is no longer true.
    db
      .update(syncNotes)
      .set({ dismissedAt: ctx.now })
      .where(and(eq(syncNotes.id, refusalNoteId(row.id, ctx.today)), isNull(syncNotes.dismissedAt), due)),
    markMirrorOwedIf(db, userId, row.id, ctx.now, due),
    db
      .update(pw)
      .set({
        ...updateDocColumns(doc),
        origin: "studio",
        courseSession: n,
        title: doc.title,
        category: derived.category,
        sport: derived.discipline,
        fallbackEstimatedDurationSeconds: seconds,
        calendarBlockDurationSeconds: booked,
        sourceContentFingerprint: "studio",
        // The event shows the title and the length: a written one is asked to update.
        calendarSyncState: sql`case when ${pw.calendarSyncState} = 'synced' and (${pw.title} is not ${doc.title} or ${pw.calendarBlockDurationSeconds} is not ${booked} or ${pw.category} is not ${derived.category}) then 'pending' else ${pw.calendarSyncState} end`,
        updatedAt: ctx.now,
      })
      .where(and(eq(pw.id, row.id), eq(pw.userId, userId), due)),
    // Last, because it copies the row as flipped, and it says whether the flip happened: only a new document is a new revision.
    revisionInsert(db, { userId, workoutId: row.id, sourceKind: "studio", sourceRef: doc.source.ref ?? null, now: ctx.now }).returning({ id: workoutDocRevisions.id }),
  ]);
  if (claimed === 0) return false;
  if (booked !== row.calendarBlockDurationSeconds) await separateDayCollisions(db, userId, [row.effectiveDate], ctx.prefs, { from: ctx.today, now: ctx.now });
  return true;
}

/**
 * Write this outline if it is due. `written` is false for anything else: not an outline of a course, not due, refused by
 * the day, or another writer got there first. `n` is the number it was, or would be, written as (0 when it isn't a course's).
 */
export async function writeCourseSession(db: Db, userId: string, row: SlotRow, ctx: BuildCtx): Promise<{ written: boolean; n: number }> {
  const course = await courseOf(db, userId, row);
  if (!course) return { written: false, n: 0 };
  const n = (await courseSessionsDone(db, userId, course.program.id)) + 1;
  if (!course.definition || !courseSessionDue(row, course.program, ctx.today)) return { written: false, n };
  return { written: await writeDue(db, userId, row, course, course.definition, n, ctx), n };
}

/** What opening a row found: the row as it now stands, and its course while it's still an outline of one. */
export interface OpenedOutline {
  row: SlotRow;
  course: CourseOutline | null;
}

/**
 * A row being opened (`buildSessionOutcome`, `loadSession`): today's outline is written, and whatever comes back is the row
 * as it now stands, a document row if this or another writer wrote it. No statement for a row that isn't a programme's, and
 * none past its plan's read for one that isn't due. `prefs` and `now` are read only for a write.
 */
export async function openCourseOutline(db: Db, userId: string, row: SlotRow, ctx: { today: string; now?: string; prefs?: UserPreferences }): Promise<OpenedOutline> {
  const course = await courseOf(db, userId, row);
  if (!course?.definition || !courseSessionDue(row, course.program, ctx.today)) return { row, course };
  const n = (await courseSessionsDone(db, userId, course.program.id)) + 1;
  await writeDue(db, userId, row, course, course.definition, n, { today: ctx.today, now: ctx.now ?? nowInstant(), prefs: ctx.prefs ?? (await loadPreferences(db, userId)) });
  const now = await loadSlot(db, userId, row.id);
  return { row: now, course: isOutline(now) ? course : null };
}

/**
 * The document a session ahead would be written with if it were written now: computed, never stored. One statement; null
 * when its course can't make one.
 */
export async function coursePreviewDoc(db: Db, userId: string, course: CourseOutline): Promise<WorkoutDoc | null> {
  if (!course.definition) return null;
  return course.definition.sessionDoc((await courseSessionsDone(db, userId, course.program.id)) + 1, { ease: course.easeNext });
}

/**
 * THE HOURLY PASS (the header's WHAT IT COSTS): each athlete's today in their own zone, every zone's within a day of UTC's;
 * an account a restore is replacing writes nothing; one failing doesn't stop the rest.
 */
export async function writeCourseSessionsDue(db: Db, at: Date = new Date()): Promise<{ written: number; failed: number }> {
  const stats = { written: 0, failed: 0 };
  const pw = plannedWorkouts;
  const utc = todayInZone("UTC", at);
  const rows = await db
    .select({
      row: pw,
      program: programs,
      prefs: userPreferences.prefs,
      refused: sql<number>`exists (select 1 from ${syncNotes} where ${syncNotes.id} = 'course-refused-' || ${pw.id} || '-' || ${pw.effectiveDate})`,
    })
    .from(pw)
    .innerJoin(programs, and(eq(programs.id, pw.planId), eq(programs.userId, pw.userId)))
    .leftJoin(userPreferences, eq(userPreferences.userId, pw.userId))
    .where(
      and(
        eq(programs.kind, "course"),
        eq(programs.status, "active"),
        eq(pw.origin, "program"),
        or(isNull(pw.contentState), eq(pw.contentState, "outline")),
        isNull(pw.archivedAt),
        eq(pw.completionState, "scheduled"),
        gte(pw.effectiveDate, addDays(utc, -1)),
        lte(pw.effectiveDate, addDays(utc, 1)),
      ),
    );
  // What the day refused last, so a pass's room goes to what can be written.
  const inTurn = [...rows].sort((a, b) => Number(a.refused) - Number(b.refused) || a.row.id.localeCompare(b.row.id));
  const now = nowInstant(at);
  let attempts = 0;
  for (const { row, program, prefs: stored } of inTurn) {
    if (attempts >= COURSE_WRITES_PER_PASS) break;
    try {
      const prefs = userPreferencesSchema.parse(stored ?? {});
      const today = todayInZone(prefs.timezone, at);
      // The read held it to the rest of what's due. These are what it can't know: the athlete's today, and so the pause.
      if (row.effectiveDate !== today || pausedOn(program.pausedUntil, today)) continue;
      const course = courseOfPlan(program);
      if (!course?.definition) continue;
      attempts += 1;
      const n = (await courseSessionsDone(db, row.userId, program.id)) + 1;
      if (await writeDue(db, row.userId, row, course, course.definition, n, { today, now, prefs })) stats.written += 1;
    } catch (e) {
      stats.failed += 1;
      console.error(`course session write failed for program ${program.id}: ${e instanceof Error ? e.name : "unknown"}`);
    }
  }
  return stats;
}
