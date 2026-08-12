import { and, eq, inArray } from "drizzle-orm";
import { activities, activitySourceLinks, providerConnections } from "@rg/database";
import { addDays, todayInZone, type UserPreferences } from "@rg/domain";
import { buildSnapshot, loadNameResolver } from "@rg/coros";
import type { NameResolver } from "@rg/providers";
import { fixtureModeEnabled, type Env } from "../env.js";
import type { Db } from "./db.js";
import { corosClient, touchCorosSync } from "./coros-connection.js";
import { ingestActivities } from "./completion.js";
import { ingestDailyHealth } from "./health-ingest.js";
import { importPlanSnapshot } from "./import-plan.js";
import { loadPreferences } from "./calendar-sync.js";
import { resimulateFrom } from "./garden-sync.js";
import { enqueueCoachReads, processCoachReads } from "./coach-reads.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { isExerciseCatalogStale, upsertExerciseCatalog } from "./exercise-catalog.js";

/**
 * The cloud pull (cloud-direct spec §3): what the bridge's snapshot sync did,
 * on demand and in the worker. Single-flighted per user; a 90-second
 * freshness window makes racing tabs and rapid reopens free; details are
 * fetched only for unseen activities so an app-open pull is one list call
 * plus the genuinely new work.
 */

export const READ_FRESHNESS_MS = 90_000;
const ACTIVITY_WINDOW_DAYS = 14;
const SCHEDULE_AHEAD_DAYS = 7;
const FULL_SCHEDULE_SPAN_DAYS = 90;
const FULL_SCHEDULE_STALE_MS = 6 * 3600 * 1000;

export interface ReadNowResult {
  status: "ok" | "fresh" | "busy" | "not_connected" | "coros_unreachable" | "bad_credentials";
  ingested?: number;
}

/** Cached per-isolate — the locale bundle is static reference data. */
let resolverCache: { value: NameResolver | undefined; at: number } | null = null;
async function nameResolver(fetchImpl: typeof fetch): Promise<NameResolver | undefined> {
  if (resolverCache && Date.now() - resolverCache.at < 24 * 3600 * 1000) return resolverCache.value;
  const value = await loadNameResolver(fetchImpl);
  resolverCache = { value, at: Date.now() };
  return value;
}

