/**
 * Fixture mode only (stream S, the watch-version journey): sessions whose watch holds an earlier version, as an
 * approved change the watch was never given leaves them — an open content claim on each, COROS holding the session on
 * its day. One ahead that a content rewrite can reach (a COROS-authored run on the watch: its address, its upstream
 * copy as imported, its own timed stages), one ahead that none can (no program id to re-prove it by), and one weeks
 * past and missed, which no longer counts. Watch updates on and a COROS connection, as the fixture account has them.
 * Synthetic titles; nothing is sent anywhere. Seeded again: the same rows, each claim open again.
 */
import { and, eq } from "drizzle-orm";
import { plannedWorkouts, plannedWorkoutStages, providerConnections } from "@rg/database";
import { addDays, newId, type LocalDate } from "@rg/domain";
import { loadPreferences, savePreferences } from "./calendar-sync.js";
import { recordIntent } from "./sync-intents.js";
import type { Db } from "./db.js";

export interface WatchVersionsSeeded {
  /** Ahead, on the watch, a rewrite can reach it: the sheet offers Send and Keep. */
  sendable: string;
  /** Ahead, on the watch, no rewrite can reach it: the sheet says why and offers Keep. */
  keepOnly: string;
  /** Weeks past and missed: not counted, nothing offered. */
  past: string;
}

export async function seedWatchVersions(db: Db, userId: string, today: LocalDate, now: string): Promise<WatchVersionsSeeded> {
  const prefs = await loadPreferences(db, userId);
  if (!prefs.corosWritesEnabled) await savePreferences(db, userId, { ...prefs, corosWritesEnabled: true });
  const [conn] = await db
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")))
    .limit(1);
  if (!conn) {
    await db.insert(providerConnections).values({
      id: newId(),
      userId,
      provider: "coros",
      status: "connected",
      createdAt: now,
      updatedAt: now,
      lastSyncAt: now,
      meta: { email: "fixture@example.com", region: "us" },
      externalAccountId: "fixture-coros",
    });
  }

  const key = userId.slice(0, 8);
  const ids: WatchVersionsSeeded = { sendable: `wv-${key}-send`, keepOnly: `wv-${key}-keep`, past: `wv-${key}-past` };
  const row = (id: string, o: { date: string; title: string; category: string; sport: string; idInPlan: string; programId: string | null; completionState?: string }) => ({
    id,
    userId,
    planId: "fixture-watch-version",
    sourceWorkoutId: `8000000000000777:${o.idInPlan}`,
    sourceIdInPlan: o.idInPlan,
    sourceProgramId: o.programId,
    title: o.title,
    category: o.category,
    sport: o.sport,
    originalPlanDate: o.date,
    lastVerifiedCorosDate: o.date,
    effectiveDate: o.date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "a1b2c3d4e5f60718",
    calendarBlockDurationSeconds: 1800,
    fallbackEstimatedDurationSeconds: 1800,
    stageSummary: null,
    corosSyncState: "calendar_only",
    completionState: o.completionState ?? "scheduled",
    ...(o.completionState === "missed" ? { resolutionDate: o.date } : {}),
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(plannedWorkouts)
    .values([
      row(ids.sendable, { date: addDays(today, 2), title: "Easy 30", category: "easy", sport: "run", idInPlan: "41", programId: "9100000000000041" }),
      row(ids.keepOnly, { date: addDays(today, 5), title: "Hills 6x1", category: "quality", sport: "run", idInPlan: "42", programId: null }),
      row(ids.past, { date: addDays(today, -10), title: "Mobility flow", category: "mobility", sport: "yoga", idInPlan: "43", programId: null, completionState: "missed" }),
    ])
    .onConflictDoNothing();
  // The app's own copy of each run ahead: timed blocks, as an ease writes them.
  await db
    .insert(plannedWorkoutStages)
    .values([
      { id: `${ids.sendable}-s0`, workoutId: ids.sendable, ord: 0, kind: "warmup", durationType: "time", durationSeconds: 600, label: "easy" },
      { id: `${ids.sendable}-s1`, workoutId: ids.sendable, ord: 1, kind: "work", durationType: "time", durationSeconds: 1200, label: "easy" },
      { id: `${ids.keepOnly}-s0`, workoutId: ids.keepOnly, ord: 0, kind: "warmup", durationType: "time", durationSeconds: 900, label: "easy" },
      { id: `${ids.keepOnly}-s1`, workoutId: ids.keepOnly, ord: 1, kind: "work", durationType: "time", durationSeconds: 900, label: "easy" },
    ] as Array<typeof plannedWorkoutStages.$inferInsert>)
    .onConflictDoNothing();
  for (const id of [ids.sendable, ids.keepOnly, ids.past]) {
    await recordIntent(db, { userId, targetKind: "workout", targetId: id, kind: "content", source: "coach_ease" });
  }
  return ids;
}
