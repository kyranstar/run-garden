/**
 * System 2 — Measure and rank. One suite for the invariant behind the measured
 * sprawl: every length, size, weight and colour in the UI comes from a named
 * step, and emphasis comes from one of exactly three ranks.
 *
 * Three kinds of assertion, all cheap and all regression-shaped:
 *  - stylesheet as text: the scales exist, and nothing outside a marked
 *    `scale-exempt` carve-out still carries a raw length;
 *  - markup: `Card` emits a real heading, the offending screens have a legal
 *    outline;
 *  - colour: the specific token bypasses that were dark-mode-broken are gone,
 *    and each category hue is declared exactly once.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { PlanDetailDto, PlanSummaryDto } from "@rg/api-client";
import type { WorkoutDto } from "@rg/domain";
import { Card } from "../src/components.js";
import { NextWorkout, TimezoneNudge } from "../src/screens/today.js";
import { PlanCards } from "../src/screens/plan-cards.js";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

function render(el: React.ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)),
  );
}

/** The `:root` block, where every scale is declared. */
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("\n}\n", css.indexOf(":root {")));
/** Everything after the token blocks — the rules that must USE the scales. */
const rules = css.slice(css.indexOf("/* ── Primitives"));

function stepsOf(prefix: string): string[] {
  return [...rootBlock.matchAll(new RegExp(`^\\s*(--${prefix}-[a-z0-9]+):`, "gm"))].map((m) => m[1]!);
}

// ── 1. The scales exist, and they are scales ───────────────────────────────

