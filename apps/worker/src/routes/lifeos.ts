/**
 * LifeOS, the owner's habit app, reads the plan: each day's planned sessions, rest days, and which sessions were
 * done (so its "Train as planned" habit follows run-garden). A read-only machine endpoint, not a browser one:
 *
 * - Auth is `Authorization: Bearer <token>`, its SHA-256 compared in constant time with the Worker secret
 *   `LIFEOS_TOKEN_SHA256`. The token is made on the owner's Mac and lives only there and on the phone; Cloudflare
 *   holds its hash. Without the secret the endpoint doesn't exist (404); a wrong or missing token is 401.
 * - The plan is the owner's (`ALLOWED_GOOGLE_EMAIL`) only. GET only; nothing is written; no cookie is read.
 */
import { Hono } from "hono";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, daysBetween, isLocalDate } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { bearerGuard } from "../auth/token.js";
import { chunkIds } from "../services/db.js";
import { plannedRowColumns } from "../services/planned-columns.js";

const { activities, plannedWorkouts, workoutCompletionMatches } = schema;

/** A planned time, `HH:MM`. */
const TIME = /^\d{2}:\d{2}$/;

/** At most this many days per request. */
export const LIFEOS_MAX_DAYS = 31;

/** The bearer door (auth/token.ts): 404 without the secret, 401 on a bad token, 503 during a restore. */
export const requireLifeosToken = bearerGuard((env) => env.LIFEOS_TOKEN_SHA256);

export interface LifeosSession {
  id: string;
  title: string;
  sport: string;
  category: string;
  /** `HH:MM`, or null when the plan gives no time. */
  time: string | null;
  /** The planned duration, rounded; null when unknown. */
  minutes: number | null;
  /** scheduled | unresolved | completed | skipped | missed */
  state: string;
  /** When the matched activity started (ISO 8601), while the match stands. */
  doneAt: string | null;
}

export interface LifeosDay {
  date: string;
  /** A rest row is planned that day. */
  rest: boolean;
  sessions: LifeosSession[];
}

export const lifeosRoutes = new Hono<AppContext>();

lifeosRoutes.use("*", requireLifeosToken);

lifeosRoutes.get("/plan", async (c) => {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!isLocalDate(from) || !isLocalDate(to) || to < from || daysBetween(from, to) + 1 > LIFEOS_MAX_DAYS) {
    return c.json({ error: "bad_range" }, 400);
  }
  const db = c.get("db");
  const ownerId = c.get("userId");

  const rows = await db
    .select(plannedRowColumns())
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, ownerId),
        gte(plannedWorkouts.effectiveDate, from),
        lte(plannedWorkouts.effectiveDate, to),
        isNull(plannedWorkouts.archivedAt),
      ),
    )
    .all();

  // A standing match's activity start, by workout.
  const doneAt = new Map<string, string>();
  const ids = rows.filter((r) => r.category !== "rest").map((r) => r.id);
  for (const chunk of chunkIds(ids)) {
    const matches = await db
      .select({ workoutId: workoutCompletionMatches.workoutId, startTime: activities.startTime })
      .from(workoutCompletionMatches)
      .innerJoin(activities, eq(activities.id, workoutCompletionMatches.activityId))
      .where(and(inArray(workoutCompletionMatches.workoutId, chunk), isNull(workoutCompletionMatches.undoneAt)))
      .all();
    // Two standing matches on one workout (nothing forbids it): the earlier start.
    for (const m of matches) {
      const seen = doneAt.get(m.workoutId);
      if (seen === undefined || m.startTime < seen) doneAt.set(m.workoutId, m.startTime);
    }
  }

  const days: LifeosDay[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const today = rows.filter((r) => r.effectiveDate === date);
    days.push({
      date,
      rest: today.some((r) => r.category === "rest"),
      sessions: today
        .filter((r) => r.category !== "rest")
        // Timed sessions first, by time; then untimed ones; then by id.
        .sort((a, b) => {
          const at = TIME.test(a.effectiveTime);
          const bt = TIME.test(b.effectiveTime);
          if (at !== bt) return at ? -1 : 1;
          return a.effectiveTime.localeCompare(b.effectiveTime) || a.id.localeCompare(b.id);
        })
        .map((r) => {
          const seconds = r.sourceEstimatedDurationSeconds ?? r.fallbackEstimatedDurationSeconds;
          return {
            id: r.id,
            title: r.title,
            sport: r.sport,
            category: r.category,
            time: TIME.test(r.effectiveTime) ? r.effectiveTime : null,
            minutes: seconds == null ? null : Math.round(seconds / 60),
            state: r.completionState,
            doneAt: doneAt.get(r.id) ?? null,
          };
        }),
    });
  }
  c.header("Cache-Control", "no-store");
  return c.json({ version: 1, days });
});
