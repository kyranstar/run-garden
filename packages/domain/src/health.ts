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
  /** Lactate-threshold pace (sec/km) and HR. */
  thresholdPaceSecPerKm?: number;
  thresholdHr?: number;
  /** COROS's own sleep-HRV baseline for the day, ms. */
  sleepHrvBase?: number;
  /** COROS's own acute:chronic workload ratio. */
  loadRatio?: number;
  acuteTi?: number;
  chronicTi?: number;
  /** This single day's training load (trainingLoad7d is the 7-day sum). */
  dayLoad?: number;
  vo2max?: number;
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
