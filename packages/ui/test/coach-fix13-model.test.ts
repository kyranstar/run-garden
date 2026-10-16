/**
 * Task 13's fix wave, stream U — what the coach's screens decide without React: a suggestion's new fields read
 * tolerantly (§2.8, §2.9), a set's rows by day (D7), the other open suggestions (R2, §2.7), the review's new labels
 * (§2.10). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { ApiError, type DesignChangeLineDto, type DesignContextRowDto, type DesignLineDto } from "@rg/api-client";
import { alsoLine } from "../src/screens/studio/also-waiting.js";
import { toCurrent, toProposal } from "../src/screens/studio/coach-tolerance.js";
import { setCostLine } from "../src/screens/studio/composer.js";
import { cardRows, contextLine } from "../src/screens/studio/proposal-card.js";
import { estimateLine, REVIEW_LABELS, reviewLabel, WEEK_USED_UP_LINE, weekBudgetOf, weekBudgetRefusal } from "../src/screens/studio/run-model.js";

const line = (opId: string, date: string, time: string | null): DesignLineDto =>
  ({ opId, kind: "new", date, time, title: opId, minutes: 20, summary: "", effort: "", place: "", parts: [], detail: [], reviewMean: null, review: null, issues: [], outcome: null, written: null }) as DesignLineDto;
const change = (opId: string, date: string | null, time: string | null = null): DesignChangeLineDto =>
  ({ opId, kind: "skip", workoutId: "w", date, time, summary: opId, was: null, effect: null, why: "", issues: [], outcome: null }) as DesignChangeLineDto;
const ctx = (title: string, date: string, time: string | null): DesignContextRowDto => ({ date, time, kind: "run", title, minutes: 30 });
const said = (rows: ReturnType<typeof cardRows>) => rows.map((r) => r.line?.opId ?? r.change?.opId ?? `(${r.context!.title})`);

describe("a set's rows by day (D7)", () => {
  it("the plan's other sessions go among the suggestion's own rows: by day, and on a shared day by time", () => {
    const rows = cardRows(
      [change("skip-tue", "2026-10-20"), change("no-day", null)],
      [line("mon-am", "2026-10-19", "07:30"), line("mon-pm", "2026-10-19", "18:00"), line("wed", "2026-10-21", null)],
      [ctx("Mon noon run", "2026-10-19", "12:00"), ctx("Mon late run", "2026-10-19", "20:00"), ctx("Sun run", "2026-10-18", "08:00"), ctx("Tue untimed", "2026-10-20", null), ctx("Thu run", "2026-10-22", "06:00")],
    );
    expect(said(rows)).toEqual(["no-day", "(Sun run)", "mon-am", "(Mon noon run)", "mon-pm", "(Mon late run)", "skip-tue", "(Tue untimed)", "wed", "(Thu run)"]);
  });

  it("with no context, the rows are as they were: by day, a set's changes among its workouts", () => {
    const rows = cardRows([change("skip-fri", "2026-10-16")], [line("thu", "2026-10-15", "18:00"), line("sat", "2026-10-17", "09:00")], []);
    expect(said(rows)).toEqual(["thu", "skip-fri", "sat"]);
  });

  it("a row says its day and time, its title, its minutes when known, and that it is on the plan", () => {
    expect(contextLine({ date: "2026-10-18", time: "08:00", title: "Long run", minutes: 90 })).toBe("Sun 8 AM · Long run · 90 min · on your plan");
    expect(contextLine({ date: "2026-10-18", time: null, title: "Jaw care", minutes: null })).toBe("Sun · Jaw care · on your plan");
  });
});

describe("a suggestion's new fields, read tolerantly (§2.8, §2.9)", () => {
  const base = { opId: "op-a", date: "2026-10-15", detail: ["Cat-cow 1 × 8", "Glute bridge 2 × 12", "Dead bug 2 × 8"] };

  it("intent, whys and alternates pass; the whys and alternates fit the moves, one each", () => {
    const read = toProposal({
      id: "dp-1",
      status: "pending",
      lines: [
        {
          ...base,
          intent: "  Loosen the hips.  ",
          whys: ["Opens the spine.", "", 42],
          alternates: [[{ name: "Hip thrust", why: "heavier" }, { name: "", why: "no name" }, { why: "none" }], "not a list"],
        },
      ],
    });
    const l = read.lines![0]!;
    expect(l.intent).toBe("Loosen the hips.");
    expect(l.whys).toEqual(["Opens the spine.", null, null]);
    expect(l.alternates).toEqual([[{ name: "Hip thrust", why: "heavier" }], [], []]);
  });

  it("an older server's line: no intent (null), a null why and no alternate for each move, no atNow", () => {
    const l = toProposal({ id: "dp-1", status: "pending", lines: [base] }).lines![0]!;
    expect(l.intent).toBeNull();
    expect(l.whys).toEqual([null, null, null]);
    expect(l.alternates).toEqual([[], [], []]);
    expect("atNow" in l).toBe(false);
  });

  it("atNow only when the server says true", () => {
    expect(toProposal({ id: "dp-1", status: "pending", lines: [{ ...base, atNow: true }] }).lines![0]!.atNow).toBe(true);
    expect("atNow" in toProposal({ id: "dp-1", status: "pending", lines: [{ ...base, atNow: "yes" }] }).lines![0]!).toBe(false);
  });

  it("a set's context: rows with a day and a title; a time and minutes only when they can be read", () => {
    const read = toProposal({
      id: "dp-1",
      status: "pending",
      lines: [],
      context: [
        { date: "2026-10-18", time: "08:00", kind: "run", title: "Long run", minutes: 90 },
        { date: "2026-10-19", time: "soon", kind: 7, title: " Jaw care ", minutes: 0 },
        { date: "Sunday", title: "No day" },
        { date: "2026-10-20", title: "" },
        "not a row",
      ],
    });
    expect(read.context).toEqual([
      { date: "2026-10-18", time: "08:00", kind: "run", title: "Long run", minutes: 90 },
      { date: "2026-10-19", time: null, kind: "", title: "Jaw care", minutes: null },
    ]);
    expect("context" in toProposal({ id: "dp-1", status: "pending", lines: [] })).toBe(false);
  });

  it("a rest day the plan holds with no title of its own says Rest", () => {
    const read = toProposal({ id: "dp-1", status: "pending", lines: [], context: [{ date: "2026-10-18", time: null, kind: "rest", title: "", minutes: null }] });
    expect(read.context).toEqual([{ date: "2026-10-18", time: null, kind: "rest", title: "Rest", minutes: null }]);
    expect(contextLine(read.context![0]!)).toBe("Sun · Rest · on your plan");
  });
});

describe("the other open suggestions, read tolerantly (R2, §2.7)", () => {
  const run = { id: "run-1", status: "finished", scope: { kind: "now" } };

  it("each with an id and a day; a title, time and count as they read — and with no run too", () => {
    const read = toCurrent({
      run,
      events: [],
      proposal: null,
      alsoOpen: [
        { proposalId: "dp-2", title: "Hips", date: "2026-10-11", time: "13:05", items: 1 },
        { proposalId: "dp-3", title: "", date: "2026-10-13", time: "noon", items: "three" },
        { proposalId: "", title: "No id", date: "2026-10-13" },
        { proposalId: "dp-4", title: "No day", date: "Tuesday" },
        "not a row",
      ],
    });
    expect(read.alsoOpen).toEqual([
      { proposalId: "dp-2", title: "Hips", date: "2026-10-11", time: "13:05", items: 1 },
      { proposalId: "dp-3", title: "A suggestion", date: "2026-10-13", time: null, items: 1 },
    ]);
    expect(toCurrent({ run: null, alsoOpen: [{ proposalId: "dp-2", title: "Hips", date: "2026-10-11", time: null, items: 2 }] })).toEqual({
      run: null,
      alsoOpen: [{ proposalId: "dp-2", title: "Hips", date: "2026-10-11", time: null, items: 2 }],
    });
  });

  it("an older server's read: no alsoOpen at all", () => {
    expect("alsoOpen" in toCurrent({ run, events: [], proposal: null })).toBe(false);
    expect(toCurrent({ run: null })).toEqual({ run: null });
  });

  it("a line in words: title, day and time, and how many to decide when more than one", () => {
    expect(alsoLine({ title: "Hips", date: "2026-10-11", time: "13:05", items: 1 })).toBe("Hips · Sun 1:05 PM");
    expect(alsoLine({ title: "Your week", date: "2026-10-13", time: null, items: 3 })).toBe("Your week · Tue · 3 to decide");
  });
});

describe("the week's budget (R11, M6, D11, §2.11)", () => {
  it("what the week has left, and whether it is used up; unreadable, none", () => {
    expect(weekBudgetOf({ spentMicros: 17_900_000, cutoffMicros: 20_000_000 })).toEqual({ leftUsd: 2.1, usedUp: false });
    expect(weekBudgetOf({ spentMicros: 20_000_000, cutoffMicros: 20_000_000 })).toEqual({ leftUsd: 0, usedUp: true });
    expect(weekBudgetOf({ spentMicros: 21_500_000, cutoffMicros: 20_000_000 })).toEqual({ leftUsd: 0, usedUp: true });
    expect(weekBudgetOf(null)).toBeNull();
    expect(weekBudgetOf({ spentMicros: Number.NaN, cutoffMicros: 20_000_000 })).toBeNull();
    expect(weekBudgetOf({ spentMicros: 0, cutoffMicros: 0 })).toBeNull();
  });

  it("a set's estimate: the week's left when it is the tighter limit on what the run may still spend", () => {
    const run = { estimateUsd: 4.23, ceilingUsd: 6, costUsd: 0.5 };
    expect(estimateLine(run)).toBe("About $4.23; the limit is $6.00");
    expect(estimateLine(run, 2.1)).toBe("About $4.23; $2.10 left this week");
    // $5.60 left this week, the run $5.50: the run's own limit is the tighter.
    expect(estimateLine(run, 5.6)).toBe("About $4.23; the limit is $6.00");
    expect(estimateLine({ estimateUsd: 4.23, ceilingUsd: null, costUsd: 0 }, 2.1)).toBe("About $4.23; $2.10 left this week");
    expect(estimateLine({ estimateUsd: null, ceilingUsd: 6, costUsd: 0 }, 2.1)).toBeNull();
  });

  it("the default set's cost line says the week's left only when the week is tighter than a set's limit", () => {
    expect(setCostLine("week", 3)).toBe("A plan for the next 7 days usually costs about $3–5.");
    expect(setCostLine("next_n", 4, 2.1, 6)).toBe("A plan for the next 4 workouts usually costs about $3–5; $2.10 left this week.");
    expect(setCostLine("week", 3, 6, 6)).toBe("A plan for the next 7 days usually costs about $3–5.");
    expect(setCostLine("now", 3, 2.1, 6)).toBeNull();
  });

  it("the server's 409 week_budget in one plain line; any other error none", () => {
    const err = (status: number, body: unknown) => new ApiError(status, body);
    expect(weekBudgetRefusal(err(409, { error: "week_budget", spentUsd: 19.6, cutoffUsd: 20 }))).toBe("This week's AI budget has $0.40 left — not enough for this request.");
    expect(weekBudgetRefusal(err(409, { error: "week_budget", spentUsd: 20.3, cutoffUsd: 20 }))).toBe(WEEK_USED_UP_LINE);
    expect(weekBudgetRefusal(err(409, { error: "week_budget" }))).toBe(WEEK_USED_UP_LINE);
    expect(weekBudgetRefusal(err(409, { error: "busy" }))).toBeNull();
    expect(weekBudgetRefusal(err(400, { error: "week_budget", spentUsd: 1, cutoffUsd: 20 }))).toBeNull();
    expect(weekBudgetRefusal(new Error("offline"))).toBeNull();
  });
});

describe("the review's labels after the rubric's change (§2.10)", () => {
  it("fit, request and words in plain words; the retired ids keep theirs; an unknown one its own words", () => {
    expect(REVIEW_LABELS.fit).toBe("Fits your time and place");
    expect(REVIEW_LABELS.request).toBe("Answers what you asked");
    expect(REVIEW_LABELS.words).toBe("Clear words");
    expect(REVIEW_LABELS.time_fit).toBe("Fits your time");
    expect(REVIEW_LABELS.equipment_fit).toBe("Fits your equipment");
    expect(reviewLabel("something_new", "Something new")).toBe("Something new");
  });
});
