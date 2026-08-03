import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts, syncRuns } from "@rg/database";
import { newId, nowInstant, todayInZone } from "@rg/domain";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { loadPreferences } from "../services/calendar-sync.js";
import { applyMove, emitPendingWork } from "../services/jobs.js";
import { activeSyncNotes, dismissSyncNote } from "../services/sync-notes.js";
import { recordIntent } from "../services/sync-intents.js";
import { computeSyncStatus } from "../services/sync-status.js";
import { undoStudioAdoption } from "../services/studio-push.js";

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
  return c.json(await computeSyncStatus(db, userId, prefs));
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
//    what COROS had, by recording a fresh move intent and letting
//    `emitPendingWork` re-derive the write (or resolve the intent as already
//    settled, if COROS already agrees).
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
      if (typeof displacedDate !== "string" || !note.workoutId) return c.json({ error: "not_found" }, 404);
      await recordIntent(db, {
        userId,
        targetKind: "workout",
        targetId: note.workoutId,
        kind: "move",
        payload: { toDate: displacedDate },
        source: "undo",
      });
      const prefs = await loadPreferences(db, userId);
      await emitPendingWork(db, userId, { corosWritesEnabled: prefs.corosWritesEnabled });
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
