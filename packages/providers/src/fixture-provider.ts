import type {
  DailyHealth,
  DateRange,
  SleepRecord,
  SourceActivity,
  TrainingProviderCapabilities,
} from "@rg/domain";
import { fingerprint, inRange } from "@rg/domain";
import {
  normalizeCorosActivity,
  normalizeCorosSchedule,
  localDateToCorosDay,
  corosDayToLocalDate,
} from "./coros/normalize.js";
import type { RawCorosSchedule } from "./coros/raw-types.js";
import { fixtureRawSchedule } from "./fixtures/coros-schedule.js";
import {
  fixtureCorosCompletedThreshold,
} from "./fixtures/activities.js";
import type {
  ProviderWriteResult,
  ScheduleUpdate,
  SourcePlannedWorkout,
  TrainingPlanInfo,
  TrainingPlanProvider,
} from "./types.js";

export interface FixtureProviderOptions {
  baseMonday: string;
  /** Simulate write support (default true). */
  writable?: boolean;
  /** Simulate a flaky first write attempt (for retry tests). */
  failFirstWrite?: boolean;
  /** Include a completed activity matching the first threshold workout. */
  withCompletedThreshold?: boolean;
}

/**
 * In-memory provider used for development fixture mode, contract tests, and
 * end-to-end tests. Mutations behave like the real Training Hub API: writes
 * mutate the raw schedule and verification re-reads it.
 */
export class FixtureTrainingProvider implements TrainingPlanProvider {
  private raw: RawCorosSchedule;
  private failNextWrite: boolean;
  private readonly writable: boolean;
  private readonly opts: FixtureProviderOptions;
  writeCount = 0;

  constructor(opts: FixtureProviderOptions) {
    this.opts = opts;
    this.raw = fixtureRawSchedule(opts.baseMonday);
    this.writable = opts.writable ?? true;
    this.failNextWrite = opts.failFirstWrite ?? false;
  }

  async getCapabilities(): Promise<TrainingProviderCapabilities> {
    return {
      readPlan: true,
      readSchedule: true,
      readActivities: true,
      readHealth: true,
      readSleep: false,
      readNativeDurationEstimate: true,
      calculateWorkout: true,
      updateExistingScheduledWorkout: this.writable,
      addScheduledWorkout: this.writable,
      removeScheduledWorkout: this.writable,
      verifyWatchSync: false,
    };
  }

  async getCurrentPlan(): Promise<TrainingPlanInfo | null> {
    const n = normalizeCorosSchedule(this.raw);
    return {
      sourcePlanId: n.planId,
      name: n.planName,
      startDate: n.planStart,
      endDate: n.planEnd,
      pbVersion: n.pbVersion,
      sourceVersion: this.raw.version != null ? String(this.raw.version) : undefined,
    };
  }

  async getPlannedWorkouts(range: DateRange): Promise<SourcePlannedWorkout[]> {
    return normalizeCorosSchedule(this.raw).workouts.filter((w) => inRange(w.date, range));
  }

  /** Raw read — what the desktop bridge uses for write verification. */
  async getRawSchedule(): Promise<RawCorosSchedule> {
    return structuredClone(this.raw);
  }

  async getActivities(range: DateRange): Promise<SourceActivity[]> {
    if (!this.opts.withCompletedThreshold) return [];
    // Completed the first threshold workout at 07:02 local on its scheduled day.
    const thresholdDate = corosDayToLocalDate(
      (this.raw.entities ?? []).find((e) => String(e.idInPlan) === "11")!.happenDay,
    );
    const { item, detail } = fixtureCorosCompletedThreshold(`${thresholdDate}T14:02:05Z`);
    const act = normalizeCorosActivity(item, detail);
    return inRange(thresholdDate, range) ? [act] : [];
  }

  async getDailyHealth(range: DateRange): Promise<DailyHealth[]> {
    const out: DailyHealth[] = [];
    let date = range.start;
    let i = 0;
    while (date <= range.end && i < 120) {
      out.push({
        date,
        restingHeartRate: 44 + (i % 4),
        hrv: 62 + (i % 9),
        recoveryScore: 70 + (i % 25),
        trainingLoad7d: 320 + i * 3,
        provider: "coros",
        contentFingerprint: fingerprint({ date, i }),
      });
      i += 1;
      const d = new Date(`${date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      date = d.toISOString().slice(0, 10);
    }
    return out;
  }

  async getSleep(_range: DateRange): Promise<SleepRecord[]> {
    return [];
  }

  async updateScheduledWorkout(input: ScheduleUpdate): Promise<ProviderWriteResult> {
    if (!this.writable) return { outcome: "unsupported" };
    const entity = (this.raw.entities ?? []).find(
      (e) => String(e.idInPlan) === String(input.sourceIdInPlan),
    );
    if (!entity) return { outcome: "upstream_changed", errorCategory: "workout_not_found" };

    const currentDate = corosDayToLocalDate(entity.happenDay);
    if (currentDate === input.toDate) {
      return {
        outcome: "already_in_desired_state",
        pathUsed: "direct_update",
        observedDate: currentDate,
      };
    }
    if (currentDate !== input.fromDate) {
      return {
        outcome: "upstream_changed",
        observedDate: currentDate,
        errorCategory: "date_mismatch",
      };
    }
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return { outcome: "write_failed", errorCategory: "network" };
    }

    entity.happenDay = localDateToCorosDay(input.toDate);
    this.writeCount += 1;

    // Read-after-write verification against the mutated store.
    const verify = (this.raw.entities ?? []).find(
      (e) => String(e.idInPlan) === String(input.sourceIdInPlan),
    );
    const observedDate = verify ? corosDayToLocalDate(verify.happenDay) : undefined;
    if (observedDate !== input.toDate) {
      return { outcome: "verification_failed", observedDate };
    }
    const program = (this.raw.programs ?? []).find(
      (p) => String(p.idInPlan) === String(input.sourceIdInPlan),
    );
    return {
      outcome: "verified",
      pathUsed: "direct_update",
      observedDate,
      observedVersion: program?.version != null ? String(program.version) : undefined,
    };
  }
}
