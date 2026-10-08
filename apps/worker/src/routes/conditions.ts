/**
 * `/api/conditions` — which health conditions the athlete has switched on (Phase 2 spec §2c "Settings sections";
 * services/user-conditions.ts). The day's check (`POST /api/conditions/checks`) lives with the sessions
 * (routes/sessions.ts) and shares this base path.
 *
 *   GET  /   {profiles: [{profileId, label, active, since}]} — every profile the library knows
 *   PUT  /   {profileId, active} → the same list; `since` is the first day it was switched on, kept across off/on
 *
 * 422 `invalid_condition` for a malformed body, `unknown_profile` for a profile the library does not know; 423 while
 * a restore is replacing the account. The base path is shared: the check routes' wildcard already authenticates every
 * `/api/conditions` request when both are mounted (index.ts), so each route here authenticates only a request nothing
 * has yet — one session read either way, and this module still stands alone.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { RestoreInProgressError } from "../services/programs.js";
import { listConditions, setCondition, UnknownConditionError } from "../services/user-conditions.js";

export const conditionSettingsRoutes = new Hono<AppContext>();

/** `requireUser`, unless it already ran for this request. */
const authenticated: MiddlewareHandler<AppContext> = async (c, next) => (c.get("userId") ? next() : requireUser(c, next));

const changeSchema = z.object({ profileId: z.string().min(1).max(60), active: z.boolean() }).strict();

conditionSettingsRoutes.get("/", authenticated, async (c) => c.json({ profiles: await listConditions(c.get("db"), c.get("userId")) }));

conditionSettingsRoutes.put("/", authenticated, async (c) => {
  const parsed = changeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_condition", issues: parsed.error.issues }, 422);
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  try {
    return c.json({ profiles: await setCondition(db, userId, parsed.data, { today: todayInZone(prefs.timezone) }) });
  } catch (e) {
    if (e instanceof UnknownConditionError) return c.json({ error: "unknown_profile" }, 422);
    if (e instanceof RestoreInProgressError) return c.json({ error: "restore_in_progress" }, 423);
    throw e;
  }
});
