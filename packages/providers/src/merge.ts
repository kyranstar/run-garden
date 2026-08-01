import type { NormalizedActivity, SourceActivity } from "@rg/domain";
import { mergeConfidenceBand, newId } from "@rg/domain";

/**
 * COROS ⇄ Strava deduplication: one physical run, one normalized activity,
 * multiple source links. Scoring never relies on titles alone.
 */

export interface MergeScoreDetail {
  score: number;
  parts: Record<string, number>;
}

export function scoreActivityPair(a: SourceActivity, b: SourceActivity): MergeScoreDetail {
  const parts: Record<string, number> = {};
  if (a.provider === b.provider) return { score: 0, parts: { sameProvider: 0 } };

  // Start-time proximity (dominant signal).
  const dtMin = Math.abs(new Date(a.startTime).getTime() - new Date(b.startTime).getTime()) / 60000;
  parts.startTime = dtMin <= 2 ? 0.35 : dtMin >= 15 ? 0 : 0.35 * (1 - (dtMin - 2) / 13);

  parts.sport = a.sport === b.sport ? 0.15 : 0;

  const durA = a.durationSeconds;
  const durB = b.durationSeconds;
  if (durA > 0 && durB > 0) {
    const rel = Math.abs(durA - durB) / Math.max(durA, durB);
    parts.duration = rel <= 0.05 ? 0.2 : rel >= 0.25 ? 0 : 0.2 * (1 - (rel - 0.05) / 0.2);
  } else parts.duration = 0;

  if (a.distanceMeters && b.distanceMeters) {
    const rel =
      Math.abs(a.distanceMeters - b.distanceMeters) / Math.max(a.distanceMeters, b.distanceMeters);
    parts.distance = rel <= 0.03 ? 0.2 : rel >= 0.2 ? 0 : 0.2 * (1 - (rel - 0.03) / 0.17);
  } else parts.distance = 0.05; // one side missing distance is weak neutral evidence

  // Device hint: COROS watches appear as device on both sides.
  const devA = (a.deviceName ?? "").toLowerCase();
  const devB = (b.deviceName ?? "").toLowerCase();
  parts.device =
    devA && devB && (devA.includes("coros") || devB.includes("coros")) && (devA.includes(devB) || devB.includes(devA) || devA.split(" ")[0] === devB.split(" ")[0])
      ? 0.1
      : 0;

  const score = Math.min(1, Object.values(parts).reduce((x, y) => x + y, 0));
  return { score, parts };
}

export interface MergeResult {
  activity: NormalizedActivity;
  confidenceBand: "high" | "medium" | "low";
  score: number;
}

/**
 * Merge a COROS and a Strava record of the same physical run.
 * COROS is authoritative for duration/distance/HR/load/plan linkage;
 * Strava enriches with title, route polyline, and its own metadata.
 */
export function mergeActivityPair(
  coros: SourceActivity,
  strava: SourceActivity,
  existingId?: string,
): MergeResult {
  const { score } = scoreActivityPair(coros, strava);
  const activity: NormalizedActivity = {
    id: existingId ?? newId(),
    corosActivityId: coros.providerActivityId,
    stravaActivityId: strava.providerActivityId,
    startTime: coros.startTime,
    startTimeLocal: coros.startTimeLocal ?? strava.startTimeLocal,
    timezone: strava.timezone ?? coros.timezone,
    sport: coros.sport,
    durationSeconds: coros.durationSeconds,
    elapsedSeconds: coros.elapsedSeconds ?? strava.elapsedSeconds,
    distanceMeters: coros.distanceMeters ?? strava.distanceMeters,
    avgHeartRate: coros.avgHeartRate ?? strava.avgHeartRate,
    maxHeartRate: coros.maxHeartRate ?? strava.maxHeartRate,
    avgPaceSecPerKm: coros.avgPaceSecPerKm,
    elevationGainMeters: coros.elevationGainMeters ?? strava.elevationGainMeters,
    trainingLoad: coros.trainingLoad,
    deviceName: coros.deviceName ?? strava.deviceName,
    title: strava.title ?? coros.title,
    summaryPolyline: strava.summaryPolyline,
    sourceMergeConfidence: score,
  };
  return { activity, confidenceBand: mergeConfidenceBand(score), score };
}

export function singleSourceActivity(src: SourceActivity, existingId?: string): NormalizedActivity {
  return {
    id: existingId ?? newId(),
    corosActivityId: src.provider === "coros" ? src.providerActivityId : undefined,
    stravaActivityId: src.provider === "strava" ? src.providerActivityId : undefined,
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
    summaryPolyline: src.summaryPolyline,
    sourceMergeConfidence: 1,
  };
}

/**
 * Given unmatched source records from both providers, pair them greedily by
 * descending score. Never merges two records from one provider and never
 * pairs two genuinely distinct runs (score floor).
 */
export function pairSources(
  corosList: SourceActivity[],
  stravaList: SourceActivity[],
  floor = 0.6,
): Array<{ coros: SourceActivity; strava: SourceActivity; score: number }> {
  const candidates: Array<{ coros: SourceActivity; strava: SourceActivity; score: number }> = [];
  for (const c of corosList) {
    for (const s of stravaList) {
      const { score } = scoreActivityPair(c, s);
      if (score >= floor) candidates.push({ coros: c, strava: s, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedC = new Set<string>();
  const usedS = new Set<string>();
  const out: typeof candidates = [];
  for (const cand of candidates) {
    if (usedC.has(cand.coros.providerActivityId) || usedS.has(cand.strava.providerActivityId)) {
      continue;
    }
    usedC.add(cand.coros.providerActivityId);
    usedS.add(cand.strava.providerActivityId);
    out.push(cand);
  }
  return out;
}
