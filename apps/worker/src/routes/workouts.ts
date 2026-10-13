/**
 * Planned workouts' documents (programme spec §3, Amendment A; Stage 2 spec §10).
 *
 *   GET  /api/workouts/:id/doc   the row's document with what is derived from it, and its revision; a row with no usable
 *                                document answers `{ doc: null, reason }`, never a 500
 *   GET  /api/workouts           a searchable list ("like last week's"); archived rows are not workouts
 *   POST /api/workouts           {date, time?, doc, clientId?} → 201 {workout, warnings}: a document workout
 *                                (services/doc-workouts.ts); a `clientId` it has seen → 200 with that row, nothing written
 *                                `startNow: true` (the builder's Start now): never planned, so booked on no calendar
 *   PUT  /api/workouts/:id/doc   {doc, baseRev} → {workout, rev, watchHasOlder, warnings}: its next revision
 *   DELETE /api/workouts/:id     → {ok}: a Studio or template workout never started removed, its calendar event and its
 *                                unsent watch work with it; 409 `not_removable` with its `reason` (not_studio, started,
 *                                done, sending)
 *
 * 422 `invalid_workout` (the body), `invalid_doc` with every issue (an error in the document for its day), `past_date`,
 * `run_unsupported` (a document that derives to a run: no run is played from the Studio yet);
 * 409 `stale_revision` with the current `rev`, or `not_editable` (a programme's session, or one resolved or under way);
 * 404 for a row that is not this account's; 423 while a restore is replacing the account. User-scoped throughout. A
 * new workout, and a revision that changes what its event shows, hand the calendar one bounded sync step.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";
import { isLocalDate, nowInstant, parseStoredWorkoutDoc, todayInZone } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import { requireUser, type AppContext } from "../auth/middleware.js";
import { CALENDAR_OPS_PER_REQUEST, loadPreferences, syncCalendar } from "../services/calendar-sync.js";
import { waitUntilSafe } from "../services/wait-until.js";
import {
  createDocWorkout,
  DocInvalidError,
  DocWorkoutNotFoundError,
  NotEditableError,
  NotRemovableError,
  PastDateError,
  removeDocWorkout,
  reviseDocWorkout,
  RunUnsupportedError,
  StaleRevisionError,
  StartedTodayError,
} from "../services/doc-workouts.js";
import { RestoreInProgressError } from "../services/programs.js";
import { plannedWorkoutColumns, rowMinutes } from "../services/workout-doc-parity.js";

export const workoutRoutes = new Hono<AppContext>();
workoutRoutes.use("*", requireUser);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A client's key for a create (a draft's, made once on the device): letters, digits, `-` and `_`. */
export const CLIENT_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** A document is an object; what it holds is the validator's to judge (every issue comes back as `invalid_doc`). */
const docField = z.record(z.string(), z.unknown());
const createSchema = z
  .object({
    date: z.string().regex(DATE).refine(isLocalDate, "not a calendar date"),
    time: z.string().regex(TIME).nullable().optional(),
    doc: docField,
    /** The draft's key, made once on the device: a create retried with it answers the row it made (200). */
    clientId: CLIENT_ID.optional(),
    /** Made to start at once (the builder's Start now): never planned, so booked on no calendar. */
    startNow: z.literal(true).optional(),
  })
  .strict();
const reviseSchema = z.object({ doc: docField, baseRev: z.number().int().min(0) }).strict();

function refusal(c: Context<AppContext>, e: unknown): Response {
  if (e instanceof DocInvalidError) return c.json({ error: "invalid_doc", issues: e.issues }, 422);
  if (e instanceof PastDateError) return c.json({ error: "past_date" }, 422);
  if (e instanceof StartedTodayError) return c.json({ error: "started_today", workout: e.workout }, 409);
  if (e instanceof RunUnsupportedError) return c.json({ error: "run_unsupported", message: "Runs can't be planned in the Studio yet." }, 422);
  if (e instanceof DocWorkoutNotFoundError) return c.json({ error: "not_found" }, 404);
  if (e instanceof NotEditableError) return c.json({ error: "not_editable" }, 409);
  if (e instanceof StaleRevisionError) return c.json({ error: "stale_revision", rev: e.rev }, 409);
  if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
  throw e;
}

async function writeCtx(c: Context<AppContext>) {
  const prefs = await loadPreferences(c.get("db"), c.get("userId"));
  return { today: todayInZone(prefs.timezone), now: nowInstant(), prefs };
}

/**
 * The calendar follows the plan, as it does after the athlete's own edits: one bounded step of the sync in this
 * request (`CALENDAR_OPS_PER_REQUEST`); the half-hourly reconcile books whatever it left.
 */
function bookCalendar(c: Context<AppContext>): void {
  waitUntilSafe(c, syncCalendar(c.get("db"), c.env, c.get("userId"), { maxOps: CALENDAR_OPS_PER_REQUEST }).catch(() => undefined));
}

workoutRoutes.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_workout", issues: parsed.error.issues }, 422);
  try {
    const { repeated, ...created } = await createDocWorkout(c.get("db"), c.get("userId"), parsed.data, await writeCtx(c));
    // A repeated key wrote nothing: nothing new to book; nor does Start now, which books nothing.
    if (repeated) return c.json(created, 200);
    if (!parsed.data.startNow) bookCalendar(c);
    return c.json(created, 201);
  } catch (e) {
    return refusal(c, e);
  }
});

