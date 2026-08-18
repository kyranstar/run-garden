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
 *  - DockPill (System 1 v2): the collapsed control from lg names the workout
 *    and ONLY the workout — readiness moved to the Today card's chip and the
 *    Readiness sheet behind it, in exactly one place.
 *  - ReadinessSheet: the numbers say "usually N", never "baseline median";
 *    the provenance paragraph survives the card it replaced.
 *  - loopLine (System 1 v2): the cause→effect sentence on the scene — every
 *    weather state names what training does to the garden, both directions.
 */
import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DisciplineBalance, WorkoutDto } from "@rg/api-client";
import type { ReadinessVerdict } from "@rg/domain";
import { initialSnapshot, type GardenSnapshot, type GardenState } from "@rg/garden-engine";
import {
  BalanceStrip,
  coachClause,
  DockPill,
  dockCoversStage,
  forecastVoice,
  loopLine,
  ReadinessSheet,
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

describe("ReadinessSheet (the one place the numbers live)", () => {
  it("phrases every number without jargon — the reading, then 'usually N'", () => {
    const html = render(
      createElement(ReadinessSheet, {
        readiness: {
          latest: { date: "2026-08-14", restingHeartRate: 47, hrv: 64, recoveryScore: 100, trainingLoad7d: null },
          baseline: { restingHeartRate: 46, hrv: 62 },
          sampleDays: 14,
          verdict: goodVerdict,
        },
        onClose: () => {},
      }),
    );
    expect(html).toContain("Good to go");
    expect(html).toContain("usually 46");
    expect(html).toContain("usually 62");
    expect(html).toContain("COROS recovery");
    // The banned vocabulary: the sheet speaks plainly or not at all.
    expect(html).not.toContain("baseline");
    expect(html).not.toContain("median");
  });

  it("keeps the provenance honesty: dated, windowed, context-not-instructions", () => {
    const html = render(
      createElement(ReadinessSheet, {
        readiness: {
          latest: { date: "2026-08-14", restingHeartRate: 47, hrv: null, recoveryScore: null, trainingLoad7d: null },
          baseline: null,
          sampleDays: 14,
          verdict: null,
        },
        onClose: () => {},
      }),
    );
    expect(html).toContain("From COROS, as of Fri Aug 14");
    expect(html).toContain("your last 14 days");
    expect(html).toContain("you know your body best");
  });

  it("claims no window it does not have — under 3 sample days the sentence drops the comparison", () => {
    const html = render(
      createElement(ReadinessSheet, {
        readiness: {
          latest: { date: "2026-08-14", restingHeartRate: 47, hrv: null, recoveryScore: null, trainingLoad7d: null },
          baseline: null,
          sampleDays: 1,
          verdict: null,
        },
        onClose: () => {},
      }),
    );
    expect(html).not.toContain("your last 1 days");
    expect(html).toContain("you know your body best");
  });
});

describe("coachClause (the coach is reachable even when the weekly line is stale)", () => {
  it("applies the verdict to the day instead of restating the chip's phrase", () => {
    for (const level of ["poor", "caution", "good"] as const) {
      const c = coachClause(level, "quality")!;
      expect(c, level).toBeTruthy();
      // The chip already says the level; the clause says what to do with it.
      expect(c, level).not.toContain("Recovery is low");
      expect(c, level).not.toContain("Good to go");
      expect(c, level).not.toContain("Take it easy");
    }
    expect(coachClause("poor", "quality")).toContain("easy end");
    expect(coachClause("good", "long")).toContain("full effort");
  });

  it("stays silent on rest days and without a verdict", () => {
    expect(coachClause("poor", "rest")).toBeNull();
    expect(coachClause(null, "quality")).toBeNull();
    expect(coachClause(undefined, undefined)).toBeNull();
  });
});

describe("loopLine (the loop, stated on every visit)", () => {
  it("every weather state names cause AND effect", () => {
    const weathers = [
      "fresh_rain", "recovery_rain", "soft_sun", "clear_sun",
      "seasonal_breeze", "light_clouds", "dry_spell", "mild_drought",
    ] as const;
    for (const wx of weathers) {
      const line = loopLine(wx, 3);
      // One sentence, two halves: the weather word, then what training does.
      expect(line, wx).toMatch(/—/);
      expect(line.length, wx).toBeGreaterThan(20);
    }
  });

  it("the growing direction credits the workout; the drying direction counts the days", () => {
    expect(loopLine("clear_sun", 0)).toContain("every workout you finish waters it");
    expect(loopLine("dry_spell", 4)).toContain("4 days without a run");
    expect(loopLine("mild_drought", 15)).toContain("15 days without a run");
    expect(loopLine("dry_spell", 1)).toContain("1 day without");
  });
});

describe("DockPill (collapsed control, lg only)", () => {
  it("names the workout and nothing else — readiness is the chip's job now", () => {
    const html = render(
      createElement(DockPill, { workout: workout(), today: "2026-08-14", onOpen: () => {} }),
    );
    expect(html).toContain("Next: Hill Strides · Today 9 AM");
    expect(html).not.toContain("Good to go");
    expect(html).not.toContain("dock-verdict");
  });

  it("keeps the rest-day and no-plan wordings", () => {
    expect(
      render(createElement(DockPill, { workout: workout({ category: "rest" }), today: "2026-08-14", onOpen: () => {} })),
    ).toContain("Rest day · Today");
    expect(
      render(createElement(DockPill, { workout: null, today: "2026-08-14", onOpen: () => {} })),
    ).toContain("No active training plan");
  });

  it("with no plan it is a status line, not a button", () => {
    const html = render(
      createElement(DockPill, { workout: null, today: "2026-08-14", onOpen: () => {}, disclosable: false }),
    );
    expect(html).toContain("<p");
    expect(html).not.toContain("<button");
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
