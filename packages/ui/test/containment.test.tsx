/**
 * System 1 — Containment. One suite for the invariant behind six measured
 * defects: a container is honest about its bounds. It fits the space it
 * actually has, it never forces the page wider, it shows you when it has
 * clipped content, and it grows away from what you are reading.
 *
 * Two kinds of assertion here, both cheap and both regression-shaped:
 *  - markup: which primitive each surface wears (`.pill` vs `.btn-wrap` /
 *    `.note`, who owns the scroll, where the pinned rows are);
 *  - stylesheet: the handful of rules that ARE the contract, read as text,
 *    because nothing else in a node-environment suite can see them. These
 *    guard the specific regressions that shipped, not the styling.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { CoachProposalDto, PlanWeekResponse } from "@rg/api-client";
import type { ReadinessVerdict, WorkoutDto } from "@rg/domain";
import { Sheet, useSpaceAbove } from "../src/components.js";
import { Drawer } from "../src/drawer.js";
import { CoachPanel, ProposalCard } from "../src/screens/coach-panel.js";
import { CorosCheck } from "../src/screens/coros-check.js";
import { DockPill } from "../src/screens/garden.js";
import { WeeklyBrief } from "../src/screens/plan-brief.js";
import { StudioScreen } from "../src/screens/studio/screen.js";
import { FiltersSheet } from "../src/screens/studio/filters-sheet.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { AddSheet } from "../src/screens/studio/add-sheet.js";
import { EXERCISES } from "@rg/exercise-library";
import { staticRouter } from "./studio-fixtures.js";
import { BuilderRoute } from "../src/screens/studio/builder.js";
import { ItemSheet } from "../src/screens/studio/item-sheet.js";
import { buildCtxOf } from "../src/screens/studio/build-model.js";
import { STUDIO_DRAFT_QUERY } from "../src/studio-drafts.js";
import { edit, newDoc, startEditing, suggestedItem } from "@rg/workout";

const noop = () => undefined;

function render(el: React.ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)),
  );
}

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
const gardenSrc = readFileSync(fileURLToPath(new URL("../src/screens/garden.tsx", import.meta.url)), "utf8");

/** The declarations of one rule, by its exact selector text. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for \`${selector}\``).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

// ── 1. No pill ever carries a sentence ─────────────────────────────────────

describe("prose never wears the label primitive", () => {
  it("`.pill` keeps its nowrap contract, and nothing overrides it back to normal", () => {
    expect(ruleBody(".pill")).toContain("white-space: nowrap");
    // A per-site `white-space: normal` on a pill is the smell that says the
    // wrong primitive was chosen (the COROS-check line carried one).
    for (const rule of css.split("}")) {
      if (!rule.includes("white-space: normal")) continue;
      expect(rule.split("{")[0]).not.toMatch(/\.pill\b/);
    }
  });

  it("the two-race-dates choices are wrapping buttons, not pills", () => {
    const week: PlanWeekResponse = {
      weekStart: "2026-08-10",
      days: [],
      plannedSeconds: 18300,
      doneCount: 1,
      sessionCount: 6,
      weekIndex: 5,
      weekTotal: 12,
      adherence4w: { pct: 86, trend: "up" },
      loadRatio: 1.04,
      adventureDays: 0,
      headline: "on_track",
      focus: null,
      raceMismatch: {
        workoutId: "w9",
        plannedDate: "2026-10-04",
        raceDate: "2026-10-11",
        title: "Riverside Half Marathon",
      },
    } as PlanWeekResponse;
    const html = render(
      createElement(WeeklyBrief, {
        week,
        pendingCount: 0,
        onNeedsYou: noop,
        onResolveRace: noop,
      }),
    );
    // The sentence still reads exactly as it did — only its container changed.
    expect(html).toContain("a normal hard session");
    const actions = html.slice(html.indexOf("plan-brief-race-actions"));
    expect(actions).toContain("btn btn-small btn-wrap");
    expect(actions.slice(0, actions.indexOf("</div>"))).not.toContain("pill");
  });

  it("a coach proposal's trade-off note is a note — a whole sentence, wrapped, readable", () => {
    const proposal: CoachProposalDto = {
      id: "p1",
      title: "Move Saturday's long run",
      evidence: "slept 5h avg",
      rationale: "Because rest beats a junk tempo.",
      flags: ["eases Tuesday's 10K-pace intervals in a build week"],
      ops: [{ kind: "skip", workoutId: "w1", reason: "rest" }],
      status: "pending",
      createdAt: "2026-08-06T10:00:00Z",
      expiresAt: "2026-08-08",
    } as CoachProposalDto;
    const html = render(
      createElement(ProposalCard, { proposal, title: proposal.title, onApprove: noop, onDecline: noop }),
    );
    expect(html).toContain("note note-warn");
    expect(html).toContain("The trade-off");
    expect(html).toContain("eases Tuesday&#x27;s 10K-pace intervals in a build week");
    expect(html).not.toContain("pill pill-warnsoft");
    // It is a sentence, and a pill is nowrap by contract — these clipped at
    // scrollWidth 461 in a 327px card.
    expect(html).not.toMatch(/class="pill[^"]*">[^<]*eases/);
  });

  it("every COROS-check state is a note, not a pill", () => {
    for (const state of ["checking", "not_connected", "bad_credentials", "still_syncing", "coros_unreachable"] as const) {
      const html = render(createElement(CorosCheck, { state }));
      expect(html, state).toContain('class="note');
      expect(html, state).not.toContain("pill");
    }
  });

  it("the shell carries a backstop that cannot be silently removed", () => {
    // `clip`, not `hidden`: hidden would create a scroll container and kill
    // the side-nav's `position: sticky`.
    expect(ruleBody(".shell-main")).toContain("overflow-x: clip");
  });
});

// ── 2. One scroll owner per dialog ─────────────────────────────────────────

describe("one scroll owner per dialog", () => {
  it("the sheet is a head/body/foot column where only the body scrolls", () => {
    const html = render(
      createElement(Sheet, {
        open: true,
        onClose: noop,
        title: "Match an activity",
        children: createElement("p", null, "body"),
        footer: createElement("button", null, "Do it"),
      }),
    );
    expect(html).toContain("row-between sheet-head");
    expect(html).toContain('class="sheet-body scroller"');
    expect(html).toContain('class="sheet-foot"');
    // Exactly one scroller inside the dialog.
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
    // The title and its ✕ live OUTSIDE the scrolling region, so a sheet can
    // never open already scrolled past them.
    expect(html.indexOf("sheet-head")).toBeLessThan(html.indexOf("sheet-body"));
    expect(html.indexOf('aria-label="Close"')).toBeLessThan(html.indexOf("sheet-body"));
  });

  it("`fill` hands a definite height to content that scrolls itself", () => {
    const html = render(
      createElement(Sheet, {
        open: true,
        onClose: noop,
        title: "Coach",
        fill: true,
        children: createElement("div", null, "panel"),
      }),
    );
    expect(html).toContain("sheet sheet--fill");
    // The body stops being the scroller — the child owns it, still one owner.
    expect(html).toContain('class="sheet-body"');
    expect(html).not.toContain("sheet-body scroller");
    expect(ruleBody(".sheet--fill")).toContain("height: 85dvh");
  });

  it("no dialog child sizes itself against the viewport", () => {
    // The 84vh panel inside an 85dvh sheet is exactly how the coach tray came
    // to paint 39px above the sheet's own top edge, out over the backdrop.
    for (const selector of [".coach-panel", ".coach-sheet-panel", ".coach-thread", ".coach-scroll", ".coach-scroll-wrap"]) {
      expect(ruleBody(selector), selector).not.toMatch(/\d+(vh|dvh)/);
    }
    expect(ruleBody(".sheet")).toContain("overflow: hidden");
  });

  it("the coach panel scrolls the whole conversation as one, head and composer pinned", () => {
    const html = render(
      createElement(CoachPanel, {
        messages: [
          { id: "m1", role: "coach", body: "Morning.", refs: {}, at: "2026-08-14T07:00:00Z" },
        ] as never,
        proposals: [],
        question: null,
        onSend: noop,
        onApprove: noop,
        onDecline: noop,
        onAnswer: noop,
        onDismiss: noop,
      }),
    );
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
    expect(html).toContain("coach-scroll scroller");
    // head → scroll region → composer, in that order.
    expect(html.indexOf("coach-panel-head")).toBeLessThan(html.indexOf("coach-scroll"));
    expect(html.indexOf("coach-scroll")).toBeLessThan(html.indexOf("coach-composer"));
    // The thread sits INSIDE the scroll region, and no longer scrolls itself.
    expect(html.indexOf("coach-scroll")).toBeLessThan(html.indexOf("coach-thread"));
    expect(ruleBody(".coach-thread")).not.toContain("overflow");
  });
});

// ── 3. A clipping container announces itself ───────────────────────────────

describe("clipping is visible", () => {
  it("the affordance is one primitive: a real scrollbar plus edge shadows", () => {
    const scroller = ruleBody(".scroller");
    expect(scroller).toContain("overflow-y: auto");
    expect(scroller).toContain("min-height: 0"); // or it pushes instead of scrolling
    expect(scroller).toContain("radial-gradient"); // the edge shadows
    expect(css).toContain(".scroller::-webkit-scrollbar");
    // Firefox's standard properties live behind @supports, because setting
    // them in the base rule makes Chromium drop the webkit rules above and
    // fall back to the overlay bar that fades out.
    expect(css).toContain("@supports not selector(::-webkit-scrollbar)");
    expect(scroller).not.toContain("scrollbar-width");
    // Nothing animated, so there is nothing to gate on reduced motion.
    expect(scroller).not.toContain("animation");
    expect(scroller).not.toContain("transition");
  });

  it("the drawer's body wears it (the Collection drawer clips 3,509px)", () => {
    const html = render(
      createElement(Drawer, {
        open: true,
        onClose: noop,
        title: "Collection",
        children: createElement("p", null, "species"),
      }),
    );
    expect(html).toContain('class="drawer-body scroller"');
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
  });
});

// ── 4. Remaining space, not the window ─────────────────────────────────────

describe("boxes size against the space they have", () => {
  it("the garden stage subtracts whatever renders above it", () => {
    const stage = ruleBody("  .garden-stage");
    expect(stage).toContain("height: calc(100dvh - var(--space-above, 0px))");
  });
});

// ── 5. Disclosure grows away from the reader ───────────────────────────────

describe("disclosure anchoring", () => {
  const verdict: ReadinessVerdict = { level: "good", reasons: ["HRV 64 (base 62)"] };
  const workout = { id: "w1", title: "Hill Strides", category: "quality", sport: "run", effectiveDate: "2026-08-14", effectiveTime: "09:00" } as WorkoutDto;

  it("the pill never carries the verdict — the chip is its one home", () => {
    // v2: readiness lives on the Today card's chip and in the sheet behind
    // it, exactly once. The pill is the collapsed workout control from lg;
    // opening and closing it can no longer move a verdict the reader was
    // looking at, because the pill never had one.
    const collapsed = render(
      createElement(DockPill, { workout, today: "2026-08-14", onOpen: noop }),
    );
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain("Good to go");
    const expanded = render(
      createElement(DockPill, { workout, today: "2026-08-14", onOpen: noop, expanded: true }),
    );
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).not.toContain("Good to go");
    // The workout text itself is identical in both states — the row cannot
    // reflow under the finger that pressed it.
    expect(collapsed.match(/aria-label="([^"]*)"/)?.[1]).toBe("Next: Hill Strides · Today 9 AM");
    expect(expanded.match(/aria-label="([^"]*)"/)?.[1]).toBe(collapsed.match(/aria-label="([^"]*)"/)?.[1]);
  });

  it("the verdict phrase exists in exactly one screen location — the chip's", () => {
    // The sheet may restate it (a dialog is its own surface); on the PAGE the
    // chip is the only bearer. Both render from VERDICT_PHRASE, so the words
    // cannot drift between them.
    const chipCount = [...gardenSrc.matchAll(/VERDICT_PHRASE\[verdict\.level\]/g)].length;
    expect(chipCount).toBe(2); // the chip + the sheet, nothing else
    expect(gardenSrc).not.toContain("dock-pill-verdict");
  });

  it("a pill with no panel behind it is not a button", () => {
    // The measured defect: with `nextWorkout: null` the dock rendered a pill
    // reading "No active training plan" that did nothing when pressed at
    // either width — `aria-expanded` stayed false, no panel mounted, because
    // the panel was gated on a workout the pill did not require.
    const dead = render(
      createElement(DockPill, {
        verdict,
        workout: null,
        today: "2026-08-14",
        onOpen: noop,
        disclosable: false,
      }),
    );
    expect(dead).not.toContain("<button");
    expect(dead).not.toContain("aria-expanded");
    expect(dead).not.toContain("aria-controls");
    expect(dead).toContain("No active training plan");
  });

  it("a centred desktop dialog freezes its geometry on the disclosure, not on open", () => {
    expect(css).toContain(".sheet-backdrop[data-pinned]");
    expect(css).toContain("margin-top: var(--sheet-pin, 0px)");
    // The TOP edge is the number that matters, and it is the only one held
    // here: a centred dialog's bottom edge is free, so it grows downward into
    // the backdrop below it (System 4 R1) and a disclosure is simply visible.
    // Holding the height too kept the frame perfectly still and put the thing
    // it revealed 59.6px below the fold. What stops the growth is the viewport.
    expect(ruleBody("  .sheet-backdrop[data-pinned] > .sheet")).toContain(
      "calc(100dvh - var(--sheet-pin, 0px) - 1.5rem)",
    );
    expect(ruleBody("  .sheet-backdrop[data-pinned] > .sheet")).not.toContain("--sheet-hold");
    // The dialog whose body was ALREADY scrolling keeps its body's size, so a
    // higher ceiling is not itself a reason to grow (see disclosure.test.tsx).
    expect(css).toContain(".sheet-backdrop[data-body-held] > .sheet > .sheet-body");
  });
});

// ── 7. A container measures itself when it EXISTS ──────────────────────────

describe("late-mounting boxes still get measured", () => {
  it("`useSpaceAbove` hands back a callback ref", () => {
    // The shape is the fix. Taking a ref object and measuring in an effect
    // with `[ref]` deps made this inert on every screen that renders a
    // spinner first: the effect ran once against a null ref and its one dep
    // never changed, so the stage that mounted a moment later was never
    // measured and `--space-above` stayed empty.
    let handed: unknown;
    function Probe() {
      handed = useSpaceAbove();
      return createElement("div", { className: "garden-stage", ref: handed as never });
    }
    expect(render(createElement(Probe))).toContain("garden-stage");
    expect(typeof handed).toBe("function");
  });

  it("nothing needing action starts hidden: a proposal IS a message in the one scroller", () => {
    // There is no second region any more. The tray used to sit above the
    // thread INSIDE the same scroller, which is why opening the panel had to
    // choose between "show the newest message" and "show what needs you" —
    // and chose the top, 1,143px above the newest message at 390. A proposal
    // is now an item in the thread at its own moment in time, so the bottom
    // is both answers at once.
    const html = render(
      createElement(CoachPanel, {
        messages: [
          { id: "m1", role: "coach", body: "Morning.", refs: {}, at: "2026-08-14T07:00:00Z" },
        ] as never,
        proposals: [
          {
            id: "p1",
            title: "Move Saturday's long run",
            evidence: "slept 5h avg",
            rationale: "Because rest beats a junk tempo.",
            flags: [],
            ops: [],
            status: "pending",
            createdAt: "2026-08-16T10:00:00Z",
            expiresAt: "2026-08-18",
          } as CoachProposalDto,
        ],
        question: null,
        onSend: noop,
        onApprove: noop,
        onDecline: noop,
        onAnswer: noop,
        onDismiss: noop,
      }),
    );
    expect(html).not.toContain("coach-tray");
    const scroll = html.indexOf("coach-scroll scroller");
    expect(scroll).toBeLessThan(html.indexOf("coach-thread"));
    expect(html.indexOf("coach-thread")).toBeLessThan(html.indexOf("coach-prop"));
    // The wrapper that lets the jump chip float is NOT the scroll owner.
    expect(html.indexOf("coach-scroll-wrap")).toBeLessThan(scroll);
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
  });
});

// ── 6. The overlay and the column share one width ──────────────────────────

describe("the coach overlay reserves its own room", () => {
  it("one custom property drives both the window and the gutter the page yields", () => {
    expect(ruleBody(".plan-page")).toContain("--coach-w:");
    expect(ruleBody(".coach-window")).toContain("width: var(--coach-w");
    expect(ruleBody("  .plan-page--coach-open")).toContain(
      "padding-right: calc(var(--coach-w) + var(--space-7))",
    );
  });
});

// ── 8. The Studio (Stage 2 Task 4) ─────────────────────────────────────────

describe("the Studio is honest about its bounds", () => {
  function renderAt(path: string, el: React.ReactElement): string {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, staticRouter(path, el)));
  }
  const rem = (v: string): number => parseFloat(v) * 16;

  it("the page owns the list's scroll; the one scroller is the lg filter column", () => {
    const html = renderAt("/studio?q=squat", createElement(StudioScreen));
    expect(html).toContain('class="stu-list"');
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<aside class="stu-facets scroller"/);
    // …and the home has none at all.
    expect(renderAt("/studio", createElement(StudioScreen))).not.toContain("scroller");
  });

  it("the filters sheet is one scroll owner, with its actions pinned below it", () => {
    const html = renderAt(
      "/studio",
      createElement(FiltersSheet, {
        open: true,
        onClose: noop,
        filters: {},
        ctx: emptyStudioCtx,
        count: 12,
        onChange: noop,
        onClear: noop,
        onShow: noop,
      }),
    );
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
    expect(html.indexOf('class="sheet-body scroller"')).toBeLessThan(html.indexOf('class="sheet-foot"'));
    expect(html.slice(html.indexOf('class="sheet-foot"'))).toContain("Show 12 moves");
  });

  it("nothing in a row, the bar or the chips can push the page wider", () => {
    expect(ruleBody(".search-field")).toContain("min-width: 0");
    expect(ruleBody(".search-field input")).toContain("min-width: 0");
    expect(ruleBody(".stu-move")).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(ruleBody(".stu-move-name")).toContain("overflow-wrap: anywhere");
    for (const sel of [".stu-meta", ".stu-chips", ".stu-chipset"]) expect(ruleBody(sel), sel).toContain("flex-wrap: wrap");
    // A long placeholder ends in an ellipsis rather than a hard cut.
    expect(ruleBody(".search-field input")).toContain("text-overflow: ellipsis");
  });

  it("the count and Clear wrap together, never Clear alone on a line", () => {
    const html = renderAt("/studio?q=squat&tag=ski", createElement(StudioScreen));
    expect(html).toMatch(/<span class="stu-tally"><span class="stu-count"[^>]*>[^<]*<\/span><button[^>]*>Clear<\/button><\/span>/);
    expect(ruleBody(".stu-tally")).toContain("white-space: nowrap");
  });

  it("a term's popover is a sentence box, not a pill, and it fits the viewport", () => {
    const pop = ruleBody(".term-pop");
    expect(pop).toContain("white-space: normal");
    expect(pop).toContain("overflow-wrap: anywhere");
    expect(pop).toMatch(/max-width: min\([^;]*100vw[^;]*\)/);
    // Measured on open and shifted back inside the viewport when it would cross the edge.
    expect(pop).toContain("translateX(var(--tip-shift, 0px))");
    // `display: block` out-specifies the browser's own `[hidden]`, so a closed popover must say none itself.
    expect(ruleBody(".term-pop[hidden]")).toContain("display: none");
  });

  it("near the bottom a popover opens upward, and it paints above the tab bar", () => {
    expect(ruleBody('.term-pop[data-place="above"]')).toContain("bottom: calc(100% + var(--space-2))");
    const z = (sel: string) => Number(/z-index:\s*(\d+)/.exec(ruleBody(sel))![1]);
    expect(z(".term-pop")).toBeGreaterThan(z(".bottom-nav"));
  });

  it("only the fit carries a pad, and it reaches no further than the row guarantees on either side: nothing overlaps", () => {
    // The terms are words inside a line of text (WCAG's inline exemption): no pad, so no reach into the lines around.
    expect(ruleBody(".stu-meta")).not.toContain("--tap-clear");
    const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}\n", css.indexOf(":root {")));
    const px = (token: string) => parseFloat(new RegExp(`--${token}: ([\\d.]+)rem`).exec(root)![1]!) * 16;
    const step = (v: string) => px(/var\(--([\w-]+)\)/.exec(v)![1]!);
    const dose = ruleBody(".stu-meta--dose");
    const reach = step(/--tap-clear-y: ([^;]+);/.exec(dose)![1]!);
    expect(reach).toBeGreaterThan(0);
    // Below: the row's own bottom padding (its phone value — the smaller one).
    const row = ruleBody(".stu-move");
    const pad = /padding: (var\([^)]+\)) (var\([^)]+\));/.exec(row)!;
    expect(step(pad[1]!)).toBeGreaterThanOrEqual(reach);
    // Above: the line above's distance — the row's gap plus this line's own top margin.
    const gap = step(/row-gap: ([^;]+);/.exec(row)![1]!);
    const top = step(/margin-top: ([^;]+);/.exec(dose)![1]!);
    expect(gap + top).toBeGreaterThanOrEqual(reach);
  });

  it("the themes are one row that scrolls sideways inside its own box, never the page", () => {
    const row = ruleBody(".stu-themes");
    expect(row).toContain("overflow-x: auto");
    expect(row).toContain("overscroll-behavior-x: contain");
    expect(ruleBody(".stu-theme")).toContain("flex: none");
  });

  it("three quick starts fit across a 320px phone", () => {
    const grid = ruleBody(".stu-quick");
    const min = rem(/minmax\(max\(([\d.]+)rem/.exec(grid)![1]!);
    expect(grid).toContain("gap: var(--space-3)");
    // 320 − 2 × 16px gutters = 288px for three tiles and two 6px gaps.
    expect(3 * min + 2 * 6).toBeLessThanOrEqual(288);
  });

  // ── Task 5: the move in full, the Add sheet, the line ──

  it("a move open on a phone is a sheet with ONE scroll owner; the page's own scroller (the lg filter column) is unchanged", () => {
    const html = renderAt("/studio/move/gobletSquat?q=squat", createElement(StudioScreen));
    expect(html).toMatch(/role="dialog"/);
    expect((html.match(/scroller/g) ?? []).length).toBe(2);
    expect(html).toContain('class="stu-facets scroller"');
    expect(html).toContain('class="sheet-body scroller"');
    expect(html.indexOf('class="sheet-body scroller"')).toBeLessThan(html.indexOf('class="sheet-foot"'));
  });

  it("the pane (md) keeps to the screen: sticky, its body the one scroller, the name and Add pinned around it", () => {
    const pane = ruleBody(".stu-detail");
    expect(pane).toContain("position: sticky");
    expect(pane).toContain("min-width: 0");
    // The room from where it starts (never above the sticky gutter) to the bottom gutter, above the tab bar — which
    // is still drawn at md — so Add is in view at once; from lg there is no tab bar to clear.
    expect(pane).toContain(
      "max-height: calc(100dvh - max(var(--pane-top, 0px), var(--space-6)) - var(--nav-height) - env(safe-area-inset-bottom, 0px) - var(--space-6))",
    );
    expect(ruleBody("  .stu-detail")).toContain("max-height: calc(100dvh - max(var(--pane-top, 0px), var(--space-6)) - var(--space-6))");
    expect(ruleBody(".stu-detail-head")).toContain("flex: none");
    expect(ruleBody(".stu-detail-foot")).toContain("flex: none");
    expect(ruleBody(".stu-detail-body")).toContain("flex: 1 1 auto");
    // A long name wraps rather than pushing the pane wider.
    expect(ruleBody(".stu-detail-head h2")).toContain("overflow-wrap: anywhere");
    expect(ruleBody(".stu--detail .stu-main")).toContain("minmax(0, 3fr) minmax(0, 2fr)");
  });

  it("the whole row opens the move: the link's box is stretched over the row, under the row's own buttons", () => {
    expect(ruleBody(".stu-move")).toContain("position: relative");
    const stretch = ruleBody(".stu-move-open::before");
    expect(stretch).toContain("position: absolute");
    expect(stretch).toContain("inset: 0");
    // The ＋ and the terms are positioned too, and come later in the row: they paint above the stretched box.
    expect(ruleBody(".stu-move-add")).toContain("position: relative");
    expect(ruleBody(".term-wrap")).toContain("position: relative");
    // The focus ring is the row's, drawn on the stretched box.
    expect(ruleBody(".stu-move-open:focus-visible::before")).toContain("outline: 2px solid var(--focus)");
  });

  it("the Add sheet: one scroll owner, its actions pinned; nothing in a choice can push it wider", () => {
    const html = renderAt(
      "/studio",
      createElement(AddSheet, { rec: EXERCISES.find((r) => r.id === "gobletSquat")!, ctx: emptyStudioCtx, today: "2026-10-11", onClose: noop, onAdded: noop }),
    );
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
    expect(html.indexOf('class="sheet-body scroller"')).toBeLessThan(html.indexOf('class="sheet-foot"'));
    expect(html.slice(html.indexOf('class="sheet-foot"'))).toMatch(/Pin — keep it in my rotation[\s\S]*>Add<\/button>/);
    // A fieldset's default min-width is its content's: it must be allowed to shrink.
    expect(ruleBody(".stu-add-targets")).toContain("min-width: 0");
    expect(ruleBody(".stu-add-opt")).toContain("flex-wrap: wrap");
    const select = ruleBody(".stu-add-select");
    expect(select).toContain("min-width: 0");
    expect(select).toContain("max-width: 100%");
    // 16px, so a phone never zooms into it.
    expect(select).toContain("font-size: var(--text-md)");
    expect(ruleBody(".stu-add-what")).toContain("overflow-wrap: anywhere");
  });

  it("the line after Add sticks above the tab bar, under the popovers and the tab bar itself, and wraps", () => {
    const line = ruleBody(".stu > .stu-added--on");
    expect(line).toContain("position: sticky");
    expect(line).toContain("bottom: calc(var(--nav-height) + env(safe-area-inset-bottom, 0px) + var(--space-4))");
    const z = (sel: string) => Number(/z-index:\s*(\d+)/.exec(ruleBody(sel))![1]);
    expect(z(".stu > .stu-added--on")).toBeLessThan(z(".bottom-nav"));
    expect(z(".stu > .stu-added--on")).toBeLessThan(z(".term-pop"));
    // One row: the words take what is left and wrap in their own column; Open, Undo and ✕ keep theirs.
    expect(ruleBody(".stu-added--on")).toContain("grid-template-columns: minmax(0, 1fr) auto auto");
    expect(ruleBody(".stu-added--on .stu-added-text")).toContain("min-width: 0");
    expect(ruleBody(".stu-added--on .stu-added-text")).toContain("overflow-wrap: anywhere");
    // Empty, it is no box at all: the box is only `--on`.
    expect(ruleBody(".stu-added-text")).not.toContain("padding");
    // The watch's Send and a failure go under the one row, across it; the costs sit with the words, in their column.
    expect(css).toMatch(/\n\.stu-added-send,\n\.stu-added-error \{\n {2}grid-column: 1 \/ -1;\n\}/);
    expect(ruleBody(".stu-added-said")).toContain("min-width: 0");
    expect(ruleBody(".stu-added-notes")).toContain("overflow-wrap: anywhere");
  });

  it("the Add sheet's list keeps its room while the draft is read, so it lands without a jump", () => {
    expect(ruleBody('.stu-add-targets[aria-busy="true"]')).toContain("min-height: calc(3 * (var(--tap) + 2 * var(--space-2)) + 2 * var(--space-3))");
  });

  it("a scroller at rest shows no shadow: each cover is solid past the shadow it hides", () => {
    const s = ruleBody(".scroller");
    const cover = /linear-gradient\(var\(--scroll-surface, var\(--bg-raised\)\) (\d+)%, transparent\) top \/ 100% ([\d.]+)rem/.exec(s);
    const shadow = /radial-gradient\(farthest-side at 50% 0%[^)]*\)[^/]*\) top \/ 100% ([\d.]+)rem/.exec(s);
    expect(cover, "top cover").not.toBeNull();
    expect(shadow, "top shadow").not.toBeNull();
    expect((Number(cover![1]) / 100) * rem(cover![2]!)).toBeGreaterThanOrEqual(rem(shadow![1]!));
    expect(s).toMatch(/linear-gradient\(transparent, var\(--scroll-surface, var\(--bg-raised\)\) \d+%\) bottom/);
  });
});

// ── 9. The builder (Stage 2 Task 6) ─────────────────────────────────────────

describe("the builder is honest about its bounds", () => {
  const rem = (v: string): number => parseFloat(v) * 16;
  const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}\n", css.indexOf(":root {")));
  const px = (token: string) => parseFloat(new RegExp(`--${token}: ([\\d.]+)rem`).exec(root)![1]!) * 16;
  const z = (sel: string) => Number(/z-index:\s*(\d+)/.exec(ruleBody(sel))![1]);
  const withGoblet = () =>
    edit(startEditing(newDoc("structured", { title: "Hips & posture", source: { kind: "studio" } })), { type: "addItem", part: 1, item: suggestedItem(EXERCISES.find((r) => r.id === "gobletSquat")!, "main") }, EXERCISES).doc;
  function builderAt(path: string): string {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(STUDIO_DRAFT_QUERY, { doc: withGoblet(), updatedAt: 1 });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, staticRouter(path, createElement(BuilderRoute))));
  }

  it("the page owns the scroll; the actions are the builder's own child, outside the grid, so their sticky box travels its height", () => {
    const html = builderAt("/studio/build/new");
    expect(html).not.toContain("scroller");
    // Between the grid's start and the actions, every <div> opened is closed: the actions sit after the grid, not in it.
    const from = html.indexOf('<div class="stu-build-grid">');
    const to = html.indexOf('<div class="stu-build-foot">');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const between = html.slice(from, to);
    expect((between.match(/<div[\s>]/g) ?? []).length).toBe((between.match(/<\/div>/g) ?? []).length);
    expect(html.slice(0, from)).toMatch(/<div class="stu-build">$/);
  });

  it("the actions stick above the tab bar, under the popovers and the tab bar itself", () => {
    const foot = ruleBody(".stu-build-foot");
    expect(foot).toContain("position: sticky");
    expect(foot).toContain("bottom: calc(var(--nav-height) + env(safe-area-inset-bottom, 0px) + var(--space-4))");
    expect(z(".stu-build-foot")).toBeLessThan(z(".bottom-nav"));
    expect(z(".stu-build-foot")).toBeLessThan(z(".term-pop"));
    // Its menu (Save ▾) paints above it.
    expect(z(".stu-save-menu")).toBeGreaterThan(z(".stu-build-foot"));
  });

  it("at 320px the two actions sit side by side in the pinned footer", () => {
    // 320 − two 16px gutters − the footer's padding on both sides − its two 1px borders: the room for two buttons and a gap.
    const foot = ruleBody(".stu-build-foot");
    const pad = px(/padding: var\(--([\w-]+)\)/.exec(foot)![1]!);
    const gap = px(/gap: var\(--([\w-]+)\)/.exec(ruleBody(".stu-build-actions"))![1]!);
    const basis = rem(/flex: 1 1 ([\d.]+)rem/.exec(ruleBody(".stu-build-actions > .btn"))![1]!);
    expect(2 * basis + gap).toBeLessThanOrEqual(320 - 2 * 16 - 2 * pad - 2);
    // …and when the words do not fit (a long reason, a status), they wrap above the buttons, never beside them.
    expect(ruleBody(".stu-build-actions")).toContain("flex-wrap: wrap");
    expect(ruleBody(".stu-build-foot")).toContain("flex-direction: column");
  });

  it("nothing in a part, a row, the summary or the header can push the page wider", () => {
    expect(ruleBody(".stu-build-grid")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(ruleBody(".stu-item")).toContain("grid-template-columns: minmax(0, 1fr) auto auto");
    expect(ruleBody(".stu-sum-head")).toContain("grid-template-columns: minmax(0, 1fr) auto auto");
    expect(ruleBody(".stu-note")).toContain("grid-template-columns: auto minmax(0, 1fr)");
    for (const sel of [".stu-item-name", ".stu-item-dose", ".stu-item-cue", ".stu-note-text", ".stu-sum-line", ".stu-part-why", ".stu-build-goal-list", ".stu-swap-name,\n.stu-pick-name"]) {
      expect(ruleBody(sel), sel).toContain("overflow-wrap: anywhere");
    }
    for (const sel of [".stu-build-title", ".stu-build-why-field", ".stu-part-head", ".stu-build-bar"]) expect(ruleBody(sel), sel).toContain("min-width: 0");
    for (const sel of [".stu-seg", ".stu-dose", ".stu-build-goals", ".stu-part-title", ".stu-effort"]) {
      expect(ruleBody(sel), sel).toContain("flex-wrap: wrap");
    }
    // A suggestion's name wraps in its row, beside its ＋; the row never grows past the column.
    expect(ruleBody(".stu-sug")).toContain("max-width: 100%");
    expect(ruleBody(".stu-sug .term-wrap")).toContain("min-width: 0");
    expect(ruleBody(".stu-sug .term")).toContain("overflow-wrap: anywhere");
    expect(ruleBody(".stu-save-menu")).toContain("max-width: calc(100vw - 2 * var(--space-6))");
  });

  it("every control in it keeps the 44px floor as its own box — no pad reaching into a neighbour", () => {
    for (const sel of [".stu-item", ".stu-sug", ".stu-sug-add", ".stu-add-move", ".stu-icon-btn", ".stu-save-item", ".stu-seg-opt span",
      ".stu-swap,\n.stu-pick", ".stu-build-goals-edit", ".stu-sum-head"]) {
      expect(ruleBody(sel), sel).toMatch(/min-(height|width): var\(--tap\)/);
    }
    const stepper = ruleBody(".stu-stepper");
    expect(stepper).toContain("grid-template-columns: var(--tap) 3.5rem var(--tap)");
    expect(stepper).toContain("grid-template-rows: auto var(--tap)");
  });

  it("a move's sheet: one scroll owner, Remove and Done pinned below it", () => {
    const doc = withGoblet();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        staticRouter(
          "/studio/build/new",
          createElement(ItemSheet, {
            doc,
            part: 1,
            item: 0,
            rec: EXERCISES.find((r) => r.id === "gobletSquat"),
            notes: [],
            unit: "kg",
            bc: buildCtxOf(emptyStudioCtx, "2026-10-11"),
            ctx: emptyStudioCtx,
            library: EXERCISES,
            onEdit: () => undefined,
            onMoved: noop,
            onRemove: noop,
            onFix: noop,
            onCheck: noop,
            checkLabel: () => "",
            onClose: noop,
          }),
        ),
      ),
    );
    expect((html.match(/scroller/g) ?? []).length).toBe(1);
    const foot = html.slice(html.indexOf('class="sheet-foot"'));
    expect(html.indexOf('class="sheet-body scroller"')).toBeLessThan(html.indexOf('class="sheet-foot"'));
    expect(foot).toMatch(/>Remove<\/button>[\s\S]*>Done<\/button>/);
    // 16px fields, so a phone never zooms into them.
    for (const sel of [".stu-load-input,\n.stu-field,\n.stu-select", ".stu-step,\n.stu-stepper input"]) expect(ruleBody(sel), sel).toContain("font-size: var(--text-md)");
  });
});
