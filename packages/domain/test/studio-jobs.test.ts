import { describe, expect, it } from "vitest";
import {
  COROS_WRITE_JOB_KINDS,
  createScheduledWorkoutJobSchema,
  deleteScheduledWorkoutJobSchema,
  isStudioJobKind,
  studioJobResultSchema,
  corosWriteResultSchema,
} from "../src/jobs.js";

/**
 * Job-kind union + studio payload/result envelopes (plan-studio-design §5).
 * These schemas are the contract between the worker's push orchestrator and
 * the bridge's executor dispatch, so every field is pinned here.
 */

const SQUAT = "425898928110747648";

function createPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pushId: "push-1",
    happenDay: "2026-09-07",
    name: "Upper A — wk 1",
    session: {
      title: "Upper A",
      weekday: 1,
      exercises: [
        {
          originId: SQUAT,
          name: "Back Squat",
          sets: 3,
          reps: 10,
          weight: { type: "bodyweight" },
          restSeconds: 60,
        },
      ],
    },
    catalog: [{ id: SQUAT, name: "Back Squat" }],
    ...over,
  };
}

function deletePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pushId: "push-1",
    happenDay: "2026-09-07",
    name: "Upper A — wk 1",
    idInPlan: "21",
    programId: "9001",
    corosPlanId: "plan-abc",
    ...over,
  };
}

describe("job kinds", () => {
  it("is the three-kind union the spec names", () => {
    expect([...COROS_WRITE_JOB_KINDS]).toEqual([
      "move_scheduled_workout",
      "create_scheduled_workout",
      "delete_scheduled_workout",
    ]);
  });

  it("classifies only the studio kinds as studio jobs", () => {
    expect(isStudioJobKind("create_scheduled_workout")).toBe(true);
    expect(isStudioJobKind("delete_scheduled_workout")).toBe(true);
    expect(isStudioJobKind("move_scheduled_workout")).toBe(false);
    expect(isStudioJobKind("something_else")).toBe(false);
  });
});

describe("create_scheduled_workout payload", () => {
  it("accepts a well-formed payload", () => {
    const parsed = createScheduledWorkoutJobSchema.safeParse(createPayload());
    expect(parsed.success).toBe(true);
  });

  it("carries a LocalDate happenDay, not the COROS YYYYMMDD wire form", () => {
    expect(createScheduledWorkoutJobSchema.safeParse(createPayload({ happenDay: "20260907" })).success).toBe(
      false,
    );
  });

  it("validates the session with the studio schema", () => {
    const bad = createPayload();
    (bad.session as { exercises: Array<Record<string, unknown>> }).exercises[0]!.sets = 0;
    expect(createScheduledWorkoutJobSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown field (strict) so a payload drift cannot pass silently", () => {
    expect(createScheduledWorkoutJobSchema.safeParse(createPayload({ planId: "plan-abc" })).success).toBe(
      false,
    );
  });

  it("has no plan id at all — the executor resolves and guards its own target plan", () => {
    const keys = Object.keys(createScheduledWorkoutJobSchema.parse(createPayload()));
    expect(keys).not.toContain("planId");
    expect(keys).not.toContain("corosPlanId");
  });
});

describe("delete_scheduled_workout payload", () => {
  it("accepts a well-formed target", () => {
    expect(deleteScheduledWorkoutJobSchema.safeParse(deletePayload()).success).toBe(true);
  });

  it("requires the whole delete triple plus the stamp", () => {
    for (const field of ["idInPlan", "programId", "corosPlanId", "name"]) {
      const payload = deletePayload();
      delete payload[field];
      expect(deleteScheduledWorkoutJobSchema.safeParse(payload).success).toBe(false);
    }
  });
});

describe("studio job result", () => {
  it("accepts a verified create with its server ids", () => {
    const parsed = studioJobResultSchema.safeParse({
      pushId: "push-1",
      kind: "create_scheduled_workout",
      ok: true,
      code: "0000",
      serverIdInPlan: "21",
      serverProgramId: "9001",
      serverEntityId: "555",
      serverPlanId: "plan-abc",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a refused delete", () => {
    expect(
      studioJobResultSchema.safeParse({
        pushId: "push-1",
        kind: "delete_scheduled_workout",
        ok: false,
        refused: "stamp_mismatch",
      }).success,
    ).toBe(true);
  });

  it("carries NO free-text error field — only structured codes reach the worker", () => {
    expect(
      studioJobResultSchema.safeParse({
        pushId: "push-1",
        kind: "create_scheduled_workout",
        ok: false,
        reason: "error",
        error: "exercise originId 123 (\"Squat\") is not in the COROS exercise catalog",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown reason", () => {
    expect(
      studioJobResultSchema.safeParse({
        pushId: "push-1",
        kind: "create_scheduled_workout",
        ok: false,
        reason: "made_up",
      }).success,
    ).toBe(false);
  });

  it("rides on the existing signed write-result envelope", () => {
    const parsed = corosWriteResultSchema.safeParse({
      jobId: "job-1",
      deviceId: "device-1",
      outcome: "verified",
      finishedAt: new Date().toISOString(),
      signature: "sig-in-headers",
      studio: {
        pushId: "push-1",
        kind: "create_scheduled_workout",
        ok: true,
        code: "0000",
        serverIdInPlan: "21",
        serverProgramId: "9001",
        serverPlanId: "plan-abc",
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.studio?.serverIdInPlan).toBe("21");
  });

  it("still accepts a plain move result with no studio block", () => {
    expect(
      corosWriteResultSchema.safeParse({
        jobId: "job-1",
        deviceId: "device-1",
        outcome: "verified",
        finishedAt: new Date().toISOString(),
        signature: "sig",
      }).success,
    ).toBe(true);
  });
});
