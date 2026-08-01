import type {
  DateRange,
  DailyHealth,
  PlannedStage,
  SleepRecord,
  SourceActivity,
  TrainingProviderCapabilities,
} from "@rg/domain";

/** A planned workout as read from a source, before Run Garden owns scheduling. */
export interface SourcePlannedWorkout {
  sourcePlanId: string;
  sourceWorkoutId: string;
  sourceProgramId?: string;
  sourceIdInPlan?: string;
  title: string;
  sport: string;
  date: string; // the provider's calendar date (YYYY-MM-DD)
  estimatedDurationSeconds?: number;
  estimatedDistanceMeters?: number;
  trainingLoad?: number;
  stages: PlannedStage[];
  sourceVersion?: string;
  contentFingerprint: string;
  isRestDay: boolean;
  raw?: unknown;
}

export interface TrainingPlanInfo {
  sourcePlanId: string;
  name: string;
  startDate?: string;
  endDate?: string;
  pbVersion?: string;
  sourceVersion?: string;
}

export interface ScheduleUpdate {
  sourcePlanId: string;
  sourceWorkoutId: string;
  sourceIdInPlan?: string;
  fromDate: string;
  toDate: string;
  expectedContentFingerprint?: string;
  expectedSourceVersion?: string;
  operationId: string;
}

export interface ProviderWriteResult {
  outcome:
    | "verified"
    | "already_in_desired_state"
    | "upstream_changed"
    | "write_failed"
    | "ambiguous"
    | "verification_failed"
    | "rolled_back"
    | "unsupported";
  pathUsed?: "official_api" | "direct_update" | "remove_and_add";
  observedDate?: string;
  observedFingerprint?: string;
  observedVersion?: string;
  errorCategory?: string;
}

export interface TrainingPlanProvider {
  getCapabilities(): Promise<TrainingProviderCapabilities>;
  getCurrentPlan(): Promise<TrainingPlanInfo | null>;
  getPlannedWorkouts(range: DateRange): Promise<SourcePlannedWorkout[]>;
  getActivities(range: DateRange): Promise<SourceActivity[]>;
  getDailyHealth(range: DateRange): Promise<DailyHealth[]>;
  getSleep?(range: DateRange): Promise<SleepRecord[]>;
  updateScheduledWorkout?(input: ScheduleUpdate): Promise<ProviderWriteResult>;
}

export interface ActivityProvider {
  getActivities(range: DateRange): Promise<SourceActivity[]>;
  getActivityDetails?(activityId: string): Promise<unknown>;
}

export const NORMALIZER_VERSION = "1.0.0";
