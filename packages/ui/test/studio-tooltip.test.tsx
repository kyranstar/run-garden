// @vitest-environment jsdom
/**
 * Stage 2 Task 4 — the accessible Tooltip (spec §5): a term is a BUTTON with `aria-expanded` / `aria-controls`; a tap
 * (or Enter, which a button turns into a click) toggles a small popover with one plain sentence; Escape and a tap
 * outside close it; nothing about it is hover-only. Escape belongs to the top thing: inside a sheet it closes the
 * tooltip, not the sheet.
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Sheet } from "../src/components.js";
import { Tooltip } from "../src/components/tooltip.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SENTENCE = "Holding still against resistance.";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
});

function mount(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}

const term = (name = "Isometric") =>
  [...host!.querySelectorAll<HTMLButtonElement>("button.term")].find((b) => b.textContent === name)!;
const pop = (b: HTMLButtonElement) => document.getElementById(b.getAttribute("aria-controls")!)!;
const isOpen = (b: HTMLButtonElement) => b.getAttribute("aria-expanded") === "true" && !pop(b).hidden;
const key = (k: string) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });

describe("Tooltip, as drawn", () => {
  const drawn = () => {
    mount(createElement(Tooltip, { term: "Isometric", tip: SENTENCE }));
    return host!.innerHTML;
  };

  it("is a real button that says whether it is open and what it controls", () => {
    const html = drawn();
    const button = /<button[^>]*>/.exec(html)![0];
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(button)![1]!;
    // The popover is in the DOM while closed, so `aria-controls` always resolves.
    expect(document.getElementById(controls)).not.toBeNull();
    expect(document.getElementById(controls)!.hidden).toBe(true);
    expect(html).toContain(SENTENCE);
  });

  it("never relies on hover: no title attribute", () => {
    expect(drawn()).not.toContain("title=");
  });
});

describe("Tooltip, live", () => {
  it("a tap opens it and a second tap closes it", () => {
    mount(createElement(Tooltip, { term: "Isometric", tip: SENTENCE }));
    const b = term();
    expect(isOpen(b)).toBe(false);
    act(() => b.click());
    expect(isOpen(b)).toBe(true);
    expect(pop(b).textContent).toContain(SENTENCE);
    act(() => b.click());
    expect(isOpen(b)).toBe(false);
  });

  it("Escape closes it, and focus stays on the term", () => {
    mount(createElement(Tooltip, { term: "Isometric", tip: SENTENCE }));
    const b = term();
    act(() => {
      b.focus();
      b.click();
    });
    key("Escape");
    expect(isOpen(b)).toBe(false);
    expect(document.activeElement).toBe(b);
  });

  // jsdom has no PointerEvent; the listener reads only the event's target, so a MouseEvent named "pointerdown" is it.
  it("a tap outside closes it; a tap inside the popover does not", () => {
    mount(createElement("div", null, createElement(Tooltip, { term: "Isometric", tip: SENTENCE }), createElement("p", { id: "away" }, "elsewhere")));
    const b = term();
    act(() => b.click());
    act(() => {
      pop(b).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(isOpen(b)).toBe(true);
    act(() => {
      document.getElementById("away")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(isOpen(b)).toBe(false);
  });

  it("hovering alone never opens it", () => {
    mount(createElement(Tooltip, { term: "Isometric", tip: SENTENCE }));
    const b = term();
    act(() => {
      b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      b.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      b.dispatchEvent(new FocusEvent("focus"));
    });
    expect(isOpen(b)).toBe(false);
  });

  it("one at a time: opening another term closes the first", () => {
    mount(
      createElement(
        "div",
        null,
        createElement(Tooltip, { term: "Isometric", tip: SENTENCE }),
        createElement(Tooltip, { term: "Isotonic", tip: "Moving through a range: lifting and lowering." }),
      ),
    );
    act(() => term("Isometric").click());
    act(() => term("Isotonic").click());
    expect(isOpen(term("Isometric"))).toBe(false);
    expect(isOpen(term("Isotonic"))).toBe(true);
  });

  it("inside a sheet, Escape closes the tooltip first and the sheet only on the next press", () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return createElement(
        Sheet,
        { open, onClose: () => setOpen(false), title: "Filters" },
        createElement(Tooltip, { term: "Isometric", tip: SENTENCE }),
      );
    }
    mount(createElement(Host));
    const b = term();
    act(() => b.click());
    key("Escape");
    expect(isOpen(term())).toBe(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    key("Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("focus leaving the term (Tab away) closes it; focus moving into its own popover does not", () => {
    mount(createElement("div", null, createElement(Tooltip, { term: "Isometric", tip: SENTENCE }), createElement("button", { id: "next" }, "Next")));
    const b = term();
    act(() => {
      b.focus();
      b.click();
    });
    expect(isOpen(b)).toBe(true);
    act(() => document.getElementById("next")!.focus());
    expect(isOpen(b)).toBe(false);
  });

  it("near the bottom of the screen it opens upward, clear of the tab bar", () => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    // jsdom has no layout: the popover reports itself below the fold (jsdom's window is 768px tall).
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const low = this.classList.contains("term-pop") || this.classList.contains("term");
      return { top: low ? 700 : 0, bottom: low ? 790 : 0, left: 20, right: 220, width: 200, height: 90, x: 20, y: 700, toJSON() {} } as DOMRect;
    };
    try {
      mount(createElement(Tooltip, { term: "Isometric", tip: SENTENCE }));
      const b = term();
      act(() => b.click());
      expect(pop(b).dataset.place).toBe("above");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = real;
    }
  });
});
