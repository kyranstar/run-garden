/**
 * Focused unit coverage for two pure/presentational pieces of the desktop
 * garden HUD pulled out of GardenScreen (screens/garden.tsx):
 *
 *  - BalanceStrip's run-bar caption (C2): the decay clock freezes under the
 *    adventure shield and rest mode, so its "N d ago" caption must say so
 *    instead of presenting a paused count as fresh recency. Round 2: the
 *    clock can also sit BEHIND true recency once a past shield has ended
 *    (it never advances on a frozen day, so it never catches back up) —
 *    runTrueRecencyDays (derived server-side from the true calendar date of
 *    the last completed run) takes over the caption whenever known.
 *  - dockCoversStage (C1/C23): the pure viewport-height heuristic that
 *    decides whether the Next Workout dock should default to its minimized
 *    pill on a short stage, so the panel never opens already covering the
 *    HUD above it.
 *  - DockVerdict / DockPill (readiness-first dock, 2026-08-14): the dock
 *    leads with a readiness verdict and names the workout second — and when
 *    there is no verdict it must fall back to the exact card that shipped
 *    before, not an empty slot.
 */
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DisciplineBalance, WorkoutDto } from "@rg/api-client";
import type { ReadinessVerdict } from "@rg/domain";
import { initialSnapshot, type GardenSnapshot, type GardenState } from "@rg/garden-engine";
import {
  BalanceStrip,
  DockPill,
  DockVerdict,
  dockCoversStage,
  forecastVoice,
} from "../src/screens/garden.js";

const balance = (over: Partial<DisciplineBalance> = {}): DisciplineBalance => ({
  run: { days: 4, health: 0.6 },
  strength: { days: 2, health: 0.8 },
  yoga: { days: 1, health: 0.9 },
  overall: 0.75,
  ...over,
});

