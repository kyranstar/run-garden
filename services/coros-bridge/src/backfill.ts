/**
 * Activities-only history fetch for the deep backfill.
 *
 * Deliberately NOT `buildSnapshot`: feeding an old date range through the
 * normal snapshot path runs it through import-plan.ts, whose rules 8 and 9
 * archive workouts and plans that are absent from the range. A range covering
 * 2024 legitimately contains none of today's workouts, so that path would
 * archive the live plan and every workout scheduled on it.
 *
 * This function therefore returns activities and laps ONLY — no plan, no daily
 * health, no exercise catalog — and its worker-side counterpart calls
 * `ingestActivities` and nothing else.
 */

import { sportIdForCorosCode, type SourceActivity } from "@rg/domain";
import {
  normalizeCorosActivity,
  normalizeCorosLaps,
  type NameResolver,
  type RawCorosActivityDetail,
} from "@rg/providers";
import type { CorosClient } from "@rg/coros";
import type { NormalizedLap } from "./snapshot.js";

export interface ActivityBackfillChunk {
  activities: SourceActivity[];
  lapsByProviderId: Record<string, NormalizedLap[]>;
  /**
   * Counts of sportType codes the sport registry could not name (resolved to
   * "other"), by code — admitted and ingested regardless.
   */
  skippedSportTypes: Record<string, number>;
}

export interface BackfillOptions {
  /**
   * Pause between per-activity detail fetches. Backfill is one detail call per
   * activity across years of history — roughly 800–1000 for five years — so it
   * paces itself rather than emptying the account's history at full speed.
   */
  delayMs?: number;
}

const DEFAULT_DELAY_MS = 120;

export async function buildActivityBackfill(
  client: CorosClient,
  rangeStart: string,
  rangeEnd: string,
  _resolver: NameResolver | undefined,
  opts: BackfillOptions = {},
): Promise<ActivityBackfillChunk> {
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const items = await client.getActivities(rangeStart, rangeEnd);

  const activities: SourceActivity[] = [];
  const lapsByProviderId: Record<string, NormalizedLap[]> = {};
  const skippedSportTypes: Record<string, number> = {};

  for (const item of items) {
    // Everything is admitted; tally only codes the registry can't name.
    if (sportIdForCorosCode(item.sportType) === "other") {
      const key = String(item.sportType);
      skippedSportTypes[key] = (skippedSportTypes[key] ?? 0) + 1;
    }
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
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return { activities, lapsByProviderId, skippedSportTypes };
}
