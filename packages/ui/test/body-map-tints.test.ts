/**
 * THE BODY MAP'S LEVELS READ APART IN BOTH THEMES (Growth's "Your body"). In the dark, "a little" sat 1.32:1 off "not
 * worked" and "not worked" 1.12:1 off the silhouette — on the figure and in the legend alike, a step the eye barely
 * took. Read off styles.css: each `--body-*` fill resolved in each theme's tokens (`color-mix(in srgb, …)` mixed as the
 * browser mixes it), every step a clear stride further from the card than the one before, and the figure and its
 * swatches painting the very same tokens.
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

const decls = (body: string) => Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const light = decls(block(":root {"));
const dark = { ...light, ...decls(block(':root:not([data-theme="light"]) {', css.indexOf("@media (prefers-color-scheme: dark)"))) };

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;

/** A token's colour in a theme: a hex, a var() of one, or `color-mix(in srgb, var(--a) P%, var(--b))`. */
function resolve(t: Record<string, string>, value: string): Rgb {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return hex(v);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return resolve(t, t[ref[1]!]!);
  const mix = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+(?:\.\d+)?)%, var\((--[\w-]+)\)\)$/.exec(v);
  if (!mix) throw new Error(`can't resolve ${v}`);
  const [a, p, b] = [resolve(t, `var(${mix[1]})`), Number(mix[2]) / 100, resolve(t, `var(${mix[3]})`)];
  return a.map((x, i) => x * p + b[i]! * (1 - p)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
const ratio = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const STEPS = ["--body-sil", "--body-lvl-0", "--body-lvl-1", "--body-lvl-2", "--body-lvl-3"] as const;

/** The declarations of the rule for exactly `selector`. */
function rule(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1]!.trim() === selector) return m[2]!;
  throw new Error(`no rule for ${selector}`);
}

describe("the body map's levels", () => {
  for (const [theme, t] of [
    ["light", light],
    ["dark (system)", dark],
  ] as const) {
    it(`${theme}: the silhouette, then not worked, a little, steadily, a lot — each a clear step further from the card`, () => {
      const card = resolve(t, "var(--bg-raised)");
      const fills = STEPS.map((s) => resolve(t, t[s]!));
      let before = card;
      for (const [i, fill] of fills.entries()) {
        // Further from the card than the step before it…
        expect(ratio(fill, card), `${STEPS[i]} vs the card`).toBeGreaterThan(ratio(before, card));
        // …and, past the silhouette (a ground: its outline draws the body), a step the eye takes.
        if (i > 0) expect(ratio(fill, before), `${STEPS[i]} vs ${STEPS[i - 1]}`).toBeGreaterThanOrEqual(1.25);
        before = fill;
      }
    });
  }

  it("the figure and its swatches paint the same tokens, so the legend says what the figure shows", () => {
    expect(rule(".body-sil")).toMatch(/fill:\s*var\(--body-sil\)/);
    for (const l of [0, 1, 2, 3]) expect(rule(`.body-area.body-lvl-${l}`), `figure ${l}`).toMatch(new RegExp(`fill:\\s*var\\(--body-lvl-${l}\\)`));
    expect(rule(".body-swatch")).toMatch(/background:\s*var\(--body-lvl-0\)/);
    for (const l of [1, 2, 3]) expect(rule(`.body-swatch.body-lvl-${l}`), `swatch ${l}`).toMatch(new RegExp(`background:\\s*var\\(--body-lvl-${l}\\)`));
  });
});
