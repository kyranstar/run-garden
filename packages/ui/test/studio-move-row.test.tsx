/**
 * Stage 2 Task 4 — a move in the list (spec §5): name and Add; the card line; purpose · contraction · primary muscles
 * · gear, each term a tooltip; the default dose, the athlete's history and today's condition fit — a fit is never a
 * colour alone: every fit colour sits beside its status word.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EXERCISES, GLOSSARY, PROFILES, label, type ExerciseRecord } from "@rg/exercise-library";
import { FitBadge, MoveRow } from "../src/screens/studio/move-row.js";
import { doseLine, FIT_WORD, fitToday, historyLine, type Fit, type FitState } from "../src/screens/studio/model.js";
import { text } from "./studio-fixtures.js";

const rec = (id: string): ExerciseRecord => EXERCISES.find((e) => e.id === id)!;
const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
const reading = (pre: number | null, feelingOff = false) => ({ tmj: { pre, post: null, feelingOff } });
const TODAY = "2026-10-11";

describe("a move row", () => {
  const goblet = rec("gobletSquat");
  const html = renderToStaticMarkup(
    createElement(MoveRow, {
      rec: goblet,
      fit: { state: "fits", word: FIT_WORD.fits, reason: "Safe for TMJ, even on a flare day." },
      prefs: { rating: null, pinned: false, excluded: false, lastDoneOn: "2026-10-05", timesDone30d: 3 },
      today: TODAY,
    }),
  );

  it("line 1 the name; line 2 the card line", () => {
    expect(html).toMatch(/<h3 class="stu-move-name">Goblet squat<\/h3>/);
    expect(text(html)).toContain(goblet.text.summary);
  });

  /** The markup of one of the row's two meta lines (0: terms, 1: dose). */
  const line = (h: string, i: 0 | 1) => [...h.matchAll(/<p class="stu-meta[^"]*">([\s\S]*?)<\/p>/g)][i]![1]!;

  it("line 3: purpose · contraction · primary muscles, each a term that explains itself — and nothing else", () => {
    for (const [word, id] of [["Strength", "strength"], ["Isotonic", "isotonic"], ["Quads", "quads"], ["Glute max", "glute-max"]] as const) {
      expect(line(html, 0), word).toMatch(new RegExp(`<button type="button" class="term"[^>]*aria-expanded="false"[^>]*>${word}</button>`));
      expect(html, word).toContain(GLOSSARY[id]!.replace(/'/g, "&#x27;"));
    }
    expect(text(line(html, 0))).not.toContain("Kettlebell");
  });

  it("line 4: the default dose, the history, today's fit — and the gear, with no place to judge it by", () => {
    const plain = text(line(html, 1));
    expect(plain).toContain("2 × 7");
    expect(plain).toContain("Last done 6 days ago");
    expect(plain).toContain("3× in 30 days");
    expect(plain).toContain("Fits today");
    expect(plain).toContain("Kettlebell or Dumbbells");
  });

  it("the gear is dropped when the place's gear covers it, and named when it does not", () => {
    const at = (placeGear: string[]) =>
      text(line(renderToStaticMarkup(createElement(MoveRow, { rec: goblet, fit: null, prefs: null, today: TODAY, placeGear })), 1));
    expect(at(["mat", "kettlebell"])).not.toContain("Kettlebell");
    expect(at(["mat"])).toContain("Kettlebell or Dumbbells");
  });

  it("the terms are words inside a line (the inline exemption): no pads to overlap; the fit alone is a padded target", () => {
    for (const cls of [...line(html, 0).matchAll(/<button type="button" class="([^"]*)"/g)].map((m) => m[1]!)) {
      expect(cls, cls).toBe("term");
    }
    const fit = /<button type="button" class="([^"]*stu-fit[^"]*)"/.exec(line(html, 1))![1]!;
    expect(fit.split(" ")).toContain("tap-pad");
  });

  it("Add is there only when there is something for it to do", () => {
    expect(html).not.toContain("Add Goblet squat");
    const withAdd = renderToStaticMarkup(createElement(MoveRow, { rec: goblet, fit: null, prefs: null, today: TODAY, onAdd: () => undefined }));
    expect(withAdd).toMatch(/<button type="button" class="btn btn-small stu-move-add" aria-label="Add Goblet squat">/);
  });

  it("with no profile on and no history, line 4 is the dose alone", () => {
    const bare = text(renderToStaticMarkup(createElement(MoveRow, { rec: goblet, fit: null, prefs: null, today: TODAY })));
    expect(bare).toContain("2 × 7");
    expect(bare).not.toMatch(/today|Last done/);
  });
});

describe("the dose line", () => {
  it("is the dose Add puts in: the record's low sets and the middle of its range, in its own unit", () => {
    expect(doseLine(rec("gobletSquat"))).toBe("2 × 7");
    expect(doseLine(rec("gobletCarry"))).toBe("2 × 45 s");
    expect(doseLine(rec("breath"))).toBe("90 s");
    expect(doseLine(rec("physiologicalSigh"))).toBe("7 breaths");
    const oneSided = EXERCISES.find((e) => e.laterality !== "bilateral" && e.dose.type === "reps")!;
    expect(doseLine(oneSided)).toMatch(/ each side$/);
    // One set of reps names its unit: a bare "10" says nothing.
    const single = EXERCISES.find((e) => e.dose.type === "reps" && !e.dose.sets && e.laterality === "bilateral")!;
    const [lo, hi] = single.dose.range;
    expect(doseLine(single)).toBe(`${Math.round((lo + hi) / 2)} reps`);
  });

  it("in a list browsed by a part, a row does not repeat that part (the chip says it once)", () => {
    const goblet = rec("gobletSquat");
    const browsed = renderToStaticMarkup(createElement(MoveRow, { rec: goblet, fit: null, prefs: null, today: TODAY, browsedPart: "strength" }));
    expect(browsed).not.toMatch(new RegExp(`>${label("strength")}</button>`));
    expect(browsed).toMatch(/>Isotonic<\/button>/);
    // Browsed by another part, or not at all: the move's own first purpose.
    const plain = renderToStaticMarkup(createElement(MoveRow, { rec: goblet, fit: null, prefs: null, today: TODAY }));
    expect(plain).toMatch(new RegExp(`>${label("strength")}</button>`));
  });

  it("the history line: when, and how often lately", () => {
    expect(historyLine({ rating: null, pinned: false, excluded: false, lastDoneOn: TODAY, timesDone30d: 1 }, TODAY)).toEqual(["Done today"]);
    expect(historyLine({ rating: null, pinned: false, excluded: false, lastDoneOn: "2026-10-10", timesDone30d: 1 }, TODAY)).toEqual(["Done yesterday"]);
    expect(historyLine({ rating: null, pinned: true, excluded: false, lastDoneOn: "2026-10-01", timesDone30d: 4 }, TODAY)).toEqual([
      "Last done 10 days ago",
      "4× in 30 days",
      "Pinned",
    ]);
    expect(historyLine({ rating: null, pinned: false, excluded: true, lastDoneOn: null, timesDone30d: 0 }, TODAY)).toEqual(["Not for me"]);
  });
});

describe("today's condition fit", () => {
  const tmj = [PROFILES.tmj];

  it("nothing to say with no profile on", () => {
    expect(fitToday(rec("gobletSquat"), [], {})).toBeNull();
  });

  it("a move safe even on a flare day fits, whatever the reading", () => {
    for (const r of [reading(null), reading(1), reading(8), reading(1, true)]) {
      expect(fitToday(rec("gobletSquat"), tmj, r)!.state).toBe("fits");
    }
  });

  it("a move allowed with limits is care on a calm day, not today on a flare day or unanswered", () => {
    const press = rec("halfKneelingPress");
    expect(fitToday(press, tmj, reading(1))!.state).toBe("care");
    expect(fitToday(press, tmj, reading(8))!.state).toBe("not");
    expect(fitToday(press, tmj, reading(null))!.state).toBe("not");
  });

  it("a flare day, or feeling off, is a recovery day: a move allowed only in harder sessions is not for today", () => {
    // Farmer carry: fine for TMJ in a consistent or build session, never in recovery.
    const carry = rec("farmerCarry");
    expect(fitToday(carry, tmj, reading(1))!.state).toBe("care");
    expect(fitToday(carry, tmj, reading(8))!.state).toBe("not");
    expect(fitToday(carry, tmj, reading(1, true))!.state).toBe("not");
    expect(fitToday(carry, tmj, reading(1, true))!.reason).toBe("Not while you're feeling off.");
    expect(fitToday(carry, tmj, reading(8))!.reason).toBe("Not with jaw / head at 8 today.");
  });

  it("a jump says why it is not for today, in the profile's own words", () => {
    const jump = rec("landingStick");
    const f = fitToday(jump, tmj, reading(null))!;
    expect(f.state).toBe("not");
    expect(f.reason).toBe(PROFILES.tmj.recordReason!(jump, "build", { pre: null, post: null, feelingOff: false }));
    expect(fitToday(jump, tmj, reading(1))!.state).toBe("care");
    expect(fitToday(jump, tmj, reading(1, true))!.state).toBe("not");
  });

  it("a move the profile never allows says so by name", () => {
    const clenching = { ...rec("gobletSquat"), conditions: { tmj: { clench: 3, neckLoad: 0, faceDown: false } } };
    const f = fitToday(clenching, tmj, reading(0))!;
    expect(f.state).toBe("not");
    expect(f.reason).toBe("TMJ rules this move out.");
    // An unrated move fails closed, and says so — not left to a profile's own reader to happen to fail closed.
    const unrated = fitToday({ ...rec("gobletSquat"), conditions: {} }, tmj, reading(0))!;
    expect(unrated.state).toBe("not");
    expect(unrated.reason).toBe("TMJ rules this move out.");
  });
});

describe("status words beside every fit colour", () => {
  const STATES: FitState[] = ["fits", "care", "not"];

  it("each state's badge carries its colour class, an icon and its word, in one control", () => {
    for (const state of STATES) {
      const fit: Fit = { state, word: FIT_WORD[state], reason: "Because." };
      const html = renderToStaticMarkup(createElement(FitBadge, { fit }));
      const button = /<button[^>]*class="term tap-pad stu-fit stu-fit--(\w+)"[^>]*>([\s\S]*?)<\/button>/.exec(html);
      expect(button, state).not.toBeNull();
      expect(button![1]).toBe(state);
      expect(button![2]).toContain("<svg");
      expect(text(button![2]!)).toBe(FIT_WORD[state]);
    }
  });

  it("the stylesheet paints no fit colour that has no word", () => {
    const painted = [...css.matchAll(/\.stu-fit--(\w+)\s*\{/g)].map((m) => m[1]!);
    expect(painted.sort()).toEqual([...STATES].sort());
    for (const s of painted) expect(FIT_WORD[s as FitState], s).toMatch(/\w/);
  });
});
