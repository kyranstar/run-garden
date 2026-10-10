/**
 * Read routes over planned workouts' documents (programme spec §3, Amendment A): one row's document with what is
 * derived from it, and a searchable list ("like last week's"). Tolerant: a row with no usable document answers
 * `{ doc: null, reason }`, never a 500. User-scoped; archived rows are not workouts and are never listed.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";
import { parseStoredWorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import { requireUser, type AppContext } from "../auth/middleware.js";
import { plannedWorkoutColumns, rowMinutes } from "../services/workout-doc-parity.js";

export const workoutRoutes = new Hono<AppContext>();
workoutRoutes.use("*", requireUser);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
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
