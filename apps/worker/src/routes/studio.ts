import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditEvents,
  corosExercises,
  corosWriteJobs,
  desktopDevices,
  studioPlanPushes,
  studioPlans,
} from "@rg/database";
import {
  compareLocalDates,
  isLocalDate,
  liftingPlanSchema,
  newId,
  nowInstant,
  planBriefSchema,
  startOfIsoWeek,
  STUDIO_JOB_KINDS,
  todayInZone,
  type LiftingPlan,
  type PlanBrief,
} from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import type { Db } from "../services/db.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { llmBudgetStatus, LLM_BUDGET } from "../services/llm.js";
import { editPlan, generatePlan, type CatalogEntry } from "../services/studio-llm.js";
import { pushStudioPlan } from "../services/studio-push.js";

/**
 * Plan Studio API routes (plan-studio-design §7, task-5-brief.md).
 *
 * The whole surface operates on "the current plan": a user has at most one
 * plan the UI shows at a time (the routes carry no planId — spec §7's list is
 * exactly {GET, generate, edit, push, push/retry}, none parameterized by plan
 * id). `generate` always inserts a FRESH `studio_plans` row rather than
 * updating one in place — a full re-generate is a new draft, not an edit —
 * so "current" is defined as the most recently CREATED row
 * (`loadCurrentPlan`). An older plan's push rows are not deleted when this
 * happens (nothing here is destructive), they simply stop being the one GET
 * surfaces; `studio-push.ts`'s own "otherLiveTitles" scoping already accounts
 * for older, still-live plans continuing to occupy COROS workout-name stamps
 * — including one retired via `replace: true` (see `/generate` below).
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

// ── DTO mapping ─────────────────────────────────────────────────────────────

function pushRowDto(row: typeof studioPlanPushes.$inferSelect) {
  return {
    id: row.id,
    happenDay: row.happenDay,
    sessionTitle: row.sessionTitle,
    status: row.status,
    error: row.error,
    corosHappenDay: row.corosHappenDay,
  };
}

async function llmStatusDto(db: Db, userId: string) {
  const budget = await llmBudgetStatus(db, userId);
  return {
    spentDollars: budget.spentMicros / 1_000_000,
    warnDollars: LLM_BUDGET.warnMicros / 1_000_000,
    cutoffDollars: LLM_BUDGET.cutoffMicros / 1_000_000,
    maxDollars: LLM_BUDGET.absoluteMaxMicros / 1_000_000,
    warn: budget.warn,
    cutoff: budget.cutoff,
  };
}

/**
 * "Waiting for bridge" (binding carry-forward g, extended by F2/fix round 1):
 * the same online heuristic `devices.ts`/`plan.ts` already use (last-seen
 * within 3 minutes) plus two DISTINCT job-count facts — the UI decides what
 * "stale"/"stuck" means from those, this just supplies them.
 *
 * `pendingJobs` stays `status === "queued"` only, NOT `studio-push.ts`'s
 * broader `IN_FLIGHT` set (queued/claimed/in_progress/verifying) that
 * `plan.ts`'s unrelated `pendingCorosJobs` count uses. Carry-forward (g)'s own
 * wording is specific: "whether any enqueued studio jobs are UNCLAIMED older
 * than N minutes" — i.e. exactly the "no device has even picked this up yet"
 * signal, which is what actually indicates an absent bridge.
 *
 * `inFlight` (F2) is the complementary signal this originally lacked: a job a
 * device DID claim but never finishes (crashed mid-write, killed process, …)
 * is a DIFFERENT failure mode — a stuck device, not a missing one — and
 * folding it into `pendingJobs` would make "waiting for bridge" read as
 * still-true the moment a bridge actually shows up and claims the work.
 * Kept as its own field instead, over `claimed`/`in_progress`/`verifying`,
 * ordered by `claimedAt` (when the device took it, not when it was
 * originally requested) since that's what "how long has this been stuck"
 * has to measure from.
 */
