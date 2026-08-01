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
};

/** Can any COROS schedule write path work with these capabilities? */
export function canWriteSchedule(c: TrainingProviderCapabilities): boolean {
  return (
    c.updateExistingScheduledWorkout ||
    (c.addScheduledWorkout && c.removeScheduledWorkout)
  );
}
