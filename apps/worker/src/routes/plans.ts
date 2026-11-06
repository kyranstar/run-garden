/**
 * `/api/plans` — the athlete's plans, each with its purpose, brief and ending (plans with a purpose, Stage 1).
 *
 *   GET    /             {plans: PlanSummaryDto[]}: the programmes, courses, coach plans and COROS plans, never a
 *                        phase and never the one-off bucket; two reads and the preferences
 *   PATCH  /:id          {purpose?, brief?, onEnd?, objectiveIds?, pausedUntil?, easeNext?} → {plan}
 *
 * An edit that breaks a rule (too long, an ending the kind doesn't allow, a pause in the past, easing a plan that
 * isn't a course) is 422 with the issues; another account's plan is 404; a restore in progress is 423. `/api/programs`
 * keeps answering adaptive programmes alone.
 */
import { Hono } from "hono";
import { nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { applyPlanPatch, listPlans } from "../services/plan-registry.js";

export const planRoutes = new Hono<AppContext>();
planRoutes.use("*", requireUser);

planRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  return c.json({ plans: await listPlans(db, userId, todayInZone(prefs.timezone)) });
});

planRoutes.patch("/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const result = await applyPlanPatch(db, userId, id, await c.req.json().catch(() => null), nowInstant(), today);
  if (!result.ok) {
    if (result.error === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.error === "restore_in_progress") return c.json({ error: "restore_in_progress" }, 423);
    return c.json({ error: "invalid_plan", issues: result.issues }, 422);
  }
  const plan = (await listPlans(db, userId, today)).find((p) => p.id === id);
  return c.json({ plan });
});
