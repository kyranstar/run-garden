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
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXERCISES, hasEquipment, NO_EQUIPMENT_GEAR, PROFILES, label } from "@rg/exercise-library";
import { StudioScreen, URL_WRITE_MS } from "../src/screens/studio/screen.js";
import {
  activeChips,
  emptyStudioCtx,
  loosenings,
  readStudio,
  studioResults,
  studioSearch,
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

  it("a place chosen is the gear judged: another place's, or bodyweight only — a hotel search finds what fits (CUJ re-walk §2.3)", () => {
    const ctx: StudioCtx = {
      ...emptyStudioCtx,
      place: { id: "p1", name: "Home", equipment: ["mat"] },
      places: [
        { id: "p1", name: "Home", equipment: ["mat"] },
        { id: "p2", name: "Gym", equipment: ["mat", "cable", "kettlebell", "dumbbells"] },
      ],
    };
    expect(studioResults(EXERCISES, "goblet", {}, ctx)).toEqual([]);
    expect(names(studioResults(EXERCISES, "goblet", { place: "p2" }, ctx))).toContain("Goblet squat");
    const bare = studioResults(EXERCISES, "", { place: "none" }, ctx);
    expect(bare.length).toBeGreaterThan(0);
    expect(bare.every((r) => hasEquipment(r, NO_EQUIPMENT_GEAR))).toBe(true);
    expect(names(bare)).toContain("Wall angels");
    // Its chip says it, and taking it off is the default place again.
    const chips = activeChips({ place: "none" }, ctx);
    expect(chips.map((c) => c.label)).toEqual(["Bodyweight only"]);
    expect(chips[0]!.without).toEqual({});
    expect(activeChips({ place: "p2" }, ctx).map((c) => c.label)).toEqual(["At Gym"]);
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
  it("a place is in the URL, and back", () => {
    expect(readStudio(new URLSearchParams("place=none")).filters).toEqual({ place: "none" });
    expect(readStudio(new URLSearchParams("place=p2&part=strength")).filters).toEqual({ part: "strength", place: "p2" });
    expect(studioSearch("", { place: "p2" })).toBe("?place=p2");
  });

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
    // A muscle belongs to its area: the area's chip takes both, the muscle's only itself.
    const area = activeChips({ area: "hips", muscle: "adductors" }, emptyStudioCtx);
    expect(area.map((c) => c.label)).toEqual(["Hips", "Adductors"]);
    expect(area[0]!.without).toEqual({});
    expect(area[1]!.without).toEqual({ area: "hips" });
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

/**
 * Mounted at the home, once it is drawn: the home waits for its reads to answer (a care tile or a pinned template that
 * came late would move it under a tap, 2026-10-19), and here they fail at once (nothing is served).
 */
async function mountHome(p: Primed = {}, before: string[] = []) {
  mount("/studio", p, before);
  for (let i = 0; i < 200 && !host!.querySelector(".stu-home .stu-section"); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

const input = () => host!.querySelector<HTMLInputElement>('input[type="search"]')!;
const body = () => (host!.textContent ?? "").replace(/\s+/g, " ");

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

/** Types into the field; by default waits for the query to reach the URL (it is written after a pause). */
async function type(value: string, { settle = true } = {}) {
  const el = input();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // useDeferredValue settles on the next render; the URL after the write delay.
  await wait(settle ? URL_WRITE_MS + 40 : 0);
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

  it("an empty result says what to loosen, in plain words — once: no count of zero beside it", () => {
    const html = shown("/studio?part=power&tag=desk-relief");
    expect(html).not.toContain('class="stu-list"');
    expect(text(html)).toContain("No moves match.");
    expect(text(html)).toMatch(/Show \d+ without (Power|Desk relief)/);
    expect(text(html)).not.toContain("0 moves");
    // The live region stays, so the next count is still announced.
    expect(html).toMatch(/<span class="stu-count" aria-live="polite"><\/span>/);
    const word = shown("/studio?q=zzzqqq");
    expect(text(word)).toContain("No moves match “zzzqqq”.");
  });

  it("at lg the list comes first in reading order; the filter column is placed beside it by the grid", () => {
    const html = shown("/studio?q=squat");
    expect(html.indexOf('class="stu-results-main"')).toBeGreaterThan(-1);
    expect(html.indexOf('class="stu-results-main"')).toBeLessThan(html.indexOf('class="stu-facets scroller"'));
  });

  it("a row names the gear only when the place's gear does not cover it", () => {
    const html = shown("/studio?q=squat&gear=any", { places: placesDto(["mat", "kettlebell"]) });
    const rowOf = (name: string) => {
      const at = html.indexOf(`>${name}</a></h3>`);
      expect(at, name).toBeGreaterThan(-1);
      return text(html.slice(at, html.indexOf("</li>", at)));
    };
    expect(rowOf("Goblet squat")).not.toContain("Kettlebell");
    expect(rowOf("Box squat to bench")).toContain("Bench or Sturdy chair");
  });

  it("while the list is filtered to what fits today, a row says only what is not plain: care", () => {
    const calm = { library: libraryDto({ tmj: true }), today: todayDto({ value: 1 }) };
    const rowOf = (html: string, name: string) => {
      const at = html.indexOf(`>${name}</a></h3>`);
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

  it("a list browsed by part does not repeat the part on its rows: the chip says it once", () => {
    const html = shown("/studio?part=mobility");
    const start = html.indexOf('class="stu-list"');
    const list = html.slice(start, html.indexOf("</ul>", start));
    expect(list).toContain("stu-move-name");
    expect(list).not.toMatch(new RegExp(`>${label("mobility")}</button>`));
    // The chip still names it.
    expect(html).toContain(`aria-label="Remove ${label("mobility")}"`);
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
    await mountHome();
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
    await mountHome();
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

  it("Clear resets the chips and keeps the search, with focus in the field", async () => {
    mount("/studio?q=squat&tag=ski");
    await press("Clear");
    expect(where).toBe("/studio?q=squat");
    expect(input().value).toBe("squat");
    expect(host!.querySelector('[aria-label="Remove Ski"]')).toBeNull();
    expect(host!.querySelectorAll(".stu-move").length).toBe(studioResults(EXERCISES, "squat", {}, emptyStudioCtx).length);
    expect(document.activeElement).toBe(input());
  });

  it("Clear with nothing typed goes back to the home", async () => {
    mount("/studio?tag=ski");
    await press("Clear");
    expect(where).toBe("/studio");
    expect(body()).toContain("Quick starts");
    expect(document.activeElement).toBe(input());
  });

  it("Clear is offered only when there is a filter to clear", () => {
    expect(text(shown("/studio?q=squat"))).not.toContain("Clear");
    expect(text(shown("/studio?q=squat&fit=0", { library: libraryDto({ tmj: true }) }))).toContain("Clear");
  });

  it("removing a chip hands focus to the next chip, and after the last to the list", async () => {
    mount("/studio?q=squat&part=strength&tag=posture");
    await press("Remove Strength");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Remove Posture");
    await press("Remove Posture");
    expect(where).toBe("/studio?q=squat");
    expect(document.activeElement?.textContent).toBe("Moves");
  });

  it("removing the last chip with nothing typed closes the list: focus goes to the field, never to the page", async () => {
    // A browsed part: its chip was the list's only one.
    await mountHome();
    await press("Strength");
    await press("Remove Strength");
    expect(where).toBe("/studio");
    expect(body()).toContain("Quick starts");
    expect(document.activeElement).toBe(input());
  });

  it("…the same with the place's gear known, whose default chip the closing list still drew for a frame", async () => {
    await mountHome({ places: placesDto(["mat", "kettlebell"]) });
    await press("Strength");
    expect(host!.querySelector('[aria-label="Remove At Home"]')).not.toBeNull();
    await press("Remove Strength");
    expect(body()).toContain("Quick starts");
    expect(document.activeElement).toBe(input());
  });

  it("…and from a deep link, with no home behind it", async () => {
    mount("/studio?tag=ski");
    await press("Remove Ski");
    expect(where).toBe("/studio");
    expect(body()).toContain("Quick starts");
    expect(document.activeElement).toBe(input());
  });

  it("a loosening hands focus to the list it opened", async () => {
    mount("/studio?part=power&tag=desk-relief");
    const show = [...host!.querySelectorAll("button")].find((b) => /^Show \d+ without/.test(b.textContent ?? ""))!;
    await press(show.textContent!);
    expect(host!.querySelector(".stu-list")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Moves");
  });

  it("the field's ✕ empties it and keeps the focus", async () => {
    mount("/studio?q=squat");
    await press("Clear search");
    expect(input().value).toBe("");
    expect(document.activeElement).toBe(input());
    await wait(URL_WRITE_MS + 40);
    expect(where).toBe("/studio");
  });

  it("the query reaches the URL after a pause, not on every keystroke", async () => {
    await mountHome();
    // The pause on a clock the test moves: however slow the machine, keystrokes are as far apart as the test says —
    // here each just inside the pause, so every one restarts it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const el = input();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      for (const v of ["g", "go", "gob"]) {
        await act(async () => {
          set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => {
          vi.advanceTimersByTime(URL_WRITE_MS - 1);
        });
        // The list follows the field at once; the address waits.
        expect(where).toBe("/studio");
      }
      expect(body()).not.toContain("Quick starts");
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(where).toBe("/studio?q=gob");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emptying the field after a search goes back to the home entry, so Back does not show the home twice", async () => {
    await mountHome({}, ["/plan"]);
    await type("gob");
    expect(where).toBe("/studio?q=gob");
    await type("");
    expect(where).toBe("/studio");
    expect(body()).toContain("Quick starts");
    await act(async () => back());
    expect(where).toBe("/plan");
  });

  it("Back leaves the results for the home: the first step into a list is an entry, every refinement after it is not", async () => {
    await mountHome({}, ["/plan"]);
    await type("gob");
    await type("goblet");
    // The filter column's chip (the rows have a "Strength" term too, and the list comes first).
    const chip = [...host!.querySelectorAll<HTMLButtonElement>(".stu-facets button[aria-pressed]")].find((b) => b.textContent === "Strength")!;
    await act(async () => chip.click());
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
    expect(input().value).toBe("");
    await wait(URL_WRITE_MS + 40);
    expect(where).toBe("/studio");
  });

  it("Back from a list to the home brings the field back to empty", async () => {
    await mountHome({}, ["/plan"]);
    await type("goblet");
    await act(async () => back());
    expect(where).toBe("/studio");
    expect(input().value).toBe("");
  });

  it("a browse tap hands focus to the list it opened, not to where the tapped chip was", async () => {
    await mountHome();
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

describe("Clear, then a tap at once (the browser's own history)", () => {
  // A browser's Back lands later — a task of its own — so this runs on the window's history (jsdom's), not a memory one.
  const settle = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

  it("Clear goes home in place: a quick start tapped straight after it opens, and Back still leaves the Studio", async () => {
    window.history.replaceState(null, "", "/plan");
    window.history.pushState(null, "", "/studio");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        createElement(
          QueryClientProvider,
          { client: primedClient({}) },
          createElement(
            BrowserRouter,
            null,
            createElement(
              Routes,
              null,
              createElement(Route, { path: "/studio/build/*", element: createElement("p", null, "the quick start") }),
              createElement(Route, { path: "/studio/*", element: createElement(StudioScreen) }),
              createElement(Route, { path: "/plan", element: createElement("p", null, "the plan") }),
            ),
          ),
        ),
      );
    });
    try {
      await type("gob");
      expect(window.location.search).toBe("?q=gob");
      // The field's pause on a clock the test moves (the window's history keeps its own, real one): Clear, the address
      // written after the pause, and the tap on a quick start in the same breath — before any Back could have landed.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const clear = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Clear search")!;
        act(() => clear.click());
        act(() => {
          vi.advanceTimersByTime(URL_WRITE_MS);
          host!.querySelector<HTMLAnchorElement>('a.stu-qs[href="/studio/build/quick/hip_opener"]')!.click();
        });
        // Then whatever the history had queued (a Back's traversal is a task of its own) lands.
        act(() => vi.advanceTimersByTime(20));
      } finally {
        vi.useRealTimers();
      }
      await settle(40);
      expect(window.location.pathname).toBe("/studio/build/quick/hip_opener");
      expect(host!.textContent).toContain("the quick start");
      // Back: the home, once; Back again: where the Studio was opened from — never the home a second time.
      await act(async () => window.history.back());
      await settle(40);
      expect(`${window.location.pathname}${window.location.search}`).toBe("/studio");
      await act(async () => window.history.back());
      // The home below is the same page: Back steps over it (a second traversal, a task of its own) — bounded.
      for (let i = 0; i < 50 && window.location.pathname !== "/plan"; i++) await settle(10);
      expect(window.location.pathname).toBe("/plan");
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
