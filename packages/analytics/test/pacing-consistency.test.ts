import { describe, expect, it } from "vitest";
import { computeConsistency } from "../src/consistency.js";
import { computePacing } from "../src/performance.js";
import { mkWorkout } from "./builders.js";

describe("computePacing", () => {
  it("suppresses below 4 runs with lap data", () => {
    const r = computePacing([
      { firstHalfPace: 300, secondHalfPace: 308 },
      { firstHalfPace: 300, secondHalfPace: 304 },
    ]);
    expect(r.status).toBe("insufficient_data");
    expect(r.status === "insufficient_data" && r.needed).toBe(4);
  });

  it("reports the median fade and the share of negative-split runs", () => {
    // deltas (secondHalf - firstHalf): +8, +4, -2, +6 s/km
    const runs = [
      { firstHalfPace: 300, secondHalfPace: 308 },
      { firstHalfPace: 300, secondHalfPace: 304 },
      { firstHalfPace: 300, secondHalfPace: 298 },
      { firstHalfPace: 300, secondHalfPace: 306 },
    ];
    const r = computePacing(runs);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.medianDeltaSecPerKm).toBe(5);
      expect(r.value.negativePct).toBe(25);
    }
  });
});

describe("computeConsistency — pending", () => {
  const range = { start: "2026-03-02", end: "2026-03-08" };

  it("counts an unresolved workout as pending and excludes it from the adherence denominator", () => {
    const report = computeConsistency(
      [
        mkWorkout({ id: "w1", effectiveDate: "2026-03-02", completionState: "completed" }),
        mkWorkout({ id: "w2", effectiveDate: "2026-03-03", completionState: "completed" }),
        mkWorkout({ id: "w3", effectiveDate: "2026-03-04", completionState: "unresolved" }),
      ],
      range,
      "2026-03-08",
    );
    expect(report.unresolved).toBe(1);
    expect(report.pending).toBe(1); // alias of `unresolved`, same value
    expect(report.completed).toBe(2);
    // denominator is 2 resolved workouts (3 planned - 0 future - 1 unresolved), not 3
    expect(report.adherenceRate).toBe(1);
  });
});

describe("computeConsistency — days grid", () => {
  const range = { start: "2026-03-02", end: "2026-03-08" };
  const today = "2026-03-05"; // Thursday

  it("computes a per-day status with pending-aware precedence", () => {
    const report = computeConsistency(
      [
        mkWorkout({
          id: "moved",
          originalPlanDate: "2026-03-02",
          effectiveDate: "2026-03-03",
          completionState: "completed",
        }),
        mkWorkout({ id: "rest", effectiveDate: "2026-03-08", category: "rest", completionState: "completed" }),
        // Scheduled for yesterday relative to `today` — sync limbo, reads as "pending".
        mkWorkout({ id: "limbo", effectiveDate: "2026-03-04", completionState: "scheduled" }),
        // Scheduled for tomorrow relative to `today` — genuinely still upcoming.
        mkWorkout({ id: "tomorrow", effectiveDate: "2026-03-06", completionState: "scheduled" }),
      ],
      range,
      today,
    );

    expect(report.days).toHaveLength(7);
    const byDate = Object.fromEntries(report.days.map((d) => [d.date, d.status]));
    expect(byDate["2026-03-03"]).toBe("moved");
    expect(byDate["2026-03-07"]).toBe("none"); // no workout at all
    expect(byDate["2026-03-08"]).toBe("rest");
    expect(byDate["2026-03-04"]).toBe("pending"); // scheduled, effectiveDate <= today
    expect(byDate["2026-03-06"]).toBe("future"); // scheduled, effectiveDate > today
  });

  it("resolves same-day conflicts by precedence: missed > skipped > pending > moved > completed > future > rest", () => {
    const report = computeConsistency(
      [
        mkWorkout({ id: "a", effectiveDate: "2026-03-06", completionState: "scheduled" }), // future
        mkWorkout({ id: "b", effectiveDate: "2026-03-06", completionState: "missed" }), // missed wins
      ],
      range,
      today,
    );
    const day = report.days.find((d) => d.date === "2026-03-06");
    expect(day?.status).toBe("missed");
  });
});
