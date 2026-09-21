/**
 * Selectors (spec: 2026-09-20-coach-plan-management-design.md §2).
 *
 * A selector names workouts by property or by id, and `expandSelectors`
 * rewrites selector ops into the ordinary ops the rest of the pipeline
 * already understands. Everything downstream — describeOps, validateOps,
 * applyOps — is untouched, so these tests are where the whole abstraction is
 * pinned down.
 */
import { describe, expect, it } from "vitest";
import { expandSelectors, describeSelector } from "../src/coach-selectors.js";
import { coachAuthoredOpSchema } from "../src/coach.js";
import type { GuardrailWorkout } from "../src/coach-guardrails.js";

const TODAY = "2026-09-20";

/** Mon 21st lift, Tue 22nd easy run, Thu 24th lift, Sat 26th long run. */
function calendar(over: Partial<GuardrailWorkout>[] = []): GuardrailWorkout[] {
  const base: GuardrailWorkout[] = [
    { id: "l1", date: "2026-09-21", title: "Lower Body", category: "strength", completionState: "scheduled", durationMinutes: 45, discipline: "strength" },
    { id: "r1", date: "2026-09-22", title: "Easy 40", category: "easy", completionState: "scheduled", durationMinutes: 40, discipline: "run" },
    { id: "l2", date: "2026-09-24", title: "Upper Body", category: "strength", completionState: "scheduled", durationMinutes: 45, discipline: "strength" },
    { id: "r2", date: "2026-09-26", title: "Long Run", category: "long", completionState: "scheduled", durationMinutes: 90, discipline: "run" },
  ];
  return [...base, ...(over as GuardrailWorkout[])];
}

describe("expandSelectors · by match", () => {
  it("moves only the matching discipline, leaving the rest alone", () => {
    const out = expandSelectors(
      [{ kind: "moveEach", select: { by: "match", from: "2026-09-21", to: "2026-11-01", discipline: "strength" }, shiftDays: 7 }],
      calendar(),
      TODAY,
    );
    expect(out.empty).toEqual([]);
    expect(out.ops).toEqual([
      { kind: "move", workoutId: "l1", toDate: "2026-09-28" },
      { kind: "move", workoutId: "l2", toDate: "2026-10-01" },
    ]);
  });

  it("carries toTime through to every resolved move", () => {
    const out = expandSelectors(
      [{ kind: "moveEach", select: { by: "match", from: "2026-09-21", to: "2026-09-30", discipline: "run" }, shiftDays: 0, toTime: "17:30" }],
      calendar(),
      TODAY,
    );
    expect(out.ops).toEqual([
      { kind: "move", workoutId: "r1", toDate: "2026-09-22", toTime: "17:30" },
      { kind: "move", workoutId: "r2", toDate: "2026-09-26", toTime: "17:30" },
    ]);
  });

  it("filters by category and by title substring, case-insensitively", () => {
    const byCategory = expandSelectors(
      [{ kind: "skipEach", select: { by: "match", from: TODAY, to: "2026-10-01", category: "long" }, reason: "travelling" }],
      calendar(),
      TODAY,
    );
    expect(byCategory.ops).toEqual([{ kind: "skip", workoutId: "r2", reason: "travelling" }]);

    const byTitle = expandSelectors(
      [{ kind: "skipEach", select: { by: "match", from: TODAY, to: "2026-10-01", titleContains: "upper" }, reason: "travelling" }],
      calendar(),
      TODAY,
    );
    expect(byTitle.ops).toEqual([{ kind: "skip", workoutId: "l2", reason: "travelling" }]);
  });

  it("clears a date range regardless of discipline — the travel-weekend shape", () => {
    const out = expandSelectors(
      [{ kind: "removeEach", select: { by: "match", from: "2026-09-24", to: "2026-09-26" } }],
      calendar(),
      TODAY,
    );
    expect(out.ops).toEqual([
      { kind: "remove", workoutId: "l2" },
      { kind: "remove", workoutId: "r2" },
    ]);
  });
});

describe("expandSelectors · by ids", () => {
  it("resolves an explicit id list in calendar order", () => {
    const out = expandSelectors(
      [{ kind: "skipEach", select: { by: "ids", ids: ["r2", "l1"] }, reason: "rest" }],
      calendar(),
      TODAY,
    );
    expect(out.ops.map((o) => (o as { workoutId: string }).workoutId)).toEqual(["l1", "r2"]);
  });

  it("silently drops an id that is not on the calendar, and reports nothing if some matched", () => {
    const out = expandSelectors(
      [{ kind: "skipEach", select: { by: "ids", ids: ["l1", "ghost"] }, reason: "rest" }],
      calendar(),
      TODAY,
    );
    expect(out.ops).toEqual([{ kind: "skip", workoutId: "l1", reason: "rest" }]);
    expect(out.empty).toEqual([]);
  });
});

