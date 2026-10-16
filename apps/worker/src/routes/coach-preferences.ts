/**
 * `/api/coach/preferences` — Settings → Coach (Stage 3 Task 10; spec §6): how the coach designer starts when the
 * athlete doesn't say (the default scope; how many "next workouts"), their preferred training times, and each run's
 * spending limit, which they may lower but never raise past its default. Stored as `coach` in the user's preferences
 * (`coachPreferencesSchema`); a create reads it from the preferences read it already makes (services/coach-runs.ts).
 *
 * Inert as the runs are: a plain 404 unless `COACH_DESIGNER = "1"` or this is staging, signed in or not; then the
 * session is checked. Mounted ahead of `/api/coach` in index.ts so the coach's own sign-in never answers first.
 *
 *   GET /   → { coach, settings, model }   (what the athlete set; the settings in force; the model, in plain words —
 *             the session and the preferences, two statements)
 *   PUT /   { …settings } → the same       (the settings, whole: what is left out is its default again; the rest of
 *             the preferences untouched — the session, the restore marker, one write, three statements)
 */
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { userPreferences } from "@rg/database";
import { coachPreferencesSchema, coachSettings, nowInstant, userPreferencesSchema, type CoachPreferences } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { coachDesignerEnabled } from "../env.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { designModel } from "../services/llm-messages.js";

/** A model id as the athlete reads it: "anthropic/claude-opus-5.5" → "Claude Opus 5.5"; another id, its own name. */
export function modelName(id: string): string {
  const name = id.slice(id.indexOf("/") + 1);
  const claude = /^claude-([a-z]+)-(\d+(?:\.\d+)?)(-fast)?$/.exec(name);
  if (!claude) return name;
  const family = claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1);
  return `Claude ${family} ${claude[2]}${claude[3] ? " (fast)" : ""}`;
}

export const coachPreferenceRoutes = new Hono<AppContext>();

coachPreferenceRoutes.use("*", async (c, next) => {
  if (!coachDesignerEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  await next();
});
coachPreferenceRoutes.use("*", requireUser);

function answer(coach: CoachPreferences | undefined, model: string) {
  return { coach: coach ?? {}, settings: coachSettings(coach), model: { id: model, name: modelName(model) } };
}

coachPreferenceRoutes.get("/", async (c) => {
  const prefs = await loadPreferences(c.get("db"), c.get("userId"));
  return c.json(answer(prefs.coach, designModel(c.env)));
});

coachPreferenceRoutes.put("/", async (c) => {
  const raw = await c.req.json().catch(() => undefined);
  const parsed = coachPreferencesSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_coach_settings", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      400,
    );
  }
  const userId = c.get("userId");
  const now = nowInstant();
  const coach = JSON.stringify(parsed.data);
  // One statement: only `coach` changes, whatever else the preferences hold (an account with none yet gets a row
  // holding the settings alone; every other preference reads as its default, as before).
  const [row] = (await c.get("db").all(sql`
    INSERT INTO ${userPreferences} (user_id, prefs, updated_at) VALUES (${userId}, json_object('coach', json(${coach})), ${now})
    ON CONFLICT (user_id) DO UPDATE SET prefs = json_set(prefs, '$.coach', json(${coach})), updated_at = ${now}
    RETURNING prefs
  `)) as Array<{ prefs: string }>;
  const stored = userPreferencesSchema.safeParse(row ? JSON.parse(row.prefs) : {});
  return c.json(answer(stored.success ? stored.data.coach : parsed.data, designModel(c.env)));
});