async function bridgeStatusDto(db: Db, userId: string) {
  const devices = await db
    .select({ lastSeenAt: desktopDevices.lastSeenAt })
    .from(desktopDevices)
    .where(and(eq(desktopDevices.userId, userId), isNull(desktopDevices.revokedAt)));
  const online = devices.some((d) => Date.parse(d.lastSeenAt) > Date.now() - 3 * 60_000);

  const queued = await db
    .select({ requestedAt: corosWriteJobs.requestedAt })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.status, "queued"),
        inArray(corosWriteJobs.kind, [...STUDIO_JOB_KINDS]),
      ),
    )
    .orderBy(asc(corosWriteJobs.requestedAt));

  const inFlight = await db
    .select({ claimedAt: corosWriteJobs.claimedAt })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.status, ["claimed", "in_progress", "verifying"]),
        inArray(corosWriteJobs.kind, [...STUDIO_JOB_KINDS]),
      ),
    )
    .orderBy(asc(corosWriteJobs.claimedAt));

  return {
    online,
    pendingJobs: { queued: queued.length, oldestQueuedAt: queued[0]?.requestedAt ?? null },
    inFlight: { count: inFlight.length, oldestClaimedAt: inFlight[0]?.claimedAt ?? null },
  };
}

interface StoredPushSummary {
  ok: true;
  planVersion: number;
  creates: number;
  deletes: number;
  failures: number;
  unchanged: number;
  drifted: number;
  blocked: number;
}

/**
 * `pushStudioPlan` never persists its own summary row — it writes one
 * `audit_events` row (kind `studio_plan_pushed`) per call, which already
 * carries every field the UI needs (binding carry-forward f: rows PLUS the
 * last PushSummary including `blocked`). Read back through `json_extract`
 * rather than a new column: SQLite (both D1 and the better-sqlite3 test
 * driver) supports it, and it avoids a schema change just to cache a value
 * that's already durable in the audit log.
 */
async function loadLastPushSummary(db: Db, userId: string, planId: string): Promise<StoredPushSummary | null> {
  const rows = await db
    .select({ detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.userId, userId),
        eq(auditEvents.kind, "studio_plan_pushed"),
        sql`json_extract(${auditEvents.detail}, '$.studioPlanId') = ${planId}`,
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);
  const detail = rows[0]?.detail as Record<string, unknown> | undefined;
  if (!detail) return null;
  return {
    ok: true,
    planVersion: Number(detail.planVersion ?? 0),
    creates: Number(detail.creates ?? 0),
    deletes: Number(detail.deletes ?? 0),
    failures: Number(detail.failures ?? 0),
    unchanged: Number(detail.unchanged ?? 0),
    drifted: Number(detail.drifted ?? 0),
    blocked: Number(detail.blocked ?? 0),
  };
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

async function loadCatalog(db: Db): Promise<CatalogEntry[]> {
  return db.select({ id: corosExercises.id, name: corosExercises.name }).from(corosExercises);
}

/**
 * F5 (fix round 1): a push row this app must account for before its plan can
 * be silently superseded — either it's confirmed on COROS (`verified`), or
 * it's `pending`/`failed` but carries a recorded id, meaning a create MAY
 * have materialized before the row's outcome was ever resolved (mirrors
 * `studio-push.ts`'s own `addressable()` reasoning: an id on the row is what
 * makes it removable at all). A `failed` row with no id, or a `deleted` row,
 * never touched COROS (or no longer does) and isn't "live".
 */
function hasLivePush(row: typeof studioPlanPushes.$inferSelect): boolean {
  if (row.status === "verified") return true;
  if (row.status === "pending" || row.status === "failed") {
    return Boolean(row.corosIdInPlan && row.corosProgramId && row.corosPlanId);
  }
  return false;
}

/**
 * `loadCurrentPlan` orders by `createdAt DESC`, so two `generate` calls that
 * land in the same millisecond (a real possibility — two fast in-region
 * Worker requests, or a double-click) would make "current" ambiguous rather
 * than "the newer one". Reads the user's own latest `createdAt` and nudges
 * forward by 1ms when `now` would tie or precede it — same "next timestamp
 * strictly after the last one" trick `studio-push.ts`'s `stamped()` already
 * uses for job ordering, applied here to plan-row ordering instead.
 */
async function nextPlanCreatedAt(db: Db, userId: string, now: string): Promise<string> {
  const latest = await loadCurrentPlan(db, userId);
  if (!latest || Date.parse(now) > Date.parse(latest.createdAt)) return now;
  return new Date(Date.parse(latest.createdAt) + 1).toISOString();
}

/**
 * Binding carry-forward (d): an empty (never-synced) catalog gets a
 * structured `catalog_not_synced` error, not a crash or a confusing
 * `unknown_exercise` from the LLM layer — checked before spending any LLM
 * budget on a request that cannot possibly succeed.
 */
function catalogNotSynced(c: Context<AppContext>) {
  return c.json({ error: "catalog_not_synced" }, 412);
}

/**
 * Binding carry-forward (i): structured reason codes only. `reason` here is
 * always one of studio-llm.ts's own codes (invalid_output, output_truncated,
 * budget_cutoff, unknown_exercise, llm_error, no_api_key, no_catalog,
 * gateway_*) — never free text, never raw model output.
 */
function llmFailureResponse(c: Context<AppContext>, reason: string | undefined) {
  const error = reason ?? "llm_error";
  if (error === "budget_cutoff") return c.json({ error }, 402);
  if (error === "no_api_key") return c.json({ error }, 503);
  // Unreachable from either call site today — both `/generate` and `/edit`
  // already return `catalogNotSynced` before ever calling generatePlan/
  // editPlan when the catalog is empty. Kept anyway: `no_catalog` is
  // studio-llm.ts's own real reason code (its fixture-mode path returns it
  // independently of this route's pre-check), so mapping it here costs
  // nothing and stays correct if a future caller ever skips the pre-check.
  if (error === "no_catalog") return catalogNotSynced(c);
  return c.json({ error }, 422);
}

function pushOutcomeResponse(
  c: Context<AppContext>,
  summary: { ok: boolean; error?: "plan_not_found" | "invalid_plan" },
) {
  const status = summary.error === "plan_not_found" ? 404 : 500;
  return c.json({ error: summary.error ?? "push_failed" }, status);
}

// ── GET /api/studio ──────────────────────────────────────────────────────────

studioRoutes.get("/", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const [planRow, bridge, llm] = await Promise.all([
    loadCurrentPlan(db, userId),
    bridgeStatusDto(db, userId),
    llmStatusDto(db, userId),
  ]);

  if (!planRow) {
    return c.json({ plan: null, brief: null, version: null, pushes: [], lastPushSummary: null, bridge, llm });
  }

  const [pushes, lastPushSummary] = await Promise.all([
    db.select().from(studioPlanPushes).where(eq(studioPlanPushes.planId, planRow.id)).orderBy(asc(studioPlanPushes.happenDay)),
    loadLastPushSummary(db, userId, planRow.id),
  ]);

  return c.json({
    plan: planRow.plan,
    brief: planRow.brief,
    version: planRow.version,
    pushes: pushes.map(pushRowDto),
    lastPushSummary,
    bridge,
    llm,
  });
});

