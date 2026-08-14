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

function renderRuns(units: "km" | "mi", over: Partial<ActivityDto> = {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["runs"], { activities: [{ ...activity, ...over }] });
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

/**
 * The pace-shape figure (audit 2026-08-14). Two findings, one caption:
 *  - lap detail existed only as a native `<title>`, i.e. only for a mouse;
 *  - the silhouette implied it drew the whole activity when it didn't.
 * The selection itself needs events (this package renders statically, node
 * environment), so what's asserted here is the reachable structure and the
 * caption's default text — the two things a static render can see.
 */
describe("PaceShape honesty + reach", () => {
  it("is one focusable figure described by a live caption — not a mouse-only tooltip", () => {
    const html = renderRuns("km");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("arrows step through the laps");
    // The description is wired to the caption element that carries it.
    const described = html.match(/aria-describedby="([^"]+)"/);
    expect(described).not.toBeNull();
    expect(html).toContain(`id="${described![1]}"`);
    // The hover tooltips stay for the mouse.
    expect(html).toContain("<title>Lap 1 · 10 min · 5:10 /km</title>");
  });

  it("says how much of the activity the laps actually cover when they fall short", () => {
    // The fixture's three laps are 30 min of a 50 min activity — the
    // silhouette is not the shape of the other 20.
    const html = renderRuns("km");
    expect(html).toContain("3 laps · 30 min of 50 min drawn");
  });

  it("keeps quiet about coverage when the laps do add up to the activity", () => {
    const html = renderRuns("km", { durationSeconds: 1800 });
    expect(html).not.toContain(" drawn");
    expect(html).toContain("3 laps · 5:10 /km–4:55 /km");
  });

  it("counts the laps too brief to draw to scale instead of hiding them", () => {
    // A 3-second lap can't be drawn to scale beside two 20-minute ones — it
    // gets the legibility floor, which is width the other laps earned, so the
    // caption says how many bars are not to scale. The lap itself is still
    // drawn and still tappable: on this data a 3s lap may be a duration that
    // was never repaired, and hiding it would bury exactly that.
    const html = renderRuns("km", {
      durationSeconds: 2403,
      laps: [
        { s: 3, p: 340 },
        { s: 1200, p: 300 },
        { s: 1200, p: 310 },
      ],
    });
    expect(html).toContain("1 too brief to draw to scale");
    expect(html).toContain('class="act-shape-bar is-stub"');
    expect(html).toContain("<title>Lap 1 · 3s · 5:40 /km</title>");
    expect(html).toContain("3 laps");
  });
});
