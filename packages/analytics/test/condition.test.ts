/**
 * The condition trend (Phase 2d Task 3; spec §2d "Progress": pre vs post over 8 weeks, flare days, insufficient
 * data below 4 paired sessions). Review Focus 4: with one paired before/after check the tile can only say it needs
 * more sessions — never a trend. The flare rule is the profile's, passed in; nothing here names a condition.
 */
import { describe, expect, it } from "vitest";
import { conditionTrend, MIN_CONDITION_PAIRS, type ConditionReading, type ConditionSession } from "../src/condition.js";

/** A Wednesday: this week starts Monday 2026-10-12; eight weeks back is Monday 2026-08-24. */
const TODAY = "2026-10-14";
/** A stand-in profile rule: a reading of 5 or more is a flare. */
const isFlare = (r: { pre: number | null }) => r.pre !== null && r.pre >= 5;

const s = (date: string, pre: number | null, post: number | null): ConditionSession => ({ date, pre, post });
const reading = (date: string, value: number | null, feelingOff = false): ConditionReading => ({ date, value, feelingOff });

describe("conditionTrend", () => {
  it("Review Focus 4: a week with only one paired check says how many more sessions it needs — no means, no line", () => {
    const r = conditionTrend({ sessions: [s("2026-10-13", 3, 1)], readings: [reading("2026-10-13", 3)], isFlare }, TODAY);
    expect(r).toEqual({ status: "insufficient_data", needed: MIN_CONDITION_PAIRS, have: 1, explanation: expect.any(String) });
    expect(MIN_CONDITION_PAIRS).toBe(4);
    expect("value" in r).toBe(false);
  });

  it("counts only sessions with both a before and an after, inside the eight weeks", () => {
    const r = conditionTrend(
      {
        sessions: [
          s("2026-10-13", 3, 1),
          s("2026-10-12", 2, null),
          s("2026-10-06", null, 1),
          s("2026-09-30", 4, 2),
          s("2026-09-29", 2, 2),
          s("2026-08-23", 5, 1), // the Sunday before the window
        ],
        readings: [],
        isFlare,
      },
      TODAY,
    );
    expect(r).toMatchObject({ status: "insufficient_data", needed: 4, have: 3 });
  });

  it("from four pairs: the before and after means, a weekly line of each, and the flare days by the profile's rule", () => {
    const r = conditionTrend(
      {
        sessions: [s("2026-08-25", 4, 2), s("2026-09-02", 2, 2), s("2026-10-05", 3, 1), s("2026-10-13", 1, 0), s("2026-10-14", 6, null)],
        readings: [
          reading("2026-08-20", 7), // before the window
          reading("2026-09-02", 5),
          reading("2026-09-02", 6), // the same day twice is one flare day
          reading("2026-10-05", 3),
          reading("2026-10-14", 6),
          reading("2026-10-10", null, true), // feeling off is not a flare by this rule
        ],
        isFlare,
      },
      TODAY,
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.pairs).toBe(4);
    expect(r.value.preMean).toBe(2.5);
    expect(r.value.postMean).toBe(1.3);
    expect(r.value.flareDays).toBe(2);
    expect(r.value.weeks).toHaveLength(8);
    expect(r.value.weeks.map((w) => [w.weekStart, w.pre, w.post])).toEqual([
      ["2026-08-24", 4, 2],
      ["2026-08-31", 2, 2],
      ["2026-09-07", null, null],
      ["2026-09-14", null, null],
      ["2026-09-21", null, null],
      ["2026-09-28", null, null],
      ["2026-10-05", 3, 1],
      ["2026-10-12", 1, 0],
    ]);
    expect(r.sampleSize).toBe(4);
  });

  it("a week's point is the mean of its pairs", () => {
    const r = conditionTrend(
      { sessions: [s("2026-10-12", 3, 2), s("2026-10-13", 2, 0), s("2026-10-14", 2, 1), s("2026-10-06", 4, 4)], readings: [], isFlare },
      TODAY,
    );
    expect(r.status === "ok" && r.value.weeks.at(-1)).toEqual({ weekStart: "2026-10-12", pre: 2.3, post: 1 });
  });
});
