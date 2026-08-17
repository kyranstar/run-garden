/**
 * The race strip: labelled, and one deliberate shape at every width.
 *
 * Two reports from production. (1) "the race bar at the top of the plan pages
 * runs onto the next line on mobile" — measured before the fix: two ragged
 * lines at 320/360/390 (at 390 the second line held nothing but "0/5 ▸"), one
 * line at 430 and above. There is no width at which ~350px of content fits a
 * 240px phone card, so the wrap is now designed: a headline row and a meta row
 * on a phone, one row from `sm`. (2) "the whole section should be labeled" —
 * the strip was a bare countdown with no name of any kind.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { RaceHubResponse } from "@rg/api-client";
import { RaceStrip } from "../src/screens/race-strip.js";

/** Comments in this sheet quote the very declarations these scans count (the
 * two-row rule's own comment names `flex-wrap`, which it replaced), so every
 * textual assertion reads CSS only — same `decomment` rule as the other
 * suites. */
const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
/** One CSS rule's declarations, by its exact selector text. */
const cssRule = (selector: string) => {
  const from = css.indexOf(`${selector} {`);
  expect(from, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(from, css.indexOf("}", from));
};
/** The declarations a selector carries inside a given media condition — the
 * sheet has several blocks per tier, so every one of them is searched. */
const inMedia = (condition: string, selector: string) => {
  const opens = [...css.matchAll(new RegExp(`@media ${condition.replace(/[()]/g, "\\$&")}`, "g"))];
  expect(opens.length, `no @media ${condition}`).toBeGreaterThan(0);
  for (const open of opens) {
    const block = css.slice(open.index!, css.indexOf("\n}", open.index!));
    const at = block.indexOf(`${selector} {`);
    if (at !== -1) return block.slice(at, block.indexOf("}", at));
  }
  return null;
};

function hub(over: Partial<NonNullable<RaceHubResponse["race"]>> = {}): RaceHubResponse {
  return {
    race: {
      raceDate: "2026-10-11",
      daysToRace: 55,
      taperStartDate: "2026-09-20",
      phase: "build",
      goal: {
        thresholdPaceSecPerKm: 258,
        asOf: "2026-08-14",
        prediction: {
          distanceKm: 21.0975,
          fastSecPerKm: 264,
          slowSecPerKm: 272,
          fastSeconds: 5570,
          slowSeconds: 5739,
        },
      },
      terrain: { recent: null, raceMetresPerKm: null, comparison: null },
      stamina: [],
      checklist: [
        { id: "c1", kind: "user", label: "Bib pickup sorted", done: false },
        { id: "c2", kind: "user", label: "Kit laid out", done: true },
      ],
      raceLine: null,
      debrief: null,
      ...over,
    },
  } as unknown as RaceHubResponse;
}

function render(data: RaceHubResponse): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["race-hub"], data);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(RaceStrip, { units: "km" as const })),
  );
}

describe("the section says what it is", () => {
  it("wears the app's one eyebrow, inside the heading that carries the outline", () => {
    const html = render(hub());
    expect(html).toContain('aria-label="Race day"');
    expect(html).toContain('<h2 class="race-strip-h">');
    expect(html).toContain('<span class="card-title race-strip-eyebrow">Race day</span>');
    // `.card-title` IS the uppercase rule (scales.test.tsx asserts there is
    // exactly one) — the label must not bring a second one.
    expect(cssRule(".race-strip-eyebrow")).not.toContain("text-transform");
    // The label sits above the trigger, and the trigger's pad reaches 12px up,
    // so that is the room the label actually leaves.
    expect(cssRule(".race-strip-eyebrow")).toContain("margin-bottom: var(--space-5)");
  });

  it("labels the post-race state the same way, and gives it the heading it never had", () => {
    const html = render(hub({ phase: "post", debrief: null }));
    expect(html).toContain('aria-label="Race day"');
    expect(html).toContain('<span class="card-title race-strip-eyebrow">Race day</span>');
    expect(html).toContain("Race day was Oct 11");
  });
});

describe("the collapsed line's shape", () => {
  const html = render(hub());

  it("is a headline row and a meta row, in reading order", () => {
    const lead = html.indexOf("race-strip-lead");
    const meta = html.indexOf("race-strip-meta");
    const caret = html.indexOf("race-caret");
    expect(lead).toBeGreaterThan(-1);
    expect(meta).toBeGreaterThan(lead);
    expect(caret).toBeGreaterThan(meta);
  });

  it("keeps every fact the wrapping row carried, and labels the checklist count", () => {
    expect(html).toContain("55 days");
    expect(html).toContain("Oct 11");
    expect(html).toContain("building");
    expect(html).toContain("4:24–4:32 /km");
    // "1/2" alone said nothing about what was counted.
    expect(html).toContain("prep 1/2");
  });

  it("is two rows on a phone and one row from sm — with no max-width query", () => {
    const base = cssRule(".race-strip-toggle");
    expect(base).toContain("display: grid");
    expect(base).toContain('"lead caret"');
    expect(base).toContain('"meta meta"');
    expect(base).not.toContain("flex-wrap");
    const sm = inMedia("(min-width: 640px)", ".race-strip-toggle");
    expect(sm).not.toBeNull();
    expect(sm!).toContain('grid-template-areas: "lead meta caret"');
    // System 3: three tiers, all min-width. The strip may not add a fourth or
    // invert one.
    expect(css).not.toMatch(/@media[^{]*max-width/);
  });

  it("keeps the button's own chrome reset (System 4 D9) and its type tokens", () => {
    const base = cssRule(".race-strip-toggle");
    for (const decl of ["appearance: none", "background: none", "border: 0", "font: inherit", "color: inherit"]) {
      expect(base).toContain(decl);
    }
    expect(cssRule(".race-strip-meta")).toContain("font-size: var(--text-xs)");
  });
});

describe("opening it moves nothing above it", () => {
  it("drops only the goal band from the collapsed line — the meta row still holds date and phase", () => {
    // The band is the one thing the open body repeats in full ("Goal pace"),
    // so it is the one thing the collapsed line stops saying. Everything else
    // stays, which is why the trigger stays the same height (measured: 45.2px
    // collapsed and 45.2px open at 320–430, 24px at 1440).
    const src = readFileSync(fileURLToPath(new URL("../src/screens/race-strip.tsx", import.meta.url)), "utf8");
    expect(src).toContain("goalMini && !open");
    expect(src).toMatch(/race-strip-meta[\s\S]{0,200}formatShortDate\(race\.raceDate\)/);
    expect(src).toMatch(/race-strip-meta[\s\S]{0,300}PHASE_LABEL\[race\.phase\]/);
  });
});
