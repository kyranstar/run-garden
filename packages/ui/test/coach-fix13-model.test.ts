/**
 * Task 13's fix wave, stream U — what the coach's screens decide without React: a suggestion's new fields read
 * tolerantly (§2.8, §2.9), a set's rows by day (D7), the review's new labels (§2.10). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import type { DesignChangeLineDto, DesignContextRowDto, DesignLineDto } from "@rg/api-client";
import { toProposal } from "../src/screens/studio/coach-tolerance.js";
import { cardRows, contextLine } from "../src/screens/studio/proposal-card.js";
import { REVIEW_LABELS, reviewLabel } from "../src/screens/studio/run-model.js";

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
