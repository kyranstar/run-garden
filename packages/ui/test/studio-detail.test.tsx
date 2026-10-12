/**
 * Stage 2 Task 5 — a move in full (spec §6), as markup: the sections in the spec's order (name and summary; the
 * metadata; How; Focus; Common mistakes; Breathing; Why; the condition note for each switched-on profile; Muscles;
 * Easier / Harder, each a link; Your history; Add); the condition note in the move's own plain words, and only for a
 * profile that is on; the history and the athlete's say; a section with nothing to say is not drawn.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EXERCISES, GLOSSARY, PROFILES, type ExerciseRecord } from "@rg/exercise-library";
import { bestLine, MoveDetail, MoveDetailBody, type MoveDetailBodyProps } from "../src/screens/studio/move-detail.js";
import { emptyStudioCtx, type StudioCtx } from "../src/screens/studio/model.js";
import { renderAt, staticRouter, text, TODAY } from "./studio-fixtures.js";

const rec = (id: string): ExerciseRecord => EXERCISES.find((e) => e.id === id)!;
const noop = () => undefined;
const tmjCtx = (pre: number | null = 1): StudioCtx => ({ ...emptyStudioCtx, profiles: [PROFILES.tmj], readings: { tmj: { pre, post: null, feelingOff: false } } });

function body(over: Partial<MoveDetailBodyProps> & { rec: ExerciseRecord }): string {
  const props: MoveDetailBodyProps = {
    ctx: emptyStudioCtx,
    today: TODAY,
    say: { rating: null, pinned: false, excluded: false },
    onSay: noop,
    weightUnit: "kg",
    moveLink: (id) => ({ to: `/studio/move/${id}?q=squat` }),
    ...over,
  };
  return renderToStaticMarkup(staticRouter("/studio/move/x", createElement(MoveDetailBody, props)));
}

/** The section headings, in document order. */
const headings = (html: string) => [...html.matchAll(/<h3 [^>]*class="eyebrow"[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

describe("the sections, in the spec's order", () => {
  const tempo = rec("tempoSquat");
  const html = body({ rec: tempo, ctx: tmjCtx() });

  it("How · Focus · Common mistakes · Breathing · Why · the condition · Muscles · Easier and harder · Your history", () => {
    expect(headings(html)).toEqual([
      "How",
      "Focus",
      "Common mistakes",
      "Breathing",
      "Why",
      "TMJ",
      "Muscles",
      "Easier and harder",
      "Your history",
    ]);
  });

  it("the summary and the metadata come first, before How", () => {
    const at = (s: string) => html.indexOf(s);
    expect(at(tempo.text.summary.replace(/'/g, "&#x27;"))).toBeGreaterThan(-1);
    expect(at(tempo.text.summary.replace(/'/g, "&#x27;"))).toBeLessThan(at("stu-detail-meta"));
    expect(at("stu-detail-meta")).toBeLessThan(at(">How</h3>"));
  });

  it("the metadata are terms that explain themselves, with the gear and the difficulty", () => {
    const meta = /<p class="stu-meta stu-detail-meta">([\s\S]*?)<\/p>/.exec(html)![1]!;
    expect(meta).toMatch(/<button type="button" class="term"[^>]*>Strength<\/button>/);
    expect(meta).toContain(GLOSSARY.strength!.replace(/'/g, "&#x27;"));
    expect(text(meta)).toContain(`Difficulty ${tempo.difficulty} of 5`);
    // The dose Add puts in, and today's fit — the word beside its colour.
    const dose = /<p class="stu-meta stu-meta--dose stu-detail-dose">([\s\S]*?)<\/p>/.exec(html)![1]!;
    expect(text(dose)).toMatch(/\d/);
    expect(text(dose)).toMatch(/Fits today|With care|Not today/);
  });

  it("How is the setup, then the steps in order", () => {
    const how = html.slice(html.indexOf(">How</h3>"), html.indexOf(">Focus</h3>"));
    expect(how).toMatch(/<ul class="stu-detail-list">[\s\S]*<\/ul><ol class="stu-detail-list">/);
    for (const s of tempo.text.steps) expect(text(how)).toContain(s.replace(/&/g, "&"));
  });

  it("Muscles: the primary, then Also the secondary", () => {
    const sec = html.slice(html.indexOf(">Muscles</h3>"), html.indexOf(">Easier and harder</h3>"));
    const lines = [...sec.matchAll(/<p class="stu-meta stu-detail-muscles">([\s\S]*?)<\/p>/g)].map((m) =>
      [...m[1]!.matchAll(/<button type="button" class="term"[^>]*>([^<]*)<\/button>|<span>(Also)<\/span>/g)].map((t) => t[1] ?? t[2]),
    );
    expect(lines).toEqual([["Quads", "Glute max"], ["Also", "Adductors"]]);
  });
});

describe("the condition note", () => {
  const goblet = rec("gobletSquat");

  it("each switched-on profile's note, in the move's own plain words, under the profile's name", () => {
    const html = body({ rec: goblet, ctx: tmjCtx() });
    const sec = html.slice(html.indexOf(">TMJ</h3>") + 1, html.indexOf("<h3", html.indexOf(">TMJ</h3>")));
    expect(text(sec)).toBe(`TMJ ${goblet.text.conditions.tmj}`);
    expect(text(sec)).toContain("Teeth apart");
  });

  it("no profile on: no condition section at all", () => {
    const html = body({ rec: goblet, ctx: emptyStudioCtx });
    expect(headings(html)).not.toContain("TMJ");
    expect(html).not.toContain("Teeth apart");
  });
});

describe("Easier and harder", () => {
  it("each a link to that move, the list's search kept", () => {
    const html = body({ rec: rec("tempoSquat") });
    expect(html).toMatch(/<span class="stu-ladder-way">Easier<\/span><a class="stu-ladder-link" href="\/studio\/move\/boxSquat\?q=squat"[^>]*>Box squat to bench<\/a>/);
    expect(html).toMatch(/<span class="stu-ladder-way">Harder<\/span><a class="stu-ladder-link" href="\/studio\/move\/bwSplitSquat\?q=squat"[^>]*>/);
  });

  it("a move with neither has no such section", () => {
    const lone = EXERCISES.find((r) => !r.easier.length && !r.harder.length)!;
    expect(headings(body({ rec: lone }))).not.toContain("Easier and harder");
  });
});

describe("your history and your say", () => {
  const goblet = rec("gobletSquat");
  const ctx: StudioCtx = {
    ...emptyStudioCtx,
    prefs: new Map([["gobletSquat", { rating: 1, pinned: true, excluded: false, lastDoneOn: "2026-10-05", timesDone30d: 3 }]]),
  };

  it("last done, times in 30 days, the best set in the athlete's unit", () => {
    const html = body({ rec: goblet, ctx, best: { w: { v: 12, u: "kg" }, reps: 8, secs: null }, weightUnit: "lb" });
    const hist = text(html.slice(html.indexOf(">Your history</h3>")));
    expect(hist).toContain("Last done 6 days ago · 3× in 30 days · Best: 26.5 lb × 8");
    // The athlete's own marks are the toggles, not words in the line.
    expect(hist.split("Best")[0]).not.toContain("Pinned");
  });

  it("not done yet says so", () => {
    expect(text(body({ rec: goblet }))).toContain("Not done yet.");
  });

  it("the say: rating, Pin and Not for me are toggles that show their state in words and marks, never colour alone", () => {
    const html = body({ rec: goblet, ctx, say: { rating: 1, pinned: true, excluded: false } });
    // Pressed: a check beside the colour, never the colour alone.
    expect(html).toMatch(/<button type="button" class="chipbtn" aria-pressed="true" aria-label="More like this"><svg[^>]*>/);
    expect(html).toMatch(/aria-label="Less like this"><span aria-hidden="true">/);
    expect(html).toMatch(/aria-pressed="false" aria-label="Less like this"/);
    // One name whatever the state: `aria-pressed` carries it, the check in the pin's place shows it.
    expect(html).toMatch(/aria-pressed="true"><svg[^>]*><path d="M4.5 12.5l5 5L19.5 7"><\/path><\/svg>Pin<\/button>/);
    expect(html).toMatch(/aria-pressed="true"><svg[^>]*>[\s\S]*?<\/svg>Pin<\/button>/);
    expect(html).toMatch(/aria-pressed="false">Not for me<\/button>/);
    const unpinned = body({ rec: goblet, say: { rating: null, pinned: false, excluded: true } });
    expect(unpinned).toMatch(/aria-pressed="false"><svg[^>]*>[\s\S]*?<\/svg>Pin<\/button>/);
    expect(unpinned).toMatch(/aria-pressed="true"><svg[^>]*>[\s\S]*?<\/svg>Not for me<\/button>/);
  });

  it("a say that didn't save says so", () => {
    expect(body({ rec: goblet, sayError: "Couldn't save that. Check your connection." })).toMatch(/role="alert">Couldn&#x27;t save that/);
  });

  it("best lines", () => {
    expect(bestLine({ w: null, reps: null, secs: 45 }, "kg")).toBe("Best hold: 45 s");
    expect(bestLine({ w: { v: 30, u: "lb" }, reps: 6, secs: null }, "lb")).toBe("Best: 30 lb × 6");
    expect(bestLine({ w: null, reps: 12, secs: null }, "kg")).toBe("Best: 12 reps");
    expect(bestLine(null, "kg")).toBeNull();
  });
});

describe("on a phone: a sheet titled by the move, Add pinned at its foot", () => {
  it("the name, then the body, then Add", () => {
    const html = renderAt(
      "/studio/move/gobletSquat",
      createElement(MoveDetail, {
        rec: rec("gobletSquat"),
        ctx: emptyStudioCtx,
        today: TODAY,
        wide: false,
        onClose: noop,
        onAdd: noop,
        moveLink: (id: string) => ({ to: `/studio/move/${id}` }),
      }),
    );
    expect(html).toMatch(/role="dialog" aria-modal="true"/);
    expect(html).toMatch(/<h2 id="[^"]+">Goblet squat<\/h2>/);
    expect(html.indexOf(">Goblet squat</h2>")).toBeLessThan(html.indexOf(">How</h3>"));
    expect(html.indexOf(">Your history</h3>")).toBeLessThan(html.indexOf('class="sheet-foot"'));
    expect(html.slice(html.indexOf('class="sheet-foot"'))).toMatch(/<button type="button" class="btn btn-primary stu-detail-add">Add<\/button>/);
    // One scroll owner: the sheet's body.
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
  });

  it("from md: a pane, not a dialog — its name a heading that takes focus, the body its one scroller, Add at its foot", () => {
    const html = renderAt(
      "/studio/move/gobletSquat",
      createElement(MoveDetail, {
        rec: rec("gobletSquat"),
        ctx: emptyStudioCtx,
        today: TODAY,
        wide: true,
        onClose: noop,
        onAdd: noop,
        moveLink: (id: string) => ({ to: `/studio/move/${id}` }),
      }),
    );
    expect(html).not.toContain('role="dialog"');
    expect(html).toMatch(/^<aside class="stu-detail" aria-labelledby="([^"]+)"><div class="row-between stu-detail-head"><h2 id="\1" tabindex="-1">Goblet squat<\/h2>/);
    expect(html).toContain('<div class="stu-detail-body scroller">');
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<div class="stu-detail-foot">[\s\S]*Add<\/button>/);
    expect(html).toContain('aria-label="Close"');
  });
});
