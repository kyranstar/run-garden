import { describe, expect, it } from "vitest";
import { programSessionPushJobSchema } from "../src/jobs.js";

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workoutId: "w1",
    buildId: "b1",
    happenDay: "2026-10-28",
    name: "RG Plan",
    session: {
      kind: "program_watch",
      title: "Strength",
      steps: [
        {
          originId: "0",
          name: "Squat",
          target: { kind: "reps", reps: 8 },
          grams: null,
          restSeconds: 60,
          overview: "",
          side: null,
        },
      ],
    },
    ...over,
  };
}

describe("programSessionPushJobSchema provisional", () => {
  it("accepts provisional: true and omits it when absent", () => {
    expect(programSessionPushJobSchema.parse(payload({ provisional: true })).provisional).toBe(true);
    expect(programSessionPushJobSchema.parse(payload()).provisional).toBeUndefined();
  });
});

describe("programSessionPushJobSchema mirror fields", () => {
  it("carries the revision a mirror push was made from and its re-queue count; both optional", () => {
    const parsed = programSessionPushJobSchema.parse(payload({ provisional: true, fromDocRev: 3, mirrorRetries: 1 }));
    expect(parsed).toMatchObject({ fromDocRev: 3, mirrorRetries: 1 });
    expect(programSessionPushJobSchema.parse(payload())).not.toHaveProperty("fromDocRev");
    expect(programSessionPushJobSchema.safeParse(payload({ fromDocRev: -1 })).success).toBe(false);
  });
});
