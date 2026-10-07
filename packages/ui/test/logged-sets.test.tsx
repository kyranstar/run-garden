/**
 * The Activity feed's inline expansion lists what was logged (Phase 2a+
 * Task 3, Phase 2 mocks §8): one line per exercise, its name in bold and its
 * sets beneath — "50 lb × 8 · 50 lb × 8". The DTO has already named the
 * exercises and put the weights in the athlete's unit; this only lays it out.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActivityDto, LoggedExerciseDto } from "@rg/api-client";
import { ActivityDetail, formatLoggedSet, LoggedSets } from "../src/screens/runs.js";

const set = (over: Partial<LoggedExerciseDto["sets"][number]>) => ({ reps: null, seconds: null, load: null, side: null, ...over });

const LOGGED: LoggedExerciseDto[] = [
  {
    exerciseId: "coros:T1041",
    name: "Bench Press",
    sets: [set({ reps: 8, load: { v: 50, u: "lb" } }), set({ reps: 8, load: { v: 50, u: "lb" } })],
  },
  { exerciseId: "coros:T1010", name: "Planks", sets: [set({ seconds: 45 })] },
  { exerciseId: "coros:T1004", name: "Push-ups", sets: [set({ reps: 15 }), set({ reps: 1 })] },
];

describe("formatLoggedSet", () => {
  it.each([
    [set({ reps: 8, load: { v: 50, u: "lb" } }), "50 lb × 8"],
    [set({ reps: 6, load: { v: 22.5, u: "kg" } }), "22.5 kg × 6"],
    [set({ reps: 15 }), "15 reps"],
    [set({ reps: 1 }), "1 rep"],
    [set({ seconds: 45 }), "45 s"],
    [set({ seconds: 34, load: { v: 20, u: "kg" } }), "20 kg × 34 s"],
    [set({ load: { v: 20, u: "kg" } }), "20 kg"],
    [set({ reps: 10, load: { v: 12, u: "kg" }, side: "left" }), "L 12 kg × 10"],
    [set({ reps: 10, side: "right" }), "R 10 reps"],
  ])("%j → %s", (s, text) => {
    expect(formatLoggedSet(s)).toBe(text);
  });
});

describe("LoggedSets", () => {
  it("lists each exercise by name with its sets, in order", () => {
    const html = renderToStaticMarkup(createElement(LoggedSets, { logged: LOGGED }));
    expect(html).toContain("<b>Bench Press</b>");
    expect(html).toContain("50 lb × 8 · 50 lb × 8");
    expect(html.indexOf("Bench Press")).toBeLessThan(html.indexOf("Planks"));
    expect(html.indexOf("Planks")).toBeLessThan(html.indexOf("Push-ups"));
    expect(html).toContain("45 s");
    expect(html).toContain("15 reps · 1 rep");
    // The raw ids never reach the page.
    expect(html).not.toContain("coros:");
  });

  it("keeps its list semantics in Safari, whose VoiceOver drops them from a list-style: none list (audit 2a+ M-11)", () => {
    const html = renderToStaticMarkup(createElement(LoggedSets, { logged: LOGGED }));
    expect(html).toMatch(/<ul [^>]*role="list"[^>]*aria-label="Logged sets"|<ul [^>]*aria-label="Logged sets"[^>]*role="list"/);
  });
});

const lift: ActivityDto = {
  id: "a-lift",
  startTime: "2026-10-01T13:00:00Z",
  startTimeLocal: "2026-10-01T06:00:00",
  date: "2026-10-01",
  title: "Upper",
  sport: "strength",
  durationSeconds: 2400,
  distanceMeters: null,
  avgPaceSecPerKm: null,
  trainingLoad: 41,
  feel: null,
  laps: null,
  logged: LOGGED,
  matched: null,
};

function renderDetail(a: ActivityDto): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["coach-read-peek", a.id], { read: null });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        MemoryRouter,
        null,
        createElement(ActivityDetail, { a, units: "km", efficiency: undefined, onLink: () => undefined }),
      ),
    ),
  );
}

describe("ActivityDetail", () => {
  it("opens on the logged sets when there are some", () => {
    const html = renderDetail(lift);
    expect(html).toContain("50 lb × 8");
    expect(html.indexOf("Bench Press")).toBeLessThan(html.indexOf("steady"));
  });

  it("shows no list for an activity with nothing logged", () => {
    expect(renderDetail({ ...lift, logged: null })).not.toContain("fw-sets");
    expect(renderDetail({ ...lift, logged: undefined })).not.toContain("fw-sets");
  });
});
