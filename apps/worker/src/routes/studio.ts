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
import { waitUntilSafe } from "../services/wait-until.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { llmBudgetStatus, LLM_BUDGET } from "../services/llm.js";
import { DEVICE_ONLINE_WINDOW_MS, devicePresence } from "../services/sync-status.js";
import { editPlan, generatePlan, type CatalogEntry } from "../services/studio-llm.js";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { exerciseNameMap, resolveExerciseName } from "../services/exercise-catalog.js";
import { pushStudioPlan, undoStudioAdoption } from "../services/studio-push.js";
import { executeCloudJobs } from "../services/coros-write-cloud.js";
import { corosConnectionStatus } from "../services/coros-connection.js";
import { corosReadNow } from "../services/coros-read.js";

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
 * `online` is `sync-status.ts`'s `devicePresence` — the same liveness
 * computation every other route uses (last-seen within 3 minutes, and now
 * false while the bridge is paused) — plus two DISTINCT job-count facts the
 * UI decides what "stale"/"stuck" means from.
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
  // Cloud-direct: a connected COROS cloud link IS an online executor — the
  // worker claims and pushes jobs itself, so "waiting for your Mac" would be
  // a lie. Mac presence still counts for the legacy path.
  const [presence, cloud] = await Promise.all([
    devicePresence(db, userId),
    corosConnectionStatus(db, userId),
  ]);
  const online = presence.online || cloud.connected;

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

/** Display copy of a lifting plan with every code-named exercise resolved
 * through the catalog (round 3: the actual workout name, every place). */
function resolvePlanExerciseNames(
  plan: { weeks?: Array<{ sessions: Array<{ exercises: Array<{ name: string; originId?: string }> }> }> },
  catalog: Map<string, string>,
) {
  if (!plan?.weeks) return plan;
  return {
    ...plan,
    weeks: plan.weeks.map((wk) => ({
      ...wk,
      sessions: wk.sessions.map((s) => ({
        ...s,
        exercises: s.exercises.map((ex) => ({
          ...ex,
          name: resolveExerciseName(ex.name, ex.originId, catalog),
        })),
      })),
    })),
  };
}

async function loadCatalog(db: Db): Promise<CatalogEntry[]> {
  // The stored names are COROS i18n keys — the generator should read (and
  // emit) human words. Push payloads resolve independently via the raw
  // catalog map, so translating here never shifts a session fingerprint.
  const rows = await db.select({ id: corosExercises.id, name: corosExercises.name }).from(corosExercises);
  return rows.map((r) => ({ id: r.id, name: COROS_EXERCISE_NAMES[r.name] ?? r.name }));
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
 *
 * The `reason` tells the UI what the user can actually do about it:
 * `bridge_offline` (open the desktop app), `bridge_outdated` (the connected
 * bridge predates catalog sync — opening it again will never help; it needs
 * an update), or `syncing` (a catalog-capable bridge is online; wait a beat).
 */
async function catalogNotSynced(c: Context<AppContext>) {
  const db = c.get("db");
  const userId = c.get("userId");
  // Cloud-direct: the catalog rides corosReadNow when stale. Connected →
  // "syncing" is genuinely true — kick a forced pull right now so "try again
  // in a minute" delivers (the coros_read lock absorbs stampedes).
  const cloud = await corosConnectionStatus(db, userId);
  if (cloud.connected) {
    const prefs = await loadPreferences(db, userId);
    waitUntilSafe(c, corosReadNow(db, c.env, userId, prefs, { force: true }).catch(() => undefined));
    return c.json({ error: "catalog_not_synced", reason: "syncing" }, 412);
  }
  // `bridge_offline` vs `syncing`/`bridge_outdated` is gated on aggregate
  // presence (sync-status.ts) — a paused bridge now reads offline here too
  // (the intended fix: Today/status must never call a paused bridge "syncing").
  const presence = await devicePresence(db, userId);
  const devices = await db
    .select({
      lastSeenAt: desktopDevices.lastSeenAt,
      capabilities: desktopDevices.capabilities,
      bridgePaused: desktopDevices.bridgePaused,
    })
    .from(desktopDevices)
    .where(and(eq(desktopDevices.userId, userId), isNull(desktopDevices.revokedAt)));
  const cutoff = Date.now() - DEVICE_ONLINE_WINDOW_MS;
  // Restricted to the same devices `presence.online` counts (not paused,
  // fresh lastSeenAt): distinguishes "an online bridge just hasn't sent the
  // catalog yet" (syncing) from "the connected bridge predates catalog sync"
  // (bridge_outdated).
  const online = devices.filter((d) => !d.bridgePaused && Date.parse(d.lastSeenAt) > cutoff);
  const reason =
    !presence.online
      ? "bridge_offline"
      : online.some(
            (d) => (d.capabilities as Record<string, boolean> | null)?.["exerciseCatalog"] === true,
          )
        ? "syncing"
        : "bridge_outdated";
  return c.json({ error: "catalog_not_synced", reason }, 412);
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
    plan: resolvePlanExerciseNames(planRow.plan as never, await exerciseNameMap(db)),
    brief: planRow.brief,
    version: planRow.version,
    pushes: pushes.map(pushRowDto),
    lastPushSummary,
    bridge,
    llm,
  });
});

