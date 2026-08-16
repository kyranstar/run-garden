/**
 * System 3 — One responsive system. The invariant behind the measured sprawl:
 * there is ONE set of breakpoints, charts size to the box they are in rather
 * than to a constant, and every screen's information exists at every width.
 *
 * Four kinds of assertion, all cheap and all regression-shaped:
 *  - stylesheet as text: how many breakpoints there are, that none of them is
 *    a `max-width`, and which rules are allowed to live inside one;
 *  - arithmetic: the chart sizing layer, whose whole contract is that a
 *    label's rendered size does not depend on its container's;
 *  - markup: `GardenBody` places every part of the garden, in hierarchy order,
 *    from ONE tree — so a part cannot land on one viewport only;
 *  - source: the two places where a constant would silently re-introduce the
 *    thing being fixed (a chart's viewBox, a chart's label size).
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CHART_LABEL_PX,
  CHART_MIN_WIDTH,
  chartWidth,
  labelStride,
} from "../src/chart-kit.js";
import { heatCellStep } from "../src/charts.js";
import {
  GARDEN_PART_KEYS,
  GardenBody,
  defaultDockOpen,
  dockCoversStage,
  type GardenParts,
} from "../src/screens/garden.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const rawCss = read("../src/styles.css");
/** Comments name breakpoints in prose all over this sheet; only rules count. */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");
const gardenSrc = read("../src/screens/garden.tsx");
const chartsSrc = read("../src/charts.tsx");
const kitSrc = read("../src/chart-kit.tsx");
/** The plan progressions — the app's SECOND chart layer, and the one this
 *  system missed on its first pass. */
const planSrc = read("../src/screens/plan-charts.tsx");

interface MediaBlock {
  condition: string;
  body: string;
}

/** Every `@media` block in the sheet, with its condition and its declarations. */
function mediaBlocks(): MediaBlock[] {
  const out: MediaBlock[] = [];
  const re = /@media ([^{]+)\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const open = m.index + m[0].length;
    let depth = 1;
    let i = open;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push({ condition: m[1]!.trim(), body: css.slice(open, i - 1) });
  }
  return out;
}

const blocks = mediaBlocks();
const widthBlocks = blocks.filter((b) => b.condition.includes("width"));
/** Everything NOT inside a media query — the mobile-first base layer. */
const baseLayer = (() => {
  let out = css;
  for (const b of blocks) out = out.replace(b.body, "");
  return out;
})();

// ── 1. Three breakpoints, and they are declared once ───────────────────────

describe("there are three breakpoints", () => {
  const declared = Object.fromEntries(
    [...css.matchAll(/^\s*--bp-(sm|md|lg):\s*(\d+)px;/gm)].map((m) => [m[1]!, Number(m[2]!)]),
  );

  it("`:root` declares sm/md/lg, ascending, and nothing else calls itself a breakpoint", () => {
    expect(declared).toEqual({ sm: 640, md: 900, lg: 1024 });
    expect([...css.matchAll(/--bp-[a-z]+:/g)]).toHaveLength(3);
  });

  it("every width query uses one of exactly those three values", () => {
    const values = new Set<number>();
    for (const b of widthBlocks) {
      for (const m of b.condition.matchAll(/(\d+)px/g)) values.add(Number(m[1]!));
    }
    // Nine before this: 480, 639, 640(min), 640(max), 720, 760, 900, 1023, 1024.
    expect([...values].sort((a, b) => a - b)).toEqual([640, 900, 1024]);
  });

  it("no layout query is a `max-width` — there are no justified exceptions left", () => {
    // `max-width: 640` and `min-width: 640` BOTH match at exactly 640px, which
    // is what made a 640px viewport render a hybrid: `.workout-row`/`.act-card`
    // in their phone form while `.race-cols`/`.plan-card-row` were already in
    // their desktop one, with `.brief-wide` long-form prose inside it. Every
    // one of those is now a single `min-width` on the same number, so 640px is
    // unambiguously the small-tablet layout and 639px is unambiguously the
    // phone one.
    const offenders = widthBlocks.filter((b) => b.condition.includes("max-width"));
    expect(offenders.map((b) => b.condition)).toEqual([]);
  });

  it("the four rules that disagreed about 640 now agree", () => {
    const sm = widthBlocks.filter((b) => b.condition === "(min-width: 640px)");
    const smBody = sm.map((b) => b.body).join("\n");
    for (const sel of [".workout-row", ".act-card", ".race-cols", ".plan-card-row", ".brief-wide"]) {
      expect(smBody, sel).toContain(sel);
    }
    // …and each of them has a phone form in the BASE layer, so the phone
    // layout is what you get by writing no query at all.
    for (const sel of [".workout-row .body {", ".act-card {", ".race-cols {", ".brief-wide,"]) {
      expect(baseLayer, sel).toContain(sel);
    }
  });
});

