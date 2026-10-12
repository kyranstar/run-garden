// @vitest-environment jsdom
/**
 * Stage 2 Task 4 — the filter controls (spec §4), as the sheet and the lg column both hold them:
 *
 *  - one value per facet: a tap chooses, a tap on the chosen one lets go; choosing an area forgets its muscle;
 *  - equipment always has a value: the place's gear (the default), any equipment, or one piece;
 *  - "Fits today" is on until turned off, and back on by turning it on;
 *  - Tags, Theme and Difficulty show a first row and keep the rest one tap down — a chosen value always shows;
 *  - the sheet's Clear resets the filters and stays open; Show closes it onto the list.
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROFILES, label } from "@rg/exercise-library";
import { FilterControls } from "../src/screens/studio/filters-sheet.js";
import { emptyStudioCtx, type StudioCtx, type StudioFilters } from "../src/screens/studio/model.js";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

function render(el: React.ReactElement) {
  if (root) act(() => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}

const buttons = (scope: ParentNode = host!) => [...scope.querySelectorAll<HTMLButtonElement>("button")];
const named = (name: string, scope: ParentNode = host!) => buttons(scope).find((b) => (b.textContent ?? "").trim() === name);
const facet = (title: string) => {
  const h = [...host!.querySelectorAll("h2, h3")].find((x) => x.textContent === title);
  if (!h) throw new Error(`no facet ${title}`);
  return h.closest(".stu-facet")!;
};

/** FilterControls with a spy: every change is recorded and fed back, as the screen does. */
function controls(start: StudioFilters, ctx: StudioCtx = emptyStudioCtx) {
  const seen: StudioFilters[] = [];
  let current = start;
  function Host() {
    const [filters, setFilters] = useState(start);
    return createElement(FilterControls, {
      filters,
      ctx,
      onChange: (next: StudioFilters) => {
        seen.push(next);
        current = next;
        setFilters(next);
      },
    });
  }
  render(createElement(Host));
  return {
    seen,
    tap: (name: string, scope?: ParentNode) => {
      const b = named(name, scope);
      if (!b) throw new Error(`no chip ${name}`);
      act(() => b.click());
    },
    now: () => current,
  };
}

describe("one value per facet", () => {
  it("a tap chooses, a tap on the chosen one lets go, and the chosen chip says so beyond colour", () => {
    const c = controls({});
    c.tap(label("strength"));
    expect(c.now()).toEqual({ part: "strength" });
    const chip = named(label("strength"))!;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.querySelector("svg")).not.toBeNull();
    c.tap(label("power"));
    expect(c.now()).toEqual({ part: "power" });
    c.tap(label("power"));
    expect(c.now()).toEqual({});
  });

  it("choosing an area forgets the muscle chosen under another", () => {
    const c = controls({ area: "hips", muscle: "adductors" });
    c.tap(label("glutes"), facet("Body area"));
    expect(c.now()).toEqual({ area: "glutes" });
  });

  it("equipment: the place's gear by default, any equipment, one piece — and that piece again goes back to the place", () => {
    const ctx: StudioCtx = { ...emptyStudioCtx, place: { name: "Home", equipment: ["mat"] } };
    const c = controls({}, ctx);
    expect(named("At Home")!.getAttribute("aria-pressed")).toBe("true");
    c.tap("Any equipment");
    expect(c.now()).toEqual({ gear: "any" });
    c.tap("Kettlebell");
    expect(c.now()).toEqual({ gear: "kettlebell" });
    c.tap("Kettlebell");
    expect(c.now()).toEqual({});
    c.tap("Any equipment");
    c.tap("At Home");
    expect(c.now()).toEqual({});
  });

  it("Fits today is on until turned off, and on again by a tap", () => {
    const ctx: StudioCtx = { ...emptyStudioCtx, profiles: [PROFILES.tmj] };
    const c = controls({ part: "strength" }, ctx);
    expect(named("Fits today")!.getAttribute("aria-pressed")).toBe("true");
    c.tap("Fits today");
    expect(c.now()).toEqual({ part: "strength", fit: false });
    c.tap("Fits today");
    expect(c.now()).toEqual({ part: "strength" });
  });
});

describe("the long facets keep their first row; the rest is one tap down", () => {
  it("Tags, Theme and Difficulty each show a first row and a More that names what it opens", () => {
    controls({});
    for (const [title, more] of [["Tags", "More tags"], ["Theme", "More themes"], ["Difficulty", "Show levels"]] as const) {
      const f = facet(title);
      const toggle = named(more, f);
      expect(toggle, more).toBeDefined();
      expect(toggle!.getAttribute("aria-expanded")).toBe("false");
      const rest = document.getElementById(toggle!.getAttribute("aria-controls")!)!;
      expect(rest.hidden).toBe(true);
      act(() => toggle!.click());
      expect(toggle!.getAttribute("aria-expanded")).toBe("true");
      expect(rest.hidden).toBe(false);
    }
  });

  it("a chosen value past the first row still shows while the facet is folded", () => {
    controls({ tag: "eccentric-emphasis" });
    const f = facet("Tags");
    const chosen = named(label("eccentric-emphasis"), f)!;
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
    expect(chosen.closest("[hidden]")).toBeNull();
  });
});

// ── The sheet, on the screen ───────────────────────────────────────────────

let where = "";
function Where() {
  const loc = useLocation();
  where = `${loc.pathname}${loc.search}`;
  return null;
}

function screenAt(path: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })));
  render(
    createElement(
      QueryClientProvider,
      { client: primedClient() },
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(StudioScreen), createElement(Where)),
    ),
  );
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const openSheet = () => act(() => buttons().find((b) => b.classList.contains("stu-filters-btn"))!.click());

describe("the sheet", () => {
  it("Clear resets the filters, keeps the search, and the sheet stays open", () => {
    screenAt("/studio?q=squat&tag=ski&part=strength");
    openSheet();
    act(() => named("Clear", dialog()!)!.click());
    expect(where).toBe("/studio?q=squat");
    expect(dialog()).not.toBeNull();
  });

  it("Show closes it onto the list, and the list has the focus", async () => {
    screenAt("/studio");
    openSheet();
    act(() => named(label("power"), dialog()!)!.click());
    const show = buttons(dialog()!).find((b) => /^Show \d+ moves?$/.test(b.textContent ?? ""))!;
    await act(async () => show.click());
    expect(dialog()).toBeNull();
    expect(where).toBe("/studio?part=power");
    expect(document.activeElement?.textContent).toBe("Moves");
  });

  it("Show with nothing chosen opens every move", async () => {
    screenAt("/studio");
    openSheet();
    const show = buttons(dialog()!).find((b) => /^Show \d+ moves?$/.test(b.textContent ?? ""))!;
    await act(async () => show.click());
    expect(where).toBe("/studio?all=1");
    expect(host!.querySelector(".stu-list")).not.toBeNull();
  });
});
