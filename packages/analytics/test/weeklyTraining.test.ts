import { describe, expect, it } from "vitest";
import { computeWeeklyTraining } from "../src/weeklyTraining.js";
import { mkActivity } from "./builders.js";

describe("computeWeeklyTraining", () => {
  it("buckets a Sunday and the following Monday into different ISO weeks", () => {
    const report = computeWeeklyTraining(
      [
        // Sunday 2026-03-08 belongs to the week starting Monday 2026-03-02.
        mkActivity({ id: "sun", startTimeLocal: "2026-03-08T09:00:00", durationSeconds: 3000 }),
        // Monday 2026-03-09 starts the next ISO week.
        mkActivity({ id: "mon", startTimeLocal: "2026-03-09T07:00:00", durationSeconds: 2400 }),
      ],
      {},
    );
    expect(report.weeks.map((w) => w.weekStart)).toEqual(["2026-03-02", "2026-03-09"]);
    expect(report.weeks[0]!.durationSeconds).toBe(3000);
    expect(report.weeks[1]!.durationSeconds).toBe(2400);
  });

  it("splits easy vs quality seconds using the match-category map; unmatched counts as easy", () => {
    const report = computeWeeklyTraining(
      [
        mkActivity({
          id: "a1",
          startTimeLocal: "2026-03-03T07:00:00",
          durationSeconds: 3600,
          completionMatchId: "m1",
        }),
        mkActivity({ id: "a2", startTimeLocal: "2026-03-04T07:00:00", durationSeconds: 1800 }),
      ],
      { m1: "quality" },
    );
    const week = report.weeks[0]!;
    expect(week.qualitySeconds).toBe(3600);
    expect(week.easySeconds).toBe(1800);
    expect(week.runCount).toBe(2);
  });

  it("sums training load only where present", () => {
    const report = computeWeeklyTraining(
      [
        mkActivity({ id: "a1", startTimeLocal: "2026-03-03T07:00:00", trainingLoad: 55 }),
        mkActivity({ id: "a2", startTimeLocal: "2026-03-04T07:00:00" }),
      ],
      {},
    );
    expect(report.weeks[0]!.trainingLoad).toBe(55);
  });

  it("computes a 4-week average once 4 weeks exist, but no 12-week average", () => {
    const report = computeWeeklyTraining(
      [
        mkActivity({ id: "a1", startTimeLocal: "2026-03-02T07:00:00", durationSeconds: 3600 }),
        mkActivity({ id: "a2", startTimeLocal: "2026-03-09T07:00:00", durationSeconds: 3600 }),
        mkActivity({ id: "a3", startTimeLocal: "2026-03-16T07:00:00", durationSeconds: 7200 }),
        mkActivity({ id: "a4", startTimeLocal: "2026-03-23T07:00:00", durationSeconds: 7200 }),
      ],
      {},
    );
    expect(report.weeks).toHaveLength(4);
    expect(report.fourWeekAvgDuration).toBe(5400);
    expect(report.twelveWeekAvgDuration).toBeUndefined();
  });

  it("zero-fills gap weeks so averages stay honest", () => {
    const report = computeWeeklyTraining(
      [
        mkActivity({ id: "a1", startTimeLocal: "2026-03-02T07:00:00", durationSeconds: 6000 }),
        // no activity in the weeks of 03-09 or 03-16
        mkActivity({ id: "a2", startTimeLocal: "2026-03-23T07:00:00", durationSeconds: 6000 }),
      ],
      {},
    );
    expect(report.weeks).toHaveLength(4);
    expect(report.weeks[1]!.runCount).toBe(0);
    expect(report.fourWeekAvgDuration).toBe(3000);
  });

  it("returns no weeks and no averages for empty input", () => {
    const report = computeWeeklyTraining([], {});
    expect(report.weeks).toEqual([]);
    expect(report.fourWeekAvgDuration).toBeUndefined();
  });

  it("marks the week containing opts.today as partial and excludes it from the 4-week average", () => {
    const report = computeWeeklyTraining(
      [
        mkActivity({ id: "a1", startTimeLocal: "2026-03-02T07:00:00", durationSeconds: 3600 }),
        mkActivity({ id: "a2", startTimeLocal: "2026-03-09T07:00:00", durationSeconds: 3600 }),
        mkActivity({ id: "a3", startTimeLocal: "2026-03-16T07:00:00", durationSeconds: 7200 }),
        mkActivity({ id: "a4", startTimeLocal: "2026-03-23T07:00:00", durationSeconds: 7200 }),
        // 2026-03-31 is a Tuesday in the same ISO week as "today" below (mid-week).
        mkActivity({ id: "a5", startTimeLocal: "2026-03-31T07:00:00", durationSeconds: 1000 }),
      ],
      {},
      { today: "2026-04-01" },
    );
    expect(report.weeks).toHaveLength(5);
    expect(report.weeks.map((w) => w.partial)).toEqual([false, false, false, false, true]);
    // Average of the 4 complete weeks only — the partial current week is skipped.
    expect(report.fourWeekAvgDuration).toBe(5400);
  });

  it("uses intensityByActivity for low/high seconds when supplied, overriding the category fallback", () => {
    const report = computeWeeklyTraining(
      [
        mkActivity({
          id: "a1",
          startTimeLocal: "2026-03-03T07:00:00",
          durationSeconds: 1800,
          completionMatchId: "m1",
        }),
      ],
      { m1: "quality" }, // would default a1's whole duration to highSeconds without the override
      { intensityByActivity: { a1: { lowSeconds: 1200, highSeconds: 600 } } },
    );
    const week = report.weeks[0]!;
    expect(week.lowSeconds).toBe(1200);
    expect(week.highSeconds).toBe(600);
  });

  it("falls back to the category heuristic for low/high seconds when no intensity data is supplied", () => {
    const report = computeWeeklyTraining(
      [
        mkActivity({
          id: "a1",
          startTimeLocal: "2026-03-03T07:00:00",
          durationSeconds: 1800,
          completionMatchId: "m1",
        }),
        mkActivity({ id: "a2", startTimeLocal: "2026-03-04T07:00:00", durationSeconds: 900 }),
      ],
      { m1: "quality" },
      {},
    );
    const week = report.weeks[0]!;
    expect(week.highSeconds).toBe(1800); // quality match -> high
    expect(week.lowSeconds).toBe(900); // unmatched -> low
  });
});
