import { describe, expect, it } from "vitest";
import { canWriteSchedule } from "@rg/domain";
import { FixtureTrainingProvider } from "../src/fixture-provider.js";

const BASE = "2026-08-03";

describe("FixtureTrainingProvider (write contract)", () => {
  const range = { start: "2026-08-01", end: "2026-09-01" };

  it("reports capabilities that allow schedule writes", async () => {
    const p = new FixtureTrainingProvider({ baseMonday: BASE });
    const caps = await p.getCapabilities();
    expect(caps.readNativeDurationEstimate).toBe(true);
    expect(canWriteSchedule(caps)).toBe(true);
    expect(caps.verifyWatchSync).toBe(false); // watch sync is never claimable
  });

  it("performs a verified direct date update (read-after-write)", async () => {
    const p = new FixtureTrainingProvider({ baseMonday: BASE });
    const result = await p.updateScheduledWorkout({
      sourcePlanId: "800000000000001234",
      sourceWorkoutId: "800000000000001234:11",
      sourceIdInPlan: "11",
      fromDate: "2026-08-04",
      toDate: "2026-08-05",
      operationId: "op-1",
    });
    expect(result.outcome).toBe("verified");
    expect(result.pathUsed).toBe("direct_update");
    expect(result.observedDate).toBe("2026-08-05");
    const workouts = await p.getPlannedWorkouts(range);
    expect(workouts.find((w) => w.sourceIdInPlan === "11")!.date).toBe("2026-08-05");
  });

  it("is idempotent: re-running the same move reports already_in_desired_state", async () => {
    const p = new FixtureTrainingProvider({ baseMonday: BASE });
    const move = {
      sourcePlanId: "800000000000001234",
      sourceWorkoutId: "800000000000001234:11",
      sourceIdInPlan: "11",
      fromDate: "2026-08-04",
      toDate: "2026-08-05",
      operationId: "op-2",
    };
    await p.updateScheduledWorkout(move);
    const again = await p.updateScheduledWorkout(move);
    expect(again.outcome).toBe("already_in_desired_state");
    expect(p.writeCount).toBe(1); // no duplicate write happened
  });

  it("refuses to overwrite an unexpected upstream change", async () => {
    const p = new FixtureTrainingProvider({ baseMonday: BASE });
    // Upstream moved it to the 6th behind our back.
    await p.updateScheduledWorkout({
      sourcePlanId: "800000000000001234",
      sourceWorkoutId: "800000000000001234:11",
      sourceIdInPlan: "11",
      fromDate: "2026-08-04",
      toDate: "2026-08-06",
      operationId: "op-3a",
    });
    const conflicting = await p.updateScheduledWorkout({
      sourcePlanId: "800000000000001234",
      sourceWorkoutId: "800000000000001234:11",
      sourceIdInPlan: "11",
      fromDate: "2026-08-04", // stale expectation
      toDate: "2026-08-07",
      operationId: "op-3b",
    });
    expect(conflicting.outcome).toBe("upstream_changed");
    expect(conflicting.observedDate).toBe("2026-08-06");
  });

  it("surfaces clean write failures without mutating the schedule", async () => {
    const p = new FixtureTrainingProvider({ baseMonday: BASE, failFirstWrite: true });
    const move = {
      sourcePlanId: "800000000000001234",
      sourceWorkoutId: "800000000000001234:11",
      sourceIdInPlan: "11",
      fromDate: "2026-08-04",
      toDate: "2026-08-05",
      operationId: "op-4",
    };
    const first = await p.updateScheduledWorkout(move);
    expect(first.outcome).toBe("write_failed");
    const workouts = await p.getPlannedWorkouts(range);
    expect(workouts.find((w) => w.sourceIdInPlan === "11")!.date).toBe("2026-08-04");
    const retry = await p.updateScheduledWorkout(move);
    expect(retry.outcome).toBe("verified");
  });

  it("reports unsupported when writes are disabled (calendar-only mode)", async () => {
    const p = new FixtureTrainingProvider({ baseMonday: BASE, writable: false });
    const caps = await p.getCapabilities();
    expect(canWriteSchedule(caps)).toBe(false);
    const result = await p.updateScheduledWorkout({
      sourcePlanId: "800000000000001234",
      sourceWorkoutId: "800000000000001234:11",
      sourceIdInPlan: "11",
      fromDate: "2026-08-04",
      toDate: "2026-08-05",
      operationId: "op-5",
    });
    expect(result.outcome).toBe("unsupported");
  });

  it("exposes a completed activity with plan linkage when configured", async () => {
    const p = new FixtureTrainingProvider({ baseMonday: BASE, withCompletedThreshold: true });
    const acts = await p.getActivities(range);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.sourcePlannedWorkoutId).toBe("9000000000000011");
  });
});