// ── POST /api/studio/generate ────────────────────────────────────────────────

const generateBodySchema = z.object({
  brief: planBriefSchema,
  /** F5 (fix round 1): required to proceed when the current plan has live
   * (verified, or possibly-materialized) COROS sessions — see below. */
  replace: z.boolean().optional(),
});

studioRoutes.post("/generate", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const bodyResult = await parseJsonBody(c);
  if (!bodyResult.ok) return bodyResult.response;
  const parsed = generateBodySchema.safeParse(bodyResult.body);
  if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  if (compareLocalDates(parsed.data.brief.startDate, today) < 0) {
    return c.json({ error: "start_date_in_past" }, 400);
  }

  // F5 (fix round 1): a regenerate that silently orphans a pushed plan's live
  // COROS workouts is a real bug, not just an inconvenience — those sessions
  // would stay on the calendar forever with nothing in the app still tracking
  // them (the new plan's own push rows start from zero). Guard: if the
  // CURRENT plan (the one about to stop being "current") has any row that IS
  // or MAY be materialized on COROS, refuse unless the caller explicitly
  // opts in with `replace: true`.
  const currentPlan = await loadCurrentPlan(db, userId);
  if (currentPlan) {
    const oldRows = await db
      .select()
      .from(studioPlanPushes)
      .where(eq(studioPlanPushes.planId, currentPlan.id));
    if (oldRows.some(hasLivePush)) {
      if (!parsed.data.replace) return c.json({ error: "plan_has_live_pushes" }, 409);
      // Retire the OLD plan's live sessions FIRST — before the new plan row
      // is even created. `desiredOverride: []` makes every one of its
      // existing rows look removed to the diff, so `pushStudioPlan`'s
      // already-guarded removal machinery (the same triple-addressed,
      // ownership-reproving delete path a normal push uses — not a bespoke
      // bulk-delete) enqueues a delete for every addressable row. The old
      // plan's own stored `plan`/`brief` content is untouched — it stays in
      // `studio_plans` as history, just no longer "current".
      //
      // This is ASYNC: the bridge executes the deletes on its own poll, so
      // the new plan below may finish generating — and even get pushed —
      // before the old workouts are actually gone from COROS.
      // `planPush`'s title-uniqueness guard is what makes that race SAFE
      // rather than silently double-writing: a new session whose stamp
      // collides with a not-yet-deleted old workout fails closed as
      // `duplicate_title` instead, and a later `/push` retry (once the
      // delete has verified) succeeds normally.
      await pushStudioPlan(db, { userId, studioPlanId: currentPlan.id, today, desiredOverride: [] });
    }
  }

  // Binding carry-forward (b): normalize intake to the ISO-week Monday BEFORE
  // persisting (and before the LLM ever sees it) — `studio-push.ts`'s
  // `sessionHappenDay` anchors the whole plan grid to
  // `startOfIsoWeek(brief.startDate)`, so persisting the raw pick would let
  // the stored brief silently disagree with what push math actually uses.
  const normalizedBrief: PlanBrief = {
    ...parsed.data.brief,
    startDate: startOfIsoWeek(parsed.data.brief.startDate),
  };

  const catalog = await loadCatalog(db);
  if (catalog.length === 0) return catalogNotSynced(c);

  const fetchImpl = c.get("llmFetch") ?? fetch;
  const result = await generatePlan(c.env, db, userId, normalizedBrief, catalog, fetchImpl);
  if (!result.plan) return llmFailureResponse(c, result.reason);

  // Defense in depth: force the persisted brief to the route-normalized one
  // regardless of what the model echoed back (it is handed the normalized
  // brief and instructed to reproduce it, but nothing stops a drift), then
  // re-validate. If that breaks weeks.length===durationWeeks the model
  // silently changed the plan's shape from what was actually requested —
  // treated the same as any other malformed generation, not silently
  // accepted with a swapped-in brief that no longer matches the content.
  const finalPlan: LiftingPlan = { ...result.plan, brief: normalizedBrief };
  const revalidated = liftingPlanSchema.safeParse(finalPlan);
  if (!revalidated.success) return c.json({ error: "invalid_output" }, 422);

  const now = await nextPlanCreatedAt(db, userId, nowInstant());
  await db.insert(studioPlans).values({
    id: newId(),
    userId,
    brief: normalizedBrief as unknown as Record<string, unknown>,
    plan: revalidated.data as unknown as Record<string, unknown>,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ ok: true, plan: revalidated.data, brief: normalizedBrief, version: 1 });
});