describe("expandSelectors · what a selector may never reach", () => {
  it("skips resolved and past sessions, so a selector cannot resolve onto a fatal op", () => {
    const cal = calendar([
      { id: "done", date: "2026-09-19", title: "Yesterday", category: "easy", completionState: "completed", durationMinutes: 40, discipline: "run" },
      { id: "gone", date: "2026-09-18", title: "Older", category: "easy", completionState: "scheduled", durationMinutes: 40, discipline: "run" },
    ]);
    const out = expandSelectors(
      [{ kind: "skipEach", select: { by: "match", from: "2026-09-01", to: "2026-10-01", discipline: "run" }, reason: "x" }],
      cal,
      TODAY,
    );
    expect(out.ops.map((o) => (o as { workoutId: string }).workoutId)).toEqual(["r1", "r2"]);
  });

  it("restoreEach reaches skipped future sessions and nothing else", () => {
    const cal = calendar([
      { id: "sk", date: "2026-09-25", title: "Skipped", category: "easy", completionState: "skipped", durationMinutes: 40, discipline: "run" },
    ]);
    const out = expandSelectors(
      [{ kind: "restoreEach", select: { by: "match", from: TODAY, to: "2026-10-01" } }],
      cal,
      TODAY,
    );
    expect(out.ops).toEqual([{ kind: "restore", workoutId: "sk" }]);
  });

  it("reports a selector that matched nothing instead of proposing an empty card", () => {
    const out = expandSelectors(
      [{ kind: "moveEach", select: { by: "match", from: "2026-09-21", to: "2026-11-01", discipline: "yoga" }, shiftDays: 7 }],
      calendar(),
      TODAY,
    );
    expect(out.ops).toEqual([]);
    expect(out.empty).toHaveLength(1);
    expect(out.empty[0]!.opIndex).toBe(0);
    expect(out.empty[0]!.detail).toContain("no yoga sessions");
  });
});

describe("expandSelectors · a selector may not PRODUCE a fatal op", () => {
  /*
   * Found by the survival harness, not by hand: a negative `shiftDays` moves
   * a session backwards, and for the earliest sessions in the range that
   * destination is yesterday. `past_date` is fatal, so two plausible plans in
   * 800 lost EVERY op over one session that could not move — the same
   * all-or-nothing failure the fatal/advisory split exists to prevent,
   * reintroduced through the resolver.
   */
  it("drops the moves that would land in the past and keeps the rest", () => {
    const out = expandSelectors(
      [{ kind: "moveEach", select: { by: "match", from: TODAY, to: "2026-10-01", discipline: "run" }, shiftDays: -3 }],
      calendar(),
      TODAY,
    );
    // r1 is 22 Sep: −3 days is the 19th, already gone. r2 survives.
    expect(out.ops).toEqual([{ kind: "move", workoutId: "r2", toDate: "2026-09-23" }]);
    expect(out.empty).toEqual([]);
  });

  it("reports the selector as empty when nothing could move at all", () => {
    const out = expandSelectors(
      [{ kind: "moveEach", select: { by: "ids", ids: ["r1"] }, shiftDays: -5 }],
      calendar(),
      TODAY,
    );
    expect(out.ops).toEqual([]);
    expect(out.empty).toHaveLength(1);
  });
});

describe("expandSelectors · composition", () => {
  it("resolves every selector against the SAME snapshot, so op order cannot change the result", () => {
    // Shifting the lifts +7 would move l1 from 21 Sep to 28 Sep. If the
    // second selector saw that result, it would match l1 too.
    const ops = [
      { kind: "moveEach" as const, select: { by: "match" as const, from: "2026-09-21", to: "2026-09-24", discipline: "strength" as const }, shiftDays: 7 },
      { kind: "skipEach" as const, select: { by: "match" as const, from: "2026-09-27", to: "2026-10-02" }, reason: "away" },
    ];
    const forward = expandSelectors(ops, calendar(), TODAY);
    const reversed = expandSelectors([ops[1]!, ops[0]!], calendar(), TODAY);

    expect(forward.empty).toHaveLength(1); // nothing is scheduled 27 Sep–2 Oct
    expect(forward.ops).toEqual([
      { kind: "move", workoutId: "l1", toDate: "2026-09-28" },
      { kind: "move", workoutId: "l2", toDate: "2026-10-01" },
    ]);
    expect(reversed.ops).toEqual(forward.ops);
  });

  it("passes ordinary ops through untouched and in place", () => {
    const out = expandSelectors(
      [
        { kind: "skip", workoutId: "r1", reason: "sick" },
        { kind: "removeEach", select: { by: "ids", ids: ["l1"] } },
      ],
      calendar(),
      TODAY,
    );
    expect(out.ops).toEqual([
      { kind: "skip", workoutId: "r1", reason: "sick" },
      { kind: "remove", workoutId: "l1" },
    ]);
  });
});

