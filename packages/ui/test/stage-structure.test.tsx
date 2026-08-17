/**
 * "Full structure" — a repeat's scope, in the DOM.
 *
 * The reported bug: "the repeat x 6, what does this refer to? hard to know if
 * it refers to the ones before or after." The list was flat, so it genuinely
 * did not say. These tests hold the fix at the structural level rather than the
 * pixel one — a screen reader has to get the grouping too, so the assertions
 * are about nesting and announced text, not about borders.
 *
 * Shapes are the ones production actually stores (measured 2026-08-17 over
 * 370 repeat groups): 319 of those groups hold exactly ONE stage, none is
 * nested inside another, and `repeat × 1` exists.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildStageTree, leafStageCount, StageStructure, type StageRow } from "../src/screens/stage-structure.js";

/** COROS-shaped rows: `ord` is a huge sortNo, children carry parentStageId. */
function stage(over: Partial<StageRow> & { id: string; ord: number; kind: string }): StageRow {
  return { parentStageId: null, repeatCount: null, durationSeconds: null, distanceMeters: null, label: null, ...over };
}

/** The exact prod interval shape: warmup, a 6× group of work+recovery, cooldown. */
const strides: StageRow[] = [
  stage({ id: "s1", ord: 16777216, kind: "warmup", durationSeconds: 1500 }),
  stage({ id: "s2", ord: 33554432, kind: "repeat", repeatCount: 6, label: "Group" }),
  stage({ id: "s3", ord: 33619968, kind: "work", parentStageId: "s2", distanceMeters: 100 }),
  stage({ id: "s4", ord: 33685504, kind: "recovery", parentStageId: "s2", durationSeconds: 60 }),
  stage({ id: "s5", ord: 50331648, kind: "cooldown", durationSeconds: 600 }),
];

const html = (stages: StageRow[]): string =>
  renderToStaticMarkup(createElement(StageStructure, { stages, units: "km" as const }));

describe("buildStageTree", () => {
  it("hangs a repeat's children off the repeat, in ord order, and leaves the rest at the root", () => {
    const tree = buildStageTree(strides);
    expect(tree.map((n) => n.stage.id)).toEqual(["s1", "s2", "s5"]);
    expect(tree[1]!.count).toBe(6);
    expect(tree[1]!.children.map((n) => n.stage.id)).toEqual(["s3", "s4"]);
    expect(tree[0]!.children).toEqual([]);
  });

  it("promotes an orphan to the root rather than dropping a prescribed stage", () => {
    const tree = buildStageTree([
      stage({ id: "a", ord: 1, kind: "work", parentStageId: "gone" }),
      stage({ id: "b", ord: 2, kind: "rest" }),
    ]);
    expect(tree.map((n) => n.stage.id)).toEqual(["a", "b"]);
  });

  it("does not hang on a parent cycle", () => {
    const tree = buildStageTree([
      stage({ id: "x", ord: 1, kind: "repeat", repeatCount: 2, parentStageId: "y" }),
      stage({ id: "y", ord: 2, kind: "repeat", repeatCount: 2, parentStageId: "x" }),
    ]);
    expect(tree.length).toBeGreaterThanOrEqual(0);
  });

  it("counts the stages a reader performs, a group once — the number the flat list showed", () => {
    expect(leafStageCount(strides)).toBe(4);
  });
});

describe("a repeat of several stages", () => {
  const markup = html(strides);

  it("puts the repeated stages INSIDE the multiplier's own list item", () => {
    // The group's `<li>` holds both the multiplier and a nested `<ul>` of
    // exactly the repeated stages — so "before or after" is not a question
    // the reader can be asked. This is the whole fix.
    const group = /<li class="stage-group">(.*?)<\/ul><\/li>/s.exec(markup);
    expect(group).not.toBeNull();
    const inner = group![1]!;
    expect(inner).toContain("6 ×");
    expect(inner).toContain("<ul class=\"stage-group-list\">");
    expect(inner).toContain("work — 0.10 km");
    expect(inner).toContain("recovery — 1 min");
    // The warmup and the cooldown are NOT in it.
    expect(inner).not.toContain("warmup");
    expect(inner).not.toContain("cooldown");
  });

  it("says the scope out loud for a screen reader, with the step count", () => {
    expect(markup).toContain("Repeat 6 times, 2 steps:");
    // The visible badge is hidden from the reader so it is not said twice.
    expect(markup).toContain('<b class="stage-mult num" aria-hidden="true">6 ×</b>');
  });

  it("keeps the unrepeated stages as siblings of the group, in order", () => {
    const items = [...markup.matchAll(/<li class="stage-(step|group)">/g)].length;
    expect(items).toBe(5); // warmup, group, work, recovery, cooldown
    expect(markup.indexOf("warmup")).toBeLessThan(markup.indexOf("stage-group"));
    expect(markup.indexOf("stage-group")).toBeLessThan(markup.indexOf("cooldown"));
  });
});

