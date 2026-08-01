import type { Instant, LocalDate } from "./time.js";

export interface DailyHealth {
  date: LocalDate;
  restingHeartRate?: number;
  hrv?: number;
  /** Provider recovery metric normalized to 0-100 when available. */
  recoveryScore?: number;
  fatigueScore?: number;
  trainingLoad7d?: number;
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
