import { describe, expect, it } from "vitest";
import {
  currentStreak,
  divergingDomain,
  formatHours,
  heatmapColumns,
  horizontalBarPath,
  inProgressColumnIndex,
  monthStartDates,
  newMonthColumns,
  outcomeSegments,
  roundedTopBarPath,
  stackedBarSegments,
  symmetricHalfExtent,
  verticalBarPath,
} from "../src/charts-math.js";

describe("formatHours", () => {
  it("renders seconds as hours with one decimal", () => {
    expect(formatHours(16_200)).toBe("4.5h");
    expect(formatHours(3600)).toBe("1.0h");
  });

  it("keeps a real zero honest (never blank, never rounded away)", () => {
    expect(formatHours(0)).toBe("0.0h");
  });

  it("rounds rather than truncates", () => {
    expect(formatHours(3599)).toBe("1.0h");
    expect(formatHours(1080)).toBe("0.3h"); // 18 min
  });
});

describe("heatmapColumns", () => {
  const day = (date: string, status = "completed") => ({ date, status });

  it("returns nothing for an empty series", () => {
    expect(heatmapColumns([])).toEqual([]);
  });

  it("buckets days into ISO week columns, oldest first, Monday at row 0", () => {
    // 2026-08-03 is a Monday; 2026-08-09 the Sunday that closes that week.
    const cols = heatmapColumns([day("2026-08-09"), day("2026-08-03"), day("2026-07-27")]);
    expect(cols.map((c) => c.weekStart)).toEqual(["2026-07-27", "2026-08-03"]);
    expect(cols[1]!.days[0]).toEqual(day("2026-08-03"));
    expect(cols[1]!.days[6]).toEqual(day("2026-08-09"));
  });

  it("leaves rows with no day as null rather than shifting later days up", () => {
    const cols = heatmapColumns([day("2026-08-05")]); // a Wednesday
    expect(cols).toHaveLength(1);
    expect(cols[0]!.days).toHaveLength(7);
    expect(cols[0]!.days[2]).toEqual(day("2026-08-05"));
    expect(cols[0]!.days.filter(Boolean)).toHaveLength(1);
  });

  it("keeps only the most recent maxColumns weeks", () => {
    const cols = heatmapColumns(
      [day("2026-06-01"), day("2026-06-08"), day("2026-06-15"), day("2026-06-22")],
      2,
    );
    expect(cols.map((c) => c.weekStart)).toEqual(["2026-06-15", "2026-06-22"]);
  });
});

describe("newMonthColumns", () => {
  it("marks the first column and every column that opens a new month", () => {
    const cols = [
      { weekStart: "2026-07-20" },
      { weekStart: "2026-07-27" },
      { weekStart: "2026-08-03" },
      { weekStart: "2026-08-10" },
      { weekStart: "2026-08-31" },
      { weekStart: "2026-09-07" },
    ];
    expect(newMonthColumns(cols)).toEqual([0, 2, 5]);
  });

  it("returns nothing for no columns", () => {
    expect(newMonthColumns([])).toEqual([]);
  });
});

describe("inProgressColumnIndex", () => {
  const col = (weekStart: string, statuses: Array<string | null>) => ({
    weekStart,
    days: statuses.map((s) => (s === null ? null : { date: weekStart, status: s })),
  });

  it("finds the last week that mixes resolved days with still-future ones", () => {
    const cols = [
      col("2026-07-27", ["completed", "rest", "completed", "rest", "completed", "rest", "completed"]),
      col("2026-08-03", ["completed", "rest", "pending", "future", "future", "future", "future"]),
    ];
    expect(inProgressColumnIndex(cols)).toBe(1);
  });

  it("returns -1 when every week is fully resolved", () => {
    const cols = [col("2026-07-27", ["completed", null, null, null, null, null, null])];
    expect(inProgressColumnIndex(cols)).toBe(-1);
  });

  it("returns -1 for a wholly future week (nothing is in progress yet)", () => {
    const cols = [col("2026-08-10", ["future", "future", "future", null, null, null, null])];
    expect(inProgressColumnIndex(cols)).toBe(-1);
  });
});

