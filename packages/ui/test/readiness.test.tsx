/**
 * The Readiness card (screens/today.tsx), audit 2026-08-14 finding 2.
 *
 * Garden said "Resting heart rate is 7 bpm above your recent median" while
 * Insights said "46 bpm · your baseline 49 bpm" — 3 BELOW. Both are true of
 * different measurements (one morning's reading against a ≤14-day median here;
 * a 3-reading median against a 30-day median there), but the card named
 * neither the reading nor the window, so the two surfaces read as a
 * contradiction. Static markup, same harness as the other screen tests.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TodayResponse } from "@rg/api-client";
import { Readiness } from "../src/screens/today.js";

type ReadinessData = TodayResponse["readiness"];

function data(over: Partial<ReadinessData> = {}): ReadinessData {
  return {
    latest: {
      date: "2026-08-10",
      restingHeartRate: 53,
      hrv: 62,
      recoveryScore: null,
      trainingLoad7d: null,
    },
    baseline: { restingHeartRate: 46, hrv: 70 },
    sampleDays: 14,
    ...over,
  };
}

const render = (readiness: ReadinessData) =>
  renderToStaticMarkup(createElement(Readiness, { readiness }));

describe("Readiness comparison basis", () => {
  it("names the reading, the median it is measured against, and the window", () => {
    const html = render(data());
    expect(html).toContain("Resting heart rate 53 bpm — 7 above your 46 bpm median.");
    expect(html).toContain("HRV 62 ms — 8 below your 70 ms median.");
    expect(html).toContain("median of your last 14 days of COROS data");
    // And says out loud why Insights can print a different number.
    expect(html).toContain("Insights compares a longer window");
    // The old, basis-free wording is gone.
    expect(html).not.toContain("your recent median");
  });

  it("reads 'below' when the morning came in under the median", () => {
    const html = render(
      data({
        latest: {
          date: "2026-08-10",
          restingHeartRate: 44,
          hrv: null,
          recoveryScore: null,
          trainingLoad7d: null,
        },
      }),
    );
    expect(html).toContain("Resting heart rate 44 bpm — 2 below your 46 bpm median.");
  });

  it("carries the reading's own date, so 'latest' is never mistaken for 'today'", () => {
    expect(render(data())).toContain("From COROS, as of Mon Aug 10.");
  });

  it("explains no window when it made no comparison — a bare COROS score stands alone", () => {
    const html = render(
      data({
        latest: {
          date: "2026-08-10",
          restingHeartRate: 53,
          hrv: null,
          recoveryScore: 82,
          trainingLoad7d: null,
        },
        baseline: null,
        sampleDays: 5,
      }),
    );
    expect(html).toContain("COROS recovery: 82%.");
    expect(html).not.toContain("median");
    expect(html).toContain("Context, not instructions");
  });

  it("a within-noise difference still says nothing at all", () => {
    const html = render(
      data({
        latest: {
          date: "2026-08-10",
          restingHeartRate: 47,
          hrv: 72,
          recoveryScore: null,
          trainingLoad7d: null,
        },
      }),
    );
    expect(html).toContain("Recovery signals look typical for you.");
    expect(html).not.toContain("bpm");
  });

  it("renders nothing at all on too few days of data", () => {
    expect(render(data({ sampleDays: 2 }))).toBe("");
    expect(render(data({ latest: null }))).toBe("");
  });
});
