/**
 * Snapshot assembly shared by the NDJSON protocol (`readSnapshot`) and the
 * cloud sync loop (`pushSnapshot`): plan + workouts + activities + laps +
 * daily health for a date range, fully normalized via @rg/providers.
 */

import {
  addDays,
  fingerprint,
  sportIdForCorosCode,
  type DailyHealth,
  type SourceActivity,
} from "@rg/domain";
import {
  corosDayToLocalDate,
  normalizeCorosActivity,
  normalizeCorosLaps,
  normalizeCorosSchedule,
  type NameResolver,
  type RawCorosActivityDetail,
  type SourcePlannedWorkout,
  type TrainingPlanInfo,
} from "@rg/providers";
import type { CorosClient, CorosDashboardSubset } from "./client.js";

export const COROS_LOCALE_URL =
  "https://static.coros.com/locale/coros-traininghub-v2/en-US.prod.js";

/**
 * COROS program names/overviews are i18n keys (T1120, sid_run_…); the
 * unauthenticated CDN bundle maps them to English. Failure → undefined
 * resolver (normalizers fall back to key prettification).
 */
export async function loadNameResolver(
  fetchImpl: typeof fetch,
): Promise<NameResolver | undefined> {
  try {
    const res = await fetchImpl(COROS_LOCALE_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return undefined;
    const text = await res.text();
    const stripped = text
      .trim()
      .replace(/^window\.en_US\s*=\s*/, "")
      .replace(/;+\s*$/, "");
    const map = JSON.parse(stripped) as Record<string, unknown>;
    return (key: string) => {
      const value = map[key];
      return typeof value === "string" ? value : undefined;
    };
  } catch {
    return undefined;
  }
}

export type NormalizedLap = ReturnType<typeof normalizeCorosLaps>[number];

export interface BridgeSnapshot {
  plan: TrainingPlanInfo | null;
  workouts: SourcePlannedWorkout[];
  activities: SourceActivity[];
  lapsByProviderId: Record<string, NormalizedLap[]>;
  health: DailyHealth[];
  /**
   * Counts of sportType codes the sport registry could not name (resolved to
   * "other"), by code — admitted and ingested regardless, but surfaced here
   * so new COROS codes worth naming show up.
   */
  skippedSportTypes?: Record<string, number>;
  /** COROS strength-exercise catalog (id/name pairs); see BuildSnapshotOptions. */
  exerciseCatalog?: Array<{ id: string; name: string }>;
}

export interface BuildSnapshotOptions {
  /**
   * Fetch and include the sportType=4 (strength) exercise catalog
   * (plan-studio-design §4, spike-verified: 382 entries live). The caller
   * (CloudSync) decides this based on whether the worker's previous sync
   * response said its stored catalog was stale.
   */
  includeExerciseCatalog?: boolean;
  /**
   * Overrides `rangeStart` for the daily-health (wellness) query only. Daily
   * health (resting HR, HRV, recovery/fatigue scores) is one cheap query
   * regardless of window size and is useful much further back than the
   * activity/plan window, so callers can pull a deeper wellness history
   * (e.g. 60 days) without widening the activities/laps range. Defaults to
   * `rangeStart` when omitted.
   */
  healthRangeStart?: string;
  /**
   * When present, per-activity DETAIL (and therefore laps) is fetched only
   * for items this returns true for. The worker's read-now passes "is this
   * labelId unseen?" so a fresh pull costs one list call plus details for
   * genuinely new activities — not a detail round-trip per historical item.
   * List-level fields still produce a usable activity either way.
   */
  detailFilter?: (item: { labelId: string; sportType: number }) => boolean;
}

/**
 * `today` is the current LocalDate in the USER's timezone (callers compute it
 * — this package never reads the wall clock). It exists solely for the
 * recovery-freshness guard below; `rangeEnd` can't serve that role because
 * live callers pass schedule-ahead ranges ending in the future.
 */
export async function buildSnapshot(
  client: CorosClient,
  rangeStart: string,
  rangeEnd: string,
  today: string,
  resolver: NameResolver | undefined,
  opts: BuildSnapshotOptions = {},
): Promise<BridgeSnapshot> {
  // ── Plan + workouts ────────────────────────────────────────────────────────
  const raw = await client.getRawSchedule(rangeStart, rangeEnd);
  const normalized = normalizeCorosSchedule(raw, resolver);
  const plan: TrainingPlanInfo | null = normalized.planId
    ? {
        sourcePlanId: normalized.planId,
        name: normalized.planName,
        startDate: normalized.planStart,
        endDate: normalized.planEnd,
        pbVersion: normalized.pbVersion,
        sourceVersion: raw.version != null ? String(raw.version) : undefined,
      }
    : null;
  // Strip raw entity/program payloads: the cloud only needs normalized shapes,
  // and the raw objects carry COROS-internal user ids.
  const workouts = normalized.workouts.map(({ raw: _raw, ...workout }) => workout);

  // ── Completed activities (all sports), with laps ────────────────────────────
  const items = await client.getActivities(rangeStart, rangeEnd);
  const activities: SourceActivity[] = [];
  const lapsByProviderId: Record<string, NormalizedLap[]> = {};
  const skipped: Record<string, number> = {};
  for (const item of items) {
    // Everything is admitted; tally only codes the registry can't name, so
    // the census still surfaces new COROS codes worth naming.
    if (sportIdForCorosCode(item.sportType) === "other") {
      const key = String(item.sportType);
      skipped[key] = (skipped[key] ?? 0) + 1;
    }
    let detail: RawCorosActivityDetail | undefined;
    if (!opts.detailFilter || opts.detailFilter(item)) {
      try {
        detail = await client.getActivityDetail(item.labelId, item.sportType);
      } catch {
        detail = undefined; // list-level fields still make a usable activity
      }
    }
    activities.push(normalizeCorosActivity(item, detail));
    if (detail) {
      const laps = normalizeCorosLaps(detail);
      if (laps.length > 0) lapsByProviderId[item.labelId] = laps;
    }
  }

  // ── Daily health ──────────────────────────────────────────────────────────
  const days = await client.getDailyMetrics(opts.healthRangeStart ?? rangeStart, rangeEnd);

  // Recovery % lives only on the dashboard (today's value) — one cheap query.
  // Historical days keep undefined; the worker's COALESCE never overwrites a
  // stored value with null.
  let dashboard: CorosDashboardSubset | undefined;
  try {
    dashboard = await client.getDashboard();
  } catch {
    dashboard = undefined;
  }

  // Only stamp the dashboard's recoveryPct when Coros's latest daily-health
  // day is CURRENT — today or yesterday in the user's timezone (COROS health
  // can lag a day; it can also sit a day AHEAD when COROS rolls dates in a
  // different zone, hence >= rather than equality). The dashboard always
  // reports "now": if the account's metrics are older, stamping the dashboard
  // value onto that stale day would misattribute today's recovery to it, and
  // because the worker's COALESCE never overwrites a stored value with null,
  // the wrong value would stick. (Comparing against rangeEnd is wrong — live
  // callers pass schedule-ahead ranges ending in the future, which left
  // recoveryScore unstamped forever.)
  const latestDay = days.reduce((m, d) => Math.max(m, Number(d.happenDay ?? 0)), 0);
  const latestIsCurrent = latestDay > 0 && corosDayToLocalDate(latestDay) >= addDays(today, -1);
  const health: DailyHealth[] = days
    .filter((d) => d.happenDay != null)
    .map((d) => {
      // All four dashboard metrics are "now" values sharing the same
      // current-day-only stamping rule as recoveryScore.
      const stampDashboard = latestIsCurrent && Number(d.happenDay) === latestDay;
      const base = {
        date: corosDayToLocalDate(d.happenDay),
        restingHeartRate: numberOrUndefined(d.rhr),
        hrv: numberOrUndefined(d.avgSleepHrv),
        fatigueScore: numberOrUndefined(d.tiredRateNew),
        trainingLoad7d: numberOrUndefined(d.t7d),
        recoveryScore: stampDashboard ? numberOrUndefined(dashboard?.recoveryPct) : undefined,
        staminaLevel: stampDashboard ? numberOrUndefined(dashboard?.staminaLevel) : undefined,
        thresholdPaceSecPerKm: stampDashboard ? numberOrUndefined(dashboard?.ltsp) : undefined,
        thresholdHr: stampDashboard ? numberOrUndefined(dashboard?.lthr) : undefined,
        provider: "coros" as const,
      };
      return { ...base, contentFingerprint: fingerprint(base) };
    });

  // ── Exercise catalog (only when the worker last said its copy was stale) ──
  let exerciseCatalog: Array<{ id: string; name: string }> | undefined;
  if (opts.includeExerciseCatalog) {
    try {
      // sportType 4 = strength (spike-verified, 382 entries live).
      const items = await client.getExerciseCatalog(4);
      exerciseCatalog = items
        .filter((i): i is typeof i & { name: string } => typeof i.name === "string")
        .map((i) => ({ id: String(i.id), name: i.name }));
    } catch {
      // Best-effort: the worker's catalog stays stale, so the next sync retries.
      exerciseCatalog = undefined;
    }
  }

  return {
    plan,
    workouts,
    activities,
    lapsByProviderId,
    health,
    ...(Object.keys(skipped).length > 0 ? { skippedSportTypes: skipped } : {}),
    ...(exerciseCatalog ? { exerciseCatalog } : {}),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
