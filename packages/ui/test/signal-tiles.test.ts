import { describe, expect, it } from "vitest";
import {
  hasDrilldown,
  pickTileVisual,
  pickStatusStripMetric,
  statusStripBaseText,
  firstSentence,
  stripKindForMetricId,
} from "../src/signal-tiles.js";
import type { InterpretedMetric } from "../src/signal-tiles.js";

// Minimal builder — only the fields the functions under test read are
// meaningful per-case; everything else gets a plausible default so each
// test can override just what matters.
function metric(overrides: Partial<InterpretedMetric> & { id: string }): InterpretedMetric {
  return {
    title: overrides.id,
    status: "ok",
    meaning: "meaning",
    sampleNote: "sample",
    ...overrides,
  };
}

describe("pickTileVisual", () => {
  it("draws gauge AND sparkline when both are present, outranking any strip", () => {
    // Spec §B2 asks the recovery tiles for both: the gauge says where today
    // sits against the band, the sparkline says how it got there. A gauge
    // alone can't tell "46 bpm, steady" from "46 bpm, climbing all week".
    const m = metric({
      id: "restingHr",
      gauge: { min: 0, max: 100, healthyLo: 60, healthyHi: 100, value: 80 },
      series: [{ date: "2026-01-01", value: 1 }],
      strip: [{ date: "2026-01-01", on: true }],
    });
    expect(pickTileVisual(m)).toBe("gauge+spark");
  });

  it("picks a bare gauge when there is no series to pair it with", () => {
    const m = metric({
      id: "ramp",
      gauge: { min: 0, max: 100, healthyLo: 60, healthyHi: 100, value: 80 },
      strip: [{ date: "2026-01-01", on: true }],
    });
    expect(pickTileVisual(m)).toBe("gauge");
  });

  it("treats an empty series as absent beside a gauge, giving a bare gauge not gauge+spark", () => {
    const m = metric({
      id: "ramp",
      gauge: { min: 0, max: 100, healthyLo: 60, healthyHi: 100, value: 80 },
      series: [],
    });
    expect(pickTileVisual(m)).toBe("gauge");
  });

  it("picks sparkline when series is present and non-empty but no gauge", () => {
    const m = metric({
      id: "x",
      series: [{ date: "2026-01-01", value: 1 }],
      strip: [{ date: "2026-01-01", on: true }],
    });
    expect(pickTileVisual(m)).toBe("sparkline");
  });

  it("picks strip when only strip is present and non-empty", () => {
    const m = metric({ id: "x", strip: [{ date: "2026-01-01", on: true }] });
    expect(pickTileVisual(m)).toBe("strip");
  });

  it("treats an empty series array as absent and falls through to strip", () => {
    const m = metric({ id: "x", series: [], strip: [{ date: "2026-01-01", on: true }] });
    expect(pickTileVisual(m)).toBe("strip");
  });

  it("treats an empty strip array as absent, returning none when nothing else is present", () => {
    const m = metric({ id: "x", strip: [] });
    expect(pickTileVisual(m)).toBe("none");
  });

  it("returns none when gauge, series, and strip are all absent", () => {
    const m = metric({ id: "x" });
    expect(pickTileVisual(m)).toBe("none");
  });
});

