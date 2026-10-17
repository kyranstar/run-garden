// @vitest-environment jsdom
/**
 * COACH EVERYWHERE, PHASE A3 — the Today card's "Ask", live: the garden home rendered whole against a stubbed worker
 * (only the canvas scene stubbed). A planned workout's card asks about the workout — beside View workout and Move — and
 * a rest day's about the day; the tap opens the app's coach sheet (here, a recorder in its place) with that focus. With
 * no coach in the app, the card is as it always was. Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialSnapshot } from "@rg/garden-engine";
import { GardenScreen } from "../src/screens/garden.js";
import { CoachOpenContext, type CoachOpener } from "../src/screens/studio/coach-ask.js";
import type { CoachOpenArgs } from "../src/screens/studio/coach-focus.js";

vi.mock("@rg/garden-renderer", () => ({ GardenScene: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-05";

const workout = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  title: "Easy Run with Strides",
  category: "easy",
  qualitySubtype: null,
  sport: "run",
  originalPlanDate: TODAY,
  lastVerifiedCorosDate: TODAY,
  effectiveDate: TODAY,
  effectiveTime: "07:00",
  workoutSeconds: 2700,
  calendarSeconds: 2700,
  stageSummary: "40 min · 4 × 15s / 45s recovery",
  calendarSyncState: "synced",
  corosSyncState: "synced",
  completionState: "scheduled",
  archived: false,
  origin: null,
  contentState: null,
  programId: null,
  ...over,
});

/** The week's focus line the coach wrote: the card's coach line shows with it. */
let weekFocus: { text: string; at: string } | null = null;

function todayPayload(w: ReturnType<typeof workout>) {
  return {
    today: TODAY,
    nextWorkout: w,
    upcoming: [w],
    todaySessions: [{ workout: w, build: null }],
    conditions: [],
    unresolved: [],
    needsAttention: [],
    sync: { pendingCorosJobs: 0, corosConnected: true, corosWritesEnabled: false, calendarConnected: true },
    readiness: { latest: null, baseline: null, sampleDays: 10, verdict: null },
    focus: weekFocus,
    consistency: { weeks: [], adherence: null, streak: 0 },
  };
}

const garden = {
  snapshot: initialSnapshot("2026-09-01"),
  events: [],
  seen: null,
  restMode: { active: false },
  balance: { run: { days: 1, health: 1 }, strength: { days: 3, health: 0.8 }, yoga: { days: 5, health: 0.6 }, overall: 0.8 },
  codex: [],
  species: [],
  wildlife: [],
  visitors: [],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00`));
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

async function renderCard(w: ReturnType<typeof workout>, opener: CoachOpener | null): Promise<HTMLElement> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/\?.*$/, "");
      const body =
        path === "/api/plan/today"
          ? todayPayload(w)
          : path === "/api/garden"
            ? garden
            : path === "/api/settings"
              ? { prefs: { units: "km", timezone: "America/Los_Angeles" } }
              : path === "/api/plan/workouts"
                ? { today: TODAY, workouts: [w], plan: null }
                : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(CoachOpenContext.Provider, { value: opener }, createElement(MemoryRouter, null, createElement(GardenScreen))),
      ),
    );
  });
  for (let i = 0; i < 300 && !host.querySelector("#dock-panel"); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  const card = host.querySelector<HTMLElement>("#dock-panel");
  if (!card) throw new Error(`the Today card never rendered\n${host.textContent}`);
  return card;
}

const recorder = () => {
  const calls: CoachOpenArgs[] = [];
  return { calls, opener: { open: (a: CoachOpenArgs) => calls.push(a) } as CoachOpener };
};

describe("the Today card's coach line (the lead's look at the shots)", () => {
  it("one ask on the card: with the coach's sheet in the app, the coach line keeps its words and the card's Ask is the one way to ask (the review's nit 2)", async () => {
    weekFocus = { text: "Hips first this week.", at: `${TODAY}T07:00:00.000Z` };
    try {
      for (const w of [workout(), workout({ id: "rest-1", title: "Rest", category: "rest", sport: "rest" })]) {
        const card = await renderCard(w, recorder().opener);
        expect(card.querySelector(".today-coach")!.textContent, w.id).toContain("Hips first this week.");
        expect(card.querySelector(".today-coach-ask"), w.id).toBeNull();
        expect(card.textContent, w.id).not.toContain("Ask me");
        expect(card.querySelectorAll(".ask-coach").length, w.id).toBe(1);
      }
    } finally {
      weekFocus = null;
    }
  });

  it("no coach in the app: 'Ask me ›' is the link to the Plan's coach, as it was", async () => {
    weekFocus = { text: "Hips first this week.", at: `${TODAY}T07:00:00.000Z` };
    try {
      const card = await renderCard(workout(), null);
      const link = card.querySelector<HTMLAnchorElement>(".today-coach a.today-coach-ask")!;
      expect(link.getAttribute("href")).toBe("/plan?coach=1");
      expect(link.textContent).toBe("Ask me ›");
    } finally {
      weekFocus = null;
    }
  });
});

describe("the Today card's Ask", () => {
  it("a planned workout's: beside View workout and Move, about the workout — the tap opens the sheet with it", async () => {
    const r = recorder();
    const card = await renderCard(workout(), r.opener);
    const actions = [...card.querySelectorAll(".today-actions .btn")].map((b) => b.textContent);
    expect(actions).toEqual(["View workout", "Move", "Ask"]);
    const ask = card.querySelector<HTMLButtonElement>(".today-actions .ask-coach")!;
    expect(ask.getAttribute("aria-label")).toBe("Ask the coach about Mon 5 Oct · Easy Run with Strides · 45 min");
    await act(async () => ask.click());
    expect(r.calls).toEqual([{ seeing: { kind: "workout", id: "run-1", date: TODAY, label: "Mon 5 Oct · Easy Run with Strides · 45 min" }, request: null }]);
  });

  it("a rest day's: about the day", async () => {
    const r = recorder();
    const card = await renderCard(workout({ id: "rest-1", title: "Rest", category: "rest", sport: "rest" }), r.opener);
    const ask = card.querySelector<HTMLButtonElement>(".ask-coach")!;
    expect(ask.getAttribute("data-focus")).toBe(`day:${TODAY}`);
    await act(async () => ask.click());
    expect(r.calls).toEqual([{ seeing: { kind: "day", id: TODAY, date: TODAY, label: "Mon 5 Oct" }, request: null }]);
  });

  it("no coach in the app: the card as it always was", async () => {
    const card = await renderCard(workout(), null);
    expect([...card.querySelectorAll(".today-actions .btn")].map((b) => b.textContent)).toEqual(["View workout", "Move"]);
    expect(card.querySelector(".ask-coach, .today-ask")).toBeNull();
  });
});
