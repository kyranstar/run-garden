// @vitest-environment jsdom
/**
 * GARDEN MOMENTS ON TODAY, LIVE (the new shape §7): the garden home rendered whole against a stubbed worker (only the
 * canvas scene stubbed), the objectives board holding a key result's best ever from yesterday and an objective completed
 * today — Today's arrival lines say both. With the coach off the board is not read, and they say neither. Synthetic data
 * only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialSnapshot } from "@rg/garden-engine";
import { keyResultMeasureSchema } from "@rg/domain";
import { features } from "../src/features.js";
import { GardenScreen } from "../src/screens/garden.js";

vi.mock("@rg/garden-renderer", () => ({ GardenScene: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-05";
const YESTERDAY = "2026-10-04";
const T0 = "2026-09-01T12:00:00.000Z";

const today = {
  today: TODAY,
  nextWorkout: null,
  upcoming: [],
  todaySessions: [],
  conditions: [],
  unresolved: [],
  needsAttention: [],
  sync: { pendingCorosJobs: 0, corosConnected: true, corosWritesEnabled: false, calendarConnected: true },
  readiness: { latest: null, baseline: null, sampleDays: 10, verdict: null },
  focus: null,
  consistency: { weeks: [], adherence: null, streak: 0 },
};

const garden = {
  snapshot: initialSnapshot("2026-09-01"),
  events: [],
  // Seen two days ago: not a brand-new garden.
  seen: { lastSeenDate: "2026-10-03", lastSeenSeq: 0, celebratedSpeciesIds: [] },
  restMode: { active: false },
  balance: { run: { days: 1, health: 1 }, strength: { days: 3, health: 0.8 }, yoga: { days: 5, health: 0.6 }, overall: 0.8 },
  codex: [],
  species: [],
  wildlife: [],
  visitors: [],
};

const kr = {
  id: "k1", objectiveId: "o1", label: "Wall sit hold", measure: keyResultMeasureSchema.parse({ kind: "hold_max", libraryIds: ["wallSit"] }), direction: "up",
  baseline: 60, target: 120, unit: "s", dueDate: null, position: 0, createdAt: T0, updatedAt: T0,
};
const board = {
  today: TODAY,
  objectives: [
    {
      objective: { id: "o1", title: "Legs for the hills", why: null, status: "active", goalIds: [], sort: 0, createdAt: T0, updatedAt: T0, keyResults: [kr] },
      keyResults: [{ keyResult: kr, progress: { unit: "s", current: 96, series: [], lastMeasuredAt: null, sampleSize: 0, evidence: "sparse", display: { unit: "s", current: 96 } }, best: { date: YESTERDAY, value: 96, display: 96 } }],
      served: [],
      streakWeeks: 1,
      note: null,
    },
    {
      objective: { id: "o2", title: "Run a calm 10K", why: null, status: "done", goalIds: [], sort: 1, createdAt: T0, updatedAt: `${TODAY}T17:00:00.000Z`, keyResults: [] },
      keyResults: [],
      served: [],
      streakWeeks: 0,
      note: null,
    },
  ],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const was = { coach: features.coach, studio: features.studio };

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
  features.coach = was.coach;
  features.studio = was.studio;
  vi.unstubAllGlobals();
});

async function renderHome(): Promise<{ paths: string[] }> {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/\?.*$/, "");
      paths.push(path);
      const body =
        path === "/api/plan/today"
          ? today
          : path === "/api/garden"
            ? garden
            : path === "/api/settings"
              ? { prefs: { units: "km", timezone: "America/Los_Angeles" } }
              : path === "/api/objectives/board"
                ? board
                : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(GardenScreen))));
  });
  const tick = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  // The home's reads out and drawn, then a few more ticks for the board's.
  for (let i = 0; i < 300 && !(paths.includes("/api/garden") && paths.includes("/api/plan/today") && (host.textContent ?? "").length > 0); i += 1) await tick();
  for (let i = 0; i < 30 && !(host.textContent ?? "").includes("is complete."); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return { paths };
}

describe("the objectives' garden moments on Today", () => {
  it("a best ever since the last visit and an objective completed today are arrival lines", async () => {
    features.coach = true;
    features.studio = true;
    await renderHome();
    const words = (host!.textContent ?? "").replace(/\s+/g, " ");
    expect(words).toContain("A best ever on Wall sit hold: 96 s.");
    expect(words).toContain("“Run a calm 10K” is complete.");
  });

  it("with the coach off the board is never read, and the lines say neither", async () => {
    features.coach = false;
    const { paths } = await renderHome();
    expect(paths).not.toContain("/api/objectives/board");
    const words = host!.textContent ?? "";
    expect(words).not.toContain("A best ever");
    expect(words).not.toContain("is complete.");
  });
});
