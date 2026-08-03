export type TrainingProviderCapabilities = {
  readPlan: boolean;
  readSchedule: boolean;
  readActivities: boolean;
  readHealth: boolean;
  readSleep: boolean;
  readNativeDurationEstimate: boolean;
  calculateWorkout: boolean;
  updateExistingScheduledWorkout: boolean;
  addScheduledWorkout: boolean;
  removeScheduledWorkout: boolean;
  verifyWatchSync: boolean;
  /** Bridge can fetch and forward the COROS strength-exercise catalog.
   * Optional: bridges built before Plan Studio never send it, and the worker
   * uses its absence to tell "outdated desktop app" apart from "still syncing". */
  exerciseCatalog?: boolean;
};

export const NO_CAPABILITIES: TrainingProviderCapabilities = {
  readPlan: false,
  readSchedule: false,
  readActivities: false,
  readHealth: false,
  readSleep: false,
  readNativeDurationEstimate: false,
  calculateWorkout: false,
  updateExistingScheduledWorkout: false,
  addScheduledWorkout: false,
  removeScheduledWorkout: false,
  verifyWatchSync: false,
  exerciseCatalog: false,
};

/** Can any COROS schedule write path work with these capabilities? */
export function canWriteSchedule(c: TrainingProviderCapabilities): boolean {
  return (
    c.updateExistingScheduledWorkout ||
    (c.addScheduledWorkout && c.removeScheduledWorkout)
  );
}
