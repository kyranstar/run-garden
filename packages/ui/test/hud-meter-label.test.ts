/**
 * On the desktop garden the Lately meters sit on the scene, so their labels are the scene's light ink. The page's
 * selected / hover rule (`.balance-bar-active .balance-bar-label { color: var(--ink) }`) has the same specificity as
 * the scene's label rule and comes later in the sheet, so a selected meter's label turned dark ink on the dark scene —
 * nearly invisible. The scene keeps its own ink for both states.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `@media (min-width: 1024px)` block's body, joined (the sheet has several; the HUD's is one of them). */
function desktopBlock(): string {
  const bodies: string[] = [];
  for (let start = css.indexOf("@media (min-width: 1024px)"); start !== -1; start = css.indexOf("@media (min-width: 1024px)", start + 1)) {
    const open = css.indexOf("{", start) + 1;
    let depth = 1;
    let i = open;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    bodies.push(css.slice(open, i - 1));
  }
  expect(bodies.length).toBeGreaterThan(0);
  return bodies.join("\n");
}

/** The declarations of the rule whose selector list includes `selector`. */
function declarationsFor(block: string, selector: string): string | null {
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) return m[2]!;
  }
  return null;
}

describe("desktop garden — a selected or hovered meter keeps the scene's ink", () => {
  for (const selector of [".hud-topright .balance-bar-active .balance-bar-label", ".hud-topright .balance-bar:hover .balance-bar-label"]) {
    it(selector, () => {
      const decls = declarationsFor(desktopBlock(), selector);
      expect(decls, `no rule for ${selector} in the desktop block`).not.toBeNull();
      expect(decls).toMatch(/color:\s*var\(--on-scene\)/);
    });
  }
});
