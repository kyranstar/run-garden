import { describe, expect, it } from "vitest";
import { reconcileWorkout, type WorkoutFacts } from "../src/services/reconcile.js";

const base: WorkoutFacts = {
  workoutId: "w1",
  effectiveDate: "2026-08-08",
  lastVerifiedCorosDate: "2026-08-08",
  observedDate: "2026-08-08",
  openIntent: null,
  pendingJob: null,
};

describe("reconcileWorkout", () => {
  it("everything agrees → none", () => {
    expect(reconcileWorkout(base)).toEqual({ act: "none" });
  });

  it("COROS reports our pending destination → verify_job", () => {
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-10",
      openIntent: { id: "i1", toDate: "2026-08-10" },
      pendingJob: { id: "j1", destinationDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({ act: "verify_job", jobId: "j1", intentId: "i1" });
  });

  it("upstream change, no open intent → adopt with note (displaces a synced value)", () => {
    const f: WorkoutFacts = { ...base, observedDate: "2026-08-09" };
    expect(reconcileWorkout(f)).toEqual({
      act: "adopt_coros",
      toDate: "2026-08-09",
      note: { previousDate: "2026-08-08" },
    });
  });

  it("upstream change while our move is pending → app wins, supersede, note", () => {
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-09",
      openIntent: { id: "i1", toDate: "2026-08-10" },
      pendingJob: { id: "j1", destinationDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({
      act: "app_wins",
      intentId: "i1",
      keepDate: "2026-08-10",
      supersedeJobId: "j1",
      note: { displacedDate: "2026-08-09" },
    });
  });

  it("upstream change with open intent but no job (writes were off) → app wins, no job to supersede", () => {
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-09",
      openIntent: { id: "i1", toDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({
      act: "app_wins",
      intentId: "i1",
      keepDate: "2026-08-10",
      supersedeJobId: null,
      note: { displacedDate: "2026-08-09" },
    });
  });

  it("COROS moved TO the open intent's date without our job → verify intent, dates agree", () => {
    // e.g. the user also moved it in the COROS app to the same day.
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-10",
      openIntent: { id: "i1", toDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({ act: "verify_job", jobId: "", intentId: "i1" });
  });

  it("waiting for our move to land (observed still at origin) → none", () => {
    const f: WorkoutFacts = {
      ...base,
      effectiveDate: "2026-08-10",
      observedDate: "2026-08-08",
      openIntent: { id: "i1", toDate: "2026-08-10" },
      pendingJob: { id: "j1", destinationDate: "2026-08-10" },
    };
    expect(reconcileWorkout(f)).toEqual({ act: "none" });
  });
});
