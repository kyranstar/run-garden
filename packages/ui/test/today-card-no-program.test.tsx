// @vitest-environment jsdom
/**
 * The account with no program (the live account) sees the Today card it always saw (Phase 2a; audit 2a-UI M11a).
 *
 * The garden home is rendered whole against a stubbed worker — only the canvas scene is stubbed — and the card is
 * read from the DOM: titled by its run with the run's own actions, no program line, no condition chip, the readiness
 * chip alone in its row. And the card is the same, to the byte, whether the server sends Phase 2a's new fields
 * empty (`todaySessions` with only the run, `conditions: []`) or not at all — a payload from before 2a, as an older
 * cached app shell may still hold. The new fields add nothing for this account.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialSnapshot } from "@rg/garden-engine";
import { GardenScreen } from "../src/screens/garden.js";

// The scene draws on a canvas jsdom does not have; the card is what is under test.
vi.mock("@rg/garden-renderer", () => ({ GardenScene: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-05";

const run = {
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
};

/** `/api/plan/today` for an account with no program, as the worker sends it now. */
function todayPayload(verdict: { level: string; reasons: string[] } | null) {
  return {
    today: TODAY,
    nextWorkout: run,
    upcoming: [run],
    todaySessions: [{ workout: run, build: null }],
    conditions: [],
    unresolved: [],
    needsAttention: [],
    sync: { pendingCorosJobs: 0, corosConnected: true, corosWritesEnabled: false, calendarConnected: true },
    readiness: { latest: null, baseline: null, sampleDays: 10, verdict },
    focus: null,
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
  // The eyebrow writes the date; pinned to TODAY's year (Date only — timers stay real).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00`));
  // Below lg: the card is the page and always open.
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

/** The home screen against `today`; resolves with the card's markup and the collapsed row's. */
async function renderCard(today: Record<string, unknown>): Promise<{ card: HTMLElement; markup: string }> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/\?.*$/, "");
      const body =
        path === "/api/plan/today"
          ? today
          : path === "/api/garden"
            ? garden
            : path === "/api/settings"
              ? { prefs: { units: "km", timezone: "America/Los_Angeles" } }
              : path === "/api/plan/workouts"
                ? { today: TODAY, workouts: [run], plan: null }
                : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(GardenScreen))));
  });
  for (let i = 0; i < 300 && !host.querySelector("#dock-panel"); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  const card = host.querySelector<HTMLElement>("#dock-panel");
  if (!card) throw new Error(`the Today card never rendered\n${host.textContent}`);
  return { card, markup: `${host.querySelector(".dock-pill")?.outerHTML}${card.outerHTML}` };
}

const withoutPhase2a = (payload: Record<string, unknown>) => {
  const { todaySessions: _sessions, conditions: _conditions, ...before } = payload;
  return before;
};

describe("the Today card for an account with no program (audit 2a-UI M11a)", () => {
  it("is the run's card: its title and actions, no program line, no condition chip, readiness alone in its row", async () => {
    const { card } = await renderCard(todayPayload({ level: "good", reasons: ["HRV in your usual range"] }));
    expect(card.querySelector(".today-title")?.textContent).toBe("Easy Run with Strides");
    expect([...card.querySelectorAll(".today-actions .btn")].map((b) => b.textContent)).toEqual(["View workout", "Move"]);
    expect(card.querySelector(".today-actions a")?.getAttribute("href")).toBe("/plan?workout=run-1");
    expect(card.querySelector(".today-sessions, .today-session, .condition-chip, .today-play")).toBeNull();
    const chips = [...card.querySelectorAll(".today-chips > *")];
    expect(chips.map((c) => c.className)).toEqual(["ready-chip ready-good"]);
    expect(card.textContent).not.toMatch(/\bOpen\b|Skipped|Done\b/);
  });

  it("is the same card, byte for byte, with Phase 2a's fields empty or absent — with a readiness verdict and without", async () => {
    for (const verdict of [{ level: "caution", reasons: ["Resting HR up"] }, null]) {
      const now = (await renderCard(todayPayload(verdict))).markup;
      const before = (await renderCard(withoutPhase2a(todayPayload(verdict)))).markup;
      expect(now).toBe(before);
    }
  });
});
