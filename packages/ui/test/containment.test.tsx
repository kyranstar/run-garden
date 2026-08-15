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
import { DockPill, DockVerdict } from "../src/screens/garden.js";
import { WeeklyBrief } from "../src/screens/plan-brief.js";

const noop = () => undefined;

function render(el: React.ReactElement): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)),
  );
}

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

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

  it("a coach proposal's rule flags are notes — a whole rule, wrapped, readable", () => {
    const proposal: CoachProposalDto = {
      id: "p1",
      title: "Move Saturday's long run",
      evidence: "slept 5h avg",
      rationale: "Because rest beats a junk tempo.",
      flags: ["Long runs stay on Saturdays"],
      ops: [{ kind: "skip", workoutId: "w1", reason: "rest" }],
      status: "pending",
      createdAt: "2026-08-06T10:00:00Z",
      expiresAt: "2026-08-08",
    } as CoachProposalDto;
    const html = render(createElement(ProposalCard, { proposal, onApprove: noop, onDecline: noop }));
    expect(html).toContain("note note-warn");
    expect(html).toContain("breaks a rule: Long runs stay on Saturdays");
    expect(html).not.toContain("pill pill-warnsoft");
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
    for (const selector of [".coach-panel", ".coach-sheet-panel", ".coach-thread", ".coach-scroll"]) {
      expect(ruleBody(selector), selector).not.toMatch(/\d+(vh|dvh)/);
    }
    expect(ruleBody(".sheet")).toContain("overflow: hidden");
  });

  it("the coach panel scrolls its tray and thread together, head and composer pinned", () => {
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

  it("the dock pill keeps the verdict word-for-word when the panel opens", () => {
    const collapsed = render(
      createElement(DockPill, { verdict, workout, today: "2026-08-14", onOpen: noop }),
    );
    expect(collapsed).toContain("Good to go");
    expect(collapsed).toContain('aria-expanded="false"');

    const expanded = render(
      createElement(DockPill, { verdict, workout, today: "2026-08-14", onOpen: noop, expanded: true }),
    );
    expect(expanded).toContain('aria-expanded="true"');
    // Not just the pill: the PHRASE holds its position. Dropping it here and
    // letting the panel head print it instead kept the box still and moved
    // the words 509px, which is the same defect with a different subject.
    expect(expanded).toContain("Good to go");
    expect(expanded).toContain("Hill Strides · Today 9 AM");
    // Character-for-character the same row, so nothing inside it can reflow.
    expect(expanded.replace(/ aria-expanded="true"/, "")).toBe(
      collapsed.replace(/ aria-expanded="false"/, ""),
    );
  });

  it("the panel head does not repeat the verdict — it renders exactly once", () => {
    const html = render(createElement(DockVerdict, { verdict }));
    expect(html).toContain("HRV 64 (base 62)");
    expect(html).not.toContain("Good to go");
  });

  it("a centred desktop dialog freezes its geometry on the disclosure, not on open", () => {
    expect(css).toContain(".sheet-backdrop[data-pinned]");
    expect(css).toContain("margin-top: var(--sheet-pin, 0px)");
    // Both numbers, together: the top edge AND the height it had when the
    // reader pressed something. Capping height is what keeps the pinned
    // action row still while the disclosure grows into the body's scroller.
    expect(ruleBody("  .sheet-backdrop[data-pinned] > .sheet")).toContain(
      "var(--sheet-hold, 100dvh)",
    );
    expect(ruleBody("  .sheet-backdrop[data-pinned] > .sheet")).toContain(
      "calc(100dvh - var(--sheet-pin, 0px) - 1.5rem)",
    );
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

  it("nothing needing action starts hidden: the tray shares the thread's scroller", () => {
    // The scroll owner holds the tray AND the thread, so "scroll to the
    // newest message" on open would start below "Needs you · N". CoachThread
    // takes `trayAbove` for exactly that case; the ordering here is what
    // makes it necessary.
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
            createdAt: "2026-08-06T10:00:00Z",
            expiresAt: "2026-08-08",
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
    const scroll = html.indexOf("coach-scroll");
    expect(scroll).toBeLessThan(html.indexOf("coach-tray"));
    expect(html.indexOf("coach-tray")).toBeLessThan(html.indexOf("coach-thread"));
    expect(html).toContain("Needs you · 1");
  });
});

// ── 6. The overlay and the column share one width ──────────────────────────

describe("the coach overlay reserves its own room", () => {
  it("one custom property drives both the window and the gutter the page yields", () => {
    expect(ruleBody(".plan-page")).toContain("--coach-w:");
    expect(ruleBody(".coach-window")).toContain("width: var(--coach-w");
    expect(ruleBody("  .plan-page--coach-open")).toContain(
      "padding-right: calc(var(--coach-w) + 1.5rem)",
    );
  });
});
