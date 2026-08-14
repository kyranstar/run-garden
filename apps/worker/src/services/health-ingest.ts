import { inArray, sql } from "drizzle-orm";
import { dailyHealth } from "@rg/database";
import { fingerprint, nowInstant } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";

/**
 * Daily-health upsert shared by the bridge sync route and the cloud pull.
 * Fingerprint-skips unchanged days (so `updatedAt` keeps meaning "when this
 * reading last changed"), and COALESCEs so a null field in a fresh push
 * never clobbers a previously stored good value.
 */
export async function ingestDailyHealth(
  db: Db,
  userId: string,
  rows: Array<Record<string, unknown>>,
): Promise<{ received: number; written: number; skipped: number }> {
  if (rows.length === 0) return { received: 0, written: 0, skipped: 0 };
  const now = nowInstant();
  const incoming = rows.map((h) => {
    const date = String(h.date);
    return { h, date, id: `${userId}:${date}`, fp: fingerprint(h) };
  });
  const storedFingerprints = new Map<string, string | null>();
  for (const ids of chunkIds(incoming.map((r) => r.id))) {
    const existing = await db
      .select({ id: dailyHealth.id, contentFingerprint: dailyHealth.contentFingerprint })
      .from(dailyHealth)
      .where(inArray(dailyHealth.id, ids));
    for (const row of existing) storedFingerprints.set(row.id, row.contentFingerprint);
  }

  let written = 0;
  let skipped = 0;
  for (const { h, date, id, fp } of incoming) {
    if (storedFingerprints.get(id) === fp) {
      skipped++;
      continue;
    }
    await db
      .insert(dailyHealth)
      .values({
        id,
        userId,
        date,
        restingHeartRate: (h.restingHeartRate as number) ?? null,
        hrv: (h.hrv as number) ?? null,
        recoveryScore: (h.recoveryScore as number) ?? null,
        fatigueScore: (h.fatigueScore as number) ?? null,
        trainingLoad7d: (h.trainingLoad7d as number) ?? null,
        staminaLevel: (h.staminaLevel as number) ?? null,
        thresholdPaceSecPerKm: (h.thresholdPaceSecPerKm as number) ?? null,
        thresholdHr: (h.thresholdHr as number) ?? null,
        provider: "coros",
        contentFingerprint: fp,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: dailyHealth.id,
        set: {
          restingHeartRate: sql`COALESCE(excluded.resting_heart_rate, ${dailyHealth.restingHeartRate})`,
          hrv: sql`COALESCE(excluded.hrv, ${dailyHealth.hrv})`,
          recoveryScore: sql`COALESCE(excluded.recovery_score, ${dailyHealth.recoveryScore})`,
          fatigueScore: sql`COALESCE(excluded.fatigue_score, ${dailyHealth.fatigueScore})`,
          trainingLoad7d: sql`COALESCE(excluded.training_load_7d, ${dailyHealth.trainingLoad7d})`,
          staminaLevel: sql`COALESCE(excluded.stamina_level, ${dailyHealth.staminaLevel})`,
          thresholdPaceSecPerKm: sql`COALESCE(excluded.threshold_pace_sec_per_km, ${dailyHealth.thresholdPaceSecPerKm})`,
          thresholdHr: sql`COALESCE(excluded.threshold_hr, ${dailyHealth.thresholdHr})`,
          contentFingerprint: fp,
          updatedAt: now,
        },
      });
    written++;
    storedFingerprints.set(id, fp);
  }
  return { received: incoming.length, written, skipped };
}
