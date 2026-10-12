/**
 * Stage 2 Task 4 — the Studio home (spec §3): the search field, the coach composer's empty slot (Stage 3 fills it),
 * quick starts, browse by part, themes and tags — in that order, every label from the vocabularies, and nothing
 * condition-specific unless a condition profile is switched on.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { EXERCISES, TAGS, label } from "@rg/exercise-library";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { emptyStudioCtx, studioResults } from "../src/screens/studio/model.js";
import { libraryDto, placesDto, renderAt, text, todayDto } from "./studio-fixtures.js";

const home = (p: Parameters<typeof renderAt>[2] = {}) => renderAt("/studio", createElement(StudioScreen), p);

/** The text of the section headed `title`, up to the next section. */
function section(html: string, title: string): string {
  const at = html.indexOf(`>${title}</h2>`);
  expect(at, title).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", at);
  return html.slice(at, end);
}

describe("the Studio home", () => {
  it("is a page titled Studio with one labelled search field", () => {
    const html = home();
    expect(html).toContain("<h1>Studio</h1>");
    expect(html).toMatch(/<div class="search-field" role="search">/);
    expect(html).toMatch(/<input[^>]*type="search"/);
    expect(html).toContain('placeholder="Search moves, muscles, tags"');
    // A visible-or-not label is still a label: the input is named.
    const id = /<input[^>]*id="([^"]+)"/.exec(html)![1]!;
    expect(html).toContain(`<label class="visually-hidden" for="${id}">Search moves</label>`);
  });

  it("leaves the coach composer's slot at the top, empty (Stage 3)", () => {
    const html = home();
    expect(html).toContain('<div class="stu-composer-slot" data-slot="coach-composer"></div>');
    expect(html.indexOf('role="search"')).toBeLessThan(html.indexOf("coach-composer"));
    expect(html.indexOf("coach-composer")).toBeLessThan(html.indexOf(">Quick starts</h2>"));
  });

  it("renders quick starts, browse, themes and tags, in that order, and no result list", () => {
    const html = home();
    const order = ["Quick starts", "Browse", "Themes", "Tags"].map((t) => html.indexOf(`>${t}</h2>`));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("stu-list");
  });

  it("quick starts: desk reset and hip opener with their lengths; condition care only with a profile on", () => {
    const plain = text(section(home(), "Quick starts"));
    expect(plain).toContain("Desk reset 8 min");
    expect(plain).toContain("Hip opener 10 min");
    expect(plain).not.toContain("Jaw care");
    const cared = text(section(home({ library: libraryDto({ tmj: true }) }), "Quick starts"));
    // The profile's own care block names it, and it comes first.
    expect(cared.indexOf("Jaw care 5 min")).toBeGreaterThan(-1);
    expect(cared.indexOf("Jaw care")).toBeLessThan(cared.indexOf("Desk reset"));
  });

  it("browse: every move, then the parts in a workout's order, labelled by the vocabulary", () => {
    const chips = [...section(home(), "Browse").matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);
    expect(chips).toEqual([
      "All moves",
      ...["warmup", "activation", "strength", "power", "balance", "mobility", "stretch", "recovery", "cooldown"].map(label),
    ]);
    // The purpose reads as itself, not as the movement pattern's "Mobility work".
    expect(chips).toContain("Mobility");
    // Condition care is a part only while a profile is on; conditioning has no moves yet, so no chip.
    const cared = section(home({ library: libraryDto({ tmj: true }) }), "Browse");
    expect(text(cared)).toContain(label("condition-care"));
    expect(text(cared)).not.toContain(label("conditioning"));
  });

  it("themes: each with how many moves it opens; a profile's own theme only with that profile on", () => {
    const html = section(home(), "Themes");
    const n = studioResults(EXERCISES, "", { theme: "hipsPosture" }, emptyStudioCtx).length;
    expect(n).toBeGreaterThan(0);
    expect(text(html)).toContain(`Hips & posture ${n} moves`);
    expect(text(html)).toContain("Ski prep");
    expect(text(html)).not.toContain("Jaw reset");
    expect(text(section(home({ library: libraryDto({ tmj: true }) }), "Themes"))).toContain("Jaw reset + easy flow");
  });

  it("theme counts are what a tap would show: today's fit and the place's gear count", () => {
    // A bare mat: every theme that needs a weight shows fewer moves than the library holds for it.
    const gearless = section(home({ places: placesDto(["mat"]) }), "Themes");
    const all = studioResults(EXERCISES, "", { theme: "carryDay" }, emptyStudioCtx).length;
    const atMat = studioResults(EXERCISES, "", { theme: "carryDay" }, { ...emptyStudioCtx, place: { name: "Home", equipment: ["mat"] } }).length;
    expect(atMat).toBeLessThan(all);
    expect(text(gearless)).toContain(`Carry day ${atMat} move`);
    // …and on a flare day, the moves today's reading rules out are not counted.
    const flare = section(home({ library: libraryDto({ tmj: true }), today: todayDto({ value: 8 }) }), "Themes");
    const ski = /Ski prep (\d+) move/.exec(text(flare))![1]!;
    expect(Number(ski)).toBeLessThan(studioResults(EXERCISES, "", { theme: "skiPrep" }, emptyStudioCtx).length);
  });

  it("a theme with nothing for today says why, rather than promising 0 moves", () => {
    // Jumps need an answered, calm jaw check: with none yet, the jumping theme has nothing that fits today.
    const html = section(home({ library: libraryDto({ tmj: true }) }), "Themes");
    expect(text(html)).toContain("Jumps and landings None fit today");
    expect(text(html)).not.toContain("0 moves");
    // A bare mat has no carry gear: the card names the place instead.
    const mat = section(home({ places: placesDto(["mat"]) }), "Themes");
    expect(text(mat)).toMatch(/Carry day (\d+ moves?|None at Home)/);
  });

  it("tags: the vocabulary's tags that have moves, by their labels", () => {
    const plain = text(section(home(), "Tags"));
    for (const t of ["posture", "ski", "hip-opening", "single-leg", "landing", "desk-relief"]) expect(plain).toContain(label(t));
    // No move carries these yet: no chip that would open an empty list.
    expect(plain).not.toContain("Isometric hold");
    expect(plain).not.toContain("Rotational");
  });

  it("tags: the eight most used show; the rest are one tap down behind More tags", () => {
    const html = section(home(), "Tags");
    const used = (t: string) => EXERCISES.filter((e) => e.tags.includes(t as never)).length;
    const shownFirst = [...html.slice(0, html.indexOf("stu-more")).matchAll(/<button type="button" class="chip">([^<]*)<\/button>/g)].map((m) => m[1]!);
    expect(shownFirst).toHaveLength(8);
    // The most used first: desk relief (the library's most tagged) leads.
    expect(shownFirst[0]).toBe(label("desk-relief"));
    const counts = shownFirst.map((l) => used(TAGS.find((t) => label(t) === l)!));
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    // The rest are in the DOM, hidden, under a disclosure that names what it opens.
    const more = /<button type="button" class="linklike stu-more-btn tap-pad" aria-expanded="false" aria-controls="([^"]+)">More tags<\/button>/.exec(html);
    expect(more, "More tags").not.toBeNull();
    expect(html).toMatch(new RegExp(`<span id="${more![1]}" class="stu-more" hidden="">`));
  });

  it("the balance tag is not a second Balance chip beside the Balance part", () => {
    const html = home();
    expect([...text(section(html, "Tags")).matchAll(/\bBalance\b/g)]).toHaveLength(0);
    expect(text(section(html, "Browse"))).toContain("Balance");
  });

  it("themes are one row of compact tiles, not a grid of cards", () => {
    const html = section(home(), "Themes");
    expect(html).toContain('class="stu-themes"');
    expect([...html.matchAll(/class="stu-theme"/g)]).toHaveLength(10);
  });

  it("every browse, theme and tag control is a real button", () => {
    const html = home();
    for (const t of ["Browse", "Themes", "Tags"]) {
      const s = section(html, t);
      expect(s, t).toMatch(/<button type="button"/);
      expect(s, t).not.toMatch(/<a /);
    }
  });
});
