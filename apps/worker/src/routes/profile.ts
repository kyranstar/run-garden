/**
 * `/api/profile` and `/api/objectives` — the athlete's profile, objectives and key results (programme spec §3.6–3.7
 * and its Amendment A; services/profile.ts, services/objectives.ts, services/key-result-measures.ts).
 *
 *   GET  /api/profile                    ProfileDto: goals, focus areas, events, preferences; units, timezone, race,
 *                                        places and conditions read-only
 *   PUT  /api/profile                    {goals?, focusAreas?, events?, preferences?} (each replaced whole) → ProfileDto
 *   GET  /api/objectives                 {objectives: ObjectiveDto[]} in board order
 *   POST /api/objectives                 {title, why?, status?, goalIds?, sort?, keyResults?} → 201 {objective}
 *   PUT  /api/objectives/:id             any of those; `keyResults` is the whole list → {objective}
 *   GET  /api/objectives/:id/progress    ObjectiveProgressDto: every key result measured from logged data
 *
 * 422 `invalid_profile` / `invalid_objective` with the issues; 404 `not_found` for an objective that is not this
 * account's; 423 while a restore is replacing the account. Every route is the signed-in account's alone.
 */
import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import { nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences } from "../services/calendar-sync.js";
import {
  createObjective,
  listObjectives,
  ObjectiveNotFoundError,
  objectiveProgress,
  updateObjective,
} from "../services/objectives.js";
import { loadProfile, updateProfile } from "../services/profile.js";
import { RestoreInProgressError } from "../services/programs.js";

function refusal(c: Context<AppContext>, e: unknown, invalid: "invalid_profile" | "invalid_objective"): Response {
  if (e instanceof ZodError) return c.json({ error: invalid, issues: e.issues }, 422);
  if (e instanceof ObjectiveNotFoundError) return c.json({ error: "not_found" }, 404);
  if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
  throw e;
}

const body = (c: Context<AppContext>): Promise<unknown> => c.req.json().catch(() => null);

export const profileRoutes = new Hono<AppContext>();
profileRoutes.use("*", requireUser);

profileRoutes.get("/", async (c) => c.json(await loadProfile(c.get("db"), c.get("userId"))));

profileRoutes.put("/", async (c) => {
  try {
    return c.json(await updateProfile(c.get("db"), c.get("userId"), await body(c), nowInstant()));
  } catch (e) {
    return refusal(c, e, "invalid_profile");
  }
});

export const objectiveRoutes = new Hono<AppContext>();
objectiveRoutes.use("*", requireUser);

objectiveRoutes.get("/", async (c) => c.json({ objectives: await listObjectives(c.get("db"), c.get("userId")) }));

objectiveRoutes.post("/", async (c) => {
  try {
    return c.json({ objective: await createObjective(c.get("db"), c.get("userId"), await body(c), nowInstant()) }, 201);
  } catch (e) {
    return refusal(c, e, "invalid_objective");
  }
});

objectiveRoutes.put("/:id", async (c) => {
  try {
    return c.json({ objective: await updateObjective(c.get("db"), c.get("userId"), c.req.param("id"), await body(c), nowInstant()) });
  } catch (e) {
    return refusal(c, e, "invalid_objective");
  }
});

objectiveRoutes.get("/:id/progress", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  try {
    const prefs = await loadPreferences(db, userId);
    return c.json(await objectiveProgress(db, userId, c.req.param("id"), { today: todayInZone(prefs.timezone), raceDate: prefs.raceDate }));
  } catch (e) {
    return refusal(c, e, "invalid_objective");
  }
});
