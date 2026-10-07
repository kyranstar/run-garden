// @vitest-environment jsdom
/**
 * The player's keyboard (spec §2b "Player"; mocks §4 desktop): Space is the primary action only when no control has
 * focus (a focused button already takes Space itself — answering it too would act twice); Enter confirms the log;
 * Esc closes a panel; ←/→ step; S swap; I how-to; ? the key list. Typing in a field types.
 */
import { describe, expect, it } from "vitest";
import { commandFor } from "../../src/player/keys.js";

const closed = { panelOpen: false, logOpen: false };

function key(k: string, target: Element = document.body, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) {
  return { key: k, target, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}
const button = () => document.body.appendChild(document.createElement("button"));
const input = () => document.body.appendChild(document.createElement("input"));

describe("Space", () => {
  it("is the primary action when nothing has focus", () => {
    expect(commandFor(key(" "), closed)).toBe("primary");
  });
  it("is left to a focused button (which presses itself)", () => {
    expect(commandFor(key(" ", button()), closed)).toBeNull();
  });
  it("types a space in a field", () => {
    expect(commandFor(key(" ", input()), closed)).toBeNull();
  });
  it("does nothing while a panel is open", () => {
    expect(commandFor(key(" "), { panelOpen: true, logOpen: false })).toBeNull();
  });
});

describe("Enter", () => {
  it("confirms the log card, from its weight field too", () => {
    expect(commandFor(key("Enter", input()), { panelOpen: false, logOpen: true })).toBe("confirm");
    expect(commandFor(key("Enter"), { panelOpen: false, logOpen: true })).toBe("confirm");
  });
  it("is left to a focused button, and means nothing without the log card", () => {
    expect(commandFor(key("Enter", button()), { panelOpen: false, logOpen: true })).toBeNull();
    expect(commandFor(key("Enter"), closed)).toBeNull();
  });
});

describe("the other keys", () => {
  it("Esc closes, from anywhere", () => {
    expect(commandFor(key("Escape", input()), { panelOpen: true, logOpen: false })).toBe("close");
    expect(commandFor(key("Escape"), closed)).toBe("close");
  });
  it("← and → step, also from a focused button, never inside a field", () => {
    expect(commandFor(key("ArrowLeft"), closed)).toBe("prev");
    expect(commandFor(key("ArrowRight", button()), closed)).toBe("next");
    expect(commandFor(key("ArrowRight", input()), closed)).toBeNull();
  });
  it("S, I and ? open the swap, the how-to and the key list", () => {
    expect(commandFor(key("s"), closed)).toBe("swap");
    expect(commandFor(key("S"), closed)).toBe("swap");
    expect(commandFor(key("i"), closed)).toBe("howto");
    expect(commandFor(key("?"), closed)).toBe("keys");
  });
  it("letters type in a field, and nothing but Esc and Enter acts while a panel is open", () => {
    expect(commandFor(key("s", input()), closed)).toBeNull();
    expect(commandFor(key("s"), { panelOpen: true, logOpen: false })).toBeNull();
    expect(commandFor(key("ArrowRight"), { panelOpen: true, logOpen: false })).toBeNull();
  });
  it("a key with Ctrl, ⌘ or Alt is the browser's", () => {
    expect(commandFor(key("s", document.body, { metaKey: true }), closed)).toBeNull();
    expect(commandFor(key("ArrowLeft", document.body, { altKey: true }), closed)).toBeNull();
  });
});
