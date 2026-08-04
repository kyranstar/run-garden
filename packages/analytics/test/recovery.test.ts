import { describe, expect, it } from "vitest";
import { computeHardDayStacking, computeHrvTrend, computeRestingHr } from "../src/recovery.js";

const DAY = 86_400_000;
const TODAY = "2026-08-01";

function daysAgo(n: number, from = TODAY): string {
  return new Date(Date.parse(from) - n * DAY).toISOString().slice(0, 10);
}

describe("computeRestingHr", () => {
  it("current is the median of the 3 most recent readings, baseline the 30-day median", () => {
    const rows: { date: string; restingHeartRate: number | null }[] = [
      { date: daysAgo(0), restingHeartRate: 53 },
      { date: daysAgo(1), restingHeartRate: 52 },
      { date: daysAgo(2), restingHeartRate: 54 },
    ];
    // 20 older readings, steady at 48, so the 23-reading baseline median is 48
    // regardless of the 3 elevated recent values mixed into the same pool.
    for (let i = 0; i < 20; i++) {
      rows.push({ date: daysAgo(3 + i), restingHeartRate: 48 });
    }
    const r = computeRestingHr(rows, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.current).toBe(53);
    expect(r.value.baseline).toBe(48);
    expect(r.value.deltaBpm).toBe(5);
    expect(r.value.staleDays).toBe(0);
    expect(r.value.series.length).toBe(23);
    // ascending
    expect(r.value.series[0]!.date < r.value.series[r.value.series.length - 1]!.date).toBe(true);
  });

  it("suppresses when the newest reading is 8 days old, mentioning '8 days' in the explanation", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      date: daysAgo(8 + i),
      restingHeartRate: 50,
    }));
    const r = computeRestingHr(rows, TODAY);
    expect(r.status).toBe("insufficient_data");
    if (r.status !== "insufficient_data") return;
    expect(r.needed).toBe(7);
    expect(r.have).toBeLessThan(r.needed);
    expect(r.explanation).toContain("8 days");
  });

  it("computes staleDays = 3 when the newest reading is today - 3", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      date: daysAgo(3 + i),
      restingHeartRate: 50,
    }));
    const r = computeRestingHr(rows, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.staleDays).toBe(3);
  });

  it("suppresses with fewer than 7 valid readings in the last 60 days", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ date: daysAgo(i), restingHeartRate: 50 }));
    const r = computeRestingHr(rows, TODAY);
    expect(r.status).toBe("insufficient_data");
    if (r.status !== "insufficient_data") return;
    expect(r.needed).toBe(7);
    expect(r.have).toBe(5);
  });

  it("does NOT reach across a gap for `current`: one fresh reading beside a 45-day-old cluster suppresses", () => {
    // The demonstrated failure. Seven valid readings (passes the >=7 gate) and
    // a newest reading from today (passes the >7-days-stale gate), but the
    // other six sit 45-50 days back. `slice(0, 3)` without a recency filter
    // would take 47, 58, 58 -> a "58 bpm, watch" verdict built almost entirely
    // out of data from seven weeks ago, against a "baseline" of the same data.
    const rows: { date: string; restingHeartRate: number | null }[] = [
      { date: daysAgo(0), restingHeartRate: 47 },
    ];
    for (let i = 0; i < 6; i++) rows.push({ date: daysAgo(45 + i), restingHeartRate: 58 });

    const r = computeRestingHr(rows, TODAY);
    expect(r.status).toBe("insufficient_data");
    if (r.status !== "insufficient_data") return;
    // The gate reports ITS OWN counts, so the card's "Need N; have M." line
    // agrees with the sentence beside it instead of quoting the 60-day gate's
    // threshold against a zeroed count.
    expect(r.needed).toBe(2);
    expect(r.have).toBe(1);
    // Names the gap, so the card can explain itself rather than just going quiet.
    expect(r.explanation).toContain("1 resting heart-rate reading in the last 5 days");
    expect(r.explanation).toContain("next-oldest is 45 days old");
  });

  it("`current` ignores readings older than 5 days even when 3 newer-ranked ones exist", () => {
    // Two fresh readings (48, 50) then a wall of 60s starting 6 days back: the
    // recent window holds exactly 2, so `current` is their median (49) and the
    // third-ranked 60 never enters it.
    const rows: { date: string; restingHeartRate: number | null }[] = [
      { date: daysAgo(0), restingHeartRate: 48 },
      { date: daysAgo(1), restingHeartRate: 50 },
    ];
    for (let i = 0; i < 20; i++) rows.push({ date: daysAgo(6 + i), restingHeartRate: 60 });

    const r = computeRestingHr(rows, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.current).toBe(49);
    expect(r.value.baseline).toBe(60);
  });

  it("suppresses when the 30-day baseline pool has fewer than 7 readings", () => {
    // 3 fresh readings (so `current` is computable) + 4 more inside 30 days =
    // a 6-reading baseline pool, topped up past the 60-day length gate by
    // readings from 40+ days back that the 30-day pool cannot use.
    const rows: { date: string; restingHeartRate: number | null }[] = [];
    for (let i = 0; i < 3; i++) rows.push({ date: daysAgo(i), restingHeartRate: 50 });
    for (let i = 0; i < 3; i++) rows.push({ date: daysAgo(10 + i), restingHeartRate: 50 });
    for (let i = 0; i < 6; i++) rows.push({ date: daysAgo(40 + i), restingHeartRate: 50 });

    const r = computeRestingHr(rows, TODAY);
    expect(r.status).toBe("insufficient_data");
    if (r.status !== "insufficient_data") return;
    expect(r.needed).toBe(7);
    expect(r.have).toBe(6);
    expect(r.explanation).toContain("last 30 days");
  });
});