// ── POST /api/studio/edit ────────────────────────────────────────────────────

const editBodySchema = z.object({
  request: z.string().min(1).max(2000),
  major: z.boolean().optional(),
});

studioRoutes.post("/edit", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const bodyResult = await parseJsonBody(c);
  if (!bodyResult.ok) return bodyResult.response;
  const parsed = editBodySchema.safeParse(bodyResult.body);
  if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  // Edit requires an existing plan; checked before the catalog so a plan-less
  // account gets `no_plan`, not a misleading catalog complaint.
  const planRow = await loadCurrentPlan(db, userId);
  if (!planRow) return c.json({ error: "no_plan" }, 404);

  // The stored plan is LLM-authored (and may have been through a prior patch
  // application) — never trusted blindly, same reasoning as
  // `pushStudioPlan`'s own re-validation before it becomes writes.
  const existing = liftingPlanSchema.safeParse(planRow.plan);
  if (!existing.success) return c.json({ error: "invalid_plan" }, 500);

  const catalog = await loadCatalog(db);
  if (catalog.length === 0) return catalogNotSynced(c);

  const fetchImpl = c.get("llmFetch") ?? fetch;
  const result = await editPlan(
    c.env,
    db,
    userId,
    existing.data as LiftingPlan,
    parsed.data.request,
    parsed.data.major ?? false,
    catalog,
    fetchImpl,
  );
  if (!result.plan) return llmFailureResponse(c, result.reason);

  // F1 (fix round 1): force the persisted brief back to the STORED plan's
  // brief verbatim, regardless of what the model emitted, then re-validate.
  // The minor (ops) path can't touch `/brief` at all (`applyOps`'s
  // `IMMUTABLE_ROOT_SEGMENT` guard) — this is a no-op there. `major: true`
  // asks the strong model for a full regenerate, and nothing stops it from
  // echoing back a mutated brief: a changed `startDate` would silently break
  // the push grid's day math (`sessionHappenDay` reads `plan.brief.startDate`
  // directly), and changed `constraints`/`equipment` would silently drop a
  // safety-relevant field the user never asked to edit. Same defense-in-depth
  // pattern as `/generate` forcing its own normalized brief onto the LLM's
  // output, just anchored to the stored plan's brief instead of a freshly
  // normalized one (an edit's brief is immutable by definition — nothing
  // "normalizes" it here, it's simply not up for revision).
  const finalPlan: LiftingPlan = { ...result.plan, brief: existing.data.brief };
  const revalidated = liftingPlanSchema.safeParse(finalPlan);
  if (!revalidated.success) return c.json({ error: "invalid_output" }, 422);

  const now = nowInstant();
  const version = planRow.version + 1;
  await db
    .update(studioPlans)
    .set({
      brief: revalidated.data.brief as unknown as Record<string, unknown>,
      plan: revalidated.data as unknown as Record<string, unknown>,
      version,
      updatedAt: now,
    })
    .where(eq(studioPlans.id, planRow.id));

  return c.json({ ok: true, plan: revalidated.data, brief: revalidated.data.brief, version });
});

