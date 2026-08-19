import { inArray, sql } from "drizzle-orm";
import { athleteZones, dailyHealth } from "@rg/database";
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
        sleepHrvBase: (h.sleepHrvBase as number) ?? null,
        sleepHrvSd: (h.sleepHrvSd as number) ?? null,
        fullRecoveryHours: (h.fullRecoveryHours as number) ?? null,
        loadRatio: (h.loadRatio as number) ?? null,
        acuteTi: (h.acuteTi as number) ?? null,
        chronicTi: (h.chronicTi as number) ?? null,
        dayLoad: (h.dayLoad as number) ?? null,
        vo2max: (h.vo2max as number) ?? null,
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
          sleepHrvBase: sql`COALESCE(excluded.sleep_hrv_base, ${dailyHealth.sleepHrvBase})`,
          sleepHrvSd: sql`COALESCE(excluded.sleep_hrv_sd, ${dailyHealth.sleepHrvSd})`,
          fullRecoveryHours: sql`COALESCE(excluded.full_recovery_hours, ${dailyHealth.fullRecoveryHours})`,
          loadRatio: sql`COALESCE(excluded.load_ratio, ${dailyHealth.loadRatio})`,
          acuteTi: sql`COALESCE(excluded.acute_ti, ${dailyHealth.acuteTi})`,
          chronicTi: sql`COALESCE(excluded.chronic_ti, ${dailyHealth.chronicTi})`,
          dayLoad: sql`COALESCE(excluded.day_load, ${dailyHealth.dayLoad})`,
          vo2max: sql`COALESCE(excluded.vo2max, ${dailyHealth.vo2max})`,
          contentFingerprint: fp,
          updatedAt: now,
        },
      });
    written++;
    storedFingerprints.set(id, fp);
  }
  return { received: incoming.length, written, skipped };
}

/** The athlete's own zone definitions — one row, replaced whole (0018). */
export async function upsertAthleteZones(
  db: Db,
  userId: string,
  zones: {
    maxHr?: number;
    lthr?: number;
    ltsp?: number;
    lthrZones?: Array<{ index: number; bound: number; ratioPct: number | undefined }>;
    ltspZones?: Array<{ index: number; bound: number; ratioPct: number | undefined }>;
  },
): Promise<void> {
  const mapHr = zones.lthrZones?.map((z) => ({ index: z.index, hr: z.bound, ratioPct: z.ratioPct ?? 0 })) ?? null;
  const mapPace = zones.ltspZones?.map((z) => ({ index: z.index, paceSecPerKm: z.bound, ratioPct: z.ratioPct ?? 0 })) ?? null;
  await db
    .insert(athleteZones)
    .values({
      userId,
      maxHr: zones.maxHr ?? null,
      lthr: zones.lthr ?? null,
      ltsp: zones.ltsp ?? null,
      lthrZones: mapHr,
      ltspZones: mapPace,
      updatedAt: nowInstant(),
    })
    .onConflictDoUpdate({
      target: athleteZones.userId,
      set: {
        maxHr: zones.maxHr ?? null,
        lthr: zones.lthr ?? null,
        ltsp: zones.ltsp ?? null,
        lthrZones: mapHr,
        ltspZones: mapPace,
        updatedAt: nowInstant(),
      },
    });
}
