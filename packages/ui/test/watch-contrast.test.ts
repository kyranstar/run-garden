/**
 * THE WATCH'S STATES CLEAR AA CONTRAST IN BOTH THEMES (audit 3-B UI-8). "Couldn't send" and "Too long for the watch"
 * are 14–16px medium text on the warn band: the `--warn` ink on `--warn-soft` measured 4.00:1 in light mode (AA asks
 * 4.5:1). The band's text takes `--warn-ink`, a darker light-mode warn for text on the soft band; dark mode keeps its
 * own (5.46:1). Read off styles.css: the rule's own colour and background, resolved in each theme's tokens.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first block opened by `head` (balanced braces). */
function block(head: string, from = 0): string {
  const start = css.indexOf(head, from);
  expect(start, `no ${head}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start + head.length - 1) + 1;
  let depth = 1;
  let i = open;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  return css.slice(open, i - 1);
}

function tokens(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

const light = tokens(block(":root {"));
const darkMedia = tokens(block(':root:not([data-theme="light"]) {', css.indexOf("@media (prefers-color-scheme: dark)")));
const darkForced = tokens(block(':root[data-theme="dark"] {'));

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The `color` and `background` tokens of the rule for exactly `selector`. */
function colours(selector: string): { color: string; background: string } {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.trim() !== selector) continue;
    const color = /(?:^|;)\s*color:\s*var\((--[\w-]+)\)/.exec(m[2]!)?.[1];
    const background = /background:\s*var\((--[\w-]+)\)/.exec(m[2]!)?.[1];
    if (color && background) return { color, background };
  }
  throw new Error(`no rule for ${selector} with a token colour and background`);
}

describe("the Take off confirm's \"Couldn't take it off\" (audit 3-B UI-3)", () => {
  const rule = /\}\s*\.confirm-error\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  it("is written in the AA warn ink", () => expect(rule).toMatch(/color:\s*var\(--warn-ink\)/));
  for (const [theme, t] of [
    ["light", light],
    ["dark (system)", { ...light, ...darkMedia }],
    ["dark (chosen)", { ...light, ...darkForced }],
  ] as const) {
    it(`${theme}: on the dialog (--bg-raised) at least 4.5:1`, () => {
      expect(ratio(t["--warn-ink"]!, t["--bg-raised"]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("the watch's warn band (Couldn't send, Too long for the watch)", () => {
  const { color, background } = colours(".watch-state--warn");
  for (const [theme, t] of [
    ["light", light],
    ["dark (system)", { ...light, ...darkMedia }],
    ["dark (chosen)", { ...light, ...darkForced }],
  ] as const) {
    it(`${theme}: ${color} on ${background} is at least 4.5:1`, () => {
      expect(t[color], `${color} in ${theme}`).toBeDefined();
      expect(t[background], `${background} in ${theme}`).toBeDefined();
      expect(ratio(t[color]!, t[background]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
