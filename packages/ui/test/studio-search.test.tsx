// @vitest-environment jsdom
/**
 * Stage 2 Task 4 — search and filters (spec §3–§4).
 *
 *  - Typing replaces the home with results, instantly: the pure `searchLibrary` over the bundled library (no network).
 *  - A browse chip, theme or tag opens the same list with that filter, shown as a removable chip under the field.
 *  - "Fits today" is on by default while a profile is on; the place's gear is the default equipment.
 *  - The count and Clear sit beside the chips; an empty result says what to loosen.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXERCISES, PROFILES, label } from "@rg/exercise-library";
import { StudioScreen } from "../src/screens/studio/screen.js";
import {
  activeChips,
  emptyStudioCtx,
  loosenings,
  readStudio,
  studioResults,
  type StudioCtx,
} from "../src/screens/studio/model.js";
import { libraryDto, placesDto, primedClient, text, todayDto, type Primed } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const names = (xs: ReadonlyArray<{ name: string }>) => xs.map((x) => x.name);
const tmj = (pre: number | null, feelingOff = false): StudioCtx => ({
  ...emptyStudioCtx,
  profiles: [PROFILES.tmj],
  readings: { tmj: { pre, post: null, feelingOff } },
});

// ── The pure half ──────────────────────────────────────────────────────────

describe("studioResults", () => {
  it("is the shared search over the bundled library: name prefix first, a typo forgiven", () => {
    expect(names(studioResults(EXERCISES, "gobl", {}, emptyStudioCtx)).slice(0, 2).sort()).toEqual(["Goblet carry", "Goblet squat"]);
    expect(names(studioResults(EXERCISES, "gobelt squat", {}, emptyStudioCtx))[0]).toBe("Goblet squat");
  });

  it("each filter narrows to its vocabulary id", () => {
    const power = studioResults(EXERCISES, "", { part: "power" }, emptyStudioCtx);
    expect(power.length).toBeGreaterThan(0);
    expect(power.every((r) => r.purposes.includes("power"))).toBe(true);
    const iso = studioResults(EXERCISES, "", { how: "isometric", area: "core" }, emptyStudioCtx);
    expect(iso.every((r) => r.contraction.includes("isometric") && r.regions.includes("core"))).toBe(true);
    const ski = studioResults(EXERCISES, "", { tag: "ski", max: 2 }, emptyStudioCtx);
    expect(ski.every((r) => r.tags.includes("ski") && r.difficulty <= 2)).toBe(true);
  });

  it("fits today is on by default while a profile is on, and the athlete can turn it off", () => {
    const flare = tmj(8);
    const press = "halfKneelingPress";
    expect(studioResults(EXERCISES, "press", {}, flare).map((r) => r.id)).not.toContain(press);
    expect(studioResults(EXERCISES, "press", { fit: false }, flare).map((r) => r.id)).toContain(press);
    // No profile on: nothing to fit, nothing hidden.
    expect(studioResults(EXERCISES, "press", {}, emptyStudioCtx).map((r) => r.id)).toContain(press);
  });

  it("the place's gear is the default equipment; any equipment, or one piece, on request", () => {
    const ctx: StudioCtx = { ...emptyStudioCtx, place: { name: "Home", equipment: ["mat"] } };
    expect(studioResults(EXERCISES, "goblet", {}, ctx)).toEqual([]);
    expect(names(studioResults(EXERCISES, "goblet", { gear: "any" }, ctx))).toContain("Goblet squat");
    const kb = studioResults(EXERCISES, "", { gear: "kettlebell" }, ctx);
    expect(kb.length).toBeGreaterThan(0);
    expect(kb.every((r) => [...r.equipment.all, ...r.equipment.oneOf].includes("kettlebell"))).toBe(true);
  });

  it("pinned and not-for-me read the athlete's own say", () => {
    const ctx: StudioCtx = {
      ...emptyStudioCtx,
      prefs: new Map([
        ["gobletSquat", { rating: null, pinned: true, excluded: false, lastDoneOn: null, timesDone30d: 0 }],
        ["gobletCarry", { rating: null, pinned: false, excluded: true, lastDoneOn: null, timesDone30d: 0 }],
      ]),
    };
    expect(names(studioResults(EXERCISES, "", { mine: "pinned" }, ctx))).toEqual(["Goblet squat"]);
    expect(names(studioResults(EXERCISES, "", { mine: "set-aside" }, ctx))).toEqual(["Goblet carry"]);
    // A pin lifts a move among equals; a move set aside sinks.
    const goblets = names(studioResults(EXERCISES, "goblet", {}, ctx));
    expect(goblets.indexOf("Goblet squat")).toBeLessThan(goblets.indexOf("Goblet carry"));
  });
});

describe("the URL is the state", () => {
  it("reads the query and the filters; unknown values are ignored", () => {
    const s = readStudio(new URLSearchParams("q=squat&part=strength&how=nope&tag=ski&max=2&fit=0&gear=any"));
    expect(s.q).toBe("squat");
    expect(s.filters).toEqual({ part: "strength", tag: "ski", max: 2, fit: false, gear: "any" });
    expect(s.listing).toBe(true);
    expect(readStudio(new URLSearchParams("")).listing).toBe(false);
    expect(readStudio(new URLSearchParams("all=1")).listing).toBe(true);
  });

  it("every active filter is a removable chip, the defaults included", () => {
    const ctx: StudioCtx = { ...tmj(1), place: { name: "Home", equipment: ["mat"] } };
    const chips = activeChips({ part: "strength", tag: "ski" }, ctx);
    expect(chips.map((c) => c.label)).toEqual(["Strength", "Ski", "At Home", "Fits today"]);
    // Removing the place's gear means any equipment; removing the fit turns it off — not back to their defaults.
    expect(chips.find((c) => c.label === "At Home")!.without).toEqual({ part: "strength", tag: "ski", gear: "any" });
    expect(chips.find((c) => c.label === "Fits today")!.without).toEqual({ part: "strength", tag: "ski", fit: false });
    expect(chips.find((c) => c.label === "Strength")!.without).toEqual({ tag: "ski" });
  });

  it("an empty result offers the loosening that shows the most", () => {
    const f = { part: "power", tag: "desk-relief" } as const;
    expect(studioResults(EXERCISES, "", f, emptyStudioCtx)).toEqual([]);
    const ways = loosenings(EXERCISES, "", f, emptyStudioCtx);
    expect(ways.length).toBeGreaterThan(0);
    expect(ways[0]!.count).toBe(Math.max(...ways.map((w) => w.count)));
    for (const w of ways) expect(studioResults(EXERCISES, "", w.chip.without, emptyStudioCtx).length).toBe(w.count);
  });
});

// ── Typing, live ───────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;
let where = "";

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

let back: () => void = () => undefined;

function Where() {
  const loc = useLocation();
  const navigate = useNavigate();
  where = `${loc.pathname}${loc.search}`;
  back = () => navigate(-1);
  return null;
}

/** Mounted at `path`; `before` are history entries behind it (Back goes to them). */
function mount(path: string, p: Primed = {}, before: string[] = []) {
  if (root) act(() => root!.unmount());
  host?.remove();
  // The Studio reads the library, today and places; nothing here is fetched (the cache is primed or the read fails).
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: primedClient(p) },
        createElement(
          MemoryRouter,
          { initialEntries: [...before, path], initialIndex: before.length },
          createElement(StudioScreen),
          createElement(Where),
        ),
      ),
    );
  });
}

