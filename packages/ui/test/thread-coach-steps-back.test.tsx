// @vitest-environment jsdom
/**
 * THE THREAD COACH STEPS BACK, ON SCREEN (§8 §6, stream T):
 *
 *  - the coach's opening screen puts the "needs you" chips (`GET /api/coach/nudges`, at most two) before its starters;
 *    a tap sends the chip's request as the athlete's words;
 *  - the plan sheet's Extend and Wind down, and "Plan with the coach" back in Your plans, open the conversation with the
 *    request written — the athlete's to send — and nothing goes to the thread coach (`coach.send` and its requests are
 *    gone); Retire stays the app's own confirm;
 *  - the Plan wakes no coach when it opens, whatever the server advises.
 *
 * Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationDto, CoachPlanDto, PlanDetailResponse } from "@rg/api-client";
import { useCoach, useCoachSeeing, CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { workoutFocus } from "../src/screens/studio/coach-focus.js";
import { GENERAL_CHIPS } from "../src/screens/studio/coach-conversation-model.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import { NEW_PLAN_REQUEST, YourPlans } from "../src/screens/plan-cards.js";
import { planRequests, PlanSheet } from "../src/screens/plan-sheet.js";
import { usePlanCoach } from "../src/screens/plan.js";
import { button, click, dialog, json, quietLoop, run, serve, settle, until, type Call, type Routes as Served } from "./coach-live-harness.js";
import { primedClient, todayDto, TODAY } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src", rel), "utf8");
const noop = () => undefined;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.unstubAllGlobals();
});

function render(el: ReactElement, qc: QueryClient): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client: qc }, el)));
}

// ── The opening screen's "needs you" chips ─────────────────────────────────

const NONE: CoachConversationDto = { id: null, startedAt: null, turns: [] };
const WORKOUT = workoutFocus({ id: "w1", title: "Long run", effectiveDate: TODAY, workoutSeconds: 3600, calendarSeconds: 3600, category: "long", sport: "run" });
const MISSED = { id: "missed:w9", label: "Rework my week around Tuesday's tempo", request: "I missed Tuesday's tempo. Rework my week around it." };
const RACE = { id: "race:2026-11-01", label: "Get me ready for race day", request: "My race is in 14 days. Get me ready for race day." };
const ENDING = { id: "ending:cp1", label: "Plan what comes after my 10K plan", request: "My 10K plan ends in 14 days. Plan what comes after it." };

function Screen({ seeing = null }: { seeing?: typeof WORKOUT | null }) {
  useCoachSeeing(seeing);
  const coach = useCoach();
  return createElement("button", { type: "button", id: "coach", onClick: () => coach?.open() }, "Coach");
}

function server(more: Served = {}): Call[] {
  return serve({
    "GET /api/coach/runs/current": { run: null },
    "GET /api/coach/conversation": NONE,
    "GET /api/templates": { templates: [] },
    "GET /api/objectives": { objectives: [] },
    ...more,
  });
}

function mountSheet(seeing: typeof WORKOUT | null = null): void {
  render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/plan"] },
      createElement(
        CoachSheetProvider,
        { loopDeps: quietLoop(() => run()) },
        createElement(Routes, null, createElement(Route, { path: "/plan", element: createElement(Screen, { seeing }) })),
      ),
    ),
    primedClient({ today: todayDto(null) }),
  );
}

const box = () => dialog()?.querySelector<HTMLTextAreaElement>(".coach-box textarea") ?? null;
const chipButtons = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>(".coach-chips button") ?? [])];
const chips = () => chipButtons().map((b) => b.textContent?.trim());
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/coach/runs").map((c) => c.body as { request: string });

async function openCoach() {
  await click(document.getElementById("coach"), "the Coach button");
  await until(() => !!box(), "the box in the sheet");
}

describe("the opening screen's \"needs you\" chips", () => {
  it("come first, at most two, before the general starters — each a chip marked as needing the athlete", async () => {
    const calls = server({ "GET /api/coach/nudges": { nudges: [MISSED, RACE, ENDING] } });
    mountSheet();
    await openCoach();
    await until(() => chips().length === 5, "the chips with the nudges");
    expect(chips()).toEqual([MISSED.label, RACE.label, ...GENERAL_CHIPS]);
    expect(chipButtons().map((b) => b.classList.contains("coach-chip--needs"))).toEqual([true, true, false, false, false]);
    expect(calls.filter((c) => c.path === "/api/coach/nudges")).toHaveLength(1);
  });

  it("a tap sends the chip's request as the athlete's words — its label is only what the chip says", async () => {
    const calls = server({
      "GET /api/coach/nudges": { nudges: [MISSED] },
      "POST /api/coach/runs": (body: unknown) => json({ run: run({ id: "run-n1", request: (body as { request: string }).request }), existing: false, conversationId: "run-n1" }),
    });
    mountSheet();
    await openCoach();
    await until(() => chips()[0] === MISSED.label, "the nudge");
    await click(button(MISSED.label, dialog()!), "the nudge chip");
    await until(() => posts(calls).length === 1, "the start");
    expect(posts(calls)[0]!.request).toBe(MISSED.request);
  });

  it("before a seen object's own chips too", async () => {
    server({ "GET /api/coach/nudges": { nudges: [RACE] } });
    mountSheet(WORKOUT);
    await openCoach();
    await until(() => chips().length === 4, "the chips with the nudge");
    expect(chips()).toEqual([RACE.label, "Shorten it", "Move it", "Why this run?"]);
  });

  it("none, or a read that fails: the starters alone", async () => {
    server({ "GET /api/coach/nudges": { nudges: [] } });
    mountSheet();
    await openCoach();
    await settle();
    expect(chips()).toEqual([...GENERAL_CHIPS]);
    act(() => root?.unmount());
    host?.remove();
    server(); // the read answers 503
    mountSheet();
    await openCoach();
    await settle();
    expect(chips()).toEqual([...GENERAL_CHIPS]);
  });

  it("past the week's cutoff they send nothing either", async () => {
    server({
      "GET /api/coach/nudges": { nudges: [MISSED] },
      "GET /api/coach/spend": { spentMicros: 20_000_000, cutoffMicros: 20_000_000, warnMicros: 5_000_000 },
    });
    mountSheet();
    await openCoach();
    await until(() => chips()[0] === MISSED.label && (dialog()?.textContent ?? "").includes("This week's AI budget is used up."), "the nudge and the line");
    expect(chipButtons().every((b) => b.disabled)).toBe(true);
  });
});

// ── The plan sheet and Your plans ──────────────────────────────────────────

const coachPlan: CoachPlanDto = { id: "cp1", discipline: "run", name: "Fall Half Block", status: "active", startDate: "2026-07-13", endDate: "2026-10-04", raceDate: null, source: "coach" };
const loose: CoachPlanDto = { ...coachPlan, id: "adhoc-run-x", name: "Coach one-offs", kind: "loose" } as CoachPlanDto;
const coros: CoachPlanDto = { ...coachPlan, id: "tp1", name: "COROS 10K", source: "coros" };
const detailOf = (plan: CoachPlanDto) => ({ plan, weeks: [], progressions: [], sessions: { planned: 48, done: 20 }, adherencePct: 86 }) as unknown as PlanDetailResponse;

function mountPlan(el: ReactElement, coach: CoachOpener | null, plan?: CoachPlanDto): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
  if (plan) qc.setQueryData(["plan-detail", plan.id], detailOf(plan));
  const routed: ReactNode = createElement(MemoryRouter, null, el);
  render(coach ? createElement(CoachOpenContext.Provider, { value: coach }, routed) : (routed as ReactElement), qc);
}
const sheetFor = (plan: CoachPlanDto) => createElement(PlanSheet, { planId: plan.id, plans: [plan], onClose: noop, onRetire: async () => null, onRename: noop });
const plain = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name);

describe("the plan sheet's Extend and Wind down open the conversation with the request written", () => {
  it("the words: the plan named plainly, never doubled", () => {
    expect(planRequests("Fall Half Block")).toEqual({
      ask: "How is my Fall Half Block plan going?",
      extend: "Extend my Fall Half Block plan by two weeks",
      windDown: "Wind down my Fall Half Block plan",
    });
    expect(planRequests("Base plan")).toMatchObject({ extend: "Extend my Base plan by two weeks", windDown: "Wind down my Base plan" });
  });

  it("each opens the coach with its words, the athlete's to send — no line saying it was asked, nothing sent", async () => {
    const opened: unknown[] = [];
    mountPlan(sheetFor(coachPlan), { open: (a) => opened.push(a) }, coachPlan);
    await act(async () => plain("Extend")!.click());
    await act(async () => plain("Wind down")!.click());
    expect(opened).toEqual([{ request: "Extend my Fall Half Block plan by two weeks" }, { request: "Wind down my Fall Half Block plan" }]);
    expect(document.body.textContent).not.toContain("Asked your coach");
    // Never waiting on a thread coach: a second tap opens it again.
    expect(plain("Extend")!.disabled).toBe(false);
  });

  it("without the conversation coach they are not offered; a loose bucket and a COROS plan are offered neither", () => {
    mountPlan(sheetFor(coachPlan), null, coachPlan);
    expect(plain("Extend")).toBeUndefined();
    expect(plain("Wind down")).toBeUndefined();
    expect(plain("Retire…")).toBeDefined();
    act(() => root?.unmount());
    host?.remove();
    for (const plan of [loose, coros]) {
      mountPlan(sheetFor(plan), { open: noop }, plan);
      expect(plain("Extend")).toBeUndefined();
      expect(plain("Wind down")).toBeUndefined();
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("Retire… stays the app's own two-step confirm, with no coach", async () => {
    const opened: unknown[] = [];
    mountPlan(sheetFor(coachPlan), { open: (a) => opened.push(a) }, coachPlan);
    await act(async () => plain("Retire…")!.click());
    expect(document.body.textContent).toContain("Retire this plan?");
    expect(opened).toEqual([]);
  });

  it("nothing of the thread coach's is left in the sheet or the Plan's wiring of it", () => {
    const sheet = read("screens/plan-sheet.tsx");
    for (const gone of ["THREAD_REQUESTS", "onAskThread", "threadBusy", "Asked your coach"]) expect(sheet).not.toContain(gone);
    const plan = read("screens/plan.tsx");
    expect(plan).not.toContain("coach.send");
    expect(plan).not.toMatch(/<PlanSheet[^>]*onAskThread/);
  });
});

describe("\"Plan with the coach\" is back in Your plans", () => {
  it("opens the conversation with the request written", async () => {
    const opened: unknown[] = [];
    mountPlan(createElement(YourPlans, { plans: [], programs: undefined, today: "2026-08-11", onOpenPlan: noop }), { open: (a) => opened.push(a) });
    expect(NEW_PLAN_REQUEST).toBe("Help me plan my next few weeks");
    await act(async () => plain("Plan with the coach")!.click());
    expect(opened).toEqual([{ request: "Help me plan my next few weeks" }]);
    expect(plain("New program…")).toBeDefined();
  });

  it("is not drawn without the conversation coach", () => {
    mountPlan(createElement(YourPlans, { plans: [], programs: undefined, today: "2026-08-11", onOpenPlan: noop }), null);
    expect(plain("Plan with the coach")).toBeUndefined();
    expect(plain("New program…")).toBeDefined();
  });
});

// ── The Plan wakes no coach ────────────────────────────────────────────────

describe("the Plan wakes no coach when it opens", () => {
  it("even when the server advises a wake (a server still running the thread coach), nothing is sent", async () => {
    const calls = serve({
      "GET /api/coach/state": {
        messages: [],
        pendingProposals: [],
        settledProposals: [],
        openQuestion: null,
        memoryCount: 0,
        lastCoachAt: null,
        wakeAdvised: true,
        coachThinking: false,
        outOfCredits: null,
      },
      "POST /api/coach/wake": { status: "ok" },
    });
    const states: boolean[] = [];
    function Probe() {
      const coach = usePlanCoach();
      if (coach.state.data) states.push(true);
      return null;
    }
    render(createElement(Probe), new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    await until(() => states.length > 0, "the state read");
    await settle();
    expect(calls.filter((c) => c.path === "/api/coach/wake")).toEqual([]);
  });
});
