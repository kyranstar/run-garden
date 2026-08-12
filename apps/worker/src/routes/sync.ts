import { Hono } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  backfillState,
  corosWriteJobs,
  plannedWorkouts,
  studioPlanPushes,
  studioPlans,
  syncRuns,
} from "@rg/database";
import { newId, nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { deriveBackfillStatus } from "../services/backfill.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { corosConnectionStatus } from "../services/coros-connection.js";
import { applyMove } from "../services/jobs.js";
import { openMoveIntents } from "../services/sync-intents.js";
import { activeSyncNotes, dismissSyncNote } from "../services/sync-notes.js";
import { computeSyncStatus, DEVICE_ONLINE_WINDOW_MS } from "../services/sync-status.js";
import { pushStudioPlan, undoStudioAdoption } from "../services/studio-push.js";

/**
 * Sync-transparency API surface (Task 10): the read side of `SyncStatus`
 * (Task 9), the active-notes feed and its dismiss/undo actions (Task 3's
 * `sync-notes.ts`), and the manual "read now" trigger.
 */

export const syncRoutes = new Hono<AppContext>();
syncRoutes.use("*", requireUser);

// ── GET /api/sync/status ─────────────────────────────────────────────────────

syncRoutes.get("/status", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const status = await computeSyncStatus(db, userId, prefs);
  // Cloud-direct COROS (spec §5): when a cloud connection exists, presence
  // means "connection healthy", not Mac liveness — the line speaks it.
  const cloud = await corosConnectionStatus(db, userId);
  return c.json({
    ...status,
    cloud: cloud.connected || cloud.status === "error"
      ? { connected: cloud.connected, lastSyncAt: cloud.lastSyncAt, error: cloud.lastErrorCategory }
      : null,
  });
});

// ── POST /api/sync/retry ─────────────────────────────────────────────────────
//
// The account-level counterpart to the per-workout `/plan/workouts/:id/retry-
// coros` route and the per-day `/studio/push/retry` route: actually retries
// every failed write that `computeSyncStatus`'s `issueCount` (the "N changes
// couldn't sync" banner) is made of, instead of the old wiring — a plain
// `readNow()` — which never touched a failed job (a fresh COROS read almost
// always short-circuits as "no change needed" within its 5-minute freshness
// window, and even a real read can't clear a failure: `emitPendingWork`
// deliberately refuses to re-emit behind a terminally failed job for the same
// destination, jobs.ts:240-253).
//
// Reuses each surface's own retry mechanics rather than inventing a third:
//  - failed workout moves (mirrors `issueCount`'s `failedMoveCount`,
//    sync-status.ts:81-95): supersede the failed job — the same guard-clearing
//    step `retry-coros` does — then re-`applyMove` to the workout's own
//    current date/time, which re-arms `emitPendingWork` for it.
//  - failed studio pushes (mirrors `issueCount`'s `failedStudio`,
//    sync-status.ts:96-101): re-push the owning plan; `pushStudioPlan` is
//    idempotent and re-plans every failed row (studio-push.ts:674-676's own
//    doc comment), exactly what `/studio/push/retry` already does per-day.
// Best-effort per item: one workout or plan that still can't retry (archived
// mid-flight, a genuinely unsupported COROS state, …) must not block the rest
// from clearing.
syncRoutes.post("/retry", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);

  const openIntentTargets = new Set((await openMoveIntents(db, userId)).map((i) => i.targetId));
  const failedJobs = await db
    .select({ workoutId: corosWriteJobs.workoutId })
    .from(corosWriteJobs)
    .innerJoin(plannedWorkouts, eq(corosWriteJobs.workoutId, plannedWorkouts.id))
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.status, "failed"),
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  const workoutIds = [
    ...new Set(failedJobs.map((j) => j.workoutId).filter((id) => openIntentTargets.has(id))),
  ];

  let movesRetried = 0;
  for (const workoutId of workoutIds) {
    const workout = (
      await db
        .select()
        .from(plannedWorkouts)
        .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
        .limit(1)
    )[0];
    if (!workout) continue;
    await db
      .update(corosWriteJobs)
      .set({ status: "superseded", updatedAt: nowInstant() })
      .where(and(eq(corosWriteJobs.workoutId, workout.id), eq(corosWriteJobs.status, "failed")));
    try {
      await applyMove(db, {
        userId,
        workoutId: workout.id,
        toDate: workout.effectiveDate,
        toTime: workout.effectiveTime,
        source: "app",
        corosWritesEnabled: prefs.corosWritesEnabled,
      });
      movesRetried += 1;
    } catch {
      // Best-effort — leave this one for the per-workout Sync to COROS retry.
    }
  }

  // Scope the studio arm to the CURRENT plan only (newest studio_plans row —
  // same predicate as the studio routes' loadCurrentPlan). A retired plan's
  // failed rows are usually failed DELETES; re-pushing that plan without its
  // retire override would re-plan the very sessions the user just removed.
  const currentPlan = (
    await db
      .select({ id: studioPlans.id })
      .from(studioPlans)
      .where(eq(studioPlans.userId, userId))
      .orderBy(desc(studioPlans.createdAt))
      .limit(1)
  )[0];
  let studioRetried = 0;
  if (currentPlan) {
    const failedCurrent = (
      await db
        .select({ planId: studioPlanPushes.planId })
        .from(studioPlanPushes)
        .where(and(eq(studioPlanPushes.planId, currentPlan.id), eq(studioPlanPushes.status, "failed")))
        .limit(1)
    )[0];
    if (failedCurrent) {
      const summary = await pushStudioPlan(db, { userId, studioPlanId: currentPlan.id, today });
      if (summary.ok) studioRetried += 1;
    }
  }

  return c.json({ ok: true, movesRetried, studioRetried });
});

