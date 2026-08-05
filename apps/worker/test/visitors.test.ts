import { describe, expect, it } from "vitest";
import { addDays } from "@rg/domain";
import type { CompletedRunInput } from "@rg/garden-engine";
import { visitorForDate, type VisitorDayRuns } from "../src/services/visitors.js";

const run = (category: string, extra: Partial<CompletedRunInput> = {}): CompletedRunInput => ({
  workoutId: `w-${category}`,
  category: category as CompletedRunInput["category"],
  ...extra,
});

/** Spread `cats` as one run per day across the 7 days ending at `end`. */
function weekOf(end: string, cats: string[]): VisitorDayRuns[] {
  return cats.map((c, i) => ({ date: addDays(end, -i - 0), runs: [run(c)] }));
}

const DATES = Array.from({ length: 90 }, (_, i) => addDays("2026-05-01", i));

describe("visitorForDate", () => {
  it("no running, no visitors — ever", () => {
    for (const date of DATES) {
      expect(visitorForDate(date, "summer", [])).toBeNull();
    }
  });

  it("is deterministic", () => {
    const days = weekOf("2026-05-10", ["long", "easy", "easy"]);
    expect(visitorForDate("2026-05-10", "summer", days)).toBe(
      visitorForDate("2026-05-10", "summer", days),
    );
  });

  it("a long-run week can draw a deer — and only a deer", () => {
    const results = DATES.map((date) =>
      visitorForDate(date, "summer", weekOf(date, ["long", "easy", "easy"])),
    ).filter((v) => v !== null);
    expect(results.length).toBeGreaterThan(0); // the seeded roll lands sometimes
    expect(results.length).toBeLessThan(DATES.length); // …and passes quietly most days
    expect(new Set(results)).toEqual(new Set(["deer"]));
  });

  it("the heron demands a real recovery week after hard training", () => {
    // Recovery-shaped week with NO hard weeks before it: never a heron.
    const soloRecovery = DATES.map((date) =>
      visitorForDate(date, "summer", weekOf(date, ["easy", "recovery"])),
    );
    expect(soloRecovery.every((v) => v !== "heron")).toBe(true);

    // The same recovery week after two hard weeks: the heron can come.
    const withHardBlock = DATES.map((date) => {
      const days = [
        ...weekOf(date, ["easy", "recovery"]),
        // week -1 and week -2: two hard sessions each
        { date: addDays(date, -8), runs: [run("quality")] },
        { date: addDays(date, -10), runs: [run("long")] },
        { date: addDays(date, -15), runs: [run("quality")] },
        { date: addDays(date, -17), runs: [run("quality")] },
      ];
      return visitorForDate(date, "summer", days);
    }).filter((v) => v !== null);
    expect(withHardBlock.length).toBeGreaterThan(0);
    expect(new Set(withHardBlock)).toEqual(new Set(["heron"]));
  });

  it("running after dark can bring the owl", () => {
    const results = DATES.map((date) =>
      visitorForDate(date, "summer", [
        { date: addDays(date, -1), runs: [run("easy", { startHourLocal: 21 })] },
      ]),
    ).filter((v) => v !== null);
    expect(results.length).toBeGreaterThan(0);
    expect(new Set(results)).toEqual(new Set(["owl"]));
  });

  it("the fox needs autumn", () => {
    const days = (date: string): VisitorDayRuns[] => [
      { date: addDays(date, -1), runs: [run("quality")] },
    ];
    const summer = DATES.map((d) => visitorForDate(d, "summer", days(d)));
    expect(summer.every((v) => v !== "fox")).toBe(true);
    const autumn = DATES.map((d) => visitorForDate(d, "autumn", days(d))).filter(
      (v) => v !== null,
    );
    expect(autumn.length).toBeGreaterThan(0);
    expect(autumn.every((v) => v === "fox")).toBe(true);
  });

  it("strength and yoga sessions never count as runs", () => {
    for (const date of DATES.slice(0, 30)) {
      const days: VisitorDayRuns[] = [
        { date: addDays(date, -1), runs: [run("long", { discipline: "strength" })] },
        { date: addDays(date, -2), runs: [run("easy", { discipline: "yoga" })] },
        { date: addDays(date, -3), runs: [run("easy", { discipline: "strength" })] },
      ];
      expect(visitorForDate(date, "summer", days)).toBeNull();
    }
  });
});
