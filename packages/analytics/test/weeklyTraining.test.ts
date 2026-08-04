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

  it("extends through the current week: a layoff emits zero weeks, a partial row, and a 0 average", () => {
    // Six trained weeks (2026-03-02 … 2026-04-06), then nothing. "Today" is
    // 2026-05-12, in the ISO week starting 2026-05-11 — five weeks after the
    // last run. Before the fix, `weeks` stopped at 2026-04-06: no zero bars,
    // no partial row, and `fourWeekAvgDuration` was the mean of the last four
    // weeks TRAINED (5400s = 1.5h) while the runner had done nothing for over
    // a month.
    const report = computeWeeklyTraining(
      [
        mkActivity({ id: "a1", startTimeLocal: "2026-03-02T07:00:00", durationSeconds: 3600 }),
        mkActivity({ id: "a2", startTimeLocal: "2026-03-09T07:00:00", durationSeconds: 3600 }),
        mkActivity({ id: "a3", startTimeLocal: "2026-03-16T07:00:00", durationSeconds: 3600 }),
        mkActivity({ id: "a4", startTimeLocal: "2026-03-23T07:00:00", durationSeconds: 7200 }),
        mkActivity({ id: "a5", startTimeLocal: "2026-03-30T07:00:00", durationSeconds: 7200 }),
        mkActivity({ id: "a6", startTimeLocal: "2026-04-06T07:00:00", durationSeconds: 7200 }),
      ],
      {},
      { today: "2026-05-12" },
    );

    // 6 trained + 4 silent complete weeks + the partial current week.
    expect(report.weeks.map((w) => w.weekStart)).toEqual([
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
      "2026-03-23",
      "2026-03-30",
      "2026-04-06",
      "2026-04-13",
      "2026-04-20",
      "2026-04-27",
      "2026-05-04",
      "2026-05-11",
    ]);
    // Only the current week is partial; the silent weeks in between are over.
    expect(report.weeks.filter((w) => w.partial).map((w) => w.weekStart)).toEqual(["2026-05-11"]);
    // Zero-week bars, not absent bars.
    expect(report.weeks.slice(6).every((w) => w.durationSeconds === 0 && w.runCount === 0)).toBe(true);
    // The four most recent COMPLETE weeks are all zero, so the average is too.
    expect(report.fourWeekAvgDuration).toBe(0);
  });

  it("does not extend backwards when the last activity is already in the current week", () => {
    const report = computeWeeklyTraining(
      [mkActivity({ id: "a1", startTimeLocal: "2026-05-13T07:00:00", durationSeconds: 3600 })],
      {},
      { today: "2026-05-12" }, // same ISO week (starts 2026-05-11) as the run
    );
    expect(report.weeks.map((w) => w.weekStart)).toEqual(["2026-05-11"]);
    expect(report.weeks[0]!.partial).toBe(true);
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