describe("the shapes production is actually full of", () => {
  it("a repeat of ONE stage puts the multiplier on that stage's line — no box needed", () => {
    const markup = html([
      stage({ id: "g", ord: 1, kind: "repeat", repeatCount: 3, label: "Group" }),
      stage({ id: "e", ord: 2, kind: "work", parentStageId: "g", label: "Push-ups" }),
    ]);
    expect(markup).toContain("3 ×");
    expect(markup).toContain("work (Push-ups)");
    expect(markup).not.toContain("stage-group-list");
    expect(markup).toContain("Repeat 3 times, 1 step:");
  });

  it("drops a `repeat × 1` wrapper entirely — a multiplier of one says nothing", () => {
    const markup = html([
      stage({ id: "g", ord: 1, kind: "repeat", repeatCount: 1, label: "Group" }),
      stage({ id: "e", ord: 2, kind: "work", parentStageId: "g", label: "Barbell Shrugs" }),
    ]);
    expect(markup).toContain("work (Barbell Shrugs)");
    expect(markup).not.toContain("1 ×");
    expect(markup).not.toContain("stage-group-list");
  });

  it("never prints COROS's generic 'Group' label, but keeps a name the athlete gave", () => {
    expect(html(strides)).not.toContain("Group");
    const named = html([
      stage({ id: "g", ord: 1, kind: "repeat", repeatCount: 2, label: "Ladder" }),
      stage({ id: "a", ord: 2, kind: "work", parentStageId: "g", durationSeconds: 60 }),
      stage({ id: "b", ord: 3, kind: "rest", parentStageId: "g", durationSeconds: 60 }),
    ]);
    expect(named).toContain("Ladder");
  });

  it("recurses: a group inside a group keeps its own bounds", () => {
    const markup = html([
      stage({ id: "outer", ord: 1, kind: "repeat", repeatCount: 2, label: "Group" }),
      stage({ id: "inner", ord: 2, kind: "repeat", repeatCount: 3, parentStageId: "outer", label: "Group" }),
      stage({ id: "w", ord: 3, kind: "work", parentStageId: "inner", durationSeconds: 30 }),
      stage({ id: "r", ord: 4, kind: "rest", parentStageId: "outer", durationSeconds: 60 }),
    ]);
    expect(markup).toContain("Repeat 2 times, 2 steps:");
    expect(markup).toContain("Repeat 3 times, 1 step:");
    // The inner multiplier is inside the outer group's list; the outer rest is too.
    const outer = /<li class="stage-group">(.*)<\/ul><\/li>/s.exec(markup)![1]!;
    expect(outer).toContain("3 ×");
    expect(outer).toContain("rest — 1 min");
  });

  it("still prints a container the import left empty", () => {
    const markup = html([stage({ id: "g", ord: 1, kind: "repeat", repeatCount: 4, label: "Group" })]);
    expect(markup).toContain("4 ×");
    expect(markup).toContain("repeat");
  });

  /**
   * The prescription's own numbers. This list sits a few pixels under the
   * stored `stageSummary` line, and both used to round to whole minutes
   * independently, so prod's strides session (`9ca6bb02`: 15s on, 45s off)
   * printed "work — 0 min" here — a step with no duration at all — and the
   * 45s recovery printed the same "1 min" as the genuinely-60s cooldown.
   */
  it("prints a sub-minute stage in seconds — a 15s stride is never '0 min'", () => {
    const markup = html([
      stage({ id: "g", ord: 1, kind: "repeat", repeatCount: 4, label: "Group" }),
      stage({ id: "on", ord: 2, kind: "work", parentStageId: "g", durationSeconds: 15, label: "Training" }),
      stage({ id: "off", ord: 3, kind: "recovery", parentStageId: "g", durationSeconds: 45, label: "Rest" }),
    ]);
    expect(markup).toContain("work — 15s (Training)");
    expect(markup).toContain("recovery — 45s (Rest)");
    // Boundary-anchored: "40 min" contains "0 min", so a bare substring check
    // would pass for the wrong reason on any longer session.
    expect(markup).not.toMatch(/(^|[ >])0 min/);
  });

  it("does not spell 45s and 60s the same way", () => {
    const markup = html([
      stage({ id: "a", ord: 1, kind: "recovery", durationSeconds: 45 }),
      stage({ id: "b", ord: 2, kind: "cooldown", durationSeconds: 60 }),
    ]);
    expect(markup).toContain("recovery — 45s");
    expect(markup).toContain("cooldown — 1 min");
  });

  it("says 90s the way an interval session is written", () => {
    // 13 prod recovery stages are 90s; every one of them read "2 min".
    expect(html([stage({ id: "a", ord: 1, kind: "recovery", durationSeconds: 90 })])).toContain(
      "recovery — 90s",
    );
  });

  it("shows a pace band ordered fast→slow whichever way round it was stored", () => {
    const markup = html([
      stage({ id: "a", ord: 1, kind: "work", durationSeconds: 300, targetType: "pace", targetLow: 266, targetHigh: 255 }),
    ]);
    expect(markup).toContain("4:15–4:26 /km");
  });
});