// ── GET /api/sync/notes ───────────────────────────────────────────────────────

function noteDto(n: Awaited<ReturnType<typeof activeSyncNotes>>[number]) {
  return { id: n.id, kind: n.kind, workoutId: n.workoutId, payload: n.payload, createdAt: n.createdAt };
}

syncRoutes.get("/notes", async (c) => {
  const notes = await activeSyncNotes(c.get("db"), c.get("userId"));
  return c.json({ notes: notes.map(noteDto) });
});

// ── POST /api/sync/notes/:id/dismiss ─────────────────────────────────────────

syncRoutes.post("/notes/:id/dismiss", async (c) => {
  await dismissSyncNote(c.get("db"), c.get("userId"), c.req.param("id"));
  return c.json({ ok: true });
});

// ── POST /api/sync/notes/:id/undo ────────────────────────────────────────────
//
// Behavior is per note kind:
//  - kept_local_change: the app kept its own edit over a displaced COROS
//    value (jobs.ts's last-edit-wins tie-break); undo asks to move back to
//    what COROS had, by going through the same `applyMove` path a manual
//    drag would — this is what actually updates `effectiveDate` (recording
//    an intent alone does nothing visible, and if COROS's re-derived job
//    hasn't landed yet, `applyMove`'s same-date branch also supersedes it so
//    it can't re-move COROS after the undo).
//  - adopted_coros_change: an import adopted a COROS-side date change; undo
//    is a normal user move back to the previous date, so it goes through the
//    same `applyMove` path a manual drag would.
//  - adopted_coros_edit / adopted_coros_removal: a Plan Studio push row was
//    adopted (spec §2) after COROS drift; undo forwards to the shared
//    `undoStudioAdoption` (also used by `/api/studio/adoption/:pushId/undo`)
//    — a RENAMED row is refused (409 `undo_unsupported_rename`) and the note
//    is deliberately NOT dismissed, since nothing was actually undone.

