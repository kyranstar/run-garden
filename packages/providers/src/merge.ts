import type { NormalizedActivity, SourceActivity } from "@rg/domain";
import { newId } from "@rg/domain";

/**
 * COROS is the only activity source: one physical session, one normalized
 * activity, one source link.
 *
 * Until 2026-08 this module also merged a Strava copy of the same session.
 * Strava API access became subscription-gated and COROS was already
 * authoritative for every metric, so the pair-merge is gone. What remains is
 * the scoring needed to recognise a stored row as *the same session* — used to
 * adopt rows that predate COROS-only ingest rather than duplicate them.
 * Scoring never relies on titles.
 */

/** Minimum score before an incoming COROS activity adopts an existing row. */
export const ORPHAN_ADOPTION_FLOOR = 0.6;

export interface ScoreDetail {
  score: number;
  parts: Record<string, number>;
}

/** The fields of a stored activity row that identity scoring actually reads. */
export interface StoredRowLike {
  startTime: string;
  sport: string;
  durationSeconds: number;
  distanceMeters?: number;
}

/**
 * How confident are we that an incoming COROS activity and an already-stored
 * row describe the same physical session? Start time dominates.
 *
 * The old pair scorer also had a device-name term, worth 0.1, that fired when
 * both sides named a COROS watch — meaningless now that every source IS the
 * COROS watch. Its weight moved to duration and distance, the two signals that
 * still discriminate, so the 0.6 floor keeps its original meaning.
 */
export function scoreAgainstStoredRow(a: SourceActivity, b: StoredRowLike): ScoreDetail {
  const parts: Record<string, number> = {};

  // A sport mismatch is a HARD reject, not a 0.15 penalty. Adoption rewrites
  // the stored row in place, so getting it wrong destroys a real session: a
  // yoga practice and a run that start together and last the same time scored
  // 0.85 on every other signal and would have been silently merged. The old
  // pair scorer could afford a soft penalty because it only ever compared two
  // providers' copies of one activity; this compares distinct sessions.
  if (a.sport !== b.sport) return { score: 0, parts: { sportMismatch: 0 } };

  // Start-time proximity (dominant signal).
  const dtMin = Math.abs(new Date(a.startTime).getTime() - new Date(b.startTime).getTime()) / 60000;
  parts.startTime = dtMin <= 2 ? 0.35 : dtMin >= 15 ? 0 : 0.35 * (1 - (dtMin - 2) / 13);

  parts.sport = 0.15;

  const durA = a.durationSeconds;
  const durB = b.durationSeconds;
  if (durA > 0 && durB > 0) {
    const rel = Math.abs(durA - durB) / Math.max(durA, durB);
    parts.duration = rel <= 0.05 ? 0.25 : rel >= 0.25 ? 0 : 0.25 * (1 - (rel - 0.05) / 0.2);
  } else parts.duration = 0;

  if (a.distanceMeters && b.distanceMeters) {
    const rel =
      Math.abs(a.distanceMeters - b.distanceMeters) / Math.max(a.distanceMeters, b.distanceMeters);
    parts.distance = rel <= 0.03 ? 0.25 : rel >= 0.2 ? 0 : 0.25 * (1 - (rel - 0.03) / 0.17);
  } else parts.distance = 0.05; // one side missing distance is weak neutral evidence

  const score = Math.min(1, Object.values(parts).reduce((x, y) => x + y, 0));
  return { score, parts };
}

export function singleSourceActivity(src: SourceActivity, existingId?: string): NormalizedActivity {
  return {
    id: existingId ?? newId(),
    corosActivityId: src.provider === "coros" ? src.providerActivityId : undefined,
    startTime: src.startTime,
    startTimeLocal: src.startTimeLocal,
    timezone: src.timezone,
    sport: src.sport,
    durationSeconds: src.durationSeconds,
    elapsedSeconds: src.elapsedSeconds,
    distanceMeters: src.distanceMeters,
    avgHeartRate: src.avgHeartRate,
    maxHeartRate: src.maxHeartRate,
    avgPaceSecPerKm: src.avgPaceSecPerKm,
    elevationGainMeters: src.elevationGainMeters,
    trainingLoad: src.trainingLoad,
    deviceName: src.deviceName,
    title: src.title,
    telemetry: src.telemetry,
    sourceMergeConfidence: 1,
  };
}