// ── GET /api/studio/history ──────────────────────────────────────────────────
// Every generated plan (and the brief that produced it) is kept forever —
// the raw material for future progressive planning ("build on my last block")
// and for reusing a past brief as a template today.
studioRoutes.get("/history", async (c) => {
  const db = c.get("db");
  const rows = await db
    .select()
    .from(studioPlans)
    .where(eq(studioPlans.userId, c.get("userId")))
    .orderBy(desc(studioPlans.createdAt))
    .limit(20);
  return c.json({
    plans: rows.map((r) => {
      const plan = r.plan as { name?: string; weeks?: unknown[] } | null;
      return {
        id: r.id,
        name: plan?.name ?? "Untitled plan",
        weeks: Array.isArray(plan?.weeks) ? plan.weeks.length : null,
        version: r.version,
        createdAt: r.createdAt,
        brief: r.brief,
      };
    }),
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
  //
  // F5-REGRESSION (fix round 2): this is a READ-ONLY decision here — whether
  // a retire will be needed — not the retire itself. Fix round 1 ran the
  // actual retire (`pushStudioPlan` with `desiredOverride: []`, which
  // enqueues real DELETE jobs against the user's live COROS calendar) at
  // this point, BEFORE the catalog check and the LLM call. Any routine
  // failure after that (`catalog_not_synced`, `budget_cutoff`,
  // `invalid_output`, …) left the deletes already enqueued with no new plan
  // ever created — the old plan's live sessions started disappearing behind
  // what the UI would show as a clean, retryable error. The retire action
  // now happens ONLY once every other way this request can fail has already
  // succeeded (see below, right before the new plan is persisted).
  const currentPlan = await loadCurrentPlan(db, userId);
  let retireOldPlan = false;
  if (currentPlan) {
    const oldRows = await db
      .select()
      .from(studioPlanPushes)
      .where(eq(studioPlanPushes.planId, currentPlan.id));
    retireOldPlan = oldRows.some(hasLivePush);
    if (retireOldPlan && !parsed.data.replace) return c.json({ error: "plan_has_live_pushes" }, 409);
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

  // Everything that could still fail this request has now succeeded — the
  // new plan is fully validated and ready to persist. ONLY NOW retire the
  // old plan's live sessions (see the F5-REGRESSION note above), immediately
  // followed by inserting the new plan row, so no routine failure above this
  // point can ever leave a retire enqueued with nothing to show for it.
  if (retireOldPlan && currentPlan) {
    const retireSummary = await pushStudioPlan(db, {
      userId,
      studioPlanId: currentPlan.id,
      today,
      desiredOverride: [],
    });
  waitUntilSafe(c, executeCloudJobs(db, c.env, userId, await loadPreferences(db, userId)).catch(() => undefined),);
    if (!retireSummary.ok) {
      // The retire call's own push machinery reports the true state
      // (`plan_not_found` / `invalid_plan`) rather than this route guessing
      // at one. The new plan is deliberately NOT created: retrying
      // `/generate` with `replace: true` again is safe — a retire is itself
      // idempotent (re-pushing the same "everything removed" desired set
      // against whatever the old plan's rows now look like).
      return pushOutcomeResponse(c, retireSummary);
    }
    // This is ASYNC beyond this point: the bridge executes the enqueued
    // deletes on its own poll, so the new plan below may get pushed before
    // the old workouts are actually gone from COROS. `planPush`'s
    // title-uniqueness guard is what makes that race SAFE rather than
    // silently double-writing: a new session whose stamp collides with a
    // not-yet-deleted old workout fails closed as `duplicate_title` instead,
    // and a later `/push`/`push/retry` (once the delete has verified)
    // succeeds normally.
  }

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

  // F1 (fix round 1), SELECTIVE (fix round 2 — the blanket version below was
  // a regression). The minor (ops) path can't touch `/brief` at all
  // (`applyOps`'s `IMMUTABLE_ROOT_SEGMENT` guard) — none of this applies
  // there. `major: true` asks the strong model for a full regenerate, and
  // its own prompt (`buildMajorReviseSystemPrompt`) explicitly PERMITS it to
  // change `durationWeeks`/`sessionsPerWeek`/`preferredDays` when the
  // request asks for a resize — fix round 1's fix locked the WHOLE brief
  // back to the stored one regardless, which blocked every legitimate resize
  // with a spurious `invalid_output` (`weeks.length` disagreeing with the
  // locked-back, stale `durationWeeks`).
  //
  // Locked back to the STORED plan's values regardless of what the model
  // emits: `constraints`, `equipment`, `notes` — the free-text fields a
  // prompt-injected edit request could use to rewrite something
  // safety-relevant (the injuries/exclusions field) or just silently drop
  // user-authored detail, exactly the surface `applyOps`'s `/brief` lock
  // already closes on the minor path — and `startDate`, the scheduling
  // anchor (`sessionHappenDay` reads `plan.brief.startDate` directly; an
  // edit's start date is simply not up for revision, nothing here
  // "normalizes" it the way `/generate`'s intake does).
  //
  // Left as the model returned them: `goal`, `durationWeeks`,
  // `sessionsPerWeek`, `sessionMinutes`, `preferredDays` — none of these are
  // free text (an enum, three numbers, an array of weekday numbers), so none
  // are an injection surface, and these are exactly the structural fields a
  // resize/rescope request needs to change. `liftingPlanSchema`'s own refine
  // (`weeks.length===durationWeeks`) and `planBriefSchema`'s own refine
  // (`preferredDays.length===sessionsPerWeek`) still enforce internal
  // consistency on whatever the model produced for these — a
  // self-inconsistent resize still fails re-validation, it's just no longer
  // blocked by a stale locked value that had nothing to do with the request.
  const finalPlan: LiftingPlan = {
    ...result.plan,
    brief: {
      ...result.plan.brief,
      constraints: existing.data.brief.constraints,
      equipment: existing.data.brief.equipment,
      notes: existing.data.brief.notes,
      startDate: existing.data.brief.startDate,
    },
  };
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
  waitUntilSafe(c, executeCloudJobs(db, c.env, userId, await loadPreferences(db, userId)).catch(() => undefined),);
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
  waitUntilSafe(c, executeCloudJobs(db, c.env, userId, await loadPreferences(db, userId)).catch(() => undefined),);
  if (!summary.ok) return pushOutcomeResponse(c, summary);

  const pushes = await db
    .select()
    .from(studioPlanPushes)
    .where(eq(studioPlanPushes.planId, planRow.id))
    .orderBy(asc(studioPlanPushes.happenDay));
  return c.json({ ok: true, summary, pushes: pushes.map(pushRowDto) });
});

// ── POST /api/studio/adoption/:pushId/undo ───────────────────────────────────
//
// An "adopted" row (spec §2) is never a permanent unmanaged state: this route
// figures out WHICH of three cases produced the adoption, by re-examining the
// last snapshot of the source workout, and handles each on its own terms
// rather than a single generic "flip it back" state transition:
//
//  - MISSING: COROS confirmed the workout gone. Nothing to delete — a plain
//    recreate suffices.
//  - MOVED: the workout is still there, still carrying our stamp, just on a
//    different day. Re-verifying the row and staling its fingerprint makes
//    the next push plan exactly delete (at the day it's actually on) then
//    recreate (at the day the plan wants).
//  - RENAMED: the workout no longer carries our stamp at all, so nothing here
//    can prove a delete of it is ours to make. Refused outright — see below.
//
// Once the row is repositioned, the whole plan is re-pushed so every other
// row's diff is re-derived exactly as `pushStudioPlan` already knows how to
// do it — no separate row-scoped code path to keep in sync with the real one.

studioRoutes.post("/adoption/:pushId/undo", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const pushId = c.req.param("pushId");

  const prefs = await loadPreferences(db, userId);
  const result = await undoStudioAdoption(db, userId, pushId, todayInZone(prefs.timezone));
  if (!result.ok) {
    // A pushId that doesn't exist, belongs to another user's plan, or isn't
    // "adopted" all fall through to the SAME `not_found` (see
    // `undoStudioAdoption`'s own doc comment) — distinguishing them would let
    // a caller enumerate other users' (or their own non-adopted) push ids by
    // shape alone.
    return c.json({ error: result.error }, result.error === "undo_unsupported_rename" ? 409 : 404);
  }
  return c.json({ ok: result.summary.ok, summary: result.summary });
});
