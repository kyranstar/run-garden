import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { auditEvents, corosExercises, studioPlans } from "@rg/database";
import { compareLocalDates, liftingPlanSchema, newId, nowInstant, todayInZone, type LiftingPlan } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import type { Db } from "../services/db.js";
import { waitUntilSafe } from "../services/wait-until.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { retireStudioPlan, studioPlanEnd, studioPlanRetired } from "../services/studio-push.js";
import { applyExerciseRemap, type RemapRule } from "../services/studio-repair.js";
import { corosConnectionStatus } from "../services/coros-connection.js";
import { corosReadNow } from "../services/coros-read.js";

/**
 * What is left of the old Plan Studio's API (plan-studio-design §7), after the safety audit (2026-11-06, S6).
 *
 * The decision of 2026-10-10 (principles §11, §12): the new Studio replaces the old Studio — its AI plan generator — and
 * its screens and code are removed. Its routes outlived its screens: `generate` and `edit` still wrote an AI lifting plan,
 * and `push`, `push/retry` and `adoption/:pushId/undo` put it on the watch with COROS ids and no condition gate. No
 * client called any of them (packages/ui, apps/web, packages/api-client — the client's functions are gone too), so they
 * are unmounted, and with them the reads only the old screens made (`GET /`, `GET /history`). What stays:
 *
 *  - `POST /plans/:id/retire` — the Plan modal's Retire of an old plan (api-client `studioPlanRetire`): what is ahead
 *    leaves the watch, what is behind stays.
 *  - `POST /plans/:id/repair-exercise-ids` — an operator's correction of a stored plan's exercise ids; it never touches
 *    COROS.
 *
 * An old plan's failed rows are still retried by Settings → Sync's Retry (routes/sync.ts) and an adopted session undone
 * from a sync note there: those re-send a plan the athlete already pushed, and never generate one.
 *
 * "The current plan" is the account's most recently created `studio_plans` row (`loadCurrentPlan`).
 */

export const studioRoutes = new Hono<AppContext>();
studioRoutes.use("*", requireUser);

/**
 * F3 (fix round 1): every other route in this repo calls `c.req.json()`
 * directly (`plan.ts`'s `moveSchema`, `misc.ts`'s `settingsRoutes.put`, …),
 * which throws on genuinely malformed JSON and — unhandled — becomes an
 * opaque 500. Studio's own binding carry-forward (i) is "structured reason
 * codes only", so a malformed body here gets its own structured 400 instead
 * of matching that pre-existing (but not this task's to fix elsewhere)
 * pattern. Used by every POST route that reads a body (`/push` doesn't, so
 * it has nothing to wrap).
 */
async function parseJsonBody(
  c: Context<AppContext>,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false, response: c.json({ error: "invalid_json" }, 400) };
  }
}

async function loadCurrentPlan(db: Db, userId: string) {
  // Binding carry-forward (c): scoped by userId — studio_plans carries the
  // column precisely so one account's draft can never be read or edited by
  // another's session.
  return (
    await db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.userId, userId))
      .orderBy(desc(studioPlans.createdAt))
      .limit(1)
  )[0];
}

/**
 * Binding carry-forward (d): an empty (never-synced) catalog gets a
 * structured `catalog_not_synced` error, not a crash or a confusing
 * `unknown_exercise` from the LLM layer — checked before spending any LLM
 * budget on a request that cannot possibly succeed.
 *
 * The `reason` tells the UI what the user can actually do about it:
 * `syncing` (the cloud connection is live and a pull is already on its way —
 * wait a beat) or `not_connected` (connect COROS in Settings).
 */
async function catalogNotSynced(c: Context<AppContext>) {
  const db = c.get("db");
  const userId = c.get("userId");
  // The catalog rides corosReadNow when stale. Connected → "syncing" is
  // genuinely true — kick a forced pull right now so "try again in a minute"
  // delivers (the coros_read lock absorbs stampedes).
  const cloud = await corosConnectionStatus(db, userId);
  if (cloud.connected) {
    const prefs = await loadPreferences(db, userId);
    waitUntilSafe(c, corosReadNow(db, c.env, userId, prefs, { force: true }).catch(() => undefined));
    return c.json({ error: "catalog_not_synced", reason: "syncing" }, 412);
  }
  return c.json({ error: "catalog_not_synced", reason: "not_connected" }, 412);
}

