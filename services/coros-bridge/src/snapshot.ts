/**
 * Snapshot assembly shared by the NDJSON protocol (`readSnapshot`) and the
 * cloud sync loop (`pushSnapshot`): plan + workouts + activities + laps +
 * daily health for a date range, fully normalized via @rg/providers.
 */

import { fingerprint, type DailyHealth, type SourceActivity } from "@rg/domain";
import {
  COROS_RUN_SPORT_TYPES,
  corosDayToLocalDate,
  normalizeCorosActivity,
  normalizeCorosLaps,
  normalizeCorosSchedule,
  type NameResolver,
  type RawCorosActivityDetail,
  type SourcePlannedWorkout,
  type TrainingPlanInfo,
} from "@rg/providers";
import type { CorosClient } from "./coros-client.js";

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
    const res = await fetchImpl(COROS_LOCALE_URL);
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
}

export async function buildSnapshot(
  client: CorosClient,
  rangeStart: string,
  rangeEnd: string,
  resolver: NameResolver | undefined,
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

  // ── Completed activities (run family), with laps ──────────────────────────
  const items = await client.getActivities(rangeStart, rangeEnd);
  const activities: SourceActivity[] = [];
  const lapsByProviderId: Record<string, NormalizedLap[]> = {};
  for (const item of items) {
    if (!COROS_RUN_SPORT_TYPES.has(item.sportType)) continue;
    let detail: RawCorosActivityDetail | undefined;
    try {
      detail = await client.getActivityDetail(item.labelId, item.sportType);
    } catch {
      detail = undefined; // list-level fields still make a usable activity
    }
    activities.push(normalizeCorosActivity(item, detail));
    if (detail) {
      const laps = normalizeCorosLaps(detail);
      if (laps.length > 0) lapsByProviderId[item.labelId] = laps;
    }
  }

  // ── Daily health ──────────────────────────────────────────────────────────
  const days = await client.getDailyMetrics(rangeStart, rangeEnd);
  const health: DailyHealth[] = days
    .filter((d) => d.happenDay != null)
    .map((d) => {
      const base = {
        date: corosDayToLocalDate(d.happenDay),
        restingHeartRate: numberOrUndefined(d.rhr),
        hrv: numberOrUndefined(d.avgSleepHrv),
        fatigueScore: numberOrUndefined(d.tiredRateNew),
        trainingLoad7d: numberOrUndefined(d.t7d),
        provider: "coros" as const,
      };
      return { ...base, contentFingerprint: fingerprint(base) };
    });

  return { plan, workouts, activities, lapsByProviderId, health };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
