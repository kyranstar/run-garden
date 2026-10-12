// @vitest-environment jsdom
/**
 * Stage 2 Task 5 — a move's detail, live (spec §2, §6): a row's tap opens `/studio/move/:id` over the list — a sheet
 * on a phone, the right-hand pane from md (900px) — and closing it goes back to the list, focus on the row that opened
 * it. Another row swaps the pane in place; Easier and Harder go one deeper; Back closes; an unknown move is the list.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioScreen, URL_WRITE_MS } from "../src/screens/studio/screen.js";
import { primedClient, type Primed } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";
let history: { back: () => void } = { back: () => undefined };

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

function Where() {
  const loc = useLocation();
  const navigate = useNavigate();
  where = `${loc.pathname}${loc.search}`;
  history = { back: () => navigate(-1) };
  return null;
}

/** The viewport: at least md (900px) or a phone. */
function viewport(wide: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: wide && q === "(min-width: 900px)", media: q, addEventListener: () => undefined, removeEventListener: () => undefined })),
  );
}

function mount(path: string, { wide = false, before = [] as string[], primed = {} as Primed } = {}) {
  viewport(wide);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: primedClient(primed) },
        createElement(MemoryRouter, { initialEntries: [...before, path], initialIndex: before.length }, createElement(StudioScreen), createElement(Where)),
      ),
    );
  });
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const rowLink = (name: string) =>
  [...host!.querySelectorAll<HTMLAnchorElement>("a.stu-move-open")].find((a) => a.textContent === name) ?? null;