function pushOutcomeResponse(
  c: Context<AppContext>,
  summary: { ok: boolean; error?: "plan_not_found" | "invalid_plan" | "writes_disabled" },
) {
  const status =
    summary.error === "plan_not_found" ? 404 : summary.error === "writes_disabled" ? 412 : 500;
  return c.json({ error: summary.error ?? "push_failed" }, status);
}

// ── POST /api/studio/plans/:id/repair-exercise-ids ───────────────────────────
//
// The one planId-PARAMETERIZED route on this surface (every other one operates
// on "the current plan", see the module header). A repair targets a specific
// stored plan by id on purpose: it is a deliberate, human-driven correction of
// a plan that may or may not still be the current one, and getting it applied
// to the wrong draft because "current" had moved on is exactly the failure the
// id in the path removes.
//
// It repairs EXERCISE IDENTITY ONLY. Loads, sets, reps, rest, notes, titles,
// weekdays and the brief are carried through untouched (`applyExerciseRemap`
// spreads each exercise and overwrites two fields), so a repaired plan
// prescribes exactly what the user approved — it just finally says which
// movement each line actually is.
//
// IT NEVER TOUCHES COROS. No `pushStudioPlan`, no `executeCloudJobs`, no job
// enqueue: repairing the stored plan and re-pushing 32 live sessions are two
// decisions, and the second one is the human's to make (and to watch) after
// reading this route's summary. That separation is load-bearing, not
// stylistic — a re-push is delete-and-recreate against a real calendar.

/** `audit_events.kind` for the pre-change backup written by a live repair. */
const REPAIR_BACKUP_KIND = "studio_plan_exercise_ids_repaired";

const repairRuleSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    toName: z.string().min(1).max(120),
  })
  .strict();

const repairBodySchema = z
  .object({
    /** Required, never defaulted: a caller that forgot the field must not be
     *  guessed at in the direction that rewrites a plan. */
    dryRun: z.boolean(),
    mapping: z.array(repairRuleSchema).min(1).max(200),
  })
  .strict();