describe("computeHrvTrend", () => {
  it("uses an uncontaminated baseline: recent7 median 58, ranks 8..37 median 64", () => {
    const rows: { date: string; hrv: number | null }[] = [];
    // Recent 7 (ranks 1-7, days 0-6 ago): sorted values 55,56,57,58,59,60,61 -> median 58.
    const recentValues = [58, 56, 60, 55, 61, 57, 59];
    for (let i = 0; i < 7; i++) rows.push({ date: daysAgo(i), hrv: recentValues[i]! });
    // Baseline (ranks 8-37, days 7-36 ago): 15x63 + 15x65 -> median 64.
    for (let i = 0; i < 30; i++) {
      rows.push({ date: daysAgo(7 + i), hrv: i < 15 ? 63 : 65 });
    }
    const r = computeHrvTrend(rows, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.recent).toBe(58);
    expect(r.value.baseline).toBe(64);
    // (58-64)/64*100 = -9.375 -> -9.4; the old contaminated-baseline regime
    // (median of vals.slice(0,30), which overlaps the recent 7) would have
    // pulled the baseline down toward ~61 and produced roughly -7.x instead.
    expect(r.value.pctVsBaseline).toBeCloseTo(-9.4, 1);
  });

  it("caps the baseline pool at ranks 8-37, excluding rank-38+ readings even when present", () => {
    const rows: { date: string; hrv: number | null }[] = [];
    // Recent 7 (ranks 1-7, days 0-6 ago): arbitrary, doesn't affect this assertion.
    for (let i = 0; i < 7; i++) rows.push({ date: daysAgo(i), hrv: 60 });
    // Baseline (ranks 8-37, days 7-36 ago): 30 readings, all 60 -> median 60.
    for (let i = 0; i < 30; i++) rows.push({ date: daysAgo(7 + i), hrv: 60 });
    // Rank 38+ (days 37-67 ago): 31 readings at a very different value (150).
    // 31 > 30 (the baseline pool size) is deliberate: if these leaked into an
    // uncapped baseline pool, they'd outnumber the rank-8..37 readings and
    // drag the combined median all the way to 150, making the leak obvious
    // rather than accidentally still landing near 60.
    for (let i = 0; i < 31; i++) rows.push({ date: daysAgo(37 + i), hrv: 150 });
    const r = computeHrvTrend(rows, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.baseline).toBe(60);
  });

  it("thresholdPct falls back to 10 when baseline readings are identical (CV incomputable)", () => {
    const rows: { date: string; hrv: number | null }[] = [];
    for (let i = 0; i < 7; i++) rows.push({ date: daysAgo(i), hrv: 60 });
    for (let i = 0; i < 10; i++) rows.push({ date: daysAgo(7 + i), hrv: 60 });
    const r = computeHrvTrend(rows, TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.thresholdPct).toBe(10);
  });

  it("suppresses with 16 valid readings, needing 17", () => {
    const rows = Array.from({ length: 16 }, (_, i) => ({ date: daysAgo(i), hrv: 60 }));
    const r = computeHrvTrend(rows, TODAY);
    expect(r.status).toBe("insufficient_data");
    if (r.status !== "insufficient_data") return;
    expect(r.needed).toBe(17);
    expect(r.have).toBe(16);
  });

  it("suppresses when the newest reading is stale (>7 days old)", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ date: daysAgo(8 + i), hrv: 60 }));
    const r = computeHrvTrend(rows, TODAY);
    expect(r.status).toBe("insufficient_data");
    if (r.status !== "insufficient_data") return;
    expect(r.needed).toBe(17);
    expect(r.have).toBeLessThan(r.needed);
  });

  it("suppresses when the 7 most recent readings are not all within 14 days of today", () => {
    // Newest reading is today (passes the overall staleness gate), but the
    // recent-7 window is sparse and its oldest member is 20 days back.
    const rows: { date: string; hrv: number | null }[] = [
      { date: daysAgo(0), hrv: 60 },
      { date: daysAgo(2), hrv: 60 },
      { date: daysAgo(5), hrv: 60 },
      { date: daysAgo(9), hrv: 60 },
      { date: daysAgo(12), hrv: 60 },
      { date: daysAgo(16), hrv: 60 },
      { date: daysAgo(20), hrv: 60 },
    ];
    for (let i = 0; i < 10; i++) rows.push({ date: daysAgo(25 + i), hrv: 60 });
    const r = computeHrvTrend(rows, TODAY);
    expect(r.status).toBe("insufficient_data");
    if (r.status !== "insufficient_data") return;
    expect(r.needed).toBe(17);
    expect(r.have).toBeLessThan(r.needed);
  });
});

describe("computeHardDayStacking", () => {
  it("counts a yesterday-ending streak when today has nothing hard yet", () => {
    const r = computeHardDayStacking([daysAgo(2), daysAgo(1)], TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.consecutive).toBe(2);
  });

  it("counts a today-ending streak of 3, with a 7-entry ascending strip ending hard:true", () => {
    const r = computeHardDayStacking([daysAgo(2), daysAgo(1), daysAgo(0)], TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.consecutive).toBe(3);
    expect(r.value.strip.length).toBe(7);
    expect(r.value.strip[6]!.date).toBe(TODAY);
    expect(r.value.strip[6]!.hard).toBe(true);
    expect(r.value.strip[0]!.date < r.value.strip[6]!.date).toBe(true);
  });

  it("reports 0 (not suppressed) when there are no hard days", () => {
    const r = computeHardDayStacking([], TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.consecutive).toBe(0);
  });
});
