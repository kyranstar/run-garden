/**
 * The Activity feed's app, merged and imported sessions (Phase 2d Task 2; mocks §8): an app session's row reads
 * "31 min · Consistent · Jaw 2 → 1" — its mode and its check values, the check's word from the profile's own label —
 * and its expansion lists the logged sets as typed, the moves played without a set, and the watch's heart rate on a
 * merged row. An imported session says "Imported" in its expansion only; it has no heart rate to show.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActivityDto, PerformedSummaryDto } from "@rg/api-client";
import { ActivityDetail, checkValues, feedRowMeta, RunsScreen } from "../src/screens/runs.js";
import { emptyInsights } from "./runs-units.test.js";

const appPerformed: PerformedSummaryDto = {
  source: "app",
  mode: "consistent",
  theme: "Hips & posture",
  checks: [{ profileId: "tmj", label: "Jaw / head", pre: 2, post: 1 }],
  played: { moves: 9, seconds: 840 },
};

const merged: ActivityDto = {
  id: "a-merged",
  startTime: "2026-10-14T19:05:00Z",
  startTimeLocal: "2026-10-14T12:05:00",
  date: "2026-10-14",
  title: "Jaw care · Hips & posture",
  sport: "strength",
  durationSeconds: 1860,
  distanceMeters: null,
  avgPaceSecPerKm: null,
  trainingLoad: 22,
  avgHeartRate: 104,
  feel: null,
  laps: null,
  logged: [
    {
      exerciseId: "gobletSquat",
      name: "Goblet squat",
      sets: [
        { reps: 8, seconds: null, load: { v: 25, u: "lb" }, side: null },
        { reps: 8, seconds: null, load: { v: 12, u: "kg" }, side: null },
      ],
    },
  ],
  performed: appPerformed,
  matched: { workoutId: "w1", title: "Jaw care", category: "strength", date: "2026-10-14" },
};

const imported: ActivityDto = {
  ...merged,
  id: "a-imported",
  date: "2026-09-14",
  startTime: "2026-09-14T18:00:00Z",
  startTimeLocal: "2026-09-14T11:00:00",
  title: "Jaw care",
  trainingLoad: null,
  avgHeartRate: null,
  performed: { ...appPerformed, source: "import", theme: null, played: null },
  matched: null,
};

function renderDetail(a: ActivityDto): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["coach-read-peek", a.id], { read: null });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(MemoryRouter, null, createElement(ActivityDetail, { a, units: "km", efficiency: undefined, onLink: () => undefined })),
    ),
  );
}

function renderFeed(activities: ActivityDto[]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["runs"], { activities });
  qc.setQueryData(["settings"], { prefs: { units: "km" } });
  qc.setQueryData(["insights", "run"], emptyInsights());
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(RunsScreen))),
  );
}

describe("checkValues", () => {
  it("speaks the profile's own word, before → after", () => {
    expect(checkValues(appPerformed.checks)).toEqual(["Jaw 2 → 1"]);
    expect(checkValues([{ profileId: "knee", label: "Knee / hip", pre: 4, post: null }])).toEqual(["Knee 4"]);
    expect(checkValues([{ profileId: "knee", label: "Knee / hip", pre: null, post: 3 }])).toEqual(["Knee → 3"]);
    expect(checkValues([])).toEqual([]);
  });
});

describe("feedRowMeta", () => {
  it("an app session: its minutes, mode and check values — the theme already in its title is not said twice", () => {
    expect(feedRowMeta(merged, "km")).toBe("31 min · Consistent · Jaw 2 → 1");
  });

  it("names a theme its title does not carry", () => {
    expect(feedRowMeta({ ...merged, title: "Jaw care" }, "km")).toBe("31 min · Consistent · Hips & posture · Jaw 2 → 1");
  });

  it("a run is unchanged: minutes, distance, pace", () => {
    const run: ActivityDto = { ...merged, sport: "run", title: "Easy", distanceMeters: 8000, avgPaceSecPerKm: 330, performed: null, logged: null };
    expect(feedRowMeta(run, "km")).toBe("31 min · 8 km · 5:30 /km");
  });
});

describe("the expansion", () => {
  it("a merged row: the app's sets as typed, the moves played without a set, and the watch's heart rate", () => {
    const html = renderDetail(merged);
    expect(html).toContain("25 lb × 8 · 12 kg × 8");
    expect(html).toContain("9 more moves");
    expect(html).toContain("14 min");
    expect(html).toContain("avg 104 bpm");
    expect(html).not.toContain("Imported");
  });

  it("an imported session says so, and shows no heart rate", () => {
    const html = renderDetail(imported);
    expect(html).toContain("Imported");
    expect(html).not.toContain("bpm");
  });

  it("a session of played-only moves still says what was done", () => {
    const html = renderDetail({ ...merged, logged: null });
    expect(html).toContain("9 moves");
    expect(html).not.toContain("9 more moves");
  });
});

describe("the feed", () => {
  it("shows the mode and the check values on the row; 'Imported' stays inside the expansion", () => {
    const html = renderFeed([merged, imported]);
    expect(html).toContain("Consistent · Jaw 2 → 1");
    expect(html).not.toContain("Imported");
  });
});
