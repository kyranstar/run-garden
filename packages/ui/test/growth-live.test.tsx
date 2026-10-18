// @vitest-environment jsdom
/**
 * GROWTH, LIVE (the new shape §7): what a tap does.
 *
 *  - The quiet area's button opens the app's coach with the request written ("15 minutes for my hips") and nothing seen —
 *    the words are the athlete's to send, never sent for them.
 *  - Month / Season reads the other period (`GET /api/growth/body?period=season`) and the page's address keeps it.
 *  - An open activity is what the coach sees (the nav's coach, no Ask of its own); closed, nothing.
 *  - A quest opens its full card in a sheet, and the coach sees the objective while it is open.
 *
 * Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityDto } from "@rg/api-client";
import {
  addDays,
  BODY_AREAS,
  DEFAULT_SCHEDULING_PREFERENCES,
  keyResultMeasureSchema,
  type GrowthBodyDto,
  type ObjectiveBoardDto,
} from "@rg/domain";
import { features } from "../src/features.js";
import { CoachOpenContext, CoachSeeingContext, SeeingRegistry, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import { OBJECTIVE_BOARD_QUERY } from "../src/screens/studio/objectives.js";
import { GrowthScreen } from "../src/screens/growth/screen.js";
import { button, click, dialog, serve, text, until } from "./coach-live-harness.js";
import { emptyInsights } from "./runs-units.test.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-14";
const T0 = "2026-09-01T12:00:00.000Z";
const was = { coach: features.coach, studio: features.studio };
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  features.coach = was.coach;
  features.studio = was.studio;
  vi.unstubAllGlobals();
});

function body(period: "month" | "season"): GrowthBodyDto {
  return {
    period,
    today: TODAY,
    from: addDays(TODAY, period === "month" ? -29 : -89),
    sessions: 3,
    runs: 2,
    other: 0,
    areas: BODY_AREAS.map((area) => ({ area, sets: area === "core" ? 12 : 0, runs: 0, level: area === "core" ? 2 : 0, last: area === "core" ? TODAY : null, daysAgo: area === "core" ? 0 : null })),
    carried: period === "month" ? ["core"] : ["back"],
    quiet: period === "month" ? { area: "hips", daysAgo: 6 } : null,
    holds: [],
  };
}

const run: ActivityDto = {
  id: "a1",
  startTime: `${TODAY}T15:00:00Z`,
  startTimeLocal: `${TODAY}T08:00:00`,
  date: TODAY,
  title: "Morning run",
  sport: "run",
  durationSeconds: 2700,
  distanceMeters: 8000,
  avgPaceSecPerKm: 337,
  trainingLoad: 50,
  feel: null,
  laps: null,
  matched: null,
} as ActivityDto;

const BOARD: ObjectiveBoardDto = {
  today: TODAY,
  objectives: [
    {
      objective: {
        id: "o1", title: "Hold a strong wall sit", why: null, status: "active", goalIds: [], sort: 0, createdAt: T0, updatedAt: T0,
        keyResults: [],
      },
      keyResults: [
        {
          keyResult: {
            id: "k1", objectiveId: "o1", label: "Wall sit hold", measure: keyResultMeasureSchema.parse({ kind: "hold_max", libraryIds: ["wallSit"] }), direction: "up",
            baseline: 60, target: 120, unit: "s", dueDate: null, position: 0, createdAt: T0, updatedAt: T0,
          },
          progress: { unit: "s", current: 90, series: [{ date: TODAY, value: 90, display: 90 }], lastMeasuredAt: TODAY, sampleSize: 1, evidence: "sparse", display: { unit: "s", current: 90 } },
          best: null,
        },
      ],
      served: [],
      streakWeeks: 1,
      note: null,
    },
  ],
};

/** Where the page's address is: the period lives there. */
let address = "";
function Where() {
  address = `${useLocation().pathname}${useLocation().search}`;
  return null;
}