const input = () => host!.querySelector<HTMLInputElement>('input[type="search"]')!;
const body = () => (host!.textContent ?? "").replace(/\s+/g, " ");

async function type(value: string) {
  const el = input();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // useDeferredValue settles on the next render.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function press(label: string) {
  const b = [...host!.querySelectorAll<HTMLButtonElement>("button")].find(
    (x) => (x.getAttribute("aria-label") ?? x.textContent ?? "").trim() === label,
  );
  if (!b) throw new Error(`no button "${label}" in: ${body()}`);
  await act(async () => {
    b.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

// ── Rendered ───────────────────────────────────────────────────────────────

/** Mounted at `path`, as markup (a live render: this file runs in jsdom). */
function shown(path: string, p: Primed = {}): string {
  mount(path, p);
  return host!.innerHTML;
}

describe("results, rendered", () => {
  it("a query in the URL renders the list instead of the home, with the count", () => {
    const html = shown("/studio?q=goblet");
    expect(html).toContain('class="stu-list"');
    expect(text(html)).toContain("Goblet squat");
    expect(html).not.toContain(">Quick starts</h2>");
    const n = studioResults(EXERCISES, "goblet", {}, emptyStudioCtx).length;
    expect(text(html)).toContain(`${n} moves`);
    // The count is announced as it changes.
    expect(html).toMatch(/<span class="stu-count" aria-live="polite">/);
  });

  it("the chips sit under the field, each a button that names what it removes, with Clear", () => {
    const html = shown("/studio?part=strength&tag=posture");
    expect(html).toContain('aria-label="Remove Strength"');
    expect(html).toContain('aria-label="Remove Posture"');
    expect(html.indexOf('role="search"')).toBeLessThan(html.indexOf('aria-label="Remove Strength"'));
    expect(text(html)).toContain("Clear");
  });

  it("an empty result says what to loosen, in plain words", () => {
    const html = shown("/studio?part=power&tag=desk-relief");
    expect(html).not.toContain('class="stu-list"');
    expect(text(html)).toContain("No moves match.");
    expect(text(html)).toMatch(/Show \d+ without (Power|Desk relief)/);
    const word = shown("/studio?q=zzzqqq");
    expect(text(word)).toContain("No moves match “zzzqqq”.");
  });

  it("while the list is filtered to what fits today, a row says only what is not plain: care", () => {
    const calm = { library: libraryDto({ tmj: true }), today: todayDto({ value: 1 }) };
    const rowOf = (html: string, name: string) => {
      const at = html.indexOf(`>${name}</h3>`);
      expect(at, name).toBeGreaterThan(-1);
      return text(html.slice(at, html.indexOf("</li>", at)));
    };
    const on = shown("/studio?q=press", calm);
    expect(rowOf(on, "Half-kneeling one-arm press")).toContain("With care");
    const plain = names(studioResults(EXERCISES, "press", {}, tmj(1))).find((n) => n !== "Half-kneeling one-arm press")!;
    expect(rowOf(on, plain)).not.toContain("Fits today");
    // With the filter off the list mixes them, so every row says where it stands.
    const off = shown("/studio?q=press&fit=0", calm);
    expect(rowOf(off, plain)).toMatch(/Fits today|With care|Not today/);
  });

  it("a list browsed by part names that part on every row", () => {
    const html = shown("/studio?part=mobility");
    // A move whose first purpose is not mobility, in mobility's list: its row says mobility.
    const rec = studioResults(EXERCISES, "", { part: "mobility" }, emptyStudioCtx).find((r) => r.purposes[0] !== "mobility")!;
    expect(rec).toBeDefined();
    const at = html.indexOf(`>${rec.name}</h3>`);
    expect(at).toBeGreaterThan(-1);
    const row = html.slice(at, html.indexOf("</li>", at));
    expect(row).toMatch(/class="term"[^>]*>Mobility work<\/button>/);
    expect(row).not.toMatch(new RegExp(`>${label(rec.purposes[0]!)}</button>`));
  });

  it("the place's gear and today's fit show as chips once known", () => {
    const html = shown("/studio?q=squat", {
      library: libraryDto({ tmj: true }),
      today: todayDto({ value: 1 }),
      places: placesDto(["mat", "kettlebell"]),
    });
    expect(html).toContain('aria-label="Remove At Home"');
    expect(html).toContain('aria-label="Remove Fits today"');
  });
});

describe("typing filters, live", () => {
  it("typing replaces the home with matching moves, and emptying the field brings the home back", async () => {
    mount("/studio");
    expect(body()).toContain("Quick starts");
    await type("gobl");
    expect(where).toBe("/studio?q=gobl");
    expect(body()).not.toContain("Quick starts");
    const shown = [...host!.querySelectorAll(".stu-move-name")].map((n) => n.textContent);
    expect(shown.slice(0, 2).sort()).toEqual(["Goblet carry", "Goblet squat"]);
    expect(shown).toHaveLength(studioResults(EXERCISES, "gobl", {}, emptyStudioCtx).length);
    // The field kept its focus target: it is the same element, typing goes on.
    await type("goblet sq");
    expect([...host!.querySelectorAll(".stu-move-name")][0]!.textContent).toBe("Goblet squat");
    await type("");
    expect(where).toBe("/studio");
    expect(body()).toContain("Quick starts");
  });

  it("a browse chip opens the list with that filter, and removing the chip removes the filter", async () => {
    mount("/studio");
    await press("Strength");
    expect(where).toBe("/studio?part=strength");
    const strength = host!.querySelectorAll(".stu-move").length;
    expect(strength).toBe(studioResults(EXERCISES, "", { part: "strength" }, emptyStudioCtx).length);
    await type("squat");
    expect(where).toBe("/studio?q=squat&part=strength");
    await press("Remove Strength");
    expect(where).toBe("/studio?q=squat");
    expect(host!.querySelectorAll(".stu-move").length).toBe(studioResults(EXERCISES, "squat", {}, emptyStudioCtx).length);
    expect(host!.querySelector('[aria-label="Remove Strength"]')).toBeNull();
  });

  it("removing the default fit chip shows what today's reading hid", async () => {
    mount("/studio?q=press", { library: libraryDto({ tmj: true }), today: todayDto({ value: 8 }) });
    const before = [...host!.querySelectorAll(".stu-move-name")].map((n) => n.textContent);
    expect(before).not.toContain("Half-kneeling one-arm press");
    await press("Remove Fits today");
    expect(where).toBe("/studio?q=press&fit=0");
    const after = [...host!.querySelectorAll(".stu-move-name")].map((n) => n.textContent);
    expect(after).toContain("Half-kneeling one-arm press");
  });

  it("Clear goes back to the home", async () => {
    mount("/studio?q=squat&tag=ski");
    await press("Clear");
    expect(where).toBe("/studio");
    expect(input().value).toBe("");
    expect(body()).toContain("Quick starts");
  });

  it("Back leaves the results for the home: the first step into a list is an entry, every refinement after it is not", async () => {
    mount("/studio", {}, ["/plan"]);
    await type("gob");
    await type("goblet");
    await press("Strength");
    expect(where).toBe("/studio?q=goblet&part=strength");
    await act(async () => back());
    expect(where).toBe("/studio");
    await act(async () => back());
    expect(where).toBe("/plan");
  });

  it("Escape in the field empties it", async () => {
    mount("/studio?q=squat");
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(where).toBe("/studio");
    expect(input().value).toBe("");
  });

  it("a browse tap hands focus to the list it opened, not to where the tapped chip was", async () => {
    mount("/studio");
    await press("Strength");
    const heading = host!.querySelector("h2.visually-hidden")!;
    expect(heading.textContent).toBe("Moves");
    expect(document.activeElement).toBe(heading);
  });

  it("the Filters badge counts the athlete's own filters, not the Studio's defaults", () => {
    const html = shown("/studio?part=strength&tag=posture", {
      library: libraryDto({ tmj: true }),
      places: placesDto(["mat"]),
    });
    expect(text(/<button[^>]*stu-filters-btn[^>]*>[\s\S]*?<\/button>/.exec(html)![0])).toBe("Filters : 2 set");
    expect(text(/<button[^>]*stu-filters-btn[^>]*>[\s\S]*?<\/button>/.exec(shown("/studio?q=squat", { library: libraryDto({ tmj: true }) }))![0])).toBe("Filters");
  });
});