describe("currentStreak", () => {
  // Ascending, one entry per calendar day — the shape ConsistencyReport.days
  // actually produces. The date values themselves don't matter to the
  // function (it walks array order, not parsed dates); they're here for
  // readability only.
  const days = (...statuses: string[]) =>
    statuses.map((status, i) => ({ date: `2026-08-${String(i + 1).padStart(2, "0")}`, status }));

  it("counts consecutive completed days ending at the most recent one", () => {
    expect(currentStreak(days("completed", "completed", "completed"))).toBe(3);
  });

  it("counts moved the same as completed", () => {
    expect(currentStreak(days("completed", "moved", "completed"))).toBe(3);
  });

  it("returns 0 for an empty list", () => {
    expect(currentStreak([])).toBe(0);
  });

  it("returns 0 when nothing has ever resolved (all future/none)", () => {
    expect(currentStreak(days("none", "future", "future"))).toBe(0);
  });

  it("skips trailing future days to start counting from the last real day", () => {
    // This week isn't over: the grid pads out to the end of the ISO week with
    // "future" cells. Those shouldn't zero out an otherwise-live streak.
    expect(currentStreak(days("completed", "completed", "future", "future"))).toBe(2);
  });

  it("skips a trailing 'none' the same way (no entry yet today)", () => {
    expect(currentStreak(days("completed", "completed", "none"))).toBe(2);
  });

  describe("rest days", () => {
    it("do not break a streak that spans one", () => {
      expect(currentStreak(days("completed", "rest", "completed"))).toBe(2);
    });

    it("do not extend the streak by themselves", () => {
      expect(currentStreak(days("rest", "rest"))).toBe(0);
    });

    it("at the walk's start are skipped over to reach the last real day", () => {
      expect(currentStreak(days("completed", "completed", "rest"))).toBe(2);
    });
  });

  describe("a missed or skipped day breaks the streak", () => {
    it("as the most recent day, the streak is 0 even though earlier days were completed", () => {
      expect(currentStreak(days("completed", "completed", "missed"))).toBe(0);
      expect(currentStreak(days("completed", "completed", "skipped"))).toBe(0);
    });

    it("further back, it stops the walk without erasing the days already counted", () => {
      // completed, MISSED, completed, completed — only the trailing pair
      // counts; the walk never reaches the completed day before the break.
      expect(currentStreak(days("completed", "missed", "completed", "completed"))).toBe(2);
    });
  });

  describe("a pending day", () => {
    it("ends the walk without breaking — it stops counting, but doesn't zero what's already tallied", () => {
      // pending, completed, completed — the trailing two are counted; the
      // pending day (unresolved sync, not a known outcome) just stops the
      // walk one day early rather than resetting to 0.
      expect(currentStreak(days("pending", "completed", "completed"))).toBe(2);
    });

    it("as the most recent day on its own gives a streak of 0 (nothing counted yet)", () => {
      expect(currentStreak(days("completed", "completed", "pending"))).toBe(0);
    });
  });

  it("a historical 'none' before the plan existed also stops the walk", () => {
    expect(currentStreak(days("none", "completed", "completed"))).toBe(2);
  });
});

describe("outcomeSegments", () => {
  const base = { completed: 0, moved: 0, pending: 0, skipped: 0, missed: 0, planned: 0 };

  it("splits completed into on-plan and moved, and omits zero-count segments", () => {
    const segs = outcomeSegments({ ...base, completed: 8, moved: 3, planned: 8 }, 102);
    expect(segs.map((s) => s.kind)).toEqual(["completed", "moved"]);
    expect(segs.map((s) => s.count)).toEqual([5, 3]);
  });

  it("subtracts a 2px gap between each pair of segments", () => {
    const segs = outcomeSegments({ ...base, completed: 5, missed: 5, planned: 10 }, 102);
    expect(segs.map((s) => s.width)).toEqual([50, 50]);
    expect(segs.map((s) => s.x)).toEqual([0, 52]);
  });

  it("accounts for the unresolved remainder as upcoming rather than inflating the bar", () => {
    const segs = outcomeSegments({ ...base, completed: 5, planned: 10 }, 102);
    expect(segs.map((s) => s.kind)).toEqual(["completed", "upcoming"]);
    expect(segs.map((s) => s.count)).toEqual([5, 5]);
  });

  it("never claims more than the plan when the counts exceed it", () => {
    const segs = outcomeSegments({ ...base, completed: 6, missed: 6, planned: 4 }, 102);
    expect(segs.map((s) => s.kind)).toEqual(["completed", "missed"]);
    expect(segs.map((s) => s.width)).toEqual([50, 50]);
  });

  it("gives a sub-2px nonzero segment a 2px minimum, taken from the segments that can spare it", () => {
    const segs = outcomeSegments({ ...base, completed: 99, missed: 1, planned: 100 }, 102);
    expect(segs.map((s) => s.width)).toEqual([98, 2]);
    expect(segs[1]!.x).toBe(100);
  });

  it("returns nothing when there is no plan at all", () => {
    expect(outcomeSegments(base, 102)).toEqual([]);
  });

  it("keeps every segment inside the given width", () => {
    const segs = outcomeSegments(
      { completed: 48, moved: 6, pending: 2, skipped: 4, missed: 3, planned: 63 },
      560,
    );
    const last = segs[segs.length - 1]!;
    expect(last.x + last.width).toBeLessThanOrEqual(560 + 1e-9);
  });
});

describe("stackedBarSegments", () => {
  it("subtracts the surface gap from the upper segment, not the total height", () => {
    const segs = stackedBarSegments({ low: 40, high: 20 }, 100);
    expect(segs).toEqual([
      { key: "low", y: 60, height: 40 },
      { key: "high", y: 40, height: 18 },
    ]);
  });

  it("does not carve a gap when there is only one segment", () => {
    expect(stackedBarSegments({ low: 0, high: 20 }, 100)).toEqual([
      { key: "high", y: 80, height: 20 },
    ]);
    expect(stackedBarSegments({ low: 20, high: 0 }, 100)).toEqual([
      { key: "low", y: 80, height: 20 },
    ]);
  });

  it("draws nothing for a week with no training", () => {
    expect(stackedBarSegments({ low: 0, high: 0 }, 100)).toEqual([]);
  });

  it("floors a nonzero-but-tiny segment at 2px so it never disappears", () => {
    const segs = stackedBarSegments({ low: 40, high: 1 }, 100);
    expect(segs[1]).toEqual({ key: "high", y: 56, height: 2 });
  });
});