describe("hasDrilldown", () => {
  it("is true for a metric with per-run detail", () => {
    const m = metric({ id: "easyDiscipline", detail: { explain: "why", runs: [] } });
    expect(hasDrilldown(m)).toBe(true);
  });

  it("is true for a recovery metric with a daily series AND its baseline band but NO detail", () => {
    // restingHr/hrv carry no `detail` at all — this is the case the original
    // `!!m.detail` gate made unreachable.
    const m = metric({
      id: "restingHr",
      series: [{ date: "2026-01-01", value: 48 }],
      baseline: { value: 48, lo: 43, hi: 53, unit: "bpm" },
    });
    expect(m.detail).toBeUndefined();
    expect(hasDrilldown(m)).toBe(true);
  });

  it("is false for a series with no baseline band — a bare line draws no sheet worth opening", () => {
    const m = metric({ id: "someFutureMetric", series: [{ date: "2026-01-01", value: 1.1 }] });
    expect(hasDrilldown(m)).toBe(false);
  });

  it("is true for loadRatio, whose baseline of 1 IS the norm the ratio is built against", () => {
    // The worker now emits `baseline` for loadRatio (misc.ts) because 1.0 is
    // the norm by construction, not an estimate — which turns its 56 daily
    // ratios from a sparkline with nowhere to go into a real baseline-band
    // sheet against the 0.8–1.3 sweet spot.
    const m = metric({
      id: "loadRatio",
      series: [
        { date: "2026-01-01", value: 1.1 },
        { date: "2026-01-02", value: 1.05 },
      ],
      baseline: { value: 1, lo: 0.8, hi: 1.3, unit: "× norm" },
    });
    expect(m.detail).toBeUndefined();
    expect(hasDrilldown(m)).toBe(true);
  });

  it("is false when the series is present but empty", () => {
    const m = metric({
      id: "restingHr",
      series: [],
      baseline: { value: 48, lo: 43, hi: 53, unit: "bpm" },
    });
    expect(hasDrilldown(m)).toBe(false);
  });

  it("is false for a metric with neither detail nor series", () => {
    expect(hasDrilldown(metric({ id: "monotony" }))).toBe(false);
  });

  it("is false for a strip-only metric — a strip is a tile visual, not evidence", () => {
    expect(hasDrilldown(metric({ id: "hardStack", strip: [{ date: "2026-01-01", on: true }] }))).toBe(
      false,
    );
  });
});

describe("pickStatusStripMetric", () => {
  it("picks the first band==='high' metric ahead of any watch metric, regardless of order", () => {
    const watchFirst = metric({ id: "a", band: "watch" });
    const high = metric({ id: "b", band: "high" });
    const result = pickStatusStripMetric([watchFirst, high]);
    expect(result.severity).toBe("high");
    expect(result.metric?.id).toBe("b");
  });

  it("picks the FIRST high metric when multiple are high", () => {
    const high1 = metric({ id: "first-high", band: "high" });
    const high2 = metric({ id: "second-high", band: "high" });
    const result = pickStatusStripMetric([high1, high2]);
    expect(result.metric?.id).toBe("first-high");
  });

  it("falls back to the first watch metric when no metric is high", () => {
    const healthy = metric({ id: "a", band: "healthy" });
    const watch1 = metric({ id: "first-watch", band: "watch" });
    const watch2 = metric({ id: "second-watch", band: "watch" });
    const result = pickStatusStripMetric([healthy, watch1, watch2]);
    expect(result.severity).toBe("watch");
    expect(result.metric?.id).toBe("first-watch");
  });

  it("returns clear with no metric when every band is healthy/low/undefined", () => {
    const healthy = metric({ id: "a", band: "healthy" });
    const low = metric({ id: "b", band: "low" });
    const insufficient = metric({ id: "c", status: "insufficient_data", band: undefined });
    const result = pickStatusStripMetric([healthy, low, insufficient]);
    expect(result.severity).toBe("clear");
    expect(result.metric).toBeUndefined();
  });

  it("returns clear for an empty metric list", () => {
    expect(pickStatusStripMetric([])).toEqual({ severity: "clear" });
  });

  it("skips a high-severity metric outside renderedIds and picks the next eligible one", () => {
    // A future worker metric could arrive with no group in the grid (see
    // insights.tsx's METRIC_GROUPS) — without renderedIds it would headline
    // the strip and offer a "scroll to signal-futureMetric" click target
    // that doesn't exist anywhere on the page.
    const futureHigh = metric({ id: "futureMetric", band: "high" });
    const renderedWatch = metric({ id: "hardStack", band: "watch" });
    const result = pickStatusStripMetric([futureHigh, renderedWatch], new Set(["hardStack"]));
    expect(result.severity).toBe("watch");
    expect(result.metric?.id).toBe("hardStack");
  });

  it("also accepts renderedIds as a plain array, not just a Set", () => {
    const futureHigh = metric({ id: "futureMetric", band: "high" });
    const renderedWatch = metric({ id: "hardStack", band: "watch" });
    const result = pickStatusStripMetric([futureHigh, renderedWatch], ["hardStack"]);
    expect(result.severity).toBe("watch");
    expect(result.metric?.id).toBe("hardStack");
  });

  it("falls all the way to clear when the only high/watch metrics are outside renderedIds", () => {
    const futureHigh = metric({ id: "futureMetric", band: "high" });
    const renderedHealthy = metric({ id: "hardStack", band: "healthy" });
    const result = pickStatusStripMetric([futureHigh, renderedHealthy], new Set(["hardStack"]));
    expect(result.severity).toBe("clear");
    expect(result.metric).toBeUndefined();
  });

  it("behaves exactly as before when renderedIds is omitted", () => {
    const high = metric({ id: "anything", band: "high" });
    expect(pickStatusStripMetric([high])).toEqual({ severity: "high", metric: high });
  });

  // audit#2 (a4): an unconfident band must never headline the strip. The
  // worker contracts bandNote/staleNote to band: undefined; this gate holds
  // even if a payload regression ships both.
  it("never lets a metric carrying a bandNote win, whatever band arrived beside it", () => {
    const unconfidentHigh = metric({
      id: "lowIntensityShare",
      band: "high",
      bandNote: "This number crosses a status boundary within ±5 bpm of your easy ceiling.",
    });
    const confidentWatch = metric({ id: "hardStack", band: "watch" });
    const result = pickStatusStripMetric([unconfidentHigh, confidentWatch]);
    expect(result.severity).toBe("watch");
    expect(result.metric?.id).toBe("hardStack");
  });

  it("never lets a metric carrying a staleNote win — the reading describes the past", () => {
    const staleHigh = metric({ id: "restingHr", band: "high", staleNote: "last reading 4 days ago" });
    expect(pickStatusStripMetric([staleHigh])).toEqual({ severity: "clear" });
  });

  it("never lets an insufficient_data metric win even if a band leaks onto it", () => {
    const impossible = metric({ id: "ramp", status: "insufficient_data", band: "high" });
    expect(pickStatusStripMetric([impossible])).toEqual({ severity: "clear" });
  });

  it("falls all the way to clear when the only banded metric is unconfident", () => {
    const unconfidentHigh = metric({ id: "lowIntensityShare", band: "high", bandNote: "±5 bpm flip" });
    expect(pickStatusStripMetric([unconfidentHigh])).toEqual({ severity: "clear" });
  });
});