describe("expandSelectors · adjustEach", () => {
  it("shortens by a delta, clamping at the schema floor rather than going negative", () => {
    const out = expandSelectors(
      [{ kind: "adjustEach", select: { by: "match", from: TODAY, to: "2026-10-01", discipline: "run" }, durationDeltaMinutes: -10 }],
      calendar(),
      TODAY,
    );
    expect(out.ops).toEqual([
      { kind: "adjust", workoutId: "r1", durationMinutes: 30 },
      { kind: "adjust", workoutId: "r2", durationMinutes: 80 },
    ]);
  });

  it("scales proportionally and rounds to whole minutes", () => {
    const out = expandSelectors(
      [{ kind: "adjustEach", select: { by: "ids", ids: ["r2"] }, durationScale: 0.75 }],
      calendar(),
      TODAY,
    );
    expect(out.ops).toEqual([{ kind: "adjust", workoutId: "r2", durationMinutes: 68 }]);
  });

  it("drops a session whose duration would not change, rather than writing a no-op", () => {
    const out = expandSelectors(
      [{ kind: "adjustEach", select: { by: "ids", ids: ["r1"] }, durationScale: 1 }],
      calendar(),
      TODAY,
    );
    expect(out.ops).toEqual([]);
    expect(out.empty).toHaveLength(1);
  });
});

describe("the selector schema", () => {
  it("accepts both addressing modes and rejects a mixed one", () => {
    expect(
      coachAuthoredOpSchema.safeParse({ kind: "removeEach", select: { by: "ids", ids: ["wo1"] } }).success,
    ).toBe(true);
    expect(
      coachAuthoredOpSchema.safeParse({
        kind: "removeEach",
        select: { by: "match", from: "2026-09-21", to: "2026-10-01", discipline: "strength" },
      }).success,
    ).toBe(true);
    // `by: "ids"` carrying match fields is the ambiguity the discriminated
    // union exists to prevent (see the `date`/`dates` note in coach.ts).
    expect(
      coachAuthoredOpSchema.safeParse({
        kind: "removeEach",
        select: { by: "ids", ids: ["wo1"], discipline: "strength" },
      }).success,
    ).toBe(false);
  });

  it("requires both date bounds on a match selector — no selector means 'everything'", () => {
    expect(
      coachAuthoredOpSchema.safeParse({
        kind: "removeEach",
        select: { by: "match", discipline: "strength" },
      }).success,
    ).toBe(false);
  });

  it("requires exactly one of the two adjust forms", () => {
    const sel = { by: "ids", ids: ["wo1"] };
    expect(coachAuthoredOpSchema.safeParse({ kind: "adjustEach", select: sel, durationScale: 0.8 }).success).toBe(true);
    expect(coachAuthoredOpSchema.safeParse({ kind: "adjustEach", select: sel }).success).toBe(false);
    expect(
      coachAuthoredOpSchema.safeParse({ kind: "adjustEach", select: sel, durationScale: 0.8, durationDeltaMinutes: -5 })
        .success,
    ).toBe(false);
  });
});

describe("describeSelector", () => {
  it("renders a match selector as the intent the athlete reads", () => {
    expect(
      describeSelector({ by: "match", from: "2026-09-22", to: "2026-11-01", discipline: "strength" }),
    ).toBe("every strength session, 22 Sep – 1 Nov");
    expect(describeSelector({ by: "match", from: "2026-09-24", to: "2026-09-26" })).toBe(
      "everything scheduled 24 – 26 Sep",
    );
  });

  it("renders an id selector by count, since ids mean nothing to a reader", () => {
    expect(describeSelector({ by: "ids", ids: ["a", "b", "c"] })).toBe("3 chosen sessions");
    expect(describeSelector({ by: "ids", ids: ["a"] })).toBe("1 chosen session");
  });
});