workoutRoutes.delete("/:id", async (c) => {
  try {
    await removeDocWorkout(c.get("db"), c.get("userId"), c.req.param("id"), await writeCtx(c));
    // Its calendar event comes off with the next step of the sync, which this request hands it.
    bookCalendar(c);
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof NotRemovableError) return c.json({ error: "not_removable", reason: e.reason }, 409);
    return refusal(c, e);
  }
});

workoutRoutes.put("/:id/doc", async (c) => {
  const parsed = reviseSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_workout", issues: parsed.error.issues }, 422);
  try {
    const { calendarChanged, ...revised } = await reviseDocWorkout(c.get("db"), c.get("userId"), c.req.param("id"), parsed.data, await writeCtx(c));
    if (calendarChanged) bookCalendar(c);
    return c.json(revised);
  } catch (e) {
    return refusal(c, e);
  }
});
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const Q_MAX = 40;
/** D1 refuses a LIKE pattern over this many BYTES ("LIKE or GLOB pattern too complex"). */
const LIKE_MAX_BYTES = 50;

/**
 * q as a LIKE pattern (ESCAPE '\'): trimmed and cut at 40 characters, its `\`, `%` and `_` escaped, between two `%`
 * wildcards — then shortened a whole character at a time (never half an emoji, never a backslash without its
 * character) until the pattern is within D1's 50 bytes of UTF-8. An all-whitespace q is no filter (null). LIKE folds
 * case for ASCII only, so "é" does not match "É".
 */
export function likePatternOf(raw: string | undefined): string | null {
  const chars = [...(raw?.trim() ?? "")].slice(0, Q_MAX);
  const bytes = new TextEncoder();
  for (let n = chars.length; n > 0; n--) {
    const q = chars.slice(0, n).join("").trim();
    if (!q) return null;
    const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    if (bytes.encode(pattern).length <= LIKE_MAX_BYTES) return pattern;
  }
  return null;
}

/**
 * The document's intent summary, read in SQL: the list never carries a whole document. NULL for no document, a
 * malformed one (json_valid: json_extract would throw and fail the whole list), another version, or no text there.
 */
const summarySql = sql<string | null>`case when json_valid(${plannedWorkouts.workoutDoc}) and json_extract(${plannedWorkouts.workoutDoc}, '$.version') = 1 and json_type(${plannedWorkouts.workoutDoc}, '$.intent.summary') = 'text' then json_extract(${plannedWorkouts.workoutDoc}, '$.intent.summary') end`;

workoutRoutes.get("/:id/doc", async (c) => {
  const row = (
    await c
      .get("db")
      .select(plannedWorkoutColumns())
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, c.get("userId"))))
      .limit(1)
  )[0];
  // An archived row is not a workout: the same 404 as the list implies.
  if (!row || row.archivedAt) return c.json({ error: "not_found" }, 404);
  const doc = parseStoredWorkoutDoc(row.workoutDoc);
  if (!doc) return c.json({ doc: null, reason: row.workoutDoc === null || row.workoutDoc === undefined ? "missing" : "invalid" });
  return c.json({ doc, derived: deriveDoc(doc, EXERCISES), rev: row.workoutDocRev ?? null });
});

workoutRoutes.get("/", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if ((from !== undefined && !DATE.test(from)) || (to !== undefined && !DATE.test(to))) return c.json({ error: "bad_date" }, 400);
  const asked = Number(c.req.query("limit"));
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), LIST_MAX) : LIST_DEFAULT;
  const like = likePatternOf(c.req.query("q"));
  const rows = await c
    .get("db")
    .select({
      id: plannedWorkouts.id,
      date: plannedWorkouts.effectiveDate,
      title: plannedWorkouts.title,
      intentSummary: summarySql,
      category: plannedWorkouts.category,
      completionState: plannedWorkouts.completionState,
      docRev: plannedWorkouts.workoutDocRev,
      sourceEstimatedDurationSeconds: plannedWorkouts.sourceEstimatedDurationSeconds,
      fallbackEstimatedDurationSeconds: plannedWorkouts.fallbackEstimatedDurationSeconds,
      calendarBlockDurationSeconds: plannedWorkouts.calendarBlockDurationSeconds,
    })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, c.get("userId")),
        isNull(plannedWorkouts.archivedAt),
        ...(from ? [gte(plannedWorkouts.effectiveDate, from)] : []),
        ...(to ? [lte(plannedWorkouts.effectiveDate, to)] : []),
        ...(like
          ? [
              or(
                sql`${plannedWorkouts.title} LIKE ${like} ESCAPE '\\'`,
                sql`${summarySql} LIKE ${like} ESCAPE '\\'`,
              )!,
            ]
          : []),
      ),
    )
    .orderBy(desc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.effectiveTime), asc(plannedWorkouts.id))
    .limit(limit);
  return c.json(
    rows.map(({ sourceEstimatedDurationSeconds, fallbackEstimatedDurationSeconds, calendarBlockDurationSeconds, ...w }) => ({
      ...w,
      // For display: the estimate, else the calendar slot (the parity check never uses the slot).
      minutes: rowMinutes({ sourceEstimatedDurationSeconds, fallbackEstimatedDurationSeconds, calendarBlockDurationSeconds }),
    })),
  );
});
