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
  it("is padded to the floor, and its line leaves the pad room", () => {
    const { relative, after, coarse } = lists();
    expect(relative).toContain(".session-reading");
    expect(after).toContain(".session-reading::after");
    expect(coarse).toContain(".session-reading");
    const clear = px(rule(".session-when")["--tap-clear"]!);
    // The reading is a line of the when-line's text: 14.4px at the body's 1.5 line height.
    const line = px(rule(".session-when")["font-size"]!) * 1.5;
    expect(line + 2 * clear).toBeGreaterThanOrEqual(TAP);
    // Below it, the sheet's stack gap; above it, the sheet head's margin: neither is narrower than the pad's reach.
    expect(px(rule(".stack").gap!)).toBeGreaterThanOrEqual(clear);
    expect(px(rule(".sheet-head")["margin-bottom"]!)).toBeGreaterThanOrEqual(clear);
  });
});
