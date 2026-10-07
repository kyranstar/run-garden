// @vitest-environment jsdom
/**
 * The Today card on a program day after the session is over (Phase 2b Task 7; 2a UI re-review U6): a program session
 * heading the card that is skipped, done, or saved here and waiting for the server is not today's to-do — the coach's
 * clause about pacing today and "Finishing it grows…" are gone, and the collapsed row does not say "Next:". The
 * garden home is rendered whole against a stubbed worker (only the canvas scene stubbed).
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialSnapshot } from "@rg/garden-engine";
import { GardenScreen } from "../src/screens/garden.js";
import { features } from "../src/features.js";
import { enqueue } from "../src/offline/outbox.js";
import { offlineDb } from "../src/offline/idb.js";

vi.mock("@rg/garden-renderer", () => ({ GardenScene: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-08";
const SLOT = "slot-p1-2026-10-08";

const slot = (over: Record<string, unknown> = {}) => ({
  id: SLOT,
  title: "Program one · Desk unwind",
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
  contentState: "built",
  programId: "p1",
  ...over,
});

function todayPayload(w: Record<string, unknown>, extra: Record<string, unknown>[] = []) {
  return {
    today: TODAY,
    nextWorkout: w,
    upcoming: [w],
    todaySessions: [{ workout: w, build: { mode: "consistent", theme: "Desk unwind", minutes: 30 } }, ...extra.map((x) => ({ workout: x, build: null }))],
    conditions: [],
    unresolved: [],
    needsAttention: [],
    sync: { pendingCorosJobs: 0, corosConnected: true, corosWritesEnabled: false, calendarConnected: true },
    readiness: { latest: null, baseline: null, sampleDays: 10, verdict: { level: "good", reasons: ["HRV in your usual range"] } },
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T08:00:00`));
  features.player = true;
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

async function renderCard(today: Record<string, unknown>): Promise<{ card: HTMLElement; pill: string }> {
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
                ? { today: TODAY, workouts: [], plan: null }
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
  for (let i = 0; i < 300 && !host.querySelector("#dock-panel .today-title"); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  const card = host.querySelector<HTMLElement>("#dock-panel");
  if (!card) throw new Error(`the Today card never rendered\n${host.textContent}`);
  return { card, pill: host.querySelector(".dock-pill")?.getAttribute("aria-label") ?? "" };
}

describe("the program session heading the card", () => {
  it("still to do: the coach's clause about today, the play action, Next: on the row", async () => {
    const { card, pill } = await renderCard(todayPayload(slot()));
    expect(card.querySelector(".today-coach")?.textContent).toContain("Green lights");
    expect(card.querySelector(".today-play")?.textContent).toBe("Start");
    expect(pill).toMatch(/^Next: /);
  });

  it("skipped: no coach clause about today, and the row says skipped", async () => {
    const { card, pill } = await renderCard(todayPayload(slot({ completionState: "skipped" })));
    expect(card.querySelector(".today-coach")).toBeNull();
    expect(pill).toMatch(/skipped$/);
  });

  it("done: no coach clause, and the row says done — not Next:", async () => {
    const { card, pill } = await renderCard(todayPayload(slot({ contentState: "done", completionState: "completed" })));
    expect(card.querySelector(".today-coach")).toBeNull();
    expect(pill).not.toMatch(/^Next:/);
    expect(pill).toMatch(/done$/);
  });

  it("saved here and waiting for the server: Done · 31 min · saved, will sync — no coach clause, no Continue", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    await enqueue(await offlineDb(), {
      id: "22222222-2222-4222-8222-222222222222", source: "app", sourceRef: null, workoutId: SLOT, buildId: "b1", localDate: TODAY,
      startedAt: `${TODAY}T18:00:00.000Z`, endedAt: `${TODAY}T18:31:00.000Z`, seconds: 1860, plannedSeconds: 1800, minutes: 30,
      mode: "consistent", theme: null, locationId: "home", blockRef: null, blockNumber: null, completed: true, stepsTotal: 9,
      stepsDone: 9, movesDone: [], note: null, newMove: null, entries: [], checks: [],
    });
    const { card } = await renderCard(todayPayload(slot({ contentState: "started" })));
    for (let i = 0; i < 100 && !card.textContent?.includes("will sync"); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    const pill = host!.querySelector(".dock-pill")?.getAttribute("aria-label") ?? "";
    expect(card.querySelector(".today-meta")?.textContent).toBe("Done · 31 min · saved, will sync");
    expect(card.querySelector(".today-play")).toBeNull();
    expect(card.querySelector(".today-coach")).toBeNull();
    expect(pill).not.toMatch(/^Next:/);
  });

  it("a skipped session under the day's run keeps a way in: Open, not primary", async () => {
    const run = { ...slot({ id: "run-1", title: "Easy Run", category: "easy", sport: "run", origin: null, contentState: null, programId: null, effectiveTime: "07:00" }) };
    const skipped = slot({ completionState: "skipped" });
    const payload = { ...todayPayload(run), todaySessions: [{ workout: run, build: null }, { workout: skipped, build: null }] };
    const { card } = await renderCard(payload);
    const line = card.querySelector(".today-session")!;
    expect(line.textContent).toContain("Skipped");
    const open = [...line.querySelectorAll("a")].find((a) => a.textContent === "Open");
    expect(open?.getAttribute("href")).toBe(`/plan?workout=${SLOT}`);
    expect(open?.className).not.toContain("btn-primary");
  });
});