// ── 2. The md tier does something ──────────────────────────────────────────

describe("the tablet tier is a real tier", () => {
  const md = widthBlocks.filter((b) => b.condition === "(min-width: 900px)");
  const lg = widthBlocks.filter((b) => b.condition === "(min-width: 1024px)");

  it("the reading column widens at md instead of staying a phone column to 1024", () => {
    // Base 700 → md 860 → lg 880. Between 700 and 1024 every page used to be
    // a 700px column with a phone's gutters and a bottom nav.
    expect(baseLayer).toMatch(/\.shell-main \{[\s\S]*?max-width: 700px;/);
    const mdMain = md.find((b) => b.body.includes(".shell-main"));
    expect(mdMain?.body).toContain("max-width: 860px");
    // The bottom nav is still present at md, so the clearance is re-stated.
    expect(mdMain?.body).toContain("var(--nav-height)");
    expect(lg.some((b) => /\.shell-main \{[\s\S]*?max-width: 880px/.test(b.body))).toBe(true);
  });

  it("charts pair at md, never below it", () => {
    // `.aerobic-pair` split at 720px inside a 700px column: each chart got
    // ~326px and its labels rendered at 5.0 CSS px, against 9.0 one pixel
    // earlier in the one-column layout.
    const mdBody = md.map((b) => b.body).join("\n");
    for (const sel of [".aerobic-pair", ".studio-modal-charts"]) {
      expect(mdBody, sel).toContain(`${sel} {`);
      expect(mdBody, sel).toContain("grid-template-columns: 1fr 1fr");
    }
    const sm = widthBlocks
      .filter((b) => b.condition === "(min-width: 640px)")
      .map((b) => b.body)
      .join("\n");
    for (const sel of [".aerobic-pair", ".studio-modal-charts"]) expect(sm, sel).not.toContain(sel);
  });

  it("`--wide` is scoped to lg instead of beating every other page at every width", () => {
    // It sat outside any media query, later in source at equal specificity, so
    // it won over `.shell-main`'s own max-width everywhere: on a 768px tablet
    // Plan ran full-bleed while every other page was capped at 700.
    expect(baseLayer).not.toContain(".shell-main--wide");
    const owner = widthBlocks.filter((b) => b.body.includes(".shell-main--wide"));
    expect(owner).toHaveLength(1);
    expect(owner[0]!.condition).toBe("(min-width: 1024px)");
    expect(owner[0]!.body).toContain("max-width: 1440px");
  });

  it("the minimized coach pill does not reserve room for a nav that isn't there", () => {
    // It inherits `.coach-pill`, which clears the MOBILE bottom nav. There is
    // no bottom nav at lg — it is `display: none` from 1024 — and this pill
    // only ever renders there.
    const mobile = css.slice(css.indexOf("\n.coach-pill {"));
    expect(mobile.slice(0, mobile.indexOf("}"))).toContain("var(--nav-height)");
    const desktop = css.slice(css.indexOf("\n.coach-pill--desktop {"));
    const body = desktop.slice(0, desktop.indexOf("}"));
    expect(body).toContain("bottom:");
    expect(body).not.toContain("--nav-height");
  });
});

// ── 3. A chart label is the same size in every box ─────────────────────────

/**
 * What a `fontSize={CHART_LABEL_PX}` label actually measures on screen: the
 * SVG renders at `min(container, viewBoxWidth)` (that is `width: 100%` capped
 * by `max-width`), so the scale factor is rendered ÷ viewBox.
 */
function labelCssPx(container: number, cap: number): number {
  const viewBox = chartWidth(container, cap);
  return CHART_LABEL_PX * (Math.min(container, viewBox) / viewBox);
}

describe("chart labels are a CSS size, not a viewBox size", () => {
  // 390px phone column, md half-column, the 719/720 cliff, the lg column, a
  // 1440px window, and a drilldown sheet's inner width.
  const CONTAINERS = [326, 358, 418, 430, 560, 668, 719, 720, 852, 880, 1440];

  it("every realistic container renders the label at exactly CHART_LABEL_PX", () => {
    for (const cap of [560, 420]) {
      for (const c of CONTAINERS) {
        expect(labelCssPx(c, cap), `${c}px container, ${cap} cap`).toBeCloseTo(CHART_LABEL_PX, 6);
      }
    }
  });

  it("crossing the old cliff changes nothing at all", () => {
    // The measured defect: 9.0 CSS px at 719 (one column, chart at its 560
    // max), 5.0 CSS px at 720 (two columns of ~310). Same number now.
    expect(labelCssPx(719, 560)).toBeCloseTo(labelCssPx(720 / 2 - 8, 560), 6);
    expect(labelCssPx(326, 560)).toBeCloseTo(labelCssPx(1440, 560), 6);
  });

  it("the viewBox is the rendered width, which is what makes a unit a pixel", () => {
    for (const c of CONTAINERS) {
      const vb = chartWidth(c, 560);
      expect(Math.min(c, vb), `${c}`).toBe(vb);
    }
  });

  it("measuring can only make a chart narrower than its design width", () => {
    expect(chartWidth(1440, 560)).toBe(560);
    expect(chartWidth(1440, 420)).toBe(420);
    expect(chartWidth(326, 560)).toBe(326);
  });

  it("an unmeasured (or server-rendered) chart falls back to its design width", () => {
    expect(chartWidth(null, 560)).toBe(560);
    expect(chartWidth(0, 560)).toBe(560);
    expect(chartWidth(Number.NaN, 560)).toBe(560);
  });

  it("a box narrower than any real layout is the one place scaling is allowed", () => {
    // Below the floor the geometry stops being a chart (a 40px left gutter out
    // of 200 is most of the plot), so the SVG scales down instead — the old
    // behaviour, in a box no layout produces. The narrowest real container is
    // a 390px phone: 390 − 2×16 shell − 2×16 card = 326.
    expect(chartWidth(180, 560)).toBe(CHART_MIN_WIDTH);
    expect(labelCssPx(180, 560)).toBeLessThan(CHART_LABEL_PX);
    expect(CHART_MIN_WIDTH).toBeLessThan(326);
  });

  it("the heatmap fills its box by resizing its CELLS, so its labels are pixels too", () => {
    // Its width is intrinsic (a week is a column), so it takes the layer from
    // the other end. Cells GROW on a phone rather than shrinking.
    const columns = 14;
    for (const c of [326, 418, 560, 880]) {
      const step = heatCellStep(c, columns);
      const width = 26 + columns * step + 2;
      expect(width, `${c}`).toBeLessThanOrEqual(c);
      expect(labelCssPx(width, width)).toBeCloseTo(CHART_LABEL_PX, 6);
    }
    // Clamped at both ends: never smaller than a target, never a wall of tiles.
    expect(heatCellStep(200, 52)).toBe(14);
    expect(heatCellStep(2000, 4)).toBe(26);
    expect(heatCellStep(null, 14)).toBe(18);
  });

  it("x labels stride by the room they have, not by a constant tuned for 560", () => {
    // 12 weeks of "May 12" at 10px: comfortable in a 510px plot, every other
    // one in half of it.
    expect(labelStride(11, 510, 46)).toBe(1); // 11 fit in a 560-wide chart
    expect(labelStride(11, 276, 46)).toBe(2); // …every other one in half of it
    expect(labelStride(40, 276, 46)).toBe(7);
    expect(labelStride(3, 40, 46)).toBe(2); // never divides by zero labels
  });
});

describe("nothing in either chart layer can re-introduce a fixed size", () => {
  /**
   * BOTH layers. The Insights charts (charts.tsx) and the plan progressions
   * (screens/plan-charts.tsx) are separate files with separate authors, and
   * this system's first pass reached only the first of them: plan-charts.tsx
   * kept a fixed `VB_W = 320` viewBox scaled by CSS and nine `fontSize="9"`
   * for three more days, on the studio modal, where a measured sweep found its
   * labels at 8.4 CSS px in a two-column modal and 33.8 in a wide one.
   */
  it("every chart builds its viewBox from a measured width", () => {
    for (const [name, code, count] of [
      ["charts.tsx", chartsSrc, 6],
      ["screens/plan-charts.tsx", planSrc, 2],
    ] as const) {
      expect([...code.matchAll(/^\s*const (?:width|VB_W) = (\d+);/gm)].map((m) => m[0]!.trim()), name).toEqual([]);
      expect([...code.matchAll(/const width = chartWidth\(measured, [\w\d]+\)/g)].length, name).toBe(count);
    }
  });

  it("both layers measure with the ONE hook, rather than each rolling its own", () => {
    // A second ResizeObserver in a second file is how the two layers came to
    // disagree about what "the chart's box" is in the first place.
    expect(planSrc).toContain("useMeasuredWidth");
    expect([...planSrc.matchAll(/ResizeObserver/g)]).toEqual([]);
    expect([...chartsSrc.matchAll(/ResizeObserver/g)]).toEqual([]);
    expect([...kitSrc.matchAll(/new ResizeObserver/g)]).toHaveLength(1);
  });

  it("the viewBox width and the SVG's max-width are always the same number", () => {
    // `svgStyle(x)` sets `max-width: x`; the viewBox is `0 0 ${w} …`. If those
    // two ever differ, the scale factor is back and so is the whole defect.
    const pattern = /viewBox=\{`0 0 \$\{(\w+)\} [^`]*`\}\s*\n\s*style=\{svgStyle\(([^)]*)\)\}/g;
    const svgs = [...chartsSrc.matchAll(pattern), ...planSrc.matchAll(pattern)];
    expect(svgs.length).toBe(9);
    for (const m of svgs) expect(m[2]!.trim(), m[0]).toBe(m[1]!.trim());
  });

  it("every label is the one size token, with no raw font sizes left", () => {
    // All three files, because scanning only the first is how `fontSize={9.5}`
    // survived inside chart-kit's ReferenceLine — and scanning only the first
    // two is how nine `fontSize="9"` survived in plan-charts.tsx. See
    // chart-annotations.test.ts, which owns this invariant now and also
    // measures where those labels ended up.
    const code = [chartsSrc, kitSrc, planSrc]
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // Fifteen in the Insights layer plus three in the plan layer (its week
    // labels, its unit, its point callouts — the y axis is `GridLines`, which
    // both layers now import from chart-kit rather than keeping a copy of).
    expect([...code.matchAll(/fontSize=\{CHART_LABEL_PX\}/g)].length).toBe(18);
    expect([...code.matchAll(/fontSize=\{[\d.]+\}/g)].map((m) => m[0])).toEqual([]);
    expect([...code.matchAll(/fontSize="[^"]*"/g)].map((m) => m[0])).toEqual([]);
  });
});

// ── 4. The garden is one tree ──────────────────────────────────────────────

describe("the garden's information exists at every width", () => {
  /** A parts record whose every slot is a findable marker. */
  const marked = Object.fromEntries(
    GARDEN_PART_KEYS.map((k) => [k, createElement("i", { "data-part": k })]),
  ) as unknown as GardenParts;
  const html = renderToStaticMarkup(createElement(GardenBody, { parts: marked }));

  it("every named part is placed, exactly once", () => {
    // The failure this prevents: `DockVerdict` (the readiness verdict), the
    // coach's weekly line and the attention link shipped into the desktop tree
    // only, so a phone user had never seen the readiness card at all. They were
    // not desktop treatments of shared features — they were features a phone
    // could not reach.
    for (const key of GARDEN_PART_KEYS) {
      const hits = [...html.matchAll(new RegExp(`data-part="${key}"`, "g"))];
      expect(hits, key).toHaveLength(1);
    }
  });

  it("places them in hierarchy order, so reading order and tab order agree", () => {
    const order = [...html.matchAll(/data-part="(\w+)"/g)].map((m) => m[1]!);
    expect(order).toEqual([...GARDEN_PART_KEYS]);
  });

  it("DOM order is the STACK order — the dock before the bars", () => {
    // Measured: with the bars first, opening a bar's detail pushed the
    // readiness verdict (and everything under it) down 184px, because the
    // detail expanded ABOVE the dock in the stack. The stage already ranks
    // them this way — the dock is bottom-left, the bars are top-right
    // peripheral furniture — so the stack was the one disagreeing.
    const order = [...html.matchAll(/data-part="(\w+)"/g)].map((m) => m[1]!);
    expect(order.indexOf("dock")).toBeLessThan(order.indexOf("balance"));
    // …and the parts a reader meets before either of them, in that order.
    expect(order.slice(0, 5)).toEqual(["scene", "condition", "beat", "ceremony", "dock"]);
  });

  it("nothing below lg may reshuffle the dock's DOM order", () => {
    // `.hud-dock`'s children were written for the stage (panel → pill →
    // attention) and flipped back with `order: 1/2/3` below lg, so tab reached
    // the panel's contents at y=851…1082 and then jumped 576px BACK UP to the
    // pill at y=506. The rule that prevents the whole family of that bug:
    // this sheet is mobile-first, so no garden part may carry `order` at all
    // — the one genuine disagreement is expressed as POSITION on the stage,
    // where the box is an overlay anyway and reflows nothing.
    const gardenOrder = [...css.matchAll(/\.(hud|dock|balance|garden|stage)[\w-]*[^{}]*\{[^}]*?\border:\s*\d/g)];
    expect(gardenOrder.map((m) => m[0].slice(0, 60))).toEqual([]);
    for (const sel of [".dock-pill", ".dock-panel", ".dock-attention", ".hud-dock"]) {
      const rules = [...css.matchAll(new RegExp(`\\${sel} \\{([^}]*)\\}`, "g"))];
      for (const r of rules) expect(r[1], `${sel}: ${r[1]!.trim()}`).not.toMatch(/\border:/);
    }
    // The stage's one disagreement, and what shape it has to take.
    const stage = widthBlocks.find(
      (b) => b.condition === "(min-width: 1024px)" && b.body.includes(".garden-stage {"),
    )!;
    expect(stage.body).toMatch(/\.dock-panel \{[\s\S]*?position: absolute;/);
    expect(stage.body).toMatch(/\.dock-panel \{[\s\S]*?bottom: calc\(100% \+ var\(--tap-clear\)\);/);
  });

  it("the screen returns that one body and nothing else", () => {
    // Two returns is how the two trees drifted in the first place.
    expect([...gardenSrc.matchAll(/return <GardenBody /g)]).toHaveLength(1);
    expect(gardenSrc).not.toContain("if (isDesktop)");
    // The tier is allowed to be KNOWN — the dock's default state genuinely
    // differs between an in-flow accordion and an overlay on a stage, and
    // asking `matchMedia` the same 1024 the stylesheet uses is how that
    // answer stays in agreement with the CSS. What it may never do is choose
    // between trees or between parts, so it may not appear in a conditional
    // that produces markup.
    for (const line of gardenSrc.split("\n").filter((l) => /\bisDesktop\b/.test(l))) {
      expect(line, line.trim()).not.toContain("<");
      expect(line, line.trim()).not.toMatch(/\bisDesktop\b\s*\?/); // never a ternary subject
    }
    // Four mentions, and every one of them is the same decision: the pure
    // helper's parameter and its single use, then the live subscription and
    // the one call that reads it. Nothing else in the file knows the tier.
    expect([...gardenSrc.matchAll(/\bisDesktop\b/g)].length).toBe(4);
  });

  it("the parts that were stage-only carry real content on the shared tree", () => {
    // Named in the type, so a future part has to be declared before it can be
    // forgotten. `dock` is the verdict + the coach's line + the attention link.
    for (const key of ["dock", "rail", "balance", "condition"]) {
      expect(GARDEN_PART_KEYS as readonly string[], key).toContain(key);
    }
    expect(gardenSrc).toContain("<DockVerdict verdict={d.readiness.verdict} focus={d.focus} />");
    expect(gardenSrc).toContain('className="dock-attention"');
  });
});

describe("the garden's hierarchy is not lg-only styling", () => {
  const lgBody = widthBlocks
    .filter((b) => b.condition === "(min-width: 1024px)")
    .map((b) => b.body)
    .join("\n");

  it("every HUD/dock class is styled in the BASE layer, not only on the stage", () => {
    // 84 rule blocks lived inside `@media (min-width: 1024px)` and ~66 of them
    // were the stage. Below it the garden had `display: flex; gap` and nothing
    // else — no verdict, no coach line, no rail.
    for (const sel of [
      ".garden-scene",
      ".hud-topleft",
      ".hud-condition",
      ".hud-weather",
      ".hud-beat",
      ".hud-beat-label",
      ".hud-dock",
      ".dock-pill",
      ".dock-panel",
      ".dock-verdict",
      ".dock-verdict-why",
      ".dock-verdict-coach",
      ".dock-attention",
      ".hud-corner",
      ".hud-nudge",
      ".hud-rail",
      ".garden-below",
    ]) {
      expect(baseLayer, sel).toContain(`${sel} {`);
    }
  });

  it("the stage block only MOVES and re-paints those parts", () => {
    // Every selector the STAGE block styles must already exist below it. A
    // class appearing for the first time inside the stage is the exact shape
    // of a feature only desktop will ever get — which is how the readiness
    // verdict came to be desktop-only in the first place.
    const stage = widthBlocks.find(
      (b) => b.condition === "(min-width: 1024px)" && b.body.includes(".garden-stage {"),
    )!;
    const introduced = [...stage.body.matchAll(/^\s{2}([.#][\w-]+)[^{]*\{/gm)]
      .map((m) => m[1]!)
      .filter((sel) => !baseLayer.includes(sel));
    // The allowed exceptions, and they are all one of two things: a box that
    // exists only to POSITION a part (it carries no content and paints
    // nothing below lg), or a modifier whose whole meaning is "this is
    // printed on the artwork". Neither can be a feature.
    expect([...new Set(introduced)].sort()).toEqual([
      ".hud-forecast", // a modifier meaning "this line is on the artwork"
      ".hud-topright", // a positioning box for `parts.balance`
      ".shell-main--immersive", // the shell's own stage modifier
      ".stage-scene-svg", // the scene's <svg>, absolutely filling the stage
      ".stage-scrim-bottom", // ┐ artwork scrims: nothing to lift type off
      ".stage-scrim-top", //    ┘ when the type is on the page
    ]);
  });

  it("the garden's own parts emit no class whose every rule is lg-only", () => {
    // `variant="hud"` was passed unconditionally and produced
    // `.balance-strip-hud` / `.balance-detail-hud` at every width, while every
    // rule either one enabled lived inside the stage block. So on a phone the
    // class was inert — a dead prop that read like a mobile/desktop switch it
    // was not. Printed-on-artwork is a property of WHERE a part sits, and the
    // stage's own positioning box (`.hud-topright`) is what selects it now.
    for (const sel of [".balance-strip-hud", ".balance-detail-hud"]) {
      expect(css, sel).not.toContain(sel);
      expect(gardenSrc, sel).not.toContain(sel.slice(1));
    }
    expect(gardenSrc).not.toContain('variant === "hud"');
    // `.ceremony-hud` (arrival-block.tsx) is the same shape and is deliberately
    // still here: the component that emits it is outside this change's scope,
    // and moving the CSS alone would leave a class with no rules at all —
    // strictly worse. Asserted so it cannot be forgotten, and so a THIRD one
    // cannot appear quietly.
    const hudVariants = [...rawCss.matchAll(/\.([\w-]+-hud)\b/g)].map((m) => m[1]!);
    expect([...new Set(hudVariants)]).toEqual(["ceremony-hud"]);
  });

  it("the readiness verdict's colour vocabulary is declared once, in the base", () => {
    for (const level of ["good", "caution", "poor"]) {
      expect(baseLayer).toContain(`.dock-verdict-${level} {`);
      expect(lgBody).not.toContain(`.dock-verdict-${level} {`);
    }
    // Colour is never the only signal: the pill carries a left EDGE in the
    // same token, and the phrase inside says the level in words.
    expect(baseLayer).toMatch(/\.dock-pill \{[\s\S]*?border-left: 3px solid var\(--verdict-ink/);
  });
});

// ── 5. A bar's colour means the same thing at every width ──────────────────

/** Crude but sufficient (id, class, type) specificity for the flat selectors
 *  in this sheet. `:where()` contributes nothing, which is the whole point. */
function specificity(selector: string): number {
  const stripped = selector.replace(/:where\([^)]*\)/g, "");
  const ids = (stripped.match(/#[\w-]+/g) ?? []).length;
  const classes = (stripped.match(/[.:[][\w-]+/g) ?? []).length;
  const types = (stripped.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

describe("a balance bar encodes ONE thing, and it is the same thing at every width", () => {
  /** Every `background` declaration on a `.balance-bar-fill`, with the layer
   *  it lives in — so the two layers can be checked independently. */
  function fillRules(body: string) {
    return [...body.matchAll(/([^{}]*\.balance-bar-fill[^{}]*)\{([^}]*)\}/g)]
      .map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
      .filter((r) => /background(-color)?:/.test(r.body));
  }
  const layers = {
    base: fillRules(baseLayer),
    stage: fillRules(widthBlocks.find((b) => b.body.includes(".hud-topright {"))!.body),
  };

  it("both layers paint both meanings — neither is width-dependent", () => {
    for (const [name, rules] of Object.entries(layers)) {
      const sels = rules.map((r) => r.selector);
      expect(sels.filter((s) => s.includes("balance-low")), name).toHaveLength(1);
      for (const disc of ["balance-run", "balance-strength", "balance-yoga"]) {
        expect(sels.filter((s) => s.includes(disc)), `${name} ${disc}`).toHaveLength(1);
      }
    }
  });

  it("status outranks discipline BY SPECIFICITY, not by source order", () => {
    // The measured defect: identical specificity in both layers, so the
    // winner was whichever rule came later — and the two layers happened to
    // be written in opposite orders. A phone painted colour = which
    // discipline (green / orange / purple); a 1440px window painted
    // colour = this bar is in the damage zone (amber ×3). Same three classes,
    // two different encodings, decided by a line number.
    for (const [name, rules] of Object.entries(layers)) {
      const low = rules.find((r) => r.selector.includes("balance-low"))!;
      for (const d of rules.filter((r) => !r.selector.includes("balance-low"))) {
        expect(
          specificity(low.selector),
          `${name}: "${low.selector}" must outrank "${d.selector}"`,
        ).toBeGreaterThan(specificity(d.selector));
      }
    }
  });

  it("…so re-ordering the sheet cannot change what a colour means", () => {
    // The property that makes the above a real fix rather than a tidier
    // accident: the discipline rules carry no specificity of their own for
    // the discipline class, so they lose to status wherever they meet it
    // regardless of where either one sits.
    for (const rules of Object.values(layers)) {
      for (const d of rules.filter((r) => !r.selector.includes("balance-low"))) {
        expect(d.selector, d.selector).toMatch(/:where\(\.balance-(run|strength|yoga)\)/);
      }
    }
  });
});

// ── 6. The dock's default state is a tier decision, not a measurement ──────

describe("the dock's default state", () => {
  // Every phone and small-tablet height the app actually meets, plus the two
  // that straddled the old flip point (iPhone 15 at 844, 15 Pro Max at 932).
  const HEIGHTS = [568, 667, 736, 812, 844, 852, 896, 926, 930, 931, 932, 956, 1024, 1180, 1366];

  it("below lg it does not depend on the viewport's height at all", () => {
    // `dockCoversStage` answers "would this OVERLAY cover the stage?" — a
    // question that only exists at lg. Below it the dock is an in-flow
    // accordion: it covers nothing, and asking anyway gave two adjacent
    // phones structurally different home screens (844 → collapsed with a 78px
    // dock, 932 → a 622px panel expanded and the rail pushed to y=1166).
    const answers = new Set(HEIGHTS.map((h) => defaultDockOpen(false, h)));
    expect([...answers]).toEqual([true]);
    expect(defaultDockOpen(false, 844)).toBe(defaultDockOpen(false, 932));
  });

  it("at lg it still protects a short stage from its own overlay", () => {
    // The heuristic is not deleted, it is scoped to the tier it describes.
    expect(defaultDockOpen(true, 700)).toBe(false);
    expect(defaultDockOpen(true, 1400)).toBe(true);
    expect(defaultDockOpen(true, 930)).toBe(!dockCoversStage(930));
  });

  it("the tier comes from the same 1024 the stylesheet uses, live", () => {
    // Not `window.innerHeight` read once during first paint and then frozen —
    // that is the bug class this file keeps meeting. `useIsDesktop` is a
    // matchMedia subscription on `(min-width: 1024px)`, which is `--bp-lg`.
    expect(gardenSrc).toContain("const isDesktop = useIsDesktop();");
    expect(gardenSrc).toMatch(/defaultDockOpen\(isDesktop, \w+\)/);
    // The seeded-boolean form is gone: the stored preference is the only
    // thing held as state, and `null` means "no choice made yet".
    expect(gardenSrc).not.toMatch(/useState\(\(\) => \{[\s\S]*?dockCoversStage\(window\.innerHeight\)/);
    expect(gardenSrc).toContain("dockChoice ?? defaultDockOpen(");
  });
});

// ── 7. The empty state is a screen, not a disabled control ─────────────────

describe("the no-plan state", () => {
  it("still says what to do, and says it in the shared tree", () => {
    // It was deleted outright by the two-trees merge: `grep "Start a plan in
    // COROS"` returned zero hits at any width, and what a new athlete got
    // instead was a pill reading "No active training plan" that did nothing
    // when pressed — `aria-expanded` stayed false because the panel behind it
    // was gated on the very workout that was missing.
    expect(gardenSrc).toContain("No active COROS training plan was found");
    expect(gardenSrc).toContain("Start a plan in COROS");
  });

  it("is not hidden behind the disclosure it replaces", () => {
    // The guidance may not be gated on `dockOpen` — a first screen's only
    // instruction cannot be a tap away. It is gated on `planActive` alone,
    // which is the same predicate that decides the pill is not a button.
    const dock = gardenSrc.slice(gardenSrc.indexOf("\n    dock: ("), gardenSrc.indexOf("\n    balance:"));
    expect(dock.length).toBeGreaterThan(200); // the slice actually found the part
    const guidance = dock.slice(dock.indexOf("dock-noplan"));
    expect(dock).toMatch(/\{!planActive \? \(\s*<div className="dock-panel dock-noplan">/);
    expect(guidance).not.toContain("dockOpen");
    expect(dock).toContain("disclosable={planActive}");
    // …and the panel is gated on the same thing, so the two can never
    // disagree about whether there is anything to open.
    expect(gardenSrc).toContain("const dockPanelOpen = dockOpen && planActive;");
  });
});
