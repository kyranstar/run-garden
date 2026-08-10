/**
 * Focused unit coverage for two pure/presentational pieces of the desktop
 * garden HUD pulled out of GardenScreen (screens/garden.tsx):
 *
 *  - BalanceStrip's run-bar caption (C2): the decay clock freezes under the
 *    adventure shield and rest mode, so its "N d ago" caption must say so
 *    instead of presenting a paused count as fresh recency.
 *  - dockCoversStage (C1/C23): the pure viewport-height heuristic that
 *    decides whether the Next Workout dock should default to its minimized
 *    pill on a short stage, so the panel never opens already covering the
 *    HUD above it.
 */
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DisciplineBalance } from "@rg/api-client";
import { BalanceStrip, dockCoversStage } from "../src/screens/garden.js";

const balance = (over: Partial<DisciplineBalance> = {}): DisciplineBalance => ({
  run: { days: 4, health: 0.6 },
  strength: { days: 2, health: 0.8 },
  yoga: { days: 1, health: 0.9 },
  overall: 0.75,
  ...over,
});

describe("BalanceStrip run caption (C2)", () => {
  it("shows the real day count by default", () => {
    const html = render(createElement(BalanceStrip, { balance: balance() }));
    expect(html).toContain("4 d ago");
    expect(html).not.toContain("sheltered");
  });

  it("says 'sheltered' instead of a day count when the run clock is frozen by the adventure shield or rest mode", () => {
    const html = render(createElement(BalanceStrip, { balance: balance(), runSheltered: true }));
    expect(html).toContain("sheltered");
    expect(html).not.toContain("4 d ago");
    // The bars/notches (health, width) are untouched — only the caption differs.
    expect(html).toMatch(/width:\s?60%/);
  });

  it("the aria-label matches the visible sheltered caption, not a stale recency claim", () => {
    const html = render(createElement(BalanceStrip, { balance: balance(), runSheltered: true }));
    expect(html).toContain("last run sheltered");
    expect(html).not.toContain("last run 4 d ago");
  });

  it("plan-paused still outranks the shelter caption", () => {
    const html = render(
      createElement(BalanceStrip, { balance: balance(), runPaused: true, runSheltered: true }),
    );
    expect(html).toContain("plan paused");
    expect(html).not.toContain("sheltered");
  });

  it("shelter only changes the run bar — strength/yoga captions stay their own day counts", () => {
    const html = render(createElement(BalanceStrip, { balance: balance(), runSheltered: true }));
    expect(html).toContain("2 d ago"); // strength
    expect(html).toContain("1 d ago"); // yoga (today's caption path, not "today" since 1 !== 0)
  });
});

describe("dockCoversStage (C1/C23)", () => {
  it("a short laptop-height stage: the panel would cover most of the HUD", () => {
    expect(dockCoversStage(700)).toBe(true);
  });

  it("a tall stage: the capped panel covers well under half", () => {
    expect(dockCoversStage(1200)).toBe(false);
  });

  it("crosses back to false above the derived break-even (~931px)", () => {
    expect(dockCoversStage(930)).toBe(true);
    expect(dockCoversStage(932)).toBe(false);
  });
});
