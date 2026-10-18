/**
 * THE ENTRY POINTS, IN THE NEW SHAPE (coach everywhere, phase A3, then the new shape §5): the per-object "Ask" went —
 * the nav's coach sees what the screen shows (`useCoachSeeing`) — except the Today card's, and the words-carrying links
 * (`data-focus`: what the sheet sees; the button's name says it in words):
 *
 *  - a planned workout's sheet no longer asks — an app session's, a watch-plan run's, the Plan's days (the nav's coach
 *    sees the open workout — shape-plan.test.tsx);
 *  - (an activity in Growth no longer asks: the nav's coach sees an open one — growth-live.test.tsx);
 *  - an objective's card has no Ask of its own; its "Ask the coach" and "Ask the coach for a test" — the old prefilled
 *    links to the Studio — open the sheet seeing the objective, with their words;
 *  - a move's page in the library no longer asks: Add alone (the nav's coach sees the move).
 *
 * And with no coach in the app (no sheet mounted: the coach is off), none of them draws an Ask. The Today card's is in
 * coach-entry-live.test.tsx (the garden renders live). Rendered statically. Synthetic data only.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { WorkoutDto } from "@rg/api-client";
import { DEFAULT_SCHEDULING_PREFERENCES, type ObjectiveBoardCard, type ObjectiveBoardDto } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { SessionSheet } from "../src/components/session-sheet.js";
import { RunWorkoutDetail } from "../src/screens/plan.js";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { MoveDetail } from "../src/screens/studio/move-detail.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { OBJECTIVE_BOARD_QUERY, ObjectivesScreen } from "../src/screens/studio/objectives.js";
import { stalledRequest, testRequest } from "../src/screens/studio/objectives-model.js";
import { primedClient, staticRouter } from "./studio-fixtures.js";


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
  // A modal sheet hides the nav, so its own small Ask is back (the integrated review, I3): it opens the coach seeing
  // the workout.
  it("an app session's sheet asks about the workout", () => {
    const html = render(createElement(SessionSheet, { w: workout(), today: "2026-10-21", onClose: () => undefined }));
    expect(asks(html)).toEqual([{ focus: "workout:w1", name: "Ask the coach about Fri 23 Oct · Strength · 40 min" }]);
  });

  it("a watch-plan run's sheet asks about it too", () => {
    const run = workout({ id: "r1", title: "Easy run", category: "easy", sport: "run", origin: null, contentState: null, programId: null, workoutSeconds: 2700 });
    const html = render(createElement(RunWorkoutDetail, { w: run, today: "2026-10-21", corosWritesEnabled: false, onClose: () => undefined }));
    expect(asks(html)).toEqual([{ focus: "workout:r1", name: "Ask the coach about Fri 23 Oct · Easy run · 45 min" }]);
  });

  it("no coach in the app: no Ask", () => {
    expect(asks(render(createElement(SessionSheet, { w: workout(), today: "2026-10-21", onClose: () => undefined }), { opener: null }))).toEqual([]);
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

  it("the card has no Ask of its own (the new shape); its test and stalled lines open the sheet with their words, seeing the objective", () => {
    const html = board();
    // Its measure's test line and its stalled line — each about the objective. The card's own Ask went with the new
    // shape: the nav's coach sees an open quest.
    expect(asks(html)).toEqual([
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
  const page = (opener?: CoachOpener | null, wide = true) =>
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
              wide,
              onClose: () => undefined,
              onAdd: () => undefined,
              moveLink: (id: string) => ({ to: `/studio/move/${id}` }),
            }),
          ),
        ),
      ),
    );

  it("its pane (from md) doesn't ask: Add alone — the nav's coach sees the move (the new shape)", () => {
    const html = page();
    expect(asks(html)).toEqual([]);
    expect(html.slice(html.indexOf("stu-detail-actions"))).toContain("stu-detail-add");
  });

  it("its sheet on a phone asks — the sheet is modal, the nav out of reach (the integrated review, I3) — beside Add", () => {
    const html = page(undefined, false);
    expect(asks(html)).toEqual([{ focus: "move:gobletSquat", name: "Ask the coach about Goblet squat" }]);
    const foot = html.slice(html.indexOf("stu-detail-actions"));
    expect(foot.indexOf("stu-detail-add")).toBeLessThan(foot.indexOf("ask-coach"));
  });

  it("no coach in the app: no Ask", () => {
    expect(asks(page(null))).toEqual([]);
    expect(asks(page(null, false))).toEqual([]);
  });
});
