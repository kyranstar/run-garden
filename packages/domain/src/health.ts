import type { Instant, LocalDate } from "./time.js";

export interface DailyHealth {
  date: LocalDate;
  restingHeartRate?: number;
  hrv?: number;
  /** Provider recovery metric normalized to 0-100 when available. */
  recoveryScore?: number;
  fatigueScore?: number;
  trainingLoad7d?: number;
  /** COROS running-fitness score 0-100 — a "now" value stamped onto the
   * current day only (race hub 2026-08-14). */
  staminaLevel?: number;
  /** Lactate-threshold pace (sec/km) and HR — same current-day stamping. */
  thresholdPaceSecPerKm?: number;
  thresholdHr?: number;
  steps?: number;
  provider: "coros";
  contentFingerprint: string;
}

export interface SleepRecord {
  date: LocalDate; // the morning this sleep ended
  startTime?: Instant;
  endTime?: Instant;
  durationSeconds: number;
  deepSeconds?: number;
  remSeconds?: number;
  lightSeconds?: number;
  awakeSeconds?: number;
  qualityScore?: number;
  provider: "coros";
  contentFingerprint: string;
}
