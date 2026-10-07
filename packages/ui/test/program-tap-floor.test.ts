/**
 * The 44px tap floor on the program surfaces (Phase 2a; audit 2a-UI M1, M2, M11f), measured from the stylesheet
 * by the same arithmetic the browser does — not by sampling a few points inside a 44px square, which a control
 * 36–43px tall or wide passes.
 *
 *  - A padded control's hit area is `clamp(padding box, padding box + 2 × clearance, --tap)` on each axis
 *    (the pad rule in styles.css), so the floor needs `padding box + 2 × clearance ≥ 44`; and a pad must never
 *    reach a neighbour's box, so the container's gap is at least that clearance.
 *  - A control that grows instead (the settings segments) needs its box itself ≥ 44 at the narrowest width.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sheetPath = "../src/styles.css";
const css = readFileSync(fileURLToPath(new URL(sheetPath, import.meta.url)), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}\n", css.indexOf(":root {")));

/** A token or a length, in px (rem at the 16px root). */
function px(value: string): number {
  const v = value.trim();
  const token = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (token) {
    const decl = new RegExp(`^\\s*${token[1]}:\\s*([^;]+);`, "m").exec(root);
    if (!decl) throw new Error(`no token ${token[1]}`);
    return px(decl[1]!);
  }
  const len = /^(-?[\d.]+)(px|rem)$/.exec(v);
  if (!len) throw new Error(`not a length: ${v}`);
  return Number(len[1]) * (len[2] === "rem" ? 16 : 1);
}

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule ${selector}`);
  const out: Record<string, string> = {};
  for (const d of m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
}

/** The three lists of the touch-floor contract: `position` (`:where`), the pad (`::after`), the coarse makeup. */
function lists(): { relative: string; after: string; coarse: string } {
  const at = (marker: string) => {
    const from = css.indexOf(marker);
    expect(from, marker).toBeGreaterThan(-1);
    return css.slice(from, css.indexOf("{", from));
  };
  const coarseFrom = css.indexOf("@media (pointer: coarse) {\n  .tap-pad,");
  expect(coarseFrom, "the coarse makeup list").toBeGreaterThan(-1);
  return { relative: at("\n:where(\n  .tap-pad,"), after: at("\n.tap-pad::after,"), coarse: css.slice(coarseFrom, css.indexOf("{", coarseFrom + 30)) };
}

const TAP = px("var(--tap)");

describe("the reading on the session sheet's when-line (ruling 2a-R14)", () => {
  it("is a 44px box of its own, not a pad — a pad above it would be clipped by the sheet's scroller", () => {
    // The when-line is the first line of the sheet's scrolling body, which clips anything drawn above its top edge:
    // measured, a padded reading lost its top 11px. The box itself takes the floor instead.
    const reading = rule(".session-reading");
    expect(reading["min-height"]).toBe("var(--tap)");
    // Wide enough too: "Knee 1" measured 36.3px wide (2a UI re-review U1) — the floor is both ways.
    expect(reading["min-width"]).toBe("var(--tap)");
    expect(reading["justify-content"]).toBe("center");
    expect(reading.display).toBe("inline-flex");
    expect(reading["align-items"]).toBe("center");
    const { relative, after, coarse } = lists();
    for (const list of [relative, after, coarse]) expect(list).not.toContain(".session-reading");
  });
});

describe("the session sheet's mode · theme · time · place chips (audit 2a-UI M1)", () => {
  it("each pad reaches 44px, and the row's gap is never narrower than a pad's reach", () => {
    const { relative, after, coarse } = lists();
    expect(relative).toContain("button.session-chip");
    expect(after).toContain("button.session-chip::after");
    expect(coarse).toContain("button.session-chip");
    const chip = rule(".session-chip");
    // The pad's 100% is the padding box: the 32px box less its border.
    const box = px(chip["--tap-own"]!) - 2 * px(chip.border!.split(/\s+/)[0]!);
    const row = rule(".session-chips");
    const clear = px(row["--tap-clear"]!);
    expect(box + 2 * clear).toBeGreaterThanOrEqual(TAP);
    // `gap: <row> <column>`. Chips wrap to a second row at phone widths: each pad reaches (44 − 30) / 2 = 7px past
    // its padding box, 6px past its border, so rows at least 12px apart keep every chip's own 44px square its own
    // (measured at 8px: the next row's pad took the bottom 4px of the first row's). Side by side, a chip is wider
    // than 44px, so its pad reaches nothing sideways and the column gap only has to clear a pad's reach.
    const [rowGap, columnGap = rowGap] = row.gap!.split(/\s+/).map((g) => (g === "var(--tap-clear)" ? clear : px(g)));
    const reach = (TAP - box) / 2 - px(chip.border!.split(/\s+/)[0]!);
    expect(rowGap!).toBeGreaterThanOrEqual(2 * reach);
    expect(columnGap!).toBeGreaterThanOrEqual(clear);
  });
});

describe("program settings' segments (audit 2a-UI M2)", () => {
  it("seven cells are each at least 44px wide in the sheet at 360px, and never narrower at any width", () => {
    const seg = rule(".program-seg");
    // The floor is structural: no cell is ever narrower than --tap, whatever the width.
    expect(seg["grid-auto-columns"]).toBe("minmax(var(--tap), 1fr)");
    // …and at 360 the seven fit the sheet without spilling: the sheet's inline padding (its body's scrollbar
    // gutter is pulled back by the same amount it pads).
    const inline = px(rule(".sheet").padding!.split(/\s+(?![^(]*\))/)[1]!);
    const body = rule(".sheet-body");
    expect(body["padding-right"]).toBe("var(--space-3)");
    expect(body["margin-right"]).toBe("calc(var(--space-3) * -1)");
    const width = 360 - 2 * inline;
    const gap = px(seg.gap!);
    const cell = (width - 6 * gap) / 7;
    expect(cell).toBeGreaterThanOrEqual(TAP);
    expect(7 * TAP + 6 * gap).toBeLessThanOrEqual(width);
  });
});