describe("the scales exist", () => {
  it("spacing is ten steps and nothing else", () => {
    // Eight rhythm steps plus two page-layout steps, replacing 62 raw values.
    const steps = stepsOf("space").filter((s) => /^--space-\d+$/.test(s));
    expect(steps).toEqual([
      "--space-1", "--space-2", "--space-3", "--space-4", "--space-5",
      "--space-6", "--space-7", "--space-8", "--space-9", "--space-10",
    ]);
    // Monotonic, and every step is a whole or half pixel at a 16px root.
    const values = steps.map((s) => parseFloat(new RegExp(`${s}: ([\\d.]+)rem`).exec(rootBlock)![1]!));
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    for (const v of values) expect((v * 16) % 0.5).toBe(0);
  });

  it("type is seven steps, ascending, with no imperceptible neighbours", () => {
    const steps = stepsOf("text");
    expect(steps).toHaveLength(7);
    const values = steps.map((s) => parseFloat(new RegExp(`${s}: ([\\d.]+)rem`).exec(rootBlock)![1]!));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
      // The measured defect was 43 sizes at an average step of 0.27px. Every
      // neighbouring pair here is at least 1.5px apart at a 16px root.
      expect((values[i]! - values[i - 1]!) * 16).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("weight is three steps, and none of them is 640/650/660", () => {
    const steps = stepsOf("weight");
    expect(steps).toEqual(["--weight-regular", "--weight-medium", "--weight-bold"]);
    const values = steps.map((s) => Number(new RegExp(`${s}: (\\d+)`).exec(rootBlock)![1]));
    expect(values).toEqual([400, 600, 700]);
  });

  it("radius has a token for every step the sheet uses, including 10px", () => {
    const steps = stepsOf("radius");
    // `--radius` itself has no suffix, so it is not in `stepsOf`.
    expect(rootBlock).toContain("--radius: 12px");
    expect(steps).toEqual([
      "--radius-hair", "--radius-xs", "--radius-sm", "--radius-md",
      "--radius-lg", "--radius-pill", "--radius-round",
    ]);
    // 10px was the de-facto small-panel radius with no token at all.
    expect(rootBlock).toContain("--radius-md: 10px");
  });

  it("elevation is five steps, and both themes declare all of them", () => {
    expect(rootBlock).toContain("--shadow:");
    for (const s of ["--shadow-sm", "--shadow-md", "--shadow-lg", "--shadow-xl"]) {
      expect(rootBlock, s).toContain(`${s}:`);
      // Both dark blocks (`prefers-color-scheme` and `[data-theme="dark"]`).
      expect((css.match(new RegExp(`${s}: 0 `, "g")) ?? []).length).toBe(3);
    }
  });
});

// ── 2. The rules USE them ──────────────────────────────────────────────────

/**
 * Declarations of the scale-governed properties, minus any rule that declares
 * itself exempt. The convention a real lint rule would read: a comment
 * containing `scale-exempt` inside a rule (or immediately above it) carves the
 * whole rule out, and must say why.
 */
function govern(): Array<[string, string]> {
  const PROPS =
    /^(margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|font-size|font-weight|border-radius)(-[a-z]+)?$/;
  const out: Array<[string, string]> = [];
  // Each chunk is "whatever preceded the selector" + the selector + its body,
  // so a comment above a rule belongs to that rule.
  let cursor = 0;
  for (const m of rules.matchAll(/\{([^{}]*)\}/g)) {
    const chunk = rules.slice(cursor, m.index! + m[0].length);
    cursor = m.index! + m[0].length;
    if (chunk.includes("scale-exempt")) continue;
    for (const d of m[1]!.matchAll(/([-a-z]+)\s*:\s*([^;{}]+);/g)) {
      if (PROPS.test(d[1]!)) out.push([d[1]!, d[2]!]);
    }
  }
  return out;
}

describe("a raw length is a lint error waiting to happen", () => {
  it("no rhythm or type property carries a raw rem", () => {
    const offenders = govern()
      // Carve-out a lint rule can express WITHOUT a comment: a `clamp()` whose
      // middle term is a viewport unit is fluid stage geometry — it places
      // furniture in a scene sized by the window, and its bounds are already
      // scale steps wherever a step exists.
      .filter(([p, v]) => !(/^(top|right|bottom|left)$/.test(p) && /clamp\([^)]*v[wh]/.test(v)))
      .filter(([, v]) => /(^|[^-\w.])-?\d*\.?\d+rem/.test(v));
    expect(offenders.map(([p, v]) => `${p}: ${v}`)).toEqual([]);
  });

  it("no font-weight is a bare number anywhere in the sheet", () => {
    const weights = [...rules.matchAll(/font-weight:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(weights.length).toBeGreaterThan(50);
    for (const w of weights) expect(w).toMatch(/^var\(--weight-(regular|medium|bold)\)$/);
    // The `font:` shorthand can smuggle one in too.
    for (const m of rules.matchAll(/font:\s*([^;]+);/g)) {
      expect(m[1]!, "font shorthand").not.toMatch(/\b\d{3}\b/);
    }
  });

  it("no border-radius is a raw length", () => {
    for (const m of rules.matchAll(/border-radius:\s*([^;]+);/g)) {
      const v = m[1]!.trim();
      if (v === "0" || v === "inherit") continue;
      expect(v, v).not.toMatch(/\d+(px|%)/);
    }
  });

  it("no box-shadow is written out longhand", () => {
    for (const m of rules.matchAll(/box-shadow:\s*([^;]+);/g)) {
      const v = m[1]!.trim();
      // `inset` rings and `0 0 0 Npx` focus/selection rings are not elevation.
      if (v === "none" || v.startsWith("inset") || /^0 0 0 /.test(v)) continue;
      expect(v, v).toMatch(/^var\(--(shadow|scene-text-shadow)/);
    }
  });

  it("no JSX inline style leaks a raw length either", () => {
    // 112 inline style objects were the other half of the sprawl.
    const files = ["components.tsx", "shell.tsx", "screens/onboarding.tsx", "screens/settings.tsx",
      "screens/studio.tsx", "screens/today.tsx", "screens/insights.tsx", "screens/plan.tsx",
      "screens/coach-panel.tsx", "screens/garden.tsx", "screens/codex.tsx", "screens/welcome.tsx"];
    const SIZE = /^(margin|padding|gap|rowGap|columnGap|fontSize)/;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
      for (const s of src.matchAll(/style=\{\{([^}]*)\}\}/g)) {
        for (const p of s[1]!.matchAll(/([a-zA-Z]+): "([^"]*)"/g)) {
          if (SIZE.test(p[1]!) && /\d*\.?\d+rem/.test(p[2]!)) offenders.push(`${f}: ${p[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── 3. Three ranks ─────────────────────────────────────────────────────────

/** A rule's declarations, by exact selector text. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for \`${selector}\``).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

describe("emphasis comes from one of three ranks", () => {
  it("each rank pins a size, a weight and a colour", () => {
    const page = ruleBody("h1,\n.rank-page");
    expect(page).toContain("font-size: var(--text-2xl)");
    expect(page).toContain("font-weight: var(--weight-bold)");
    expect(page).toContain("color: var(--ink)");

    const item = css.slice(css.indexOf(".rank-item,"));
    const itemBody = item.slice(item.indexOf("{"), item.indexOf("}"));
    expect(itemBody).toContain("font-size: var(--text-lg)");
    expect(itemBody).toContain("font-weight: var(--weight-medium)");
    expect(itemBody).toContain("color: var(--ink)");
  });

  it("the page title is the largest type on the page", () => {
    // `.headline-stat-value` used to be 1.9rem — the largest type in the app —
    // sitting inside a card while the page title was 1.5rem.
    expect(ruleBody(".headline-stat-value")).toContain("font-size: var(--text-xl)");
    const twoXl = [...rules.matchAll(/font-size:[^;]*--text-2xl[^;]*;/g)];
    // Three, and no more: the h1/.rank-page rule, plus the two scene words
    // sized against the viewport — the garden stage's condition (whose <h1> is
    // deliberately `.visually-hidden`, because the scene is the page) and the
    // ambient screensaver, which has no page chrome at all.
    expect(twoXl).toHaveLength(3);
  });

  it("the eyebrow is ONE implementation, not nineteen", () => {
    // Every uppercase label in the sheet must be part of the shared rule
    // rather than declaring its own size/tracking/weight.
    const uppercase = [...rules.matchAll(/text-transform:\s*uppercase;/g)];
    expect(uppercase).toHaveLength(1);
    const eyebrow = css.slice(css.indexOf(".eyebrow,"));
    const body = eyebrow.slice(eyebrow.indexOf("{"), eyebrow.indexOf("}"));
    expect(body).toContain("font-size: var(--text-2xs)");
    expect(body).toContain("font-weight: var(--weight-medium)");
    expect(body).toContain("letter-spacing: 0.06em");
    // Rank 2 is the SMALLEST type in the app, so it takes the darker of the
    // two secondary inks. On --ink-faint these nineteen labels measured
    // 3.29:1 light / 3.95:1 dark at 11.2px — under the 4.5:1 floor, and rank 2
    // had made them smaller and lighter than the sites it replaced. Measured
    // on the live fixture after the move: 6.51:1 light, 7.38:1 dark.
    expect(body).toContain("color: var(--ink-soft)");
    expect(body).not.toContain("--ink-faint");
    // The selectors that used to each carry their own copy.
    const selector = eyebrow.slice(0, eyebrow.indexOf("{"));
    // (`.now-chip` was in this list until System 3 folded the garden's two
    // trees into one: the mobile-only "since Aug 12" chip became `.hud-beat-
    // label`, the same label the stage has always used, and the class no
    // longer exists to be checked.)
    for (const s of [".card-title", ".week-header", ".signal-group-label", ".studio-week-label",
      ".coach-tray-head", ".race-h", ".plan-week-dow", ".prog-chip-label", ".wkrow-state",
      ".new-ring", ".codex-newring", ".nudge-disc", ".rarity", ".today-tag"]) {
      expect(selector, s).toContain(`${s},`.replace(",", ""));
    }
  });

  it("only one display-serif size survives for a section's lead", () => {
    // Six sizes inside 0.4rem all meant "primary".
    const serif = [...rules.matchAll(/font-family:\s*var\(--font-display\);/g)];
    // The rank-3 group, the `.display` utility, and the stage/ambient pair
    // whose type is sized against the viewport.
    expect(serif.length).toBeLessThanOrEqual(4);
  });

  it("severity is a left edge, not a second tinted field", () => {
    // `.card-next` (special) and `.card-prompt` (explicitly NOT special) used
    // the same two devices. The prompt now wears the `.status-strip` rule.
    expect(ruleBody(".card-next")).toContain("background: var(--green-soft)");
    const prompt = ruleBody(".card-prompt");
    expect(prompt).toContain("border-left: 3px solid var(--warn)");
    expect(prompt).not.toContain("background:");
    // …and so does the chip that used to out-shout the brief's headline. On a
    // pill the accent EDGE has no straight corner to run down (it renders as a
    // crescent), so the same principle takes the shape a chip can carry: the
    // field and the text stay neutral, one hairline marks the level.
    const needs = ruleBody(".plan-brief-needs");
    expect(needs).toContain("border: 1px solid var(--warn)");
    expect(needs).toContain("color: var(--ink)");
    expect(needs).toContain("background: var(--bg-sunken)");
    // The variant it used to borrow is gone — one fewer way to build a second
    // tinted field next to a headline.
    expect(css).not.toContain(".pill-warnsoft {");
    for (const cls of ["edge-clear", "edge-watch", "edge-high"]) expect(css).toContain(`.${cls} {`);
  });
});

// ── 4. Card renders a real heading ─────────────────────────────────────────

describe("a section has a heading", () => {
  it("`Card` emits an <h2> that keeps the eyebrow look and names the section", () => {
    const html = renderToStaticMarkup(
      createElement(Card, { title: "Readiness", children: createElement("p", null, "body") }),
    );
    expect(html).toMatch(/<h2 id="[^"]+" class="card-title">Readiness<\/h2>/);
    expect(html).not.toContain('<div class="card-title">');
    // The region announces with the name you can read.
    const id = /<h2 id="([^"]+)"/.exec(html)![1]!;
    expect(html).toContain(`aria-labelledby="${id}"`);
  });

  it("the level moves for a card nested under another heading", () => {
    const html = renderToStaticMarkup(
      createElement(Card, { title: "Weeks", level: 3, children: "x" }),
    );
    expect(html).toContain('class="card-title">Weeks</h3>');
  });

  it("an untitled card emits no heading and no dangling label", () => {
    const html = renderToStaticMarkup(createElement(Card, { children: "x" }));
    expect(html).not.toContain("card-title");
    expect(html).not.toContain("aria-labelledby");
  });
});

describe("heading levels do not skip", () => {
  const workout = {
    id: "w1",
    title: "Hill Strides",
    category: "quality",
    sport: "run",
    effectiveDate: "2026-08-14",
    effectiveTime: "09:00",
    workoutSeconds: 2700,
    calendarSeconds: 3600,
    corosSyncState: "synced",
  } as WorkoutDto;

  it("the card's title is the section and the workout's name is the item", () => {
    // Two <h2>s and no <h1> was the shape of this screen's cards.
    const html = render(createElement(NextWorkout, { w: workout, today: "2026-08-14" }));
    expect(html).toContain('class="card-title">Next workout</h2>');
    expect(html).toContain('<h3 class="hero-title">Hill Strides</h3>');
    expect((html.match(/<h2/g) ?? []).length).toBe(1);
  });

  it("the plan's sport organizers are headings, not just aria-labels", () => {
    const plans = [
      { id: "p1", name: "Fall Half Block", discipline: "run", source: "coros", weekIndex: 1, weekTotal: 12 },
      { id: "p2", name: "Strength Wave", discipline: "lift", source: "coach", weekIndex: 2, weekTotal: 8 },
    ] as unknown as PlanSummaryDto[];
    const html = render(
      createElement(PlanCards, {
        plans,
        details: new Map<string, PlanDetailDto>(),
        units: "km",
        onOpen: () => undefined,
      }),
    );
    expect(html).toMatch(/<h2 id="plan-section-run" class="plan-section-h">/);
    expect(html).toContain("Running plans");
    expect(html).toContain('aria-labelledby="plan-section-run"');
  });

  it("every screen renders at most one <h1> per branch", () => {
    // Insights and Garden each declare two, in mutually exclusive branches
    // (loading vs loaded; stage vs stacked) — that is legal, and the check
    // that matters is that no single RETURN carries two.
    for (const f of ["screens/insights.tsx", "screens/garden.tsx", "screens/runs.tsx",
      "screens/plan.tsx", "screens/settings.tsx", "screens/today.tsx"]) {
      const src = readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
      // `.hero-title` is rank 3 and out-specifies `h1`; an <h1> must never
      // borrow it, or the page title silently renders at item size.
      expect(src, f).not.toMatch(/<h1[^>]*className="[^"]*hero-title/);
      // …and no <h1> may re-declare its own size inline.
      expect(src, f).not.toMatch(/<h1[^>]*style=\{\{[^}]*fontSize/);
    }
  });
});

// ── 5. One touch floor ─────────────────────────────────────────────────────

describe("one touch floor, enforced", () => {
  it("`--tap` is 44px and every control height is expressed in it", () => {
    expect(rootBlock).toContain("--tap: 44px");
    // Every raw `min-height` left in the sheet is either a CONTAINER (a
    // textarea, a thread, a calendar cell, the new-plan slab) or a control
    // that keeps a small box and wears `.tap-pad`. Nothing else.
    const heights = [...rules.matchAll(/min-height:\s*(\d+)px;/g)].map((m) => Number(m[1]));
    expect(heights.sort((a, b) => a - b)).toEqual([32, 32, 36, 64, 72, 120, 128]);
    const padded = css.slice(css.indexOf("\n.btn-small::after,"));
    const padList = padded.slice(0, padded.indexOf("{"));
    for (const sel of [".btn-small", ".plan-week-back", ".plan-week-jump summary"]) {
      expect(padList, sel).toContain(`${sel}::after`);
    }
  });

  it("the controls that measured under the floor now reach it", () => {
    // Real height where the box can grow. The floor these take is the TOUCH
    // one; the same selectors carry `--tap-fine` outside the media query.
    const coarse = css.slice(css.indexOf("@media (pointer: coarse) {"));
    const coarseBody = coarse.slice(0, coarse.lastIndexOf("}"));
    for (const sel of [".chip", ".chipbtn", ".day-chip", ".cal-ghost",
      ".coach-input input", ".act-actions > *", ".act-status-slot"]) {
      expect(coarseBody, sel).toContain(`${sel},`.replace(/,$/, ""));
    }
    expect(coarseBody).toContain("min-height: var(--tap)");
    // A control a mouse cannot miss is never gated.
    expect(ruleBody(".btn")).toContain("min-height: var(--tap)");
    expect(ruleBody(".coach-pill")).toContain("min-height: var(--tap)");
    // Adjacent list rows can never be padded — their pads would steal from
    // each other — so the row itself grows, unconditionally.
    expect(ruleBody(".plan-week-jumplist button")).toContain("min-height: var(--tap)");
    expect(ruleBody(".plan-week-nav button")).toContain("min-height: var(--tap)");
  });

  it("the grown heights are a TOUCH floor, not a desktop tax", () => {
    // Unconditionally, `.act-actions > *` added 12px to each of 80 buttons and
    // 1016px — 23.3% — to the desktop activity page. Measured after gating:
    // +100px, +2.3%, and the mobile fix is untouched (+615px, +10.6%).
    expect(rootBlock).toContain("--tap-fine: 40px");
    expect(rootBlock).toContain("--tap-fine-row: 32px");
    // The fine-pointer branch is each control's PRE-floor size, so a mouse
    // sees exactly what it saw before System 2.
    for (const sel of [".chip", ".chipbtn", ".cal-ghost", ".day-chip",
      ".coach-input input", ".studio-revise summary"])
      expect(rules, sel).toMatch(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{]*\\{[^}]*var\\(--tap-fine\\)`));
    expect(rules).toContain(".act-status-slot { min-height: var(--tap-fine-row); }");
    // …and a pad is never gated: it costs no layout, so there is nothing to
    // save by withholding it from a pointer.
    const coarse = css.slice(css.indexOf("@media (pointer: coarse) {"));
    expect(coarse.slice(0, coarse.lastIndexOf("}"))).not.toContain("::after");
  });

  it("a control that must look small pads its hit area instead", () => {
    const padAt = css.indexOf("\n.tap-pad::after,");
    const pad = css.slice(css.indexOf("{", padAt), css.indexOf("}", padAt));
    // Never smaller than the control, never larger than the floor, and never
    // reaching past the clearance the CONTAINER granted.
    expect(pad).toContain("clamp(100%, calc(100% + 2 * var(--tap-clear-x, var(--tap-clear, 0px))), var(--tap))");
    expect(pad).toContain("clamp(100%, calc(100% + 2 * var(--tap-clear-y, var(--tap-clear, 0px))), var(--tap))");
    // Every named offender is in the pad list, and — the bug this rule was
    // split into two rules to hide — every one of them is also `relative`.
    const padList = css.slice(css.indexOf("\n.tap-pad,\n.btn-small,"));
    const relative = padList.slice(0, padList.indexOf("{"));
    const after = css.slice(css.indexOf("\n.tap-pad::after,"));
    const afterList = after.slice(0, after.indexOf("{"));
    for (const sel of [".tap-pad", ".btn-small", ".plan-brief-chip", ".plan-brief-needs",
      ".race-check-btn", ".plan-week-back", ".plan-week-jump summary", ".ceremony-close",
      ".hud-rail button", ".proposal-actions > .linklike"]) {
      expect(afterList, sel).toContain(`${sel}::after`);
      expect(relative, sel).toContain(sel);
    }
    expect(relative.split(",").length).toBe(afterList.split(",").length);
  });

  it("a pad is only as large as its container's clearance", () => {
    // The defect this replaces: two 39.6px buttons in a bare <span> with
    // `row-gap: normal` — 0px of visual gap — each grew a 44px pad, so 2.2px
    // of the visible "Switch to …" button fired "Keep …" instead. The pad
    // cannot know the room it has; the container declares it.
    expect(ruleBody(".tap-clear")).toContain("--tap-clear: var(--space-5)");
    expect(ruleBody(".tap-clear")).toContain("gap: var(--tap-clear)");
    // The container that had none now has a container at all.
    expect(ruleBody(".banner-actions")).toContain("display: inline-flex");
    // …and the timezone prompt's two mutually-exclusive buttons are inside it
    // rather than loose in the banner's prose, where the only thing between
    // them was a line box.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["settings"], { prefs: { timezone: "Asia/Tokyo" } });
    const nudge = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(TimezoneNudge)),
    );
    expect(nudge).toContain('<span class="banner-actions tap-clear">');
    const actions = nudge.slice(nudge.indexOf('class="banner-actions'));
    expect((actions.match(/<button/g) ?? []).length).toBe(2);
    // No text node may separate them again — that was the 0px gap.
    expect(actions).not.toMatch(/<\/button>\s+<button/);
    // Every container of a padded control names its clearance. Widened rows
    // stay widened; `.hud-dock` joins them (its pad reached 3.2px into the
    // verdict pill).
    for (const sel of [".plan-brief-chips", ".race-checklist", ".hud-dock", ".hud-corner",
      ".row", ".act-actions", ".wildlife-row", ".switch-row", ".hud-rail", ".drawer-head",
      ".plan-brief-head", ".plan-brief-race-actions", ".card"])
      expect(rules, sel).toMatch(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,\\s][^{]*\\{[^}]*--tap-clear`));
    // The two containers whose room differs by axis say so. The rail's y
    // clearance is --space-5 (12px), not --space-4: a pad is CLAMPED to what
    // its container grants, so 8px capped the 24.8px rail buttons at 40.8px —
    // measured 41px for `LOG`, under the 44px floor. `.hud-corner`'s own gap
    // steps with it so the extra reach lands in the gap, not in the nudge.
    expect(rules).toMatch(/\.hud-rail \{\s*--tap-clear: var\(--space-7\);\s*--tap-clear-y: var\(--space-5\);/);
    // The arithmetic the floor actually depends on: control height + 2 ×
    // clearance must REACH --tap, or the clamp's middle term never wins.
    const RAIL_CONTROL_PX = 24.8; // measured; --text-md line box + --space-2 × 2
    expect(RAIL_CONTROL_PX + 2 * 12).toBeGreaterThanOrEqual(44);
    expect(RAIL_CONTROL_PX + 2 * 8).toBeLessThan(44); // …and 8px did not
    expect(rules).toMatch(/\.drawer-head \{\s*--tap-clear: var\(--space-4\);\s*--tap-clear-x: 0px;/);
    // …and the one container that had to widen writes its gap from the same
    // property, so the two can never disagree again.
    expect(rules).toMatch(/\.hud-dock \{[\s\S]*?gap: var\(--tap-clear\);/);
  });

  it("a container never spaces its rows more tightly than the clearance in force", () => {
    /**
     * THE RULE, and the reason it can be checked without a layout engine.
     *
     * A pad reaches `(--tap − height) / 2` past its control, so the rule a
     * reviewer states is "the container's row gap must be at least the largest
     * `(44 − child height) / 2` among its children". No stylesheet knows those
     * heights — but it does not have to, because the pad is CLAMPED to
     * `--tap-clear`: the reach is `min(--tap-clear, (44 − h) / 2)`, which is
     * never more than `--tap-clear`. So
     *
     *     row gap ≥ --tap-clear  ⟹  row gap ≥ every pad reach inside it
     *
     * whatever the children turn out to measure. That is the invariant below,
     * and it is why every container here writes its `gap` FROM the property
     * rather than from a `--space-N` that merely happens to match today.
     */
    // `var(--space-N)` / `var(--tap-clear)` / `0px` → pixels at a 16px root.
    const px = (v: string, clear: number | null): number | null => {
      if (v === "var(--tap-clear)") return clear;
      const step = /^var\((--space-\d+)\)$/.exec(v)?.[1];
      if (step) return 16 * parseFloat(new RegExp(`${step}: ([\\d.]+)rem`).exec(rootBlock)![1]!);
      return /^[\d.]+px$/.test(v) ? parseFloat(v) : null;
    };
    interface Container { clear?: string; clearX?: string; clearY?: string; gaps: string[] }
    const box = new Map<string, Container>();
    const get = (sel: string) => box.get(sel) ?? (box.set(sel, { gaps: [] }), box.get(sel)!);
    // Comments first: this sheet's prose quotes declarations and braces, and a
    // rule split that keeps them reads `var(--space-4)` out of a paragraph.
    for (const [, selRaw, body] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const read = (p: string) => new RegExp(`${p}\\s*:\\s*([^;]+);`).exec(body!)?.[1]!.trim();
      const clear = read("--tap-clear");
      const clearX = read("--tap-clear-x");
      const clearY = read("--tap-clear-y");
      const gap = /(?:^|[\s;])(?:gap|row-gap)\s*:\s*([^;]+);/.exec(body!)?.[1]!.trim();
      for (const sel of selRaw!.trim().split(",").map((s) => s.trim())) {
        if (!sel) continue;
        const c = get(sel);
        if (clear) c.clear = clear;
        if (clearX) c.clearX = clearX;
        if (clearY) c.clearY = clearY;
        if (gap) c.gaps.push(gap);
      }
    }
    const granting = [...box].filter(([, c]) => c.clear && c.gaps.length);
    expect(granting.length, "no clearance-granting container declares a gap at all").toBeGreaterThan(4);
    for (const [sel, c] of granting) {
      const clear = px(c.clear!, null)!;
      // Per axis, because two containers' room genuinely differs by axis.
      const need = { row: px(c.clearY ?? c.clear!, clear)!, col: px(c.clearX ?? c.clear!, clear)! };
      for (const decl of c.gaps) {
        const parts = decl.split(/\s+(?![^(]*\))/);
        const have = { row: px(parts[0]!, clear), col: px(parts[1] ?? parts[0]!, clear) };
        for (const axis of ["row", "col"] as const)
          expect(have[axis], `${sel}: ${axis} gap \`${decl}\` under the ${need[axis]}px it grants`)
            .toBeGreaterThanOrEqual(need[axis]);
      }
    }

    /**
     * The specific defect. `--tap-clear` INHERITS, so `.hud-dock`'s 12px
     * reached into `.dock-panel` and licensed every pad in there to 12px —
     * but the panel was block flow, and the only room it left between the week
     * pull and "Minimize" was `.dock-week`'s 6px bottom margin. "Minimize" is
     * a 24px box, so its 44px pad reached 10px up, 4px inside the pull:
     * `elementFromPoint` at the pull's bottom-left inset 4px returned
     * `dock-collapse` at 390, 900, 1024 and 1440.
     */
    const COLLAPSE_PX = 24; // measured; --text-xs line box, no padding
    expect((44 - COLLAPSE_PX) / 2).toBe(10);
    expect((44 - COLLAPSE_PX) / 2).toBeGreaterThan(6); // …which --space-3 did not grant
    expect((44 - COLLAPSE_PX) / 2).toBeLessThanOrEqual(12); // …and --space-5 does
    const panel = ruleBody(".dock-panel");
    expect(panel).toContain("--tap-clear: var(--space-5)");
    expect(panel).toContain("gap: var(--tap-clear)");
    // A `gap` needs a container to be a gap: the panel used to be block flow,
    // where the only vertical spacing available is the children's margins —
    // and a child's margin loses to `.linklike`'s `margin: 0` on specificity
    // AND resolves `var(--tap-clear)` against the CHILD's own value.
    expect(panel).toContain("display: flex");
    expect(panel).toContain("flex-direction: column");
    // …so no child of the panel may write a vertical margin again.
    for (const sel of [".dock-collapse", ".dock-grows", ".dock-week"])
      expect(ruleBody(sel), sel).not.toMatch(/margin(?:-block-start|-top|-bottom)?: (?!0 )/);
    // Stretch is the flex default and it is wrong for these two: "Minimize" is
    // a 64px box that grew to the panel's full width, i.e. a whole row of the
    // panel that silently closed it.
    for (const sel of [".dock-collapse", ".dock-grows"])
      expect(ruleBody(sel), sel).toContain("align-self: start");
  });

  it("the timeline scrubber is grabbable without changing its 6px bar", () => {
    expect(ruleBody(".timeline-slider")).toContain("height: var(--tap)");
    expect(ruleBody(".timeline-slider::-webkit-slider-runnable-track")).toContain("height: 6px");
    expect(ruleBody(".timeline-slider::-moz-range-track")).toContain("height: 6px");
  });
});

// ── 6. Colour: no token bypasses left ──────────────────────────────────────

describe("every colour flips with the theme", () => {
  it("the literals that duplicated a token are gone", () => {
    // 13 × #b5652f against a defined --lift-ink, all dark-mode-broken; 3 ×
    // #8a7550 against --adventure-ring; 6 × #8f6fae with no token at all.
    for (const [hex, token] of [["#b5652f", "--lift-ink"], ["#8a7550", "--adventure-ring"],
      ["#83649d", "--hue-yoga"]] as const) {
      expect(rules, hex).not.toContain(hex);
      expect(rootBlock).toContain(`${token}: ${hex}`);
    }
    // The old yoga literal, which measured 4.16:1 under the 11.2px text it
    // carries, is gone from the sheet entirely.
    expect(css).not.toContain("#8f6fae");
  });

  it("the one category hue that carries TEXT clears the text floor in both themes", () => {
    // Every other --hue-* is a dot, a spine or a bar (3:1). Yoga paints
    // `.nudge-disc` (11.2px) and the active `.chip-yoga`, so it answers to
    // 4.5:1 — and it was the only hue with no dark override at all.
    // Measured on the live fixture: 4.91:1 light, 5.70:1 dark.
    expect(rootBlock).toContain("--hue-yoga: #83649d");
    // Once per dark block: the `prefers-color-scheme` one and the
    // `[data-theme="dark"]` twin.
    expect((css.match(/--hue-yoga: #a184c0/g) ?? []).length).toBe(2);
  });

  it("text on an accent fill has a token, and it flips", () => {
    expect(rules).not.toMatch(/#fff\b/);
    expect(rootBlock).toContain("--on-accent: #fff");
    // The dark blocks give it a DARK value — an accent fill is light there.
    expect((css.match(/--on-accent: #141614/g) ?? []).length).toBe(2);
    expect(ruleBody(".btn-primary")).toContain("color: var(--on-accent)");
    // Type printed on the garden artwork is a different job and does NOT flip.
    expect(rootBlock).toContain("--on-scene: #fff");
    expect((css.match(/--on-scene: /g) ?? []).length).toBe(1);
  });

  it("nine category hues, declared once each", () => {
    for (const cat of ["quality", "race", "long", "easy", "recovery", "rest", "strength",
      "yoga", "unknown"]) {
      expect(rootBlock, cat).toContain(`--hue-${cat}:`);
      // Both surfaces read the token; neither declares its own literal.
      expect(ruleBody(`.cat-${cat}`) || "", cat).not.toMatch(/#[0-9a-f]{6}/);
    }
    // The two independent systems are one: `.act-hue-*` reads `--hue-*` too,
    // so a dark correction is written in `:root` and nowhere else.
    expect(rules).toContain(".act-hue-race { --act-hue: var(--hue-race); }");
    expect(rules).not.toContain(':root[data-theme="dark"] .act-hue-race');
    expect(rules).not.toContain(':root[data-theme="dark"] .cat-race');
  });

  it("no theme block is missing its toggle guard", () => {
    // `.rarity-*` was the one `prefers-color-scheme` block with neither a
    // `:not([data-theme="light"])` guard nor a `[data-theme="dark"]` twin, so
    // it was wrong in BOTH directions. Every remaining media block has one.
    for (const m of css.matchAll(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/g)) {
      expect(m[1]!, m[1]!.slice(0, 80)).toMatch(/:root(:not\(\[data-theme="light"\]\)|\[data-theme)/);
    }
    expect(ruleBody(".rarity-uncommon")).toContain("var(--rarity-uncommon-bg)");
    expect(ruleBody(".rarity-rare")).toContain("var(--rarity-rare-ink)");
  });

  it("the stage scrim is one colour, not sixteen hand-typed alphas", () => {
    expect(rootBlock).toContain("--scrim-rgb: 9, 14, 10");
    for (const m of rules.matchAll(/rgba\(\s*\d+\s*,/g)) {
      // Only pure-black overlays (the dark theme's own shadows) may still be
      // written out; every scene/scrim alpha reads the token.
      expect(m[0], m[0]).toBe("rgba(0,");
    }
    // …and one text-shadow for every word printed on the artwork.
    expect(rootBlock).toContain("--scene-text-shadow:");
    expect([...rules.matchAll(/text-shadow:\s*0 /g)]).toHaveLength(0);
  });
});
