/**
 * `/api/plans` — the athlete's plans, each with its purpose, brief and ending (plans with a purpose, Stage 1).
 *
 *   GET    /             {plans: PlanSummaryDto[]}: the programmes, courses, coach plans and COROS plans, never a
 *                        phase and never the one-off bucket; two reads and the preferences. With drafts on
 *                        (plan-drafts.ts `planDraftsOn`), a coach plan's draft is read with its row, no read more, and its
 *                        prompt says where the draft stands (and `note`, when it came to nothing).
 *   PATCH  /:id          {purpose?, brief?, onEnd?, objectiveIds?, pausedUntil?, easeNext?} → {plan}
 *   POST   /courses      {course, weekdays, time} → {plan, more, waiting?}: start a course (`course-plans.ts`)
 *   POST   /:id/stop     → {more, waiting?}: stop a plan
 *
 * An edit that breaks a rule (too long, an ending the kind doesn't allow, a pause in the past, easing a plan that
 * isn't a course) is 422 with the issues; another account's plan is 404; a restore in progress is 423. `/api/programs`
 * keeps answering adaptive programmes alone.
 *
 * A change to the pause, set or cleared, runs the plan's placement pass in this request (`placeAfterPauseChange`), in what
 * the request has left: today's session comes off at once, or the outlines come back, and what doesn't fit is the next
 * hourly pass's.
 *
 * A START is idempotent per course, since a course has one plan. An unknown course or days and a time `courseConfigSchema`
 * refuses are 422, and other days or another time on a course already running are 409 `course_running`, saying how to change
 * them: answering 200 and ignoring them would be false. Stop and start is the one way, since a revival takes the new days and its
 * number goes on; changing them in place would also have to re-place the outlines. A definition says nothing of a limit on
 * sessions a week, so none is held to.
 *
 * A STOP IS ONE ROUTE, AND NOT A SECOND WAY TO STOP ANYTHING. Each kind stops as it always has, by the code that has always
 * stopped it, and this only finds it from the plan's id:
 *  - a course: `stopCourse`, built on what a programme's retirement runs (placement's goal 0 pass) and the document removal path;
 *  - a programme: what `PATCH /api/programs/:id {status: "retired"}` runs (`updateProgram`, `placeAndBook`);
 *  - a coach plan: what a line's "Stop this plan" sends a block at a time (`POST /api/coach/plans/:id/retire?stop=`), for each
 *    block that hasn't ended (`stopBlocks`), with its one receipt. The last of them stops the plan's own row too, as on every
 *    path that stops a coach plan (`plan-status.ts`).
 *  - a Studio plan stops by `POST /api/studio/plans/:id/retire`, whose checks (the current plan, not over) live in that route,
 *    so it isn't sent there from here, though its row's `source.studioPlanId` names it; a watch plan stops on the watch. Both
 *    are 409 `not_stoppable`.
 *
 * Both do what fits a request's budget, and `more` says something is left: send the same request again until it's false. With
 * `waiting: true` as well, all that's left is mid-send, so a resend can't help: stop asking, and the hourly pass finishes it. A
 * client that never comes back loses nothing: the same (`finishCoursesPartWay`). A restore in progress is 423 from both.
 */
import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { coachPlans, programs } from "@rg/database";
import { courseConfigSchema, nowInstant, planEnded, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { restoreInProgress } from "../services/account-state.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { COURSE_RUNNING_WHY, startCourse, stopCourse } from "../services/course-plans.js";
import { REQUEST_BUDGET } from "../services/design-approve.js";
import { planDraftsOn } from "../services/plan-drafts.js";
import { applyPlanPatch, listPlans } from "../services/plan-registry.js";
import { planStoppedIfNoBlockLeft } from "../services/plan-status.js";
import { isPlanKind } from "../services/plan-summaries.js";
import { placeAfterPauseChange } from "../services/program-slots.js";
import { RestoreInProgressError, updateProgram } from "../services/programs.js";
import { receipt } from "./coach.js";
import { placeAndBook } from "./programs.js";
import { stopBlocks } from "./thread-structural.js";

/** What a patch spends beside its pass, at its most: the session and the user, the preferences, the patch's five, the list. */
const PLAN_PATCH_FIXED = 12;

/**
 * What a start spends beside its step, at its most: the session, the look for a restore (the middleware's and its own), the
 * preferences, the plan read, its write with a revival's version read and written, the list. Pinned in course-start.test.ts.
 */
export const COURSE_START_FIXED = 1 + 2 + 1 + 1 + 3 + 2;

/**
 * What a stop spends beside its step, at its most: the session, the look for a restore (the middleware's and its own), the
 * preferences, the plan and its status. Pinned in course-start.test.ts.
 */
export const PLAN_STOP_FIXED = 1 + 2 + 1 + 1 + 1;

/** The body of a start: the settings `courseConfigSchema` holds a course to, what's asked for and nothing else. */
const courseStartSchema = courseConfigSchema.pick({ course: true, weekdays: true, time: true }).strict();

export const planRoutes = new Hono<AppContext>();
planRoutes.use("*", requireUser);

planRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  return c.json({ plans: await listPlans(db, userId, todayInZone(prefs.timezone), { drafts: planDraftsOn(c.env) }) });
});

