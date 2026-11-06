// @vitest-environment jsdom
/**
 * What a plan's sheet says it is for (plans with a purpose §4.3): the purpose and how the plan ends, the brief one tap
 * down, and a "Change" that opens the coach with the words written (the athlete's to finish and send). The summary
 * comes from the `["plans"]` query (`api.plans()`), found by the plan's id or by `listedAs` — and by the line's key in a
 * line's sheet; none found (an older server) is no words at all. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachPlanDto, PlanDetailResponse, PlanSummaryDto, TrainingLineDto } from "@rg/api-client";
import { CoachOpenContext } from "../src/screens/studio/coach-ask.js";
import { LineSheet, PlanSheet } from "../src/screens/plan-sheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

const block = (id: string, name = "Base"): CoachPlanDto => ({
  id,
  discipline: "run",
  name,
  status: "active",
  startDate: "2026-10-12",
  endDate: "2026-11-08",
  raceDate: null,
  planRaceDate: null,
  source: "coach",
  kind: "block",
});
const detailOf = (p: CoachPlanDto): PlanDetailResponse => ({ plan: p, weeks: [], progressions: [], sessions: { planned: 4, done: 1 }, adherencePct: null });
const summary = (over: Partial<PlanSummaryDto> = {}): PlanSummaryDto => ({
  id: "pl1",
  kind: "coach",
  name: "Base",
  purpose: "Keep the habit going",
  brief: "Ten sessions, then easier.",
  onEnd: "ask",
  pausedUntil: null,
  objectiveIds: [],
  status: "active",
  lineKey: null,
  listedAs: null,
  course: null,
  prompt: null,
  ...over,
});

function mount(el: () => React.ReactElement, plans: PlanSummaryDto[] | null, open: (a?: { request?: string }) => void = () => undefined, details: CoachPlanDto[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const p of details) qc.setQueryData(["plan-detail", p.id], detailOf(p));
  if (plans) qc.setQueryData(["plans"], { plans });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } })));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client: qc }, createElement(CoachOpenContext.Provider, { value: { open } }, createElement(MemoryRouter, null, el())))));
}
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const findButton = (name: string) => buttons().find((b) => text(b) === name);
const sheet = (planId: string, plans: CoachPlanDto[], line?: TrainingLineDto) =>
  createElement(PlanSheet, { planId, plans, onClose: () => undefined, onRename: () => undefined, ...(line ? { line } : {}) });

describe("the plan sheet's words", () => {
  const plan = block("cp1");

  it("says what the plan is for and how it ends, found by the plan's id", () => {
    mount(() => sheet("pl1", [block("pl1")]), [summary()], undefined, [block("pl1")]);
    expect(text(document.querySelector(".plan-words-purpose"))).toBe("Keep the habit going");
    expect(text(document.querySelector(".plan-words-ending"))).toBe("Asks you when it ends");
  });

  it("finds its plan by listedAs when the sheet is the list row's id, not the plan's", () => {
    mount(() => sheet("cp1", [plan]), [summary({ id: "pl9", listedAs: "cp1", onEnd: "continue" })], undefined, [plan]);
    expect(text(document.querySelector(".plan-words-purpose"))).toBe("Keep the habit going");
    expect(text(document.querySelector(".plan-words-ending"))).toBe("Continues on its own");
  });

  it("keeps the brief behind a tap: hidden until opened, hidden again when closed", () => {
    mount(() => sheet("pl1", [block("pl1")]), [summary()], undefined, [block("pl1")]);
    expect(document.body.textContent).not.toContain("Ten sessions, then easier.");
    const more = findButton("How it works")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    act(() => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Ten sessions, then easier.");
    act(() => more.click());
    expect(document.body.textContent).not.toContain("Ten sessions, then easier.");
  });

  it("no purpose draws no purpose line (the ending still stands); no brief draws no disclosure", () => {
    mount(() => sheet("pl1", [block("pl1")]), [summary({ purpose: null, brief: null, onEnd: "finish" })], undefined, [block("pl1")]);
    expect(document.querySelector(".plan-words-purpose")).toBeNull();
    expect(text(document.querySelector(".plan-words-ending"))).toBe("Ends when its sessions do");
    expect(findButton("How it works")).toBeUndefined();
  });

  it("no summary (an older server, or not yet read) is no words and no Change", () => {
    mount(() => sheet("pl1", [block("pl1")]), null, undefined, [block("pl1")]);
    expect(document.querySelector(".plan-words")).toBeNull();
    expect(findButton("Change")).toBeUndefined();
  });

  it("Change opens the coach with the words written and sends nothing", () => {
    const open = vi.fn();
    mount(() => sheet("pl1", [block("pl1", "Base")]), [summary({ name: "Base" })], open, [block("pl1", "Base")]);
    act(() => findButton("Change")!.click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ request: "Change how my Base plan works: " });
  });

  it("a line of several phases says its plan's words too, found by the line's key", () => {
    const a = { id: "r1", discipline: "run", status: "completed", name: "Bridge", startDate: "2026-09-28", endDate: "2026-10-11", planRaceDate: null, futureSessions: 0 } as const;
    const b = { id: "r2", discipline: "run", status: "active", name: "Base", startDate: "2026-10-12", endDate: "2026-11-08", planRaceDate: null, futureSessions: 9 } as const;
    const line: TrainingLineDto = { key: "run:r1", discipline: "run", name: "Running", phases: [a, b], currentPhaseId: "r2", startDate: a.startDate, endDate: b.endDate, goalRaceDate: null, ended: false };
    mount(
      () => createElement(LineSheet, { lineKey: "run:r1", lines: [line], plans: [block("r1"), block("r2")], today: "2026-10-20", todayKnown: true, onClose: () => undefined, onRename: () => undefined }),
      [summary({ id: "pl2", lineKey: "run:r1", purpose: "Get back to running", onEnd: "continue" })],
      undefined,
      [block("r1"), block("r2")],
    );
    expect(text(document.querySelector(".plan-words-purpose"))).toBe("Get back to running");
    expect(text(document.querySelector(".plan-words-ending"))).toBe("Continues on its own");
  });
});
