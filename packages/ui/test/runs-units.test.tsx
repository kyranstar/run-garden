/**
 * Activity page display units (units sweep, 2026-08): every distance and
 * pace RunsScreen renders goes through formatDistance/formatPace with the
 * settings preference. Data arrives via a primed QueryClient cache (the
 * studio-modal.test.tsx pattern) so the static render serves synchronously:
 * ["runs"] carries one activity, ["settings"] carries the units preference.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActivityDto } from "@rg/api-client";
import { RunsScreen } from "../src/screens/runs.js";

const activity: ActivityDto = {
  id: "a1",
  startTime: "2026-08-10T07:01:00Z",
  startTimeLocal: "2026-08-10T07:01:00",
  date: "2026-08-10",
  title: "Morning run",
  sport: "run",
  durationSeconds: 3000,
  distanceMeters: 10000,
  avgPaceSecPerKm: 300, // 5:00 /km ≡ 8:03 /mi
  trainingLoad: 62,
  feel: 4,
  laps: [
    { s: 600, p: 310 },
    { s: 600, p: 295 },
    { s: 600, p: 300 },
  ],
  matched: null,
};

function renderRuns(units: "km" | "mi"): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["runs"], { activities: [activity] });
  qc.setQueryData(["settings"], { prefs: { units } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(MemoryRouter, null, createElement(RunsScreen)),
    ),
  );
}

describe("RunsScreen units", () => {
  it("units=mi: distance and pace render in miles, and no /km survives", () => {
    const html = renderRuns("mi");
    expect(html).toContain("6.2 mi"); // 10 000 m
    expect(html).toContain("8:03 /mi"); // 300 s/km converted
    expect(html).not.toContain("/km");
    expect(html).not.toContain(" km");
  });

  it("units=km: metric stays metric, and the lap tooltips share the unit", () => {
    const html = renderRuns("km");
    expect(html).toContain("10 km");
    expect(html).toContain("5:00 /km");
    expect(html).not.toContain("/mi");
    // PaceShape lap tooltip goes through the same helper.
    expect(html).toContain("5:10 /km"); // lap 1, 310 s/km
  });
});
