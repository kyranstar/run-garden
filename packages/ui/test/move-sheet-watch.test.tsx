// @vitest-environment jsdom
/**
 * A MOVE OF A SESSION THE WATCH MIRRORS (the watch mirrors the plan §3.4; M1). The move sheet's result never says the
 * watch is "not auto-updated" for an app-built session: its copy follows by itself — "Updating your watch" while the
 * move's old-copy delete is on its way. And a session moved onto today goes on as the day's build: its build is asked
 * for, then the drain chain. A run keeps its own words. Synthetic data only; the clock pinned.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkoutDto } from "@rg/api-client";
import { MoveSheet } from "../src/screens/move-sheet.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-05";
let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** The query client of the sheet last mounted. */
let lastQc: QueryClient | null = null;

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

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

const row = (over: Partial<WorkoutDto> = {}): WorkoutDto =>
  ({
    id: "w1", title: "Leg day", category: "strength", qualitySubtype: null, sport: "strength", originalPlanDate: "2026-10-07",
    lastVerifiedCorosDate: "2026-10-07", effectiveDate: "2026-10-07", effectiveTime: "18:00", workoutSeconds: 1800, calendarSeconds: 1800,
    stageSummary: null, calendarSyncState: "synced", corosSyncState: "synced", completionState: "scheduled", archived: false,
    origin: "studio", contentState: "outline", ...over,
  }) as WorkoutDto;

function mount(w: WorkoutDto, moved: { corosSyncState: string; watchDrain?: boolean }, refused?: { path: "move" | "skip"; status: number; body: unknown }): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      if (refused && url === `/api/plan/workouts/${w.id}/${refused.path}`) return new Response(JSON.stringify(refused.body), { status: refused.status, headers: { "Content-Type": "application/json" } });
      if (url === `/api/plan/workouts/${w.id}/candidates`) return json({ candidates: [{ date: TODAY, time: "18:00", window: "evening", explanation: "Open evening.", warnings: [], daysMoved: 2 }], skipOption: { explanation: "Skip it." }, busyChecked: true });
      if (url === `/api/plan/workouts/${w.id}/move`) return json({ workoutId: w.id, ...moved });
      if (url === "/api/sync/status") return json({ state: "in_sync", pendingCount: 0, issueCount: 0, lastCorosReadAt: null, writesEnabled: true, registered: true });
      if (url === "/api/plan/today") return json({ today: TODAY, todaySessions: [{ workout: { ...w, effectiveDate: TODAY }, build: null }] });
      if (url === `/api/sessions/${w.id}`) return json({ workoutId: w.id, contentState: "built", locked: false, checks: {}, profiles: [] });
      if (url === `/api/sessions/${w.id}/build`) return json({ workoutId: w.id, contentState: "built", locked: false, checks: {}, profiles: [] });
      if (url === "/api/sessions/watch/drain") return json({ ran: false, pending: 0 });
      return json({});
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastQc = qc;
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MoveSheet, { workout: w, open: true, onClose: () => undefined })));
  });
  return calls;
}

const settle = async (n = 30) => {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
};
const text = () => document.body.textContent ?? "";

describe("moving a session the watch mirrors", () => {
  it("onto today: 'Updating your watch' — never 'not auto-updated' — and its day build asked for, then the drain", async () => {
    const calls = mount(row(), { corosSyncState: "calendar_only", watchDrain: true });
    await settle();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button.workout-row")][0]!.click());
    await settle();
    expect(text()).toContain("· Updating your watch");
    expect(text()).not.toContain("not auto-updated");
    expect(calls).toContain("GET /api/sessions/w1");
    expect(calls).toContain("POST /api/sessions/w1/build");
    expect(calls).toContain("POST /api/sessions/watch/drain");
  });

  it("with nothing on its way: 'Your watch follows the plan'", async () => {
    mount(row(), { corosSyncState: "calendar_only" });
    await settle();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button.workout-row")][0]!.click());
    await settle();
    expect(text()).toContain("· Your watch follows the plan");
  });

  it("a run (the coach's lane) keeps its own words, and no build is asked for", async () => {
    const calls = mount(row({ origin: null, sport: "run", category: "easy" }), { corosSyncState: "calendar_only" });
    await settle();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button.workout-row")][0]!.click());
    await settle();
    expect(text()).toContain("In Calendar (watch not auto-updated)");
    expect(calls.some((c) => c.endsWith("/build"))).toBe(false);
  });
});

describe("a refusal says the server's words (the session guard, 409 `{ error, why }`)", () => {
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 200; i += 1) {
      if (check()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    throw new Error(`timed out waiting for: ${what}\n${document.body.textContent}`);
  };
  const pressed = async (text: RegExp | string) => {
    const find = () => [...document.querySelectorAll<HTMLElement>("button")].find((b) => (typeof text === "string" ? b.textContent?.includes(text) : text.test(b.textContent ?? "")));
    await until(() => !!find(), `the button ${String(text)}`);
    await act(async () => find()!.click());
  };
  const WHY = "This session was started and may still be running on another device, so it stays as it is.";

  it("a move: the words, not \"The move failed\"", async () => {
    mount(row(), { corosSyncState: "calendar_only" }, { path: "move", status: 409, body: { error: "session_under_way", why: WHY } });
    await pressed("Open evening.");
    await until(() => (document.body.textContent ?? "").includes(WHY), "the refusal's words");
    expect(document.body.textContent).not.toContain("The move failed");
  });

  it("a skip: the words, the sheet still open", async () => {
    mount(row(), { corosSyncState: "calendar_only" }, { path: "skip", status: 409, body: { error: "session_under_way", why: WHY } });
    await pressed("Skip workout");
    await until(() => (document.body.textContent ?? "").includes(WHY), "the refusal's words");
    expect(document.body.textContent).not.toContain("Workout skipped");
  });

  it("after a refusal the sheet offers no other day and no skip (the session can't be changed), and the plan is read again", async () => {
    mount(row(), { corosSyncState: "calendar_only" }, { path: "move", status: 409, body: { error: "session_completed", why: "This session is done, so it stays as it is on your plan." } });
    // What the sheet that opened this one reads, held in the cache as it would be.
    for (const key of [["today"], ["plan"], ["workout", "w1"], ["session", "w1"]]) lastQc!.setQueryData(key, {});
    await pressed("Open evening.");
    await until(() => (document.body.textContent ?? "").includes("stays as it is"), "the refusal's words");
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Skip workout");
    expect(document.querySelectorAll("button.workout-row")).toHaveLength(0);
    for (const key of [["today"], ["plan"], ["workout", "w1"], ["session", "w1"]]) expect(lastQc!.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
  });

  it("anything else: what it always said", async () => {
    mount(row(), { corosSyncState: "calendar_only" }, { path: "move", status: 500, body: { error: "move_failed" } });
    await pressed("Open evening.");
    await until(() => (document.body.textContent ?? "").includes("The move failed"), "the old words");
  });
});