export async function corosReadNow(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  opts: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<ReadNowResult> {
  // Fixture mode never talks to real providers (repo-wide convention) — the
  // seeded connection reports "fresh" so the UI reads as healthy and silent.
  if (fixtureModeEnabled(env)) return { status: "fresh" };
  const fetchImpl = opts.fetchImpl ?? fetch;

  const [conn] = await db
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")))
    .limit(1);
  if (!conn || conn.status === "disconnected") return { status: "not_connected" };
  if (conn.lastErrorCategory === "bad_credentials") return { status: "bad_credentials" };
  if (
    !opts.force &&
    conn.lastSyncAt &&
    Date.now() - Date.parse(conn.lastSyncAt) < READ_FRESHNESS_MS
  ) {
    return { status: "fresh" };
  }

  const lock = await claimUserLock(db, userId, "coros_read", 5);
  if (!lock) return { status: "busy" };

  try {
    const client = await corosClient(db, env, userId, fetchImpl);
    if (!client) {
      // corosClient parked the row (bad credentials) or it vanished.
      const [after] = await db
        .select({ cat: providerConnections.lastErrorCategory })
        .from(providerConnections)
        .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")))
        .limit(1);
      return after?.cat === "bad_credentials"
        ? { status: "bad_credentials" }
        : { status: "coros_unreachable" };
    }

    const today = todayInZone(prefs.timezone);
    const meta = (conn.meta ?? {}) as Record<string, unknown> & { lastFullScheduleAt?: string };
    const fullScheduleDue =
      !meta.lastFullScheduleAt || Date.now() - Date.parse(meta.lastFullScheduleAt) > FULL_SCHEDULE_STALE_MS;
    const rangeStart = addDays(today, -ACTIVITY_WINDOW_DAYS);
    const rangeEnd = fullScheduleDue
      ? addDays(rangeStart, FULL_SCHEDULE_SPAN_DAYS - 1)
      : addDays(today, SCHEDULE_AHEAD_DAYS);

    // Details only for unseen activities — read-now stays light. Rows whose
    // stored telemetry is LIST-grade (nothing beyond deviceTempC, or null)
    // get their detail re-fetched too: that's the permanent self-heal for the
    // 2026-08-12 incident where list-only refreshes clobbered detail data,
    // and it repairs any future row that loses its detail for any reason.
    const linkRows = await db
      .select({
        providerActivityId: activitySourceLinks.providerActivityId,
        telemetry: activities.telemetry,
      })
      .from(activitySourceLinks)
      .innerJoin(activities, eq(activitySourceLinks.activityId, activities.id))
      .where(and(eq(activitySourceLinks.provider, "coros"), eq(activities.userId, userId)));
    const seen = new Set(linkRows.map((r) => r.providerActivityId));
    const needsDetail = new Set(
      linkRows
        .filter((r) => {
          const t = (r.telemetry ?? {}) as Record<string, unknown>;
          return Object.keys(t).filter((k) => k !== "deviceTempC").length === 0;
        })
        .map((r) => r.providerActivityId),
    );
    if (needsDetail.size > 0) {
      // The wound isn't part of the fingerprint, so ingest would skip the
      // healed record as "unchanged" — void the stored fingerprint to force
      // the refresh through.
      await db
        .update(activitySourceLinks)
        .set({ contentFingerprint: "" })
        .where(
          and(
            eq(activitySourceLinks.provider, "coros"),
            inArray(activitySourceLinks.providerActivityId, [...needsDetail]),
          ),
        );
    }

    const resolver = await nameResolver(fetchImpl);
    // The exercise catalog also rides the cloud now — the last snapshot duty
    // the desktop bridge held.
    const catalogStale = await isExerciseCatalogStale(db);
    const snapshot = await buildSnapshot(client, rangeStart, rangeEnd, resolver, {
      includeExerciseCatalog: catalogStale,
      healthRangeStart: addDays(today, -7),
      detailFilter: (item) => !seen.has(item.labelId) || needsDetail.has(item.labelId),
    });
    if (snapshot.exerciseCatalog && snapshot.exerciseCatalog.length > 0) {
      await upsertExerciseCatalog(db, snapshot.exerciseCatalog);
    }

    // Same ingest order as the bridge-sync route: plan first, then
    // activities (matching sees fresh workouts), then health.
    if (snapshot.plan && snapshot.workouts.length > 0) {
      await importPlanSnapshot(
        db,
        {
          userId,
          plan: snapshot.plan,
          workouts: snapshot.workouts as never,
          rangeStart,
          rangeEnd,
          source: "bridge",
        },
        prefs,
      );
    }

    let ingested = 0;
    if (snapshot.activities.length > 0) {
      const stats = await ingestActivities(db, {
        userId,
        sources: snapshot.activities,
        lapsByProviderId: snapshot.lapsByProviderId as never,
      });
      ingested = stats.newActivities + stats.mergedPairs;
      const earliest = stats.affectedDates[0];
      if (earliest) await resimulateFrom(db, userId, earliest, prefs);
      await enqueueCoachReads(db, userId, today);
    }

    await ingestDailyHealth(db, userId, snapshot.health as unknown as Array<Record<string, unknown>>);

    if (fullScheduleDue) {
      await db
        .update(providerConnections)
        .set({ meta: { ...meta, lastFullScheduleAt: new Date().toISOString() } })
        .where(eq(providerConnections.id, conn.id));
    }
    await touchCorosSync(db, userId);
    return { status: "ok", ingested };
  } catch {
    await db
      .update(providerConnections)
      .set({ lastErrorCategory: "api_error" })
      .where(eq(providerConnections.id, conn.id));
    return { status: "coros_unreachable" };
  } finally {
    await releaseUserLock(db, userId, "coros_read", lock).catch(() => undefined);
  }
}

/** Cron sweep: one forced pull per connected user (replaces bridge snapshots). */
export async function corosReadSweep(db: Db, env: Env): Promise<void> {
  const rows = await db
    .select({ userId: providerConnections.userId })
    .from(providerConnections)
    .where(and(eq(providerConnections.provider, "coros"), eq(providerConnections.status, "connected")));
  for (const { userId } of rows) {
    const prefs = await loadPreferences(db, userId);
    const result = await corosReadNow(db, env, userId, prefs, { force: true }).catch(() => null);
    if (result?.ingested) {
      // Ambient reads ride the pull; the sweep drains a couple immediately.
      await processCoachReads(db, env, userId, prefs, {}).catch(() => undefined);
    }
  }
}