async function mount(el: ReactElement, o: { opener: CoachOpener | null; registry?: SeeingRegistry; path?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["insights", "run"], emptyInsights());
  qc.setQueryData(["runs"], { activities: [run] });
  qc.setQueryData(["settings"], { prefs: { ...DEFAULT_SCHEDULING_PREFERENCES, units: "km", weightUnit: "kg" } });
  qc.setQueryData(["coach-read-peek", run.id], { read: null });
  qc.setQueryData(["growth", "body", "month"], body("month"));
  qc.setQueryData(OBJECTIVE_BOARD_QUERY, BOARD);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          CoachSeeingContext.Provider,
          { value: o.registry ?? new SeeingRegistry() },
          createElement(
            CoachOpenContext.Provider,
            { value: o.opener },
            createElement(MemoryRouter, { initialEntries: [o.path ?? "/growth"] }, createElement(Where), el),
          ),
        ),
      ),
    );
  });
}

describe("Growth, live", () => {
  it("the quiet area's button opens the coach with the words written, seeing nothing", async () => {
    features.coach = true;
    features.studio = true;
    serve({ "GET /api/coros/read-now": { busy: false } });
    const open = vi.fn();
    await mount(createElement(GrowthScreen), { opener: { open } });
    await until(() => text().includes("Hips quiet for 6 days."), "the quiet line");
    await click(button("15 minutes for my hips"), "the quiet area's button");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ request: "15 minutes for my hips", seeing: null });
  });

  it("Season reads the season, and the address keeps it; Month takes it back off", async () => {
    features.coach = false;
    const calls = serve({ "GET /api/growth/body": (_b: unknown, q: string) => body(q.includes("season") ? "season" : "month"), "GET /api/coros/read-now": { busy: false } });
    await mount(createElement(GrowthScreen), { opener: null });
    await until(() => text().includes("Core carried the month."), "the month");
    await click(button("Season"), "Season");
    await until(() => text().includes("Back carried the season."), "the season");
    expect(calls.some((c) => c.path === "/api/growth/body" && c.query === "period=season")).toBe(true);
    expect(address).toBe("/growth?period=season");
    expect(button("Season")?.getAttribute("aria-pressed")).toBe("true");
    await click(button("Month"), "Month");
    await until(() => text().includes("Core carried the month."), "the month again");
    expect(address).toBe("/growth");
  });

  it("an open activity is what the coach sees; closed, nothing", async () => {
    features.coach = false;
    serve({ "GET /api/coros/read-now": { busy: false } });
    const registry = new SeeingRegistry();
    await mount(createElement(GrowthScreen), { opener: { open: () => undefined }, registry });
    await until(() => text().includes("Morning run"), "the feed");
    expect(registry.current).toBeNull();
    const row = () => host!.querySelector<HTMLButtonElement>(".fw-row");
    await click(row(), "the activity's row");
    expect(registry.current).toMatchObject({ kind: "activity", id: "a1" });
    // No Ask of its own: the nav's coach is the way to ask.
    expect(host!.querySelector(".fw-detail .ask-coach")).toBeNull();
    await click(row(), "the activity's row again");
    expect(registry.current).toBeNull();
  });

  it("a quest opens its full card in a sheet; the coach sees the objective while it is open", async () => {
    features.coach = true;
    features.studio = true;
    serve({ "GET /api/coros/read-now": { busy: false } });
    const registry = new SeeingRegistry();
    await mount(createElement(GrowthScreen), { opener: { open: () => undefined }, registry });
    await until(() => text().includes("Hold a strong wall sit"), "the quest");
    await click(host!.querySelector(".quest-open"), "the quest's title");
    const sheet = dialog();
    expect(sheet?.textContent).toContain("Wall sit hold");
    expect(sheet?.querySelector(".obj-card")).not.toBeNull();
    // The sheet's title names it; the card's own title is not drawn a second time (kept for the outline).
    expect(sheet?.querySelector(".obj-title")?.classList.contains("visually-hidden")).toBe(true);
    expect(registry.current).toMatchObject({ kind: "objective", id: "o1" });
  });

  it("a quest's sheet has its own small Ask, seeing the objective (a modal sheet covers the nav's coach)", async () => {
    features.coach = true;
    features.studio = true;
    serve({ "GET /api/coros/read-now": { busy: false } });
    const open = vi.fn();
    await mount(createElement(GrowthScreen), { opener: { open } });
    await until(() => text().includes("Hold a strong wall sit"), "the quest");
    await click(host!.querySelector(".quest-open"), "the quest's title");
    const ask = dialog()?.querySelector<HTMLButtonElement>('button[aria-label="Ask the coach about Hold a strong wall sit"]');
    await click(ask, "the sheet's Ask");
    expect(open).toHaveBeenCalledWith({ seeing: expect.objectContaining({ kind: "objective", id: "o1" }), request: null });
  });

  describe("the board's actions, from Growth: a quest's sheet → ⋯", () => {
    /** A server that keeps the objective's status: a write changes what the board answers next. */
    function board() {
      let status = "active";
      const objectiveNow = () => ({ ...BOARD.objectives[0]!.objective, status });
      const calls = serve({
        "GET /api/coros/read-now": { busy: false },
        "GET /api/objectives/board": () => ({ ...BOARD, objectives: [{ ...BOARD.objectives[0]!, objective: objectiveNow() }] }),
        "PUT /api/objectives/o1": (body: { status?: string }) => {
          if (body?.status) status = body.status;
          return { objective: objectiveNow() };
        },
      });
      return calls;
    }
    async function more() {
      await until(() => !!host!.querySelector(".quest-open"), "the quest");
      await click(host!.querySelector(".quest-open"), "the quest's title");
      await click(dialog()?.querySelector('button[aria-label="Hold a strong wall sit: more"]'), "⋯");
      return dialog()!;
    }

    it("⋯ offers Edit…, Pause and Mark complete…, in place of the card", async () => {
      features.coach = true;
      features.studio = true;
      board();
      await mount(createElement(GrowthScreen), { opener: { open: () => undefined } });
      const menu = await more();
      expect([...menu.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(expect.arrayContaining(["Edit…", "Pause", "Mark complete…"]));
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    });

    it("Pause writes it, says so, and the quest reads Paused", async () => {
      features.coach = true;
      features.studio = true;
      const calls = board();
      await mount(createElement(GrowthScreen), { opener: { open: () => undefined } });
      await click(button("Pause", await more()), "Pause");
      await until(() => text().includes("Paused “Hold a strong wall sit”."), "the status line");
      expect(calls.filter((c) => c.method === "PUT")).toEqual([expect.objectContaining({ path: "/api/objectives/o1", body: { status: "paused" } })]);
      await until(() => host!.querySelector(".quest")?.textContent?.includes("Paused") === true, "the quest's line");
    });

    it("Mark complete… asks once, then writes it", async () => {
      features.coach = true;
      features.studio = true;
      const calls = board();
      await mount(createElement(GrowthScreen), { opener: { open: () => undefined } });
      await click(button("Mark complete…", await more()), "Mark complete…");
      const confirm = dialog()!;
      expect(confirm.textContent).toContain("Mark it complete?");
      await click(button("Mark complete", confirm), "Mark complete");
      await until(() => calls.some((c) => c.method === "PUT"), "the write");
      expect(calls.filter((c) => c.method === "PUT")).toEqual([expect.objectContaining({ path: "/api/objectives/o1", body: { status: "done" } })]);
      await until(() => text().includes("Completed “Hold a strong wall sit”."), "the status line");
    });

    it("Edit… opens the objective's edit sheet", async () => {
      features.coach = true;
      features.studio = true;
      board();
      await mount(createElement(GrowthScreen), { opener: { open: () => undefined } });
      await click(button("Edit…", await more()), "Edit…");
      await until(() => !!document.querySelector('[role="dialog"]')?.textContent?.includes("Edit objective"), "the edit sheet");
    });
  });
});
