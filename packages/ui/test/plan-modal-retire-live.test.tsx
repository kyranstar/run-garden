// @vitest-environment jsdom
/**
 * The plan sheet's Retire…, live (Stage 2 Task 9, fix round 1): a plan the old generator made is retired the way a coach
 * plan is — Retire…, the same confirmation, and the page told which kind it is, so it asks the right route.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type CoachPlanDto, type PlanDetailResponse } from "@rg/api-client";
import { PlanSheet } from "../src/screens/plan-sheet.js";
import { retirePlan } from "../src/screens/plan.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const plan = (over: Partial<CoachPlanDto>): CoachPlanDto => ({
  id: "p1",
  discipline: "lift",
  name: "Strength Block",
  status: "active",
  startDate: "2026-09-28",
  endDate: "2026-11-22",
  raceDate: null,
  source: "coach",
  ...over,
});

function mount(p: CoachPlanDto, onRetire: (id: string, source: "coach" | "studio") => Promise<string | null>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const detail: PlanDetailResponse = { plan: p, weeks: [], progressions: [], sessions: { planned: 24, done: 7 }, adherencePct: null };
  qc.setQueryData(["plan-detail", p.id], detail);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          null,
          createElement(PlanSheet, { planId: p.id, plans: [p], onClose: () => undefined, onRetire, onRename: () => undefined }),
        ),
      ),
    ),
  );
}

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
};

describe("Retire… in the plan sheet", () => {
  it("a plan the old generator made: the same confirmation, and the page is told it is a Studio plan", () => {
    const onRetire = vi.fn(async () => null);
    mount(plan({ id: "sp1", name: "Generated Block", source: "studio" }), onRetire);
    act(() => button("Retire…").click());
    expect(document.body.textContent).toContain("Retire this plan?");
    expect(document.body.textContent).toContain("“Generated Block” stops here and every session still ahead of it is archived.");
    act(() => button("Retire the plan").click());
    expect(onRetire).toHaveBeenCalledWith("sp1", "studio");
  });

  it("a coach plan: as before, told it is the coach's", () => {
    const onRetire = vi.fn(async () => null);
    mount(plan({ id: "cp1" }), onRetire);
    act(() => button("Retire…").click());
    act(() => button("Retire the plan").click());
    expect(onRetire).toHaveBeenCalledWith("cp1", "coach");
  });

  it("a refused Retire is said in its confirmation, which stays open; it is busy while it waits (fix round 2)", async () => {
    let answer!: (why: string | null) => void;
    const onRetire = vi.fn(() => new Promise<string | null>((r) => (answer = r)));
    mount(plan({ id: "sp1", name: "Generated Block", source: "studio" }), onRetire);
    act(() => button("Retire…").click());
    act(() => button("Retire the plan").click());
    expect(button("Retire the plan").disabled).toBe(true);
    await act(async () => answer("Writing to COROS is switched off. Turn on “Write date changes back to COROS” in Settings, then retire it."));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Writing to COROS is switched off. Turn on “Write date changes back to COROS” in Settings, then retire it.",
    );
    expect(document.body.textContent).toContain("Retire this plan?");
    expect(button("Retire the plan").disabled).toBe(false);
    // Closed and opened again, it starts fresh.
    act(() => button("Cancel").click());
    act(() => button("Retire…").click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("the page asks the Studio's route for a Studio plan and the coach's for a coach plan", async () => {
    const studio = vi.spyOn(api, "studioPlanRetire").mockResolvedValue({ ok: true });
    const coach = vi.spyOn(api, "coachPlanRetire").mockResolvedValue({ ok: true });
    await retirePlan({ id: "sp1", source: "studio" });
    await retirePlan({ id: "cp1", source: "coach" });
    expect(studio.mock.calls).toEqual([["sp1"]]);
    expect(coach.mock.calls).toEqual([["cp1"]]);
    vi.restoreAllMocks();
  });
});