describe("divergingDomain", () => {
  it("covers the data and the center line", () => {
    const d = divergingDomain([150, 160], 155);
    expect(d.lo).toBeLessThanOrEqual(150);
    expect(d.hi).toBeGreaterThanOrEqual(160);
  });

  it("pulls the center inside the domain even when every value sits on one side", () => {
    const d = divergingDomain([140, 145], 155);
    expect(d.lo).toBeLessThan(140);
    expect(d.hi).toBeGreaterThan(155);
  });

  it("gives a flat series a real span instead of a zero-height axis", () => {
    const d = divergingDomain([155], 155);
    expect(d.hi - d.lo).toBeGreaterThan(0);
    expect(d.lo).toBeLessThan(155);
    expect(d.hi).toBeGreaterThan(155);
  });
});

describe("symmetricHalfExtent", () => {
  it("returns the largest distance from the center, so both sides share a scale", () => {
    expect(symmetricHalfExtent([-12, 5, 3])).toBe(12);
    expect(symmetricHalfExtent([2, 9])).toBe(9);
  });

  it("never returns zero (an all-zero series still needs an axis)", () => {
    expect(symmetricHalfExtent([])).toBe(1);
    expect(symmetricHalfExtent([0, 0])).toBe(1);
  });
});

describe("monthStartDates", () => {
  it("returns the earliest charted date in each month", () => {
    expect(
      monthStartDates(["2026-05-28", "2026-05-30", "2026-06-01", "2026-06-15", "2026-07-02"]),
    ).toEqual(["2026-05-28", "2026-06-01", "2026-07-02"]);
  });

  it("handles unsorted input and a year boundary", () => {
    expect(monthStartDates(["2027-01-03", "2026-12-30", "2026-12-28"])).toEqual([
      "2026-12-28",
      "2027-01-03",
    ]);
  });

  it("returns nothing for no dates", () => {
    expect(monthStartDates([])).toEqual([]);
  });
});

describe("roundedTopBarPath", () => {
  it("rounds the data end and leaves the baseline square", () => {
    expect(roundedTopBarPath(0, 0, 10, 20, 3)).toBe("M0,20 L0,3 Q0,0 3,0 L7,0 Q10,0 10,3 L10,20 Z");
  });

  it("clamps the radius so a short bar never inverts", () => {
    expect(roundedTopBarPath(0, 0, 10, 1, 3)).toBe("M0,1 L0,1 Q0,0 1,0 L9,0 Q10,0 10,1 L10,1 Z");
  });
});

describe("verticalBarPath", () => {
  it("rounds the bottom for a bar that hangs below its reference line", () => {
    expect(verticalBarPath(0, 0, 10, 20, 3, { bottom: true })).toBe(
      "M0,17 L0,0 L10,0 L10,17 Q10,20 7,20 L3,20 Q0,20 0,17 Z",
    );
  });

  it("leaves both ends square when neither is a data end", () => {
    expect(verticalBarPath(0, 0, 10, 20, 3, {})).toBe("M0,20 L0,0 L10,0 L10,20 Z");
  });

  it("clamps the radius to half the height when both ends round", () => {
    expect(verticalBarPath(0, 0, 10, 4, 6, { top: true, bottom: true })).toBe(
      "M0,2 L0,2 Q0,0 2,0 L8,0 Q10,0 10,2 L10,2 Q10,4 8,4 L2,4 Q0,4 0,2 Z",
    );
  });
});

describe("horizontalBarPath", () => {
  it("rounds only the requested ends", () => {
    expect(horizontalBarPath(0, 0, 20, 12, 3, { left: false, right: false })).toBe(
      "M0,0 L20,0 L20,12 L0,12 Z",
    );
    expect(horizontalBarPath(0, 0, 20, 12, 3, { left: false, right: true })).toBe(
      "M0,0 L17,0 Q20,0 20,3 L20,9 Q20,12 17,12 L0,12 Z",
    );
  });

  it("keeps the straight left edge when the radius is smaller than half the height", () => {
    // rr (3) < h/2 (6): without the L between the two corner arcs the left
    // edge bows inward into a half-pill instead of a rounded rectangle.
    expect(horizontalBarPath(0, 0, 20, 12, 3, { left: true, right: false })).toBe(
      "M3,0 L20,0 L20,12 L3,12 Q0,12 0,9 L0,3 Q0,0 3,0 Z",
    );
  });

  it("clamps the radius to half the height of a thin bar", () => {
    expect(horizontalBarPath(0, 0, 20, 4, 6, { left: true, right: false })).toBe(
      "M2,0 L20,0 L20,4 L2,4 Q0,4 0,2 L0,2 Q0,0 2,0 Z",
    );
  });
});
