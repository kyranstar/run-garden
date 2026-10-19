// @vitest-environment jsdom
/**
 * The Plan's first-paint gate (`settling`) after a read has failed. TanStack puts a failed read with no data back to
 * pending whenever something that needs it mounts and reads it again — and to a gate that read `isLoading` alone, that
 * was a first load once more: the page went back to its spinner, unmounting what had asked; the read failed; the page
 * drew it again, it asked again — round and round, the read hammered (2026-10-19, found in the Studio's home). The
 * order made certain: the Plan opened on a programme session (`?workout=`), the programmes read failing. The session
 * sheet reads the programmes too, so it asks again as it mounts.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkoutDto } from "@rg/api-client";
import { PlanScreen } from "../src/screens/plan.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-05";
const SLOT = "slot-p1-2026-10-05";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

/** Today's programme session: a row the Plan opens in the session sheet. */
const slot = {
  id: SLOT,
  title: "Garden program · Hips & posture",
  category: "strength",
  qualitySubtype: null,
  sport: "strength",
  originalPlanDate: TODAY,
  lastVerifiedCorosDate: "",
  effectiveDate: TODAY,
  effectiveTime: "19:00",
  workoutSeconds: 1800,
  calendarSeconds: 1800,
  stageSummary: null,
  calendarSyncState: "synced",
  corosSyncState: "calendar_only",
  completionState: "scheduled",
  archived: false,
  origin: "program",
  contentState: "outline",
  programId: "p1",
} as WorkoutDto;

const WEEK = {
  weekStart: TODAY,
  days: ["05", "06", "07", "08", "09", "10", "11"].map((d) => ({ date: `2026-10-${d}`, workouts: d === "05" ? [slot] : [] })),
  plannedSeconds: 1800,
  doneCount: 0,
  sessionCount: 1,
  weekIndex: null,
  weekTotal: null,
  adherence4w: { pct: null, trend: null },
  loadRatio: null,
  adventureDays: 0,
  headline: "on_track",
  focus: null,
};

/** The Plan at `/plan?workout=<the slot>`, every read answered but the programmes', which fail every time. */
function mountOnTheSession() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = url.replace(/\?.*$/, "");
      calls.push(path);
      if (path === "/api/programs") return json({ error: "internal" }, 500);
      if (path === "/api/plan/week") return json(WEEK);
      if (path === "/api/plan/workouts") return json({ today: TODAY, workouts: [slot], plan: null });
      if (path === "/api/coach/plans") return json({ plans: [] });
      if (path === "/api/coach/state") {
        return json({ messages: [], pendingProposals: [], settledProposals: [], openQuestion: null, memoryCount: 0, lastCoachAt: null, wakeAdvised: false });
      }
      if (path === "/api/plan/race") return json({ race: null });
      if (path === "/api/settings") return json({ prefs: { units: "km", timezone: "America/Los_Angeles" } });
      return json({ error: "not_found" }, 404);
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  // The app's own retry rule (app.tsx: two retries), quickly.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: (count) => count < 2, retryDelay: 1 } } });
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(MemoryRouter, { initialEntries: [`/plan?workout=${SLOT}`] }, createElement(PlanScreen)),
      ),
    );
  });
  return { calls };
}

const settle = async (n = 40) => {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
};

describe("the Plan's first paint, after a read has failed (2026-10-19)", () => {
  it("a failed read is answered: the page is drawn once, the session sheet on it, and the read is not asked over and over", async () => {
    const { calls } = mountOnTheSession();
    await settle();
    expect(host!.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host!.textContent).not.toContain("Loading plan");
    // The page's one attempt, then the sheet's own (with its retries): no more.
    const reads = calls.filter((c) => c === "/api/programs").length;
    expect(reads).toBeLessThanOrEqual(4);
    await settle(20);
    expect(calls.filter((c) => c === "/api/programs").length).toBe(reads);
  });
});