// ── POST /api/studio/push ────────────────────────────────────────────────────

studioRoutes.post("/push", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const planRow = await loadCurrentPlan(db, userId);
  if (!planRow) return c.json({ error: "no_plan" }, 404);

  const prefs = await loadPreferences(db, userId);
  // Binding carry-forward (a): the user's local today, never a UTC default —
  // `pushStudioPlan`'s `today` parameter has no default for exactly this
  // reason (its own doc comment: "the compiler enforces it").
  const today = todayInZone(prefs.timezone);
  const summary = await pushStudioPlan(db, { userId, studioPlanId: planRow.id, today });
  if (!summary.ok) return pushOutcomeResponse(c, summary);

  const pushes = await db
    .select()
    .from(studioPlanPushes)
    .where(eq(studioPlanPushes.planId, planRow.id))
    .orderBy(asc(studioPlanPushes.happenDay));
  return c.json({ ok: true, summary, pushes: pushes.map(pushRowDto) });
});

// ── POST /api/studio/push/retry ──────────────────────────────────────────────

const retryBodySchema = z.object({
  happenDay: z.string().refine(isLocalDate, { message: "happenDay must be a YYYY-MM-DD calendar date" }),
});

studioRoutes.post("/push/retry", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const bodyResult = await parseJsonBody(c);
  if (!bodyResult.ok) return bodyResult.response;
  const parsed = retryBodySchema.safeParse(bodyResult.body);
  if (!parsed.success) return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);

  const planRow = await loadCurrentPlan(db, userId);
  if (!planRow) return c.json({ error: "no_plan" }, 404);

  const failedRow = (
    await db
      .select({ id: studioPlanPushes.id })
      .from(studioPlanPushes)
      .where(
        and(
          eq(studioPlanPushes.planId, planRow.id),
          eq(studioPlanPushes.happenDay, parsed.data.happenDay),
          eq(studioPlanPushes.status, "failed"),
        ),
      )
      .limit(1)
  )[0];
  if (!failedRow) return c.json({ error: "no_failed_row_for_day" }, 404);

  // Binding carry-forward (e): re-invoke the WHOLE-plan push rather than a
  // row-scoped retry. `pushStudioPlan` is idempotent by design (its own doc
  // comment: "a failed row is re-planned by the next push") — every
  // unaffected row comes back through the diff as `unchanged`, so this is not
  // a heavier operation than a row-scoped retry would be, just a single
  // correct implementation instead of two.
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const summary = await pushStudioPlan(db, { userId, studioPlanId: planRow.id, today });
  if (!summary.ok) return pushOutcomeResponse(c, summary);

  const pushes = await db
    .select()
    .from(studioPlanPushes)
    .where(eq(studioPlanPushes.planId, planRow.id))
    .orderBy(asc(studioPlanPushes.happenDay));
  return c.json({ ok: true, summary, pushes: pushes.map(pushRowDto) });
});