studioRoutes.post("/plans/:id/repair-exercise-ids", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const planId = c.req.param("id");

  const bodyResult = await parseJsonBody(c);
  if (!bodyResult.ok) return bodyResult.response;
  const parsed = repairBodySchema.safeParse(bodyResult.body);
  if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  const { dryRun, mapping } = parsed.data;

  // Scoped by userId in the WHERE, not checked after the fact: another user's
  // plan is simply not found, which is also the only answer that doesn't let a
  // caller probe which plan ids exist.
  const planRow = (
    await db
      .select()
      .from(studioPlans)
      .where(and(eq(studioPlans.id, planId), eq(studioPlans.userId, userId)))
      .limit(1)
  )[0];
  if (!planRow) return c.json({ error: "plan_not_found" }, 404);

  // Same reasoning as `/edit` and `pushStudioPlan`: the stored plan is
  // LLM-authored and is about to be rewritten, so it is re-validated, never
  // trusted. A plan that doesn't parse cannot be safely repaired in place.
  const existing = liftingPlanSchema.safeParse(planRow.plan);
  if (!existing.success) return c.json({ error: "invalid_plan" }, 500);

  const duplicateFrom = [...new Set(mapping.map((m) => m.from).filter((f, i, a) => a.indexOf(f) !== i))];
  if (duplicateFrom.length > 0) {
    return c.json({ error: "duplicate_from", details: duplicateFrom }, 400);
  }

  // Every `from` must actually be in the plan. A rule that matches nothing is
  // almost always a typo or a mapping built against a different plan, and
  // silently ignoring it would let a partially-applied repair look complete.
  const planOriginIds = new Set<string>();
  for (const week of existing.data.weeks) {
    for (const session of week.sessions) for (const ex of session.exercises) planOriginIds.add(ex.originId);
  }
  const unknownFrom = mapping.map((m) => m.from).filter((f) => !planOriginIds.has(f));
  if (unknownFrom.length > 0) return c.json({ error: "unknown_from", details: unknownFrom }, 400);

  // Every `to` must be a real catalog id. `planPush` refuses a session
  // containing an `originId` the catalog doesn't know (`unknown_exercise`), so
  // writing one here would produce a plan that validates and then can never be
  // pushed — caught at the point where the caller can still fix the mapping.
  const catalogRows = await db.select({ id: corosExercises.id, name: corosExercises.name }).from(corosExercises);
  if (catalogRows.length === 0) return catalogNotSynced(c);
  const catalogNames = new Map(catalogRows.map((r) => [r.id, r.name]));
  const unknownTo = [...new Set(mapping.map((m) => m.to).filter((t) => !catalogNames.has(t)))];
  if (unknownTo.length > 0) return c.json({ error: "unknown_exercise", details: unknownTo }, 400);

  const { plan: repaired, summary } = applyExerciseRemap(
    existing.data as LiftingPlan,
    mapping as RemapRule[],
    catalogNames,
  );

  // The permutation output is re-validated against the same schema the push
  // path re-validates against, BEFORE anything is persisted — a repair that
  // produced an unpushable plan must fail as a repair, not later as a push.
  const revalidated = liftingPlanSchema.safeParse(repaired);
  if (!revalidated.success) return c.json({ error: "invalid_result", details: revalidated.error.issues }, 422);

  const body = {
    ok: true as const,
    dryRun,
    planId,
    planVersion: planRow.version,
    ...summary,
  };

  if (dryRun) {
    return c.json({ ...body, newVersion: null, backup: null });
  }

  const now = nowInstant();
  const newVersion = planRow.version + 1;
  const backupId = newId();

  // BACKUP FIRST, then the update. `studio_plans` has no history table (its
  // `version` is a counter, not a revision store) and `/generate`'s "a new
  // draft is a new row" pattern is wrong here — inserting the pre-change plan
  // as a second row would make the BACKUP the user's "current plan"
  // (`loadCurrentPlan` orders by `createdAt DESC`) and orphan the live push
  // rows from the UI. So the previous JSON goes into `audit_events`, the same
  // durable store this module already reads push summaries back out of
  // (`loadLastPushSummary`), recoverable with a single statement:
  //
  //   UPDATE studio_plans SET plan = json_extract(
  //     (SELECT detail FROM audit_events WHERE id = '<backupId>'), '$.previousPlan')
  //   WHERE id = '<planId>';
  //
  // Ordered this way so the only possible half-state is a backup with no
  // change applied (harmless), never a rewritten plan with no way back.
  await db.insert(auditEvents).values({
    id: backupId,
    userId,
    kind: REPAIR_BACKUP_KIND,
    detail: {
      studioPlanId: planId,
      fromVersion: planRow.version,
      toVersion: newVersion,
      mapping,
      totals: summary.totals,
      changes: summary.changes,
      warnings: summary.warnings,
      previousPlan: planRow.plan,
    },
    createdAt: now,
  });

  await db
    .update(studioPlans)
    .set({ plan: revalidated.data as unknown as Record<string, unknown>, version: newVersion, updatedAt: now })
    .where(and(eq(studioPlans.id, planId), eq(studioPlans.userId, userId)));

  // No push, no job enqueue, no `executeCloudJobs` — see the note above.
  return c.json({
    ...body,
    newVersion,
    backup: { auditEventId: backupId, kind: REPAIR_BACKUP_KIND, table: "audit_events" },
  });
});


// ── POST /api/studio/plans/:id/retire ────────────────────────────────────────
//
// The old generator's screens are retired, so its plans are retired here, as a coach plan is from the plan modal:
// every session still ahead leaves the watch through the push path, what is behind stays, and the plan leaves the list
// (`retireStudioPlan`). Only the account's current plan, and only while it runs: an older plan was already retired by
// the generate that replaced it, and one past its last day is over — both refused in plain codes. The removals it
// queues drain as a coach plan's Retire's do — the hourly lane, or any drain — so the request itself stays within one
// invocation's budget for the longest plan (studio-retire-budget.test.ts).

studioRoutes.post("/plans/:id/retire", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const planId = c.req.param("id");
  const current = await loadCurrentPlan(db, userId);
  if (!current || current.id !== planId) {
    const [owned] = await db
      .select({ id: studioPlans.id })
      .from(studioPlans)
      .where(and(eq(studioPlans.id, planId), eq(studioPlans.userId, userId)))
      .limit(1);
    return owned ? c.json({ error: "not_current" }, 409) : c.json({ error: "not_found" }, 404);
  }
  if (await studioPlanRetired(db, userId, planId)) return c.json({ error: "already_retired" }, 409);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  if (compareLocalDates(studioPlanEnd(current), today) < 0) return c.json({ error: "plan_completed" }, 409);

  const summary = await retireStudioPlan(db, { userId, studioPlanId: planId, today, alreadyRetired: false });
  if (!summary.ok) return pushOutcomeResponse(c, summary);
  return c.json({ ok: true, summary });
});
