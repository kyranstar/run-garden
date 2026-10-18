// @vitest-environment jsdom
/**
 * THE NEW SHAPE, PLAN (2026-10-17 design §6): the week first — "This week" with ‹ ›, one line that folds in the plan,
 * the count done and the race ("Aug 10–16 · Fall Half Block, week 5 of 12 · 1 of 6 done · Race in 24 days"), then the
 * days; "Your plans" as one list, a row each with its kind and its state, each opening its sheet; the plan sheet's
 * actions open the coach with the request written (never a canned chat message); no floating thread-coach window, no
 * pill, no per-day Ask (the nav's coach sees the open workout instead).
 *
 * Synthetic data only.
 */
import { act, createElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { CoachPlanDto, PlanDetailResponse, PlanWeekResponse, ProgramDto, WorkoutDto } from "@rg/api-client";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { planRequests, PlanSheet } from "../src/screens/plan-sheet.js";
import { planRowState, YourPlans } from "../src/screens/plan-cards.js";
import { RaceMismatchNotice, WeeklyBrief } from "../src/screens/plan-brief.js";
import { WeekView, weekLine, weekPlanName, weekTitle } from "../src/screens/week-view.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => undefined;
const src = (file: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src", file), "utf8");

function client(prime: Array<{ key: unknown[]; data: unknown }> = []): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
  for (const p of prime) qc.setQueryData(p.key, p.data);
  return qc;
}

function wrap(el: ReactElement, coach: CoachOpener | null, qc = client()): ReactElement {
  const routed = createElement(MemoryRouter, null, el);
  return createElement(QueryClientProvider, { client: qc }, coach ? createElement(CoachOpenContext.Provider, { value: coach }, routed) : routed);
}

const workout = (over: Partial<WorkoutDto> = {}): WorkoutDto =>
  ({
    id: "w1",
    title: "Tempo 40 min",
    category: "quality",
    qualitySubtype: null,
    sport: "run",
    effectiveDate: "2026-08-11",
    effectiveTime: "07:00",
    workoutSeconds: 2400,
    calendarSeconds: 2400,
    completionState: "scheduled",
    ...over,
  }) as WorkoutDto;

const week = (over: Partial<PlanWeekResponse> = {}): PlanWeekResponse => ({
  weekStart: "2026-08-10",
  days: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-08-${10 + i}`,
    workouts: i === 1 ? [workout()] : i === 3 ? [workout({ id: "r1", title: "Rest", category: "rest" })] : [],
  })),
  plannedSeconds: 18300,
  doneCount: 1,
  sessionCount: 6,
  weekIndex: 5,
  weekTotal: 12,
  adherence4w: { pct: 86, trend: "up" },
  loadRatio: 1.04,
  adventureDays: 0,
  headline: "on_track",
  focus: null,
  ...over,
});

const weekProps = {
  today: "2026-08-11",
  ghostsByDate: new Map(),
  jumpWeeks: [],
  onPick: noop,
  onOpenWorkout: noop,
  onGhostTap: noop,
  onStep: noop,
  onBrief: noop,
};

describe("the week first", () => {
  it("the title says which week in words: this, next, last, else its dates", () => {
    expect(weekTitle("2026-08-10", "2026-08-11")).toBe("This week");
    expect(weekTitle("2026-08-17", "2026-08-11")).toBe("Next week");
    expect(weekTitle("2026-08-03", "2026-08-11")).toBe("Last week");
    expect(weekTitle("2026-08-24", "2026-08-11")).toBe("Aug 24–30");
  });

  it("one line folds in the plan and its week, the count done, and the race", () => {
    expect(weekLine({ week: week(), planName: "Fall Half Block", race: { daysToRace: 24, phase: "build" } })).toBe(
      "Aug 10–16 · Fall Half Block, week 5 of 12 · 1 of 6 done · Race in 24 days",
    );
  });

  it("…and leaves out what it does not know, never inventing a part", () => {
    expect(weekLine({ week: week({ weekIndex: null, weekTotal: null }), planName: null, race: null })).toBe("Aug 10–16 · 1 of 6 done");
    expect(weekLine({ week: week(), planName: null, race: null })).toBe("Aug 10–16 · week 5 of 12 · 1 of 6 done");
    expect(weekLine({ week: week({ sessionCount: 0, doneCount: 0 }), planName: null, race: null })).toBe("Aug 10–16 · week 5 of 12");
  });

  it("the race in words: tomorrow, the day itself; a race gone by says nothing here", () => {
    const line = (daysToRace: number, phase: "build" | "taper" | "race_week" | "post") =>
      weekLine({ week: week({ weekIndex: null }), planName: null, race: { daysToRace, phase } });
    expect(line(1, "race_week")).toBe("Aug 10–16 · 1 of 6 done · Race tomorrow");
    expect(line(0, "race_week")).toBe("Aug 10–16 · 1 of 6 done · Race day");
    expect(line(-3, "post")).toBe("Aug 10–16 · 1 of 6 done");
    // Either sign of a race gone by is enough on its own: its phase, or a countdown past zero.
    expect(line(0, "post")).toBe("Aug 10–16 · 1 of 6 done");
    expect(line(-1, "taper")).toBe("Aug 10–16 · 1 of 6 done");
  });

  it("the plan the line names: the one block holding the week (two or more: how many — review-3), none when no block holds it", () => {
    const block = (id: string, startDate: string, endDate: string): CoachPlanDto => ({ ...runPlan, id, name: id, startDate, endDate });
    const plans = [block("Short", "2026-08-03", "2026-08-30"), block("Long", "2026-07-13", "2026-10-04"), block("Later", "2026-09-07", "2026-11-01")];
    expect(weekPlanName(plans, "2026-08-10")).toBe("2 plans");
    expect(weekPlanName(plans, "2026-10-26")).toBe("Later");
    expect(weekPlanName(plans, "2026-09-14")).toBe("2 plans");
    expect(weekPlanName(plans, "2026-11-09")).toBeNull();
    // A block that starts mid-week holds that week; one that ended the Sunday before does not.
    expect(weekPlanName([block("Midweek", "2026-08-12", "2026-08-30")], "2026-08-10")).toBe("Midweek");
    expect(weekPlanName([block("Done", "2026-07-13", "2026-08-09")], "2026-08-10")).toBeNull();
  });

  it("the week's head: its title, ‹ ›, and the line as one button that opens the week's brief", () => {
    const html = renderToStaticMarkup(
      wrap(createElement(WeekView, { ...weekProps, week: week(), planName: "Fall Half Block", race: { daysToRace: 24, phase: "build" } }), null),
    );
    expect(html).toMatch(/<h2 class="plan-week-title"[^>]*>This week<\/h2>/);
    expect(html).toContain('aria-label="Previous week"');
    expect(html).toContain('aria-label="Next week"');
    const line = /<button type="button" class="plan-week-line"[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(line).not.toBeNull();
    expect(line![1]!.replace(/<[^>]+>/g, "")).toBe("Aug 10–16 · Fall Half Block, week 5 of 12 · 1 of 6 done · Race in 24 days");
    // Two plans holding the week (review-3): how many, and no week count — the count is one block's.
    const two = renderToStaticMarkup(wrap(createElement(WeekView, { ...weekProps, week: week(), planName: "2 plans", planWeek: false, race: null }), null));
    expect(/<button type="button" class="plan-week-line"[^>]*>([\s\S]*?)<\/button>/.exec(two)![1]!.replace(/<[^>]+>/g, "")).toBe("Aug 10–16 · 2 plans · 1 of 6 done");
    // The plan's week was a pill of its own; it is the line's now.
    expect(html).not.toContain("pill pill-neutral num");
  });

  it("a day no longer carries its own Ask: the nav's coach sees what is open", () => {
    const html = renderToStaticMarkup(wrap(createElement(WeekView, { ...weekProps, week: week() }), { open: noop }));
    expect(html).not.toContain("ask-coach");
    expect(src("screens/week-view.tsx")).not.toContain("AskCoach");
  });

  it("the brief behind the line holds no two-race-dates notice: the page shows it, answerable, not the sheet", () => {
    const mismatch = { workoutId: "w9", plannedDate: "2026-10-04", raceDate: "2026-10-11", title: "Half marathon" };
    const inSheet = renderToStaticMarkup(wrap(createElement(WeeklyBrief, { week: week({ raceMismatch: mismatch }), today: "2026-08-11" }), null));
    expect(inSheet).not.toContain("Two race dates");
    const onPage = renderToStaticMarkup(wrap(createElement(RaceMismatchNotice, { mismatch, onResolve: noop }), null));
    expect(onPage).toContain("Two race dates");
    expect(onPage).toContain("The plan is right");
  });

  it("rest days are dashed; today is marked", () => {
    const html = renderToStaticMarkup(wrap(createElement(WeekView, { ...weekProps, week: week() }), null));
    expect(html).toContain("is-today");
    expect(html).toContain("cal-rest");
    const css = src("styles.css");
    expect(/\.cal-rest \{[^}]*border-style: dashed/.test(css)).toBe(true);
  });
});

const runPlan: CoachPlanDto = {
  id: "cp1",
  discipline: "run",
  name: "Fall Half Block",
  status: "active",
  startDate: "2026-07-13",
  endDate: "2026-10-04",
  raceDate: "2026-10-04",
  source: "coach",
};
const liftPlan: CoachPlanDto = { ...runPlan, id: "cp2", discipline: "lift", name: "Strength Block", startDate: "2026-09-21", endDate: "2026-10-25", raceDate: null };
const loose: CoachPlanDto = { ...runPlan, id: "cp3", discipline: "mobility", name: "Coach one-offs", kind: "loose", holds: { sessions: 2, done: 1, firstDate: "2026-08-12", lastDate: "2026-08-14" } };
const program = {
  id: "pg1",
  kind: "adaptive",
  name: "Strength & mobility",
  status: "active",
  config: {},
  block: { number: 2, week: 3, weeks: 5, core: [] },
  week: { placed: 3, done: 1, goal: 3 },
} as unknown as ProgramDto;

describe("Your plans, one list", () => {
  it("each row says its kind and its state", () => {
    const today = "2026-08-11";
    expect(planRowState({ kind: "program", program }, today)).toEqual({ kind: "Program", state: "Block 2 · week 3 of 5 · 1 of 3 this week" });
    expect(planRowState({ kind: "plan", plan: runPlan }, today)).toEqual({ kind: "Running plan", state: "Week 5 of 12 · ends Oct 4" });
    expect(planRowState({ kind: "plan", plan: liftPlan }, today)).toEqual({ kind: "Lifting plan", state: "Starts Sep 21" });
    expect(planRowState({ kind: "plan", plan: { ...runPlan, status: "draft", source: "studio" } }, today)).toEqual({ kind: "Running plan", state: "Draft — not on your watch" });
    expect(planRowState({ kind: "plan", plan: { ...runPlan, source: "coros" } }, today)).toEqual({ kind: "Running plan", state: "From COROS · week 5 of 12" });
    expect(planRowState({ kind: "plan", plan: loose }, today)).toEqual({ kind: "Mobility one-offs", state: "2 sessions · 1 done" });
  });

  it("one list under one heading, a row a button, programs first then plans in time order", () => {
    const html = renderToStaticMarkup(
      wrap(createElement(YourPlans, { plans: [liftPlan, loose, runPlan], programs: { programs: [program], places: [], profiles: [] }, today: "2026-08-11", onOpenPlan: noop }), { open: noop }),
    );
    expect(html).toMatch(/<h2[^>]*>Your plans<\/h2>/);
    const rows = [...html.matchAll(/<button type="button" class="plan-row"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    expect(rows).toEqual([
      "Strength &amp; mobility Program · Block 2 · week 3 of 5 · 1 of 3 this week",
      "Fall Half Block Running plan · Week 5 of 12 · ends Oct 4",
      "Strength Block Lifting plan · Starts Sep 21",
      "Coach one-offs Mobility one-offs · 2 sessions · 1 done",
    ]);
    // No sport sections, no sparklines: the sheet holds the detail.
    expect(html).not.toContain("plan-section");
    expect(html).not.toContain("<svg");
  });

  it("a retired or finished plan is not on the list", () => {
    const html = renderToStaticMarkup(
      wrap(createElement(YourPlans, { plans: [{ ...runPlan, status: "retired" }, { ...liftPlan, status: "completed" }], programs: undefined, today: "2026-08-11", onOpenPlan: noop }), null),
    );
    expect(html).not.toContain('class="plan-row"');
  });

  it("its foot: a new program, and a plan asked of the coach (§8 §6: thread-coach-steps-back)", () => {
    const html = renderToStaticMarkup(wrap(createElement(YourPlans, { plans: [], programs: undefined, today: "2026-08-11", onOpenPlan: noop }), { open: noop }));
    expect(html).toContain("New program…");
    expect(html).toContain("Plan with the coach");
  });
});

const detail: PlanDetailResponse = {
  plan: runPlan,
  weeks: [],
  progressions: [],
  sessions: { planned: 48, done: 20 },
  adherencePct: 86,
} as unknown as PlanDetailResponse;

describe("the plan sheet's actions open the coach with the words written", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
  });

  function mount(plan: CoachPlanDto, coach: CoachOpener | null) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = client([{ key: ["plan-detail", plan.id], data: { ...detail, plan } }]);
    act(() =>
      root!.render(
        wrap(createElement(PlanSheet, { planId: plan.id, plans: [plan], onClose: noop, onRetire: async () => null, onRename: noop }), coach, qc),
      ),
    );
  }
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name);

  it("the words: the plan named plainly, never doubled", () => {
    expect(planRequests("Fall Half Block")).toEqual({
      ask: "How is my Fall Half Block plan going?",
      extend: "Extend my Fall Half Block plan by two weeks",
      windDown: "Wind down my Fall Half Block plan",
    });
    expect(planRequests("Base plan").ask).toBe("How is my Base plan going?");
  });

  it("Ask about this plan opens the conversation with its request (Extend and Wind down too: thread-coach-steps-back)", () => {
    const calls: unknown[] = [];
    mount(runPlan, { open: (a) => calls.push(a) });
    act(() => button("Ask about this plan")!.click());
    expect(calls).toEqual([{ request: "How is my Fall Half Block plan going?" }]);
  });

  it("Retire… stays the app's own two-step confirm (the coach retires no plan in this wave)", () => {
    mount(runPlan, { open: noop });
    act(() => button("Retire…")!.click());
    expect(document.body.textContent).toContain("Retire this plan?");
  });

  it("a loose bucket is offered no Extend or Wind down; a COROS plan none of the coach's actions but Ask", () => {
    mount(loose, { open: noop });
    expect(button("Extend")).toBeUndefined();
    expect(button("Wind down")).toBeUndefined();
    expect(button("Ask about this plan")).toBeDefined();
  });

  it("without the conversation coach, its Ask is not drawn", () => {
    mount(runPlan, null);
    expect(button("Ask about this plan")).toBeUndefined();
    expect(button("Rename")).toBeDefined();
  });

  it("no canned chat message is left in the sheet", () => {
    const sheet = src("screens/plan-sheet.tsx");
    expect(sheet).not.toContain("onCanned");
    expect(sheet).not.toContain("Start the interview");
  });
});

describe("the Plan screen keeps no coach window of its own", () => {
  const plan = src("screens/plan.tsx");
  it("no floating window, no pill, no sheet of its own, no ?coach=1", () => {
    expect(plan).not.toContain("CoachWindow");
    expect(plan).not.toContain("coach-pill");
    expect(plan).not.toContain('params.get("coach")');
    expect(plan).not.toContain("WINDOW_OPEN_KEY");
    expect(plan).not.toContain("cannedSend");
  });

  it("the thread coach's pending suggestions and its question stay, as cards", () => {
    expect(plan).toContain("<ThreadCoachCards {...coachProps}");
  });

  it("the open workout's sheet is what the coach sees — and, modal, it keeps its own Ask (the integrated review, I3)", () => {
    expect(plan).toContain("useCoachSeeing(selected ? workoutFocus(selected) : null)");
    expect(plan).toContain('<AskCoach focus={workoutFocus(w)} wrap="session-ask-row" />');
  });

  it("the week comes first; the sync panel only when something is wrong; no race strip or brief card of their own", () => {
    const body = plan.slice(plan.indexOf('<div className="plan-page-col">'));
    expect(body.indexOf("<WeekView")).toBeGreaterThan(-1);
    expect(body.indexOf("<WeekView")).toBeLessThan(body.indexOf("<YourPlans"));
    expect(body).toContain("<SyncPanel quietWhenHealthy />");
    expect(body).not.toContain("<RaceStrip units={units} />\n        <WeeklyBrief");
  });
});
