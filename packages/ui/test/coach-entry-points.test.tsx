/**
 * COACH EVERYWHERE, PHASE A3 — every entry point wears the one "Ask", with what the athlete is looking at as its focus
 * (`data-focus`: what the sheet is opened with; the button's name says it in words):
 *
 *  - a planned workout's sheet — an app session's and every other workout's — asks about the workout;
 *  - a day in the Plan's week view asks about the day (from a week back to the last day Plan ahead plans);
 *  - an activity in Activity asks about the session it logged when it holds one, else the activity;
 *  - an objective's card asks about the objective, and its "Ask the coach" and "Ask the coach for a test" — the old
 *    prefilled links to the Studio — open the sheet with the objective and their words;
 *  - a move's page in the library asks about the move.
 *
 * And with no coach in the app (no sheet mounted: the coach is off), none of them draws an Ask. The Today card's is in
 * coach-entry-live.test.tsx (the garden renders live). Rendered statically. Synthetic data only.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActivityDto, PlanWeekResponse, WorkoutDto } from "@rg/api-client";
import { DEFAULT_SCHEDULING_PREFERENCES, type ObjectiveBoardCard, type ObjectiveBoardDto } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { SessionSheet } from "../src/components/session-sheet.js";
import { RunWorkoutDetail } from "../src/screens/plan.js";
import { ActivityDetail } from "../src/screens/runs.js";
import { WeekView } from "../src/screens/week-view.js";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { MoveDetail } from "../src/screens/studio/move-detail.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { OBJECTIVE_BOARD_QUERY, ObjectivesScreen } from "../src/screens/studio/objectives.js";
import { stalledRequest, testRequest } from "../src/screens/studio/objectives-model.js";
import { primedClient, staticRouter } from "./studio-fixtures.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

const coach: CoachOpener = { open: () => undefined };

/** Rendered with the app's coach sheet in reach (`coach`), or without one (`null`). */
function render(el: ReactElement, o: { opener?: CoachOpener | null; client?: QueryClient; path?: string } = {}): string {
  const qc = o.client ?? new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(CoachOpenContext.Provider, { value: o.opener === undefined ? coach : o.opener }, createElement(MemoryRouter, { initialEntries: [o.path ?? "/plan"] }, el)),
    ),
  );
}

/** Every Ask in the markup: its focus and its name. */
const asks = (html: string): Array<{ focus: string; name: string }> =>
  [...html.matchAll(/<button type="button" class="[^"]*\bask-coach(?:-link)?\b[^"]*" data-focus="([^"]+)" aria-label="([^"]+)"/g)].map((m) => ({
    focus: m[1]!,
    name: m[2]!.replace(/&amp;/g, "&"),
  }));

const workout = (over: Partial<WorkoutDto> = {}): WorkoutDto =>
  ({
    id: "w1",
    title: "Strength",
    category: "strength",
    qualitySubtype: null,
    sport: "strength",
    originalPlanDate: "2026-10-23",
    lastVerifiedCorosDate: "2026-10-23",
    effectiveDate: "2026-10-23",
    effectiveTime: "18:00",
    workoutSeconds: 2400,
    calendarSeconds: 2400,
    stageSummary: null,
    calendarSyncState: "created",
    corosSyncState: "synced",
    completionState: "scheduled",
    archived: false,
    origin: "program",
    contentState: "outline",
    programId: "p1",
    ...over,
  }) as WorkoutDto;

describe("a planned workout's sheet", () => {
  it("an app session's sheet asks about the workout", () => {
    const html = render(createElement(SessionSheet, { w: workout(), today: "2026-10-21", onClose: () => undefined }));
    expect(asks(html)).toEqual([{ focus: "workout:w1", name: "Ask the coach about Fri Oct 23 · Strength · 40 min" }]);
  });

  it("every other workout's sheet (a watch-plan run) asks about it too", () => {
    const run = workout({ id: "r1", title: "Easy run", category: "easy", sport: "run", origin: null, contentState: null, programId: null, workoutSeconds: 2700 });
    const html = render(createElement(RunWorkoutDetail, { w: run, today: "2026-10-21", corosWritesEnabled: false, onClose: () => undefined }));
    expect(asks(html)).toEqual([{ focus: "workout:r1", name: "Ask the coach about Fri Oct 23 · Easy run · 45 min" }]);
  });

  it("no coach in the app: no Ask", () => {
    expect(asks(render(createElement(SessionSheet, { w: workout(), today: "2026-10-21", onClose: () => undefined }), { opener: null }))).toEqual([]);
  });
});

