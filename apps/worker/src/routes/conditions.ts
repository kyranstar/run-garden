/**
 * `/api/conditions` — which health conditions the athlete has switched on (Phase 2 spec §2c "Settings sections";
 * services/user-conditions.ts), and a condition's daytime cue on their calendar (services/condition-cues.ts). The day's
 * check (`POST /api/conditions/checks`) lives with the sessions (routes/sessions.ts) and shares this base path.
 *
 *   GET    /                    {profiles: [{profileId, label, active, since}]} — every profile the library knows
 *   PUT    /                    {profileId, active} → the same list; `since` is the first day it was switched on, kept
 *                               across off/on
 *   PUT    /:profileId/cues     {times: ["HH:MM", …]} (24-hour, none twice, at most 4) → {cues: {profileId, words,
 *                               times, timezone}, done}: one recurring calendar event per time, the others removed; the
 *                               same times again change nothing. 202 `done: false` when a request's calls ran out (try
 *                               again); 502 `calendar_failed` when Google failed part way — `cues` says what is there
 *   DELETE /:profileId/cues     → the same, with no times: every cue event removed
 *
 * 422 `invalid_condition` for a malformed body, `unknown_profile` for a profile the library does not know,
 * `invalid_cue_times`, `no_cue` for a profile with none; 409 `condition_off` (a cue needs its condition on; turning
 * cues off doesn't), `cues_busy` while another change to them is under way; 412 `google_not_connected`, `no_calendar`;
 * 423 while a restore is replacing the account. Every refusal has a `message` in plain words. The base path is shared:
 * the check routes' wildcard already authenticates every `/api/conditions` request when both are mounted (index.ts),
 * so each route here authenticates only a request nothing has yet — one session read either way, and this module still
 * stands alone.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { conditionCueTimesSchema, todayInZone } from "@rg/domain";
import { isProfileId } from "@rg/exercise-library";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { clearConditionCues, setConditionCues } from "../services/condition-cues.js";
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

// ── The daytime cue ─────────────────────────────────────────────────────────────────────────────────────────────────

const UNKNOWN_PROFILE = { error: "unknown_profile", message: "No such condition." } as const;
const cueBodySchema = z.object({ times: z.array(z.unknown()) }).strict();

conditionSettingsRoutes.put("/:profileId/cues", authenticated, async (c) => {
  const profileId = c.req.param("profileId");
  if (!isProfileId(profileId)) return c.json(UNKNOWN_PROFILE, 422);
  const body = cueBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid_cue_times", message: 'send { "times": ["HH:MM", …] }' }, 422);
  const times = conditionCueTimesSchema.safeParse(body.data.times);
  if (!times.success) return c.json({ error: "invalid_cue_times", message: times.error.issues[0]!.message }, 422);
  const answer = await setConditionCues(c.get("db"), c.env, c.get("userId"), profileId, times.data);
  return c.json(answer.body, answer.status);
});

conditionSettingsRoutes.delete("/:profileId/cues", authenticated, async (c) => {
  const profileId = c.req.param("profileId");
  if (!isProfileId(profileId)) return c.json(UNKNOWN_PROFILE, 422);
  const answer = await clearConditionCues(c.get("db"), c.env, c.get("userId"), profileId);
  return c.json(answer.body, answer.status);
});