async function click(el: Element | null, what = "element") {
  if (!el) throw new Error(`no ${what}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

/** Types into the search field, then waits past the pause after which the field writes the URL. */
async function typeQuery(value: string) {
  const el = host!.querySelector<HTMLInputElement>('input[type="search"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, URL_WRITE_MS + 40));
  });
}

async function key(k: string) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  await settle();
}

const dialog = () => host!.querySelector<HTMLElement>('[role="dialog"]');
const pane = () => host!.querySelector<HTMLElement>("aside.stu-detail");

describe("on a phone: a sheet over the list", () => {
  it("a row's tap opens the move as a dialog over the list; the list stays behind it", async () => {
    mount("/studio?q=goblet");
    const link = rowLink("Goblet squat");
    expect(link?.getAttribute("href")).toBe("/studio/move/gobletSquat?q=goblet");
    await click(link, "row link");
    expect(where).toBe("/studio/move/gobletSquat?q=goblet");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Goblet squat");
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(host!.querySelector(".stu-list")).not.toBeNull();
    expect(pane()).toBeNull();
    // Focus went into the dialog.
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });

  it("✕ closes it back to the list — Back, not a new entry — and focus returns to the row", async () => {
    mount("/studio?q=goblet", { before: ["/studio"] });
    const link = rowLink("Goblet squat")!;
    link.focus();
    await click(link);
    await click(dialog()!.querySelector('[aria-label="Close"]'), "Close");
    expect(where).toBe("/studio?q=goblet");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(rowLink("Goblet squat"));
    // The entry the move made is gone: one more Back is the home.
    await act(async () => history.back());
    await settle();
    expect(where).toBe("/studio");
  });

  it("Back closes it too", async () => {
    mount("/studio?q=goblet");
    await click(rowLink("Goblet squat"));
    await act(async () => history.back());
    await settle();
    expect(where).toBe("/studio?q=goblet");
    expect(dialog()).toBeNull();
  });

  it("Easier swaps the move in place, one entry deeper; ✕ goes back past both to the list", async () => {
    mount("/studio?q=tempo%20bodyweight");
    await click(rowLink("Tempo bodyweight squat"), "Tempo bodyweight squat");
    const easier = [...dialog()!.querySelectorAll("a.stu-ladder-link")].find((a) => a.textContent === "Box squat to bench");
    // As a keyboard reaches it: the link has the focus when it is followed (and goes away with the old move).
    (easier as HTMLElement | undefined)?.focus();
    expect(document.activeElement).toBe(easier);
    await click(easier ?? null, "Easier link");
    expect(where).toBe("/studio/move/boxSquat?q=tempo+bodyweight");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Box squat to bench");
    // Focus is on the dialog that now names the new move, not on a link that went away.
    expect(document.activeElement).toBe(dialog());
    await click(dialog()!.querySelector('[aria-label="Close"]'));
    // Back past both entries, to the list exactly as it was.
    expect(where).toBe("/studio?q=tempo%20bodyweight");
    expect(dialog()).toBeNull();
  });

  it("a link straight to a move opens it over the home; ✕ leaves the home", async () => {
    mount("/studio/move/gobletSquat");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Goblet squat");
    expect(host!.querySelector(".stu-home")).not.toBeNull();
    await click(dialog()!.querySelector('[aria-label="Close"]'));
    expect(where).toBe("/studio");
    expect(dialog()).toBeNull();
  });

  it("a move the library does not have is the list, without it", async () => {
    mount("/studio/move/noSuchMove?q=goblet");
    await settle();
    expect(where).toBe("/studio?q=goblet");
    expect(dialog()).toBeNull();
  });

  it("a modified click (a new tab) is left to the link", async () => {
    mount("/studio?q=goblet");
    const link = rowLink("Goblet squat")!;
    let left = false;
    // After every handler has had its say: was the browser left to follow the link? (Then stop it: jsdom can't.)
    const after = (e: Event) => {
      left = !e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener("click", after);
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    });
    document.removeEventListener("click", after);
    expect(left).toBe(true);
    expect(where).toBe("/studio?q=goblet");
    expect(dialog()).toBeNull();
  });
});

describe("your say, from the detail", () => {
  it("a toggle writes only what changed, shows at once, and a second tap takes it back", async () => {
    mount("/studio/move/gobletSquat");
    const puts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "PUT" && String(input) === "/api/library/gobletSquat/prefs") {
          const patch = JSON.parse(String(init.body));
          puts.push(patch);
          return new Response(JSON.stringify({ prefs: { exerciseId: "gobletSquat", rating: null, excluded: false, pinned: false, introducedOn: null, ...patch } }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "offline" }), { status: 503 });
      }),
    );
    const more = () => dialog()!.querySelector<HTMLButtonElement>('[aria-label="More like this"]')!;
    await click(more(), "More like this");
    expect(more().getAttribute("aria-pressed")).toBe("true");
    await click(more(), "More like this");
    expect(more().getAttribute("aria-pressed")).toBe("false");
    const notForMe = [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === "Not for me")!;
    await click(notForMe, "Not for me");
    expect(puts).toEqual([{ rating: 1 }, { rating: null }, { excluded: true }]);
    expect(notForMe.getAttribute("aria-pressed")).toBe("true");
  });

  it("answers apply in the order the taps were made: a late answer to an earlier tap never undoes a later one", async () => {
    mount("/studio/move/gobletSquat");
    let releaseFirst: () => void = () => undefined;
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "PUT" && String(input) === "/api/library/gobletSquat/prefs") {
          const patch = JSON.parse(String(init.body));
          const answer = () =>
            new Response(JSON.stringify({ prefs: { exerciseId: "gobletSquat", rating: null, excluded: false, pinned: false, introducedOn: null, ...patch } }), { status: 200 });
          // The first tap's answer is slow; the second's is quick.
          if (n++ === 0) return new Promise<Response>((r) => (releaseFirst = () => r(answer())));
          return answer();
        }
        return new Response(JSON.stringify({ error: "offline" }), { status: 503 });
      }),
    );
    const pin = () => [...dialog()!.querySelectorAll<HTMLButtonElement>(".stu-say button")].find((b) => /Pin/.test(b.textContent ?? ""))!;
    await click(pin(), "Pin");
    expect(pin().getAttribute("aria-pressed")).toBe("true");
    await click(pin(), "Pin");
    expect(pin().getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      releaseFirst();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(pin().getAttribute("aria-pressed")).toBe("false");
  });

  it("a failed latest tap falls back to the newest answer that saved — not to the state before the first tap", async () => {
    mount("/studio/move/gobletSquat");
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === "PUT" && String(input) === "/api/library/gobletSquat/prefs") {
          const patch = JSON.parse(String(init.body));
          // The first tap saves; the second fails.
          if (n++ === 1) return new Response(JSON.stringify({ error: "server" }), { status: 500 });
          return new Response(JSON.stringify({ prefs: { exerciseId: "gobletSquat", rating: null, excluded: false, pinned: false, introducedOn: null, ...patch } }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "offline" }), { status: 503 });
      }),
    );
    const pin = () => [...dialog()!.querySelectorAll<HTMLButtonElement>(".stu-say button")].find((b) => /Pin/.test(b.textContent ?? ""))!;
    const first = pin();
    // Both taps before either answers.
    await act(async () => {
      first.click();
      first.click();
    });
    await settle();
    await settle();
    expect(pin().getAttribute("aria-pressed")).toBe("true");
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe("Couldn't save that. Check your connection.");
  });

  it("a write that fails puts the toggle back and says so", async () => {
    mount("/studio/move/gobletSquat");
    const pin = () => [...dialog()!.querySelectorAll<HTMLButtonElement>(".stu-say button")].find((b) => /Pin/.test(b.textContent ?? ""))!;
    await click(pin(), "Pin");
    await settle();
    expect(pin().getAttribute("aria-pressed")).toBe("false");
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe("Couldn't save that. Check your connection.");
  });
});

describe("from md: the pane beside the list", () => {
  it("opens beside the list, not over it; focus moves to its name", async () => {
    mount("/studio?q=goblet", { wide: true });
    await click(rowLink("Goblet squat"));
    expect(dialog()).toBeNull();
    expect(pane()?.querySelector("h2")?.textContent).toBe("Goblet squat");
    expect(document.activeElement).toBe(pane()!.querySelector("h2"));
    expect(host!.querySelector(".stu")!.className).toContain("stu--detail");
    // The row says it is the open one.
    expect(rowLink("Goblet squat")!.getAttribute("aria-current")).toBe("true");
    expect(rowLink("Goblet squat")!.closest("li")!.className).toContain("stu-move--open");
  });

  it("another row swaps it in place; ✕ goes back to the list in one step", async () => {
    mount("/studio?q=goblet", { wide: true, before: ["/studio"] });
    await click(rowLink("Goblet squat"));
    await click(rowLink("Goblet carry"));
    expect(where).toBe("/studio/move/gobletCarry?q=goblet");
    expect(pane()?.querySelector("h2")?.textContent).toBe("Goblet carry");
    expect(document.activeElement).toBe(pane()!.querySelector("h2"));
    await click(pane()!.querySelector('[aria-label="Close"]'));
    expect(where).toBe("/studio?q=goblet");
    expect(pane()).toBeNull();
    expect(document.activeElement).toBe(rowLink("Goblet carry"));
  });

  it("it is never taller than the room below where it starts, so Add is in view at once; scrolling re-measures", async () => {
    let top = 242;
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("stu-detail") ? ({ top, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: top } as DOMRect) : real.call(this);
    });
    try {
      mount("/studio?q=goblet", { wide: true });
      await click(rowLink("Goblet squat"));
      expect(pane()!.style.getPropertyValue("--pane-top")).toBe("242px");
      top = 16;
      await act(async () => {
        window.dispatchEvent(new Event("scroll"));
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(pane()!.style.getPropertyValue("--pane-top")).toBe("16px");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("the search cleared and retyped under the pane changes its entry in place: ✕ closes it, Back is the list before, no stale redirect", async () => {
    mount("/studio?q=goblet", { wide: true, before: ["/studio"] });
    await click(rowLink("Goblet squat"));
    expect(where).toBe("/studio/move/gobletSquat?q=goblet");
    await typeQuery("");
    expect(where).toBe("/studio/move/gobletSquat");
    await typeQuery("squat");
    expect(where).toBe("/studio/move/gobletSquat?q=squat");
    await click(pane()!.querySelector('[aria-label="Close"]'), "Close");
    await settle();
    expect(pane()).toBeNull();
    expect(where).toBe("/studio?q=squat");
    await act(async () => history.back());
    await settle();
    expect(where).toBe("/studio");
    // Nothing armed: opening and closing a move again goes back to exactly where it came from.
    await typeQuery("goblet");
    await click(rowLink("Goblet squat"));
    await click(pane()!.querySelector('[aria-label="Close"]'), "Close");
    await settle();
    expect(where).toBe("/studio?q=goblet");
  });

  it("a close whose Back lands on another move entry drops its redirect — the next close is not sent to a stale list", async () => {
    viewport(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    // History as an older build could leave it: a list, a move entry, then a move opened from a list that has changed.
    const entries = [
      { pathname: "/studio", search: "?q=goblet" },
      { pathname: "/studio/move/gobletSquat", search: "?q=squat" },
      { pathname: "/studio/move/gobletCarry", search: "?q=goblet", state: { moveDepth: 1, list: "q=old" } },
    ];
    act(() => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client: primedClient() },
          createElement(MemoryRouter, { initialEntries: entries, initialIndex: 2 }, createElement(StudioScreen), createElement(Where)),
        ),
      );
    });
    await click(pane()!.querySelector('[aria-label="Close"]'), "Close");
    await settle();
    expect(where).toBe("/studio/move/gobletSquat?q=squat");
    await click(pane()!.querySelector('[aria-label="Close"]'), "Close");
    await settle();
    expect(where).toBe("/studio?q=squat");
  });

  it("Escape closes it, focus back on the row", async () => {
    mount("/studio?q=goblet", { wide: true });
    await click(rowLink("Goblet squat"));
    await key("Escape");
    expect(pane()).toBeNull();
    expect(where).toBe("/studio?q=goblet");
    expect(document.activeElement).toBe(rowLink("Goblet squat"));
  });

  it("the list changed under the pane: ✕ keeps the list as it is now", async () => {
    mount("/studio?q=goblet&how=isotonic", { wide: true });
    await click(rowLink("Goblet squat"));
    // A chip removed while the pane is open: the list's search changes, the move stays open.
    await click(host!.querySelector('[aria-label="Remove Isotonic"]'), "the Isotonic chip");
    expect(where).toBe("/studio/move/gobletSquat?q=goblet");
    expect(pane()?.querySelector("h2")?.textContent).toBe("Goblet squat");
    await click(pane()!.querySelector('[aria-label="Close"]'));
    expect(where).toBe("/studio?q=goblet");
    expect(pane()).toBeNull();
  });

  it("…and Back from there is what came before the list: the move's entries are gone, the old list replaced, nothing twice", async () => {
    mount("/studio?q=goblet&how=isotonic", { wide: true, before: ["/studio"] });
    await click(rowLink("Goblet squat"));
    await click(host!.querySelector('[aria-label="Remove Isotonic"]'), "the Isotonic chip");
    await click(pane()!.querySelector('[aria-label="Close"]'));
    await settle();
    expect(where).toBe("/studio?q=goblet");
    await act(async () => history.back());
    await settle();
    expect(where).toBe("/studio");
  });
});