planRoutes.patch("/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();
  const result = await applyPlanPatch(db, userId, id, await c.req.json().catch(() => null), now, today);
  if (!result.ok) {
    if (result.error === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.error === "restore_in_progress") return c.json({ error: "restore_in_progress" }, 423);
    return c.json({ error: "invalid_plan", issues: result.issues }, 422);
  }
  if (result.changed.includes("pausedUntil")) await placeAfterPauseChange(db, userId, id, today, prefs, now, REQUEST_BUDGET - PLAN_PATCH_FIXED);
  const plan = (await listPlans(db, userId, today, { drafts: planDraftsOn(c.env) })).find((p) => p.id === id);
  return c.json({ plan });
});

planRoutes.post("/courses", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = courseStartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_plan", issues: parsed.error.issues }, 422);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  try {
    const started = await startCourse(db, userId, parsed.data, { today, now: nowInstant(), prefs }, REQUEST_BUDGET - COURSE_START_FIXED);
    if (!started.ok) {
      if (started.error === "restore_in_progress") return c.json({ error: "restore_in_progress" }, 423);
      if (started.error === "course_running") return c.json({ error: "course_running", why: COURSE_RUNNING_WHY }, 409);
      return c.json({ error: "invalid_plan", issues: [{ path: ["course"], message: "no such course" }] }, 422);
    }
    const plan = (await listPlans(db, userId, today, { drafts: planDraftsOn(c.env) })).find((p) => p.id === started.planId);
    return c.json({ plan, more: started.more, ...(started.waiting ? { waiting: true } : {}) });
  } catch (e) {
    if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
    throw e;
  }
});

planRoutes.post("/:id/stop", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();
  if (await restoreInProgress(db, userId)) return c.json({ error: "restore_in_progress" }, 423);
  const [plan] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.id, id), eq(programs.userId, userId)))
    .limit(1);
  // An archived row is no plan, as the list and an edit have it; nor is the one-off bucket.
  if (!plan || plan.archivedAt !== null || !isPlanKind(plan.kind)) return c.json({ error: "not_found" }, 404);
  try {
    if (plan.kind === "course") {
      return c.json(await stopCourse(db, userId, plan, { today, now, prefs }, REQUEST_BUDGET - PLAN_STOP_FIXED));
    }
    if (plan.kind === "adaptive") {
      await updateProgram(db, userId, id, { status: "retired" }, now);
      return c.json({ more: await placeAndBook(c, id, today, now, prefs) });
    }
    const blocks = plan.kind === "coach" ? await db.select().from(coachPlans).where(and(eq(coachPlans.userId, userId), eq(coachPlans.programId, id))).orderBy(asc(coachPlans.startDate), asc(coachPlans.id)) : [];
    if (blocks.length === 0) return c.json({ error: "not_stoppable" }, 409);
    const live = blocks.filter((b) => b.status !== "retired" && !planEnded(b.endDate, today));
    // Nothing left to retire, and nothing written yet to say the plan is stopped.
    if (live.length === 0) {
      await planStoppedIfNoBlockLeft(db, { userId, today, now }, { plan: id });
      return c.json({ more: false });
    }
    // The session, the two looks for a restore, the preferences, the plan, its blocks, and the one receipt.
    return c.json(await stopBlocks(db, userId, live.map((b) => b.id), prefs, REQUEST_BUDGET - (PLAN_STOP_FIXED + 1), (body) => receipt(db, userId, body)));
  } catch (e) {
    if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
    throw e;
  }
});
