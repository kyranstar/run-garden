/**
 * The popup's rows hold a stranger's titles and, before the app has a post, the link itself — one long word. Each piece
 * of a row wraps anywhere, so nothing runs past the popup's edge (audit 2026-11-06, I12).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../src/popup.css", import.meta.url)), "utf8");
const rule = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

describe("the popup's rows", () => {
  it("each piece of a row wraps anywhere and may shrink: an unbroken link never overflows", () => {
    const piece = rule(".row .line > *");
    expect(piece).toMatch(/overflow-wrap:\s*anywhere/);
    expect(piece).toMatch(/min-width:\s*0/);
  });

  it("the field's answer and a light's failures wrap too", () => {
    expect(rule(".link-note")).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