describe("statusStripBaseText", () => {
  it("counts only status==='ok' metrics in the all-clear line, not insufficient_data ones", () => {
    const interpreted = [
      metric({ id: "a", band: "healthy" }),
      metric({ id: "b", band: "low" }),
      metric({ id: "c", status: "insufficient_data", band: undefined }),
    ];
    const pick = pickStatusStripMetric(interpreted);
    const result = statusStripBaseText(pick, interpreted);
    expect(result.base).toBe("All 2 signals in range");
  });

  it("reports no awaitingCount when every metric is status==='ok'", () => {
    const interpreted = [metric({ id: "a", band: "healthy" }), metric({ id: "b", band: "low" })];
    const result = statusStripBaseText(pickStatusStripMetric(interpreted), interpreted);
    expect(result.awaitingCount).toBeUndefined();
  });

  it("reports awaitingCount equal to the number of insufficient_data metrics on the all-clear line", () => {
    const interpreted = [
      metric({ id: "a", band: "healthy" }),
      metric({ id: "b", status: "insufficient_data", band: undefined }),
      metric({ id: "c", status: "insufficient_data", band: undefined }),
    ];
    const result = statusStripBaseText(pickStatusStripMetric(interpreted), interpreted);
    expect(result.base).toBe("All 1 signals in range");
    expect(result.awaitingCount).toBe(2);
  });

  it("counts only rendered metrics when renderedIds is given, in both the count and awaitingCount", () => {
    // A worker metric the grid has no group for is invisible on the page.
    // Counting it here made the strip promise "All 3 signals in range" over a
    // grid of two tiles — and the awaiting clause point at a metric with no
    // tile to be awaiting anything on. Same filter as pickStatusStripMetric,
    // or the headline and its count disagree about what "the signals" are.
    const interpreted = [
      metric({ id: "loadRatio", band: "healthy" }),
      metric({ id: "ramp", band: "healthy" }),
      metric({ id: "notOnTheGrid", band: "healthy" }),
      metric({ id: "alsoNotOnTheGrid", status: "insufficient_data", band: undefined }),
    ];
    const rendered = ["loadRatio", "ramp"];
    const pick = pickStatusStripMetric(interpreted, rendered);
    const result = statusStripBaseText(pick, interpreted, rendered);
    expect(result.base).toBe("All 2 signals in range");
    expect(result.awaitingCount).toBeUndefined();
  });

  it("omitting renderedIds counts everything, exactly as before", () => {
    const interpreted = [
      metric({ id: "a", band: "healthy" }),
      metric({ id: "b", band: "healthy" }),
      metric({ id: "c", status: "insufficient_data", band: undefined }),
    ];
    const result = statusStripBaseText(pickStatusStripMetric(interpreted), interpreted);
    expect(result.base).toBe("All 2 signals in range");
    expect(result.awaitingCount).toBe(1);
  });

  it("does not report awaitingCount on the high-severity branch, even alongside insufficient_data metrics", () => {
    const interpreted = [
      metric({ id: "bad", band: "high" }),
      metric({ id: "pending", status: "insufficient_data", band: undefined }),
    ];
    const result = statusStripBaseText(pickStatusStripMetric(interpreted), interpreted);
    expect(result.awaitingCount).toBeUndefined();
  });

  it("builds the high-severity line with the ⚠ glyph, title, value, and first-sentence phrase", () => {
    const bad = metric({
      id: "bad",
      title: "Load vs your norm",
      band: "high",
      value: "1.8x",
      suggestion: "Way over your norm. Back off for a few days.",
    });
    const result = statusStripBaseText(pickStatusStripMetric([bad]), [bad]);
    expect(result.base).toBe("⚠ Load vs your norm: 1.8x — Way over your norm.");
  });

  it("builds the watch-severity line with no glyph at all — the ⚠ is high's alone", () => {
    // The old "•" read on the deployed page as a stray bullet in front of the
    // metric name ("• Low-intensity share: 66% …") — the strip is one line,
    // not a list, and the warn-colored left border already says "watch".
    const watching = metric({
      id: "watching",
      title: "Hard-day stacking",
      band: "watch",
      value: "2 days",
      suggestion: "Back-to-back hard days leave less room to absorb the work.",
    });
    const result = statusStripBaseText(pickStatusStripMetric([watching]), [watching]);
    expect(result.base).toBe("Hard-day stacking: 2 days — Back-to-back hard days leave less room to absorb the work.");
    expect(result.base).not.toContain("•");
    expect(result.base).not.toContain("⚠");
  });
});

