/**
 * Planned workouts' documents (programme spec §3, Amendment A; Stage 2 spec §10).
 *
 *   GET  /api/workouts/:id/doc   the row's document with what is derived from it, and its revision; a row with no usable
 *                                document answers `{ doc: null, reason }`, never a 500
 *   GET  /api/workouts           a searchable list ("like last week's"); archived rows are not workouts
 *   POST /api/workouts           {date, time?, doc} → 201 {workout, warnings}: a document workout (services/doc-workouts.ts)
 *   PUT  /api/workouts/:id/doc   {doc, baseRev} → {workout, rev, watchHasOlder, warnings}: its next revision
 *
 * 422 `invalid_workout` (the body), `invalid_doc` with every issue (an error in the document for its day), `past_date`;
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
  PastDateError,
  reviseDocWorkout,
  StaleRevisionError,
} from "../services/doc-workouts.js";
import { RestoreInProgressError } from "../services/programs.js";
import { plannedWorkoutColumns, rowMinutes } from "../services/workout-doc-parity.js";

export const workoutRoutes = new Hono<AppContext>();
workoutRoutes.use("*", requireUser);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A document is an object; what it holds is the validator's to judge (every issue comes back as `invalid_doc`). */
const docField = z.record(z.string(), z.unknown());
const createSchema = z
  .object({
    date: z.string().regex(DATE).refine(isLocalDate, "not a calendar date"),
    time: z.string().regex(TIME).nullable().optional(),
    doc: docField,
  })
  .strict();
const reviseSchema = z.object({ doc: docField, baseRev: z.number().int().min(0) }).strict();

function refusal(c: Context<AppContext>, e: unknown): Response {
  if (e instanceof DocInvalidError) return c.json({ error: "invalid_doc", issues: e.issues }, 422);
  if (e instanceof PastDateError) return c.json({ error: "past_date" }, 422);
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
    const created = await createDocWorkout(c.get("db"), c.get("userId"), parsed.data, await writeCtx(c));
    bookCalendar(c);
    return c.json(created, 201);
  } catch (e) {
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
  // D1 refuses a LIKE pattern over 50 bytes ("LIKE or GLOB pattern too complex"): trim, then cut silently at 40
  // characters, leaving room for the two % wildcards. An all-whitespace q is no filter. LIKE folds case for ASCII
  // only, so "é" does not match "É".
  const q = (c.req.query("q")?.trim().slice(0, Q_MAX) ?? "").trim();
  const like = q ? `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const rows = await c
    .get("db")
    .select(plannedWorkoutColumns())
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
                // json_valid guards a malformed column: json_extract would throw and fail the whole list.
                sql`CASE WHEN json_valid(${plannedWorkouts.workoutDoc}) THEN json_extract(${plannedWorkouts.workoutDoc}, '$.intent.summary') END LIKE ${like} ESCAPE '\\'`,
              )!,
            ]
          : []),
      ),
    )
    .orderBy(desc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.effectiveTime), asc(plannedWorkouts.id))
    .limit(limit);
  return c.json(
    rows.map((w) => ({
      id: w.id,
      date: w.effectiveDate,
      title: w.title,
      intentSummary: parseStoredWorkoutDoc(w.workoutDoc)?.intent.summary ?? null,
      category: w.category,
      completionState: w.completionState,
      docRev: w.workoutDocRev ?? null,
      // For display: the estimate, else the calendar slot (the parity check never uses the slot).
      minutes: rowMinutes(w),
    })),
  );
});