syncRoutes.post("/notes/:id/undo", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const noteId = c.req.param("id");

  const notes = await activeSyncNotes(db, userId);
  const note = notes.find((n) => n.id === noteId);
  if (!note) return c.json({ error: "not_found" }, 404);
  const payload = (note.payload ?? {}) as Record<string, unknown>;

  switch (note.kind) {
    case "kept_local_change": {
      const displacedDate = payload["displacedDate"];
      if (typeof displacedDate !== "string") return c.json({ error: "invalid_note" }, 400);
      const workout = note.workoutId
        ? (
            await db
              .select()
              .from(plannedWorkouts)
              .where(and(eq(plannedWorkouts.id, note.workoutId), eq(plannedWorkouts.userId, userId)))
              .limit(1)
          )[0]
        : undefined;
      if (!workout || workout.archivedAt) return c.json({ error: "not_found" }, 404);
      const prefs = await loadPreferences(db, userId);
      try {
        await applyMove(db, {
          userId,
          workoutId: note.workoutId!,
          toDate: displacedDate,
          toTime: workout.effectiveTime,
          source: "app",
          corosWritesEnabled: prefs.corosWritesEnabled,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "move_failed";
        return c.json({ error: msg }, msg === "races_cannot_move" ? 422 : 500);
      }
      await dismissSyncNote(db, userId, noteId);
      return c.json({ ok: true });
    }
    case "adopted_coros_change": {
      const previousDate = payload["previousDate"];
      if (typeof previousDate !== "string" || !note.workoutId) return c.json({ error: "not_found" }, 404);
      const workout = (
        await db
          .select()
          .from(plannedWorkouts)
          .where(and(eq(plannedWorkouts.id, note.workoutId), eq(plannedWorkouts.userId, userId)))
          .limit(1)
      )[0];
      if (!workout) return c.json({ error: "not_found" }, 404);
      const prefs = await loadPreferences(db, userId);
      try {
        await applyMove(db, {
          userId,
          workoutId: note.workoutId,
          toDate: previousDate,
          toTime: workout.effectiveTime,
          source: "app",
          corosWritesEnabled: prefs.corosWritesEnabled,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "move_failed";
        return c.json({ error: msg }, msg === "races_cannot_move" ? 422 : 500);
      }
      await dismissSyncNote(db, userId, noteId);
      return c.json({ ok: true });
    }
    case "adopted_coros_edit":
    case "adopted_coros_removal": {
      const pushId = payload["pushId"];
      if (typeof pushId !== "string") return c.json({ error: "not_found" }, 404);
      const prefs = await loadPreferences(db, userId);
      const result = await undoStudioAdoption(db, userId, pushId, todayInZone(prefs.timezone));
      if (!result.ok) {
        return c.json({ error: result.error }, result.error === "undo_unsupported_rename" ? 409 : 404);
      }
      await dismissSyncNote(db, userId, noteId);
      return c.json({ ok: true });
    }
    default:
      return c.json({ error: "not_found" }, 404);
  }
});

// ── POST /api/sync/read-now ──────────────────────────────────────────────────

const READ_NOW_FRESH_MS = 5 * 60_000;
const READ_NOW_IN_FLIGHT = ["queued", "claimed", "in_progress", "verifying"] as const;

/**
 * Progress of the one-shot deep history backfill. Polled by Settings while it
 * is queued or running; `skippedSportTypes` tallies codes the sport registry
 * couldn't name (admitted as "other"), so new COROS codes stay visible.
 *
 * The status is derived honestly at read time: "queued" until the cloud
 * walker has actually landed a chunk — never a spinner over nothing.
 */
syncRoutes.get("/backfill-status", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const row = (
    await db
      .select()
      .from(backfillState)
      .where(eq(backfillState.userId, userId))
      .limit(1)
  )[0];
  const newestJob = (
    await db
      .select({ status: corosWriteJobs.status })
      .from(corosWriteJobs)
      .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.kind, "backfill")))
      .orderBy(desc(corosWriteJobs.requestedAt))
      .limit(1)
  )[0];
  return c.json({
    status: deriveBackfillStatus(row, newestJob?.status ?? null),
    earliestDateReached: row?.earliestDateReached ?? null,
    chunksCompleted: row?.chunksCompleted ?? 0,
    activitiesIngested: row?.activitiesIngested ?? 0,
    skippedSportTypes: row?.skippedSportTypes ?? {},
    // Bridge-era categories still sit in stored rows; alias them so the UI's
    // current branches (never_started | stalled) match instead of falling
    // through to a generic line that misdescribes the walk.
    lastErrorCategory:
      row?.lastErrorCategory === "bridge_never_claimed"
        ? "never_started"
        : row?.lastErrorCategory === "bridge_stalled_mid_walk"
          ? "stalled"
          : (row?.lastErrorCategory ?? null),
    /** A live job means an errored/queued walk is still claimable — the UI
     * keeps polling on this even after a watchdog error. */
    jobQueued: newestJob?.status === "queued" || newestJob?.status === "claimed",
  });
});

syncRoutes.post("/read-now", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");

  const lastRead = (
    await db
      .select({ finishedAt: syncRuns.finishedAt })
      .from(syncRuns)
      .where(and(eq(syncRuns.kind, "coros_read"), eq(syncRuns.status, "ok"), eq(syncRuns.userId, userId)))
      .orderBy(desc(syncRuns.finishedAt))
      .limit(1)
  )[0];
  const lastCorosReadAt = lastRead?.finishedAt ?? null;

  if (lastCorosReadAt && Date.now() - Date.parse(lastCorosReadAt) < READ_NOW_FRESH_MS) {
    return c.json({ enqueued: false, lastCorosReadAt });
  }

  const inFlight = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.kind, "read_now"),
        inArray(corosWriteJobs.status, [...READ_NOW_IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (inFlight.length > 0) {
    return c.json({ enqueued: false, lastCorosReadAt });
  }

  const id = newId();
  const today = todayInZone((await loadPreferences(db, userId)).timezone);
  await db.insert(corosWriteJobs).values({
    id,
    userId,
    workoutId: id,
    kind: "read_now",
    expectedContentFingerprint: "",
    originalDate: today,
    destinationDate: today,
    requestedAt: nowInstant(),
    status: "queued",
    updatedAt: nowInstant(),
  });
  return c.json({ enqueued: true, lastCorosReadAt });
});