describe("firstSentence", () => {
  it("returns the whole string when it is already a single sentence", () => {
    expect(firstSentence("Back-to-back hard days leave less room to absorb the work.")).toBe(
      "Back-to-back hard days leave less room to absorb the work.",
    );
  });

  it("drops trailing sentences after the first terminator", () => {
    expect(firstSentence("5 bpm above your baseline. One day means little; take the easier option.")).toBe(
      "5 bpm above your baseline.",
    );
  });

  it("handles em-dashes inside the first sentence without splitting on them", () => {
    expect(
      firstSentence(
        "A drop past your own noise threshold usually means accumulated stress — training, sleep, life. Easy days work here.",
      ),
    ).toBe("A drop past your own noise threshold usually means accumulated stress — training, sleep, life.");
  });

  it("returns the trimmed input verbatim when there is no terminating punctuation", () => {
    expect(firstSentence("  no terminator here  ")).toBe("no terminator here");
  });
});

describe("stripKindForMetricId", () => {
  it("classifies hardStack as the hard-day kind", () => {
    expect(stripKindForMetricId("hardStack")).toBe("hard");
  });

  it("classifies any other id (e.g. easyDiscipline) as the easy-run kind", () => {
    expect(stripKindForMetricId("easyDiscipline")).toBe("easy");
    expect(stripKindForMetricId("somethingElse")).toBe("easy");
  });
});