describe("BalanceStrip run caption (C2)", () => {
  it("shows the clock's day count when no true-recency date is known", () => {
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

  it("the aria-label describes the sheltered state sensibly, not a stale recency claim", () => {
    const html = render(createElement(BalanceStrip, { balance: balance(), runSheltered: true }));
    expect(html).toContain("sheltered today, so the run clock is paused");
    expect(html).not.toContain("last run sheltered");
    expect(html).not.toContain("last run 4 d ago");
  });

  it("plan-paused still outranks the shelter caption, and its aria reads as a sentence (not 'last run plan paused')", () => {
    const html = render(
      createElement(BalanceStrip, { balance: balance(), runPaused: true, runSheltered: true }),
    );
    expect(html).toContain("plan paused");
    expect(html).not.toContain("sheltered");
    expect(html).toContain("no active plan, so the run clock is paused");
    expect(html).not.toContain("last run plan paused");
  });

  it("shelter only changes the run bar — strength/yoga captions stay their own day counts", () => {
    const html = render(createElement(BalanceStrip, { balance: balance(), runSheltered: true }));
    expect(html).toContain("2 d ago"); // strength
    expect(html).toContain("1 d ago"); // yoga (today's caption path, not "today" since 1 !== 0)
  });

  it("renders TRUE recency from runTrueRecencyDays when the clock is behind it (round 2)", () => {
    // The clock says 4 (frozen for a stretch by a shield that has since
    // ended), but the true last-run date is 9 days back.
    const html = render(
      createElement(BalanceStrip, { balance: balance(), runTrueRecencyDays: 9 }),
    );
    expect(html).toContain("9 d ago");
    expect(html).not.toContain("4 d ago");
    expect(html).toContain("last run 9 d ago"); // aria matches the visible caption
  });

  it("sheltered (today) still outranks true recency — the clock isn't behind reality on a day it's legitimately paused", () => {
    const html = render(
      createElement(BalanceStrip, {
        balance: balance(),
        runSheltered: true,
        runTrueRecencyDays: 9,
      }),
    );
    expect(html).toContain("sheltered");
    expect(html).not.toContain("9 d ago");
  });

  it("plan-paused outranks true recency too", () => {
    const html = render(
      createElement(BalanceStrip, {
        balance: balance(),
        runPaused: true,
        runTrueRecencyDays: 9,
      }),
    );
    expect(html).toContain("plan paused");
    expect(html).not.toContain("9 d ago");
  });

  it("falls back to the clock when runTrueRecencyDays is null (no run ever recorded)", () => {
    const html = render(
      createElement(BalanceStrip, { balance: balance(), runTrueRecencyDays: null }),
    );
    expect(html).toContain("4 d ago");
  });

  it("true recency only changes the run bar — strength/yoga stay clock-driven", () => {
    const html = render(
      createElement(BalanceStrip, { balance: balance(), runTrueRecencyDays: 9 }),
    );
    expect(html).toContain("2 d ago"); // strength, unaffected
    expect(html).toContain("1 d ago"); // yoga, unaffected
  });
});

// Live prod shape (2026-08-14): HRV 64 against a 62 median, RHR 47 against
// 46, COROS recovery 100.
const goodVerdict: ReadinessVerdict = {
  level: "good",
  reasons: ["HRV 64 (base 62)", "RHR 47 (base 46)", "recovery 100%"],
};
const poorVerdict: ReadinessVerdict = {
  level: "poor",
  reasons: ["RHR 9 bpm above your baseline", "HRV 6% below your baseline"],
};
const workout = (over: Partial<WorkoutDto> = {}): WorkoutDto =>
  ({
    id: "w1",
    title: "Hill Strides",
    category: "quality",
    sport: "run",
    effectiveDate: "2026-08-14",
    effectiveTime: "09:00",
    ...over,
  }) as WorkoutDto;

describe("DockVerdict (readiness-first dock)", () => {
  it("prints the evidence, and leaves the verdict phrase to the pill below it", () => {
    const html = render(createElement(DockVerdict, { verdict: goodVerdict }));
    expect(html).toContain("HRV 64 (base 62) · RHR 47 (base 46) · recovery 100%");
    // NOT the phrase: the pill renders that in both dock states, so the words
    // the reader is looking at hold one y instead of jumping 509px on expand.
    expect(html).not.toContain("Good to go");
    // The numbers still announce what they are evidence for.
    expect(html).toContain("Why: ");
    // The level is on the wrapper (colour).
    expect(html).toContain("dock-verdict-good");
  });

  it("a poor morning still shows its numbers, and still names its level in the markup", () => {
    const html = render(createElement(DockVerdict, { verdict: poorVerdict }));
    expect(html).not.toContain("Recovery is low");
    expect(html).toContain("RHR 9 bpm above your baseline");
    expect(html).toContain("dock-verdict-poor");
  });

  it("renders NOTHING when there is no verdict — no empty readiness slot", () => {
    expect(render(createElement(DockVerdict, { verdict: null }))).toBe("");
    expect(render(createElement(DockVerdict, { verdict: undefined }))).toBe("");
    // Not even the coach line: with no verdict the dock is the card it was
    // before readiness led it.
    expect(
      render(
        createElement(DockVerdict, {
          verdict: null,
          focus: { text: "Saturday's long run is the anchor.", at: "2026-08-14T07:12:54.826Z" },
        }),
      ),
    ).toBe("");
  });

  it("quotes the coach's own line, labelled and dated so it never reads as a remark about today", () => {
    const html = render(
      createElement(DockVerdict, {
        verdict: goodVerdict,
        focus: { text: "Saturday&#x27;s long run is the anchor.", at: "2026-08-14T07:12:54.826Z" },
      }),
    );
    expect(html).toContain("Coach · Fri Aug 14");
    expect(html).toContain("long run is the anchor");
    expect(html).toContain("not a comment on today&#x27;s readiness");
  });

  it("shows no coach line at all when the server withheld a stale one", () => {
    const html = render(createElement(DockVerdict, { verdict: goodVerdict, focus: null }));
    expect(html).not.toContain("Coach");
    expect(html).toContain("HRV 64 (base 62)");
  });
});

describe("DockPill (collapsed dock)", () => {
  it("leads with the verdict, then names the workout", () => {
    const html = render(
      createElement(DockPill, {
        verdict: goodVerdict,
        workout: workout(),
        today: "2026-08-14",
        onOpen: () => {},
      }),
    );
    expect(html).toContain("Good to go");
    expect(html).toContain("Hill Strides · Today 9 AM");
    expect(html).toContain("dock-verdict-good");
    // The verdict is the headline, so the old "Next:" prefix steps aside.
    expect(html).not.toContain("Next:");
  });

  it("with no verdict it is exactly the pill that shipped before", () => {
    const html = render(
      createElement(DockPill, {
        verdict: null,
        workout: workout(),
        today: "2026-08-14",
        onOpen: () => {},
      }),
    );
    expect(html).toContain("Next: Hill Strides · Today 9 AM");
    expect(html).not.toContain("dock-verdict");
  });

  it("keeps the rest-day and no-plan wordings, verdict or not", () => {
    const rest = { workout: workout({ category: "rest" }), today: "2026-08-14", onOpen: () => {} };
    expect(render(createElement(DockPill, { ...rest, verdict: null }))).toContain("Rest day · Today");
    const withVerdict = render(createElement(DockPill, { ...rest, verdict: poorVerdict }));
    expect(withVerdict).toContain("Recovery is low");
    expect(withVerdict).toContain("Rest day · Today");
    expect(
      render(
        createElement(DockPill, { verdict: null, workout: null, today: "2026-08-14", onOpen: () => {} }),
      ),
    ).toContain("No active training plan");
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

/**
 * The forecast's VOICE (audit#4 D9). The balance strip goes quiet when the
 * forecast is already speaking a loss for the garden, and until now it decided
 * that by restating the forecast's branch conditions in `GardenScreen` — a
 * copy that drifted (it claimed a voice in the no-plan branch, where the line
 * renders nothing at all) and then went dead when `quiet` was hardcoded true.
 * One function answers now, so these are the branches that answer differently.
 */
describe("forecastVoice: which branches speak a loss", () => {
  const base = (over: Partial<GardenState> = {}): GardenSnapshot => {
    const s = initialSnapshot("2026-08-01");
    return { ...s, state: { ...s.state, ...over } };
  };
  const run = (o: Partial<Parameters<typeof forecastVoice>[0]> = {}) =>
    forecastVoice({
      snapshot: base(),
      todayDate: "2026-08-14",
      daysAhead: 0,
      nextWorkout: workout({ category: "easy", effectiveDate: "2026-08-20" }),
      ...o,
    });

  it("an adventure shield is reassurance, never a loss", () => {
    for (const adv of [
      { frozenToday: true, graceDay: false, lastSport: "ski", lastDate: "2026-08-14" },
      { frozenToday: false, graceDay: true, lastSport: "ski", lastDate: "2026-08-13" },
    ]) {
      expect(run({ adventure: adv })?.kind).toBe("calm");
    }
  });

  it("recovery rain is reassurance — so the bars keep their voice", () => {
    // The measured hole: `quiet` was unconditional, so a garden drinking in
    // recovery rain while strength and yoga starved said nothing about them.
    const v = run({ snapshot: base({ inComeback: true, restMode: false }) });
    expect(v?.kind).toBe("calm");
  });

  it("a taper is reassurance", () => {
    expect(run({ nextWorkout: workout({ category: "rest", effectiveDate: "2026-08-14" }) })?.kind)
      .toBe("calm");
  });

  it("a dry spell, a drought and a deep drought are losses", () => {
    for (const days of [5, 10, 20]) {
      const v = run({ snapshot: base({ daysSinceCompletedRun: days }) });
      expect(v?.kind, `${days} days`).toBe("loss");
    }
  });

  it("with no plan it renders NOTHING — so it cannot be counted as a voice", () => {
    // This is the branch the restated copy got wrong: `fc.next !== null` was
    // true, so the strip went quiet for a line that was never on the page.
    expect(run({ nextWorkout: null })).toBeNull();
    expect(run({ nextWorkout: undefined })).toBeNull();
  });

  it("rest mode silences the forecast entirely", () => {
    expect(run({ snapshot: base({ restMode: true }) })).toBeNull();
  });
});