describe("a day in the Plan's week view", () => {
  const week = (start: string, holding: number[] = [1]): PlanWeekResponse =>
    ({
      weekStart: start,
      days: Array.from({ length: 7 }, (_, i) => {
        const date = new Date(Date.parse(`${start}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
        return { date, workouts: holding.includes(i) ? [workout({ id: `w${i}`, effectiveDate: date })] : [] };
      }),
      plannedSeconds: 0,
      doneCount: 0,
      sessionCount: 1,
      weekIndex: null,
      weekTotal: null,
      adherence4w: null,
      loadRatio: null,
      adventureDays: 0,
      headline: null,
      focus: null,
    }) as unknown as PlanWeekResponse;
  const view = (w: PlanWeekResponse, today: string, opener?: CoachOpener | null) =>
    render(
      createElement(WeekView, { week: w, today, ghostsByDate: new Map(), jumpWeeks: [], onPick: () => undefined, onOpenWorkout: () => undefined, onGhostTap: () => undefined, onStep: () => undefined }),
      { opener },
    );

  it("each day asks about itself", () => {
    const html = view(week("2026-10-19"), "2026-10-21");
    expect(asks(html).map((a) => a.focus)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"].map((d) => `day:${d}`));
    expect(asks(html)[2]!.name).toBe("Ask the coach about Wed Oct 21");
    // Each at its day: the Ask is inside the day's own cell.
    const cell = html.slice(html.indexOf('data-date="2026-10-22"'), html.indexOf('data-date="2026-10-23"'));
    expect(cell).toContain('data-focus="day:2026-10-22"');
    expect(cell).toContain("plan-week-ask");
  });

  it("only the days a run can plan for: a week back to six days ahead (the review, I1)", () => {
    // Next week: its Monday and Tuesday (today + 5, + 6); the days past + 6 have no Ask.
    expect(asks(view(week("2026-10-26"), "2026-10-21")).map((a) => a.focus)).toEqual(["day:2026-10-26", "day:2026-10-27"]);
    // Two weeks on: none.
    expect(asks(view(week("2026-11-02"), "2026-10-21"))).toEqual([]);
    // Two weeks back: none.
    expect(asks(view(week("2026-10-05"), "2026-10-21"))).toEqual([]);
  });

  it("on a phone each day's Ask is the coach mark alone, named in words, on the 44 px floor; from lg, 'Ask' at the column's foot (the review, minor 2)", () => {
    const html = view(week("2026-10-19"), "2026-10-21");
    // The word is in the markup, a span the phone hides: the button's name says it all the same.
    expect(html).toMatch(/class="btn btn-small ask-coach plan-week-ask"[^>]*aria-label="Ask the coach about [^"]+"[^>]*>.*?<span class="ask-coach-word">Ask<\/span><\/button>/);
    const at = css.indexOf(".plan-week-ask .ask-coach-word {");
    expect(at, "the phone hides the word").toBeGreaterThan(-1);
    const hide = css.slice(at, css.indexOf("}", at));
    expect(hide).toContain("clip");
    expect(css.indexOf(".plan-week-ask .ask-coach-word {")).toBeLessThan(css.indexOf("@media (min-width: 1024px) {\n  .plan-week-ask {"));
    const square = css.slice(css.indexOf("\n.plan-week-ask {"), css.indexOf("}", css.indexOf("\n.plan-week-ask {")));
    expect(square).toContain("min-width: var(--tap)");
    expect(square).toContain("min-height: var(--tap)");
    const lg = css.slice(css.indexOf("@media (min-width: 1024px) {\n  .plan-week-ask {"));
    expect(lg.slice(0, lg.indexOf("\n}"))).toMatch(/\.plan-week-ask \.ask-coach-word \{[^}]*position: static/);
  });

  it("no coach in the app: no Ask", () => {
    expect(asks(view(week("2026-10-19"), "2026-10-21", null))).toEqual([]);
  });
});

describe("an activity in Activity", () => {
  const activity = (over: Partial<ActivityDto> = {}): ActivityDto =>
    ({
      id: "a1",
      startTime: "2026-10-20T01:00:00Z",
      startTimeLocal: "2026-10-19T18:00:00",
      date: "2026-10-19",
      title: "Evening run",
      sport: "run",
      durationSeconds: 2700,
      distanceMeters: 8000,
      avgPaceSecPerKm: 337,
      trainingLoad: 62,
      avgHeartRate: 148,
      feel: 4,
      laps: null,
      logged: null,
      performed: null,
      matched: null,
      ...over,
    }) as ActivityDto;
  const detail = (a: ActivityDto, opener?: CoachOpener | null) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["coach-read-peek", a.id], { read: null });
    return render(createElement(ActivityDetail, { a, units: "km", efficiency: undefined, onLink: () => undefined }), { client: qc, opener });
  };

  it("a run the watch recorded asks about the activity", () => {
    expect(asks(detail(activity()))).toEqual([{ focus: "activity:a1", name: "Ask the coach about Mon Oct 19 · Evening run · 45 min" }]);
  });

  it("a logged session (an app save, a watch review, an import) asks about the session", () => {
    const a = activity({ title: null, sport: "strength", performed: { id: "s1", source: "app", mode: "build", theme: "Full-body strength", checks: [], played: null } });
    expect(asks(detail(a))).toEqual([{ focus: "session:s1", name: "Ask the coach about Mon Oct 19 · Full-body strength · 45 min" }]);
  });

  it("no coach in the app: no Ask", () => {
    expect(asks(detail(activity(), null))).toEqual([]);
  });
});

describe("an objective's card", () => {
  const kr = (id: string, label: string) => ({
    id,
    objectiveId: "o1",
    label,
    measure: { kind: "hold_max", libraryIds: ["wallSit"], windowDays: 90 },
    direction: "up",
    baseline: null,
    target: 90,
    unit: "s",
    dueDate: null,
    position: 0,
  });
  const progress = (evidence: string) => ({ display: { current: null }, evidence, sampleSize: 0, series: [], missing: "Nothing measured yet." });
  const card = (id: string, title: string, stalledLong = false): ObjectiveBoardCard =>
    ({
      objective: { id, title, why: null, status: "active", goalIds: [], sort: 0, keyResults: [], createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
      keyResults: [{ keyResult: kr(`${id}-k`, "Wall sit hold"), progress: progress("none"), best: null }],
      served: stalledLong ? [{ workoutId: "w9", date: "2026-08-20", title: "Old mobility", source: "studio" }] : [],
      streakWeeks: 0,
      note: null,
      lastServedOn: stalledLong ? "2026-08-20" : null,
    }) as unknown as ObjectiveBoardCard;
  const board = (opener?: CoachOpener | null) => {
    const qc = primedClient();
    qc.setQueryData(OBJECTIVE_BOARD_QUERY, { today: "2026-10-21", objectives: [card("o1", "Hold a strong wall sit", true)] } as unknown as ObjectiveBoardDto);
    qc.setQueryData(["settings"], { prefs: { ...DEFAULT_SCHEDULING_PREFERENCES, units: "km", weightUnit: "kg" } });
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client: qc }, createElement(CoachOpenContext.Provider, { value: opener === undefined ? coach : opener }, staticRouter("/studio/objectives", createElement(ObjectivesScreen)))),
    );
  };

  it("no coach in the app: no Ask", () => {
    expect(asks(board(null))).toEqual([]);
  });

  it("the card asks about the objective; its test and stalled lines open the sheet with their words, not the Studio", () => {
    const html = board();
    // The card's own Ask (its head), its measure's test line, its stalled line — each about the objective.
    expect(asks(html)).toEqual([
      { focus: "objective:o1", name: "Ask the coach about Hold a strong wall sit" },
      { focus: "objective:o1", name: "Ask the coach for a test: Hold a strong wall sit" },
      { focus: "objective:o1", name: "Ask the coach: Hold a strong wall sit" },
    ]);
    expect(html).toContain("Nothing done toward this in the last 4 weeks.");
    // The old prefilled links to the Studio are gone from the board.
    expect(html).not.toMatch(/<a[^>]*href="\/studio"[^>]*>Ask the coach/);
    expect(testRequest("Wall sit hold")).toBe("Plan a test so I can measure: Wall sit hold");
    expect(stalledRequest("Hold a strong wall sit")).toBe("Plan a session toward my objective: Hold a strong wall sit");
  });
});

describe("a move's page in the library", () => {
  const goblet = EXERCISES.find((e) => e.id === "gobletSquat")!;
  const page = (opener?: CoachOpener | null) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: primedClient() },
        createElement(
          CoachOpenContext.Provider,
          { value: opener === undefined ? coach : opener },
          staticRouter(
            "/studio/move/gobletSquat",
            createElement(MoveDetail, {
              rec: goblet,
              ctx: emptyStudioCtx,
              today: "2026-10-21",
              wide: true,
              onClose: () => undefined,
              onAdd: () => undefined,
              moveLink: (id: string) => ({ to: `/studio/move/${id}` }),
            }),
          ),
        ),
      ),
    );

  it("asks about the move, beside Add", () => {
    const html = page();
    expect(asks(html)).toEqual([{ focus: "move:gobletSquat", name: "Ask the coach about Goblet squat" }]);
    const foot = html.slice(html.indexOf("stu-detail-actions"));
    expect(foot).toContain("ask-coach");
    expect(foot.indexOf("stu-detail-add")).toBeLessThan(foot.indexOf("ask-coach"));
  });

  it("no coach in the app: no Ask", () => {
    expect(asks(page(null))).toEqual([]);
  });
});
