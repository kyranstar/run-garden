// @vitest-environment jsdom
/**
 * THE WATCH'S EARLIER VERSION, AS THE ATHLETE MEETS IT (the owner, 2026-10-19: "It's always there and annoying and not
 * actionable or removable"). The account line opens to the sessions it counts — date · title, each opening its sheet on
 * the Plan — and the sheet says it in one sentence with what can honestly be done: "Send this version to the watch"
 * when a rewrite can reach it, else why not, and "Keep the watch's version". Either counts the line down (the status is
 * read again). Synthetic data only.
 */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStatusDto, WatchVersionDto, WorkoutDto } from "@rg/api-client";
import type { SyncAction } from "@rg/domain";
import { SessionSheet } from "../src/components/session-sheet.js";
import { RunWorkoutDetail } from "../src/screens/plan.js";
import { SyncPanel } from "../src/screens/today.js";
import { PlanScreen } from "../src/screens/plan.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-19";

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

const STATUS: SyncStatusDto = {
  state: "in_sync",
  pendingCount: 0,
  issueCount: 0,
  contentStaleCount: 2,
  contentStaleSessions: [
    { workoutId: "w-tempo", date: "2026-10-21", title: "Tempo 30" },
    { workoutId: "w-long", date: "2026-10-25", title: "Long run" },
  ],
  lastCorosReadAt: null,
  writesEnabled: true,
  registered: true,
  cloud: { connected: true, lastSyncAt: "2026-10-19T10:00:00.000Z", error: null },
};

const run = (over: Partial<WorkoutDto> = {}): WorkoutDto =>
  ({
    id: "w-tempo",
    title: "Tempo 30",
    category: "quality",
    qualitySubtype: null,
    sport: "run",
    originalPlanDate: "2026-10-21",
    lastVerifiedCorosDate: "2026-10-21",
    effectiveDate: "2026-10-21",
    effectiveTime: "07:00",
    workoutSeconds: 1800,
    calendarSeconds: 1800,
    stageSummary: "30 min tempo",
    calendarSyncState: "synced",
    corosSyncState: "calendar_only",
    corosSyncView: "content_stale",
    syncAction: { agent: "nobody", code: "watch_keeps_old_copy" } satisfies SyncAction,
    completionState: "scheduled",
    archived: false,
    origin: null,
    ...over,
  }) as WorkoutDto;

interface Call {
  method: string;
  path: string;
}

/** Every read answered from `answers` (by path), every call recorded. */
function stubFetch(answers: Record<string, (method: string) => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/\?.*$/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, path });
      const answer = answers[path];
      return answer ? answer(method) : json({ error: "not_found" }, 404);
    }),
  );
  return calls;
}

function mount(el: React.ReactElement, path = "/plan") {
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: [path] }, el)));
  });
}

const settle = async (n = 20) => {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
};

const buttons = () => [...host!.querySelectorAll("button")].map((b) => b.textContent ?? "");
const button = (name: string) => [...host!.querySelectorAll("button")].find((b) => b.textContent === name)!;
const occurrences = (text: string) => (host!.textContent ?? "").split(text).length - 1;

function detailAnswers(watchVersion: WatchVersionDto | undefined, w = run()) {
  return {
    "/api/plan/workouts/w-tempo": () => json({ workout: w, stages: [], match: null, ...(watchVersion ? { watchVersion } : {}) }),
    "/api/sync/notes": () => json({ notes: [] }),
    "/api/sync/status": () => json(STATUS),
    "/api/plan/workouts/w-tempo/watch-version/send": () => json({ ok: true, coachDrain: true }),
    "/api/plan/workouts/w-tempo/watch-version/keep": () => json({ ok: true }),
    "/api/coach/drain": () => json({ executed: 0 }),
    "/api/sync/read-now": () => json({ enqueued: false, status: "fresh", lastCorosReadAt: null }),
  };
}

describe("the account line", () => {
  it("opens to the sessions it counts, date · title, each opening its sheet on the Plan", async () => {
    stubFetch({ "/api/sync/status": () => json(STATUS), "/api/sync/notes": () => json({ notes: [] }) });
    function Where() {
      const loc = useLocation();
      return createElement("output", { "data-where": `${loc.pathname}${loc.search}` });
    }
    mount(
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/", element: createElement(SyncPanel) }),
        createElement(Route, { path: "/plan", element: createElement(Where) }),
      ),
      "/",
    );
    await settle();
    const summary = host!.querySelector(".sync-stale > summary")!;
    expect(summary.textContent).toBe("Your watch has an earlier version of 2 sessions");
    expect(summary.classList.contains("tap-pad")).toBe(true);
    const links = [...host!.querySelectorAll<HTMLAnchorElement>(".sync-stale-list a.sync-stale-link")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Wed Oct 21 · Tempo 30", "/plan?workout=w-tempo"],
      ["Sun Oct 25 · Long run", "/plan?workout=w-long"],
    ]);
    await act(async () => links[0]!.click());
    expect(host!.querySelector("output")!.getAttribute("data-where")).toBe("/plan?workout=w-tempo");
  });

  it("a server that sends no list keeps the plain sentence", async () => {
    stubFetch({ "/api/sync/status": () => json({ ...STATUS, contentStaleSessions: undefined }), "/api/sync/notes": () => json({ notes: [] }) });
    mount(createElement(SyncPanel), "/");
    await settle();
    expect(host!.querySelector(".sync-stale")).toBeNull();
    expect(host!.textContent).toContain("Your watch has an earlier version of 2 sessions");
  });
});

describe("the session's sheet", () => {
  const sheetWithLine = (w = run()) =>
    createElement(
      "div",
      null,
      // The Plan's own line beside the sheet, as on the page.
      createElement(SyncPanel, { quietWhenHealthy: true }),
      createElement(RunWorkoutDetail, { w, today: TODAY, corosWritesEnabled: true, onClose: () => undefined }),
    );

  it("says it once, and offers to send this version — sent, it says so in place, the focus on it, the drain runs, the line is read again", async () => {
    const calls = stubFetch(detailAnswers({ send: true }));
    mount(sheetWithLine());
    await settle();
    expect(occurrences("Your watch has an earlier version of this session.")).toBe(1);
    expect(host!.textContent).not.toContain("no way to");
    expect(buttons()).toEqual(expect.arrayContaining(["Send this version to the watch", "Keep the watch's version"]));
    for (const name of ["Send this version to the watch", "Keep the watch's version"]) {
      expect(button(name).classList.contains("btn"), `${name} is a 44 px button`).toBe(true);
    }
    const statusReads = calls.filter((c) => c.path === "/api/sync/status").length;
    const actions = host!.querySelector(".watch-version-actions")!;

    await act(async () => button("Send this version to the watch").click());
    await settle();
    expect(calls).toContainEqual({ method: "POST", path: "/api/plan/workouts/w-tempo/watch-version/send" });
    expect(calls).toContainEqual({ method: "POST", path: "/api/coach/drain" });
    expect(calls.filter((c) => c.path === "/api/sync/status").length).toBeGreaterThan(statusReads);
    // Said where the buttons were — the same row, kept — and the focus there, never on the page.
    const doneLine = host!.querySelector('.watch-version-done[role="status"]')!;
    expect(doneLine.textContent).toBe("Sending this version to your watch.");
    expect(host!.querySelector(".watch-version-actions")).toBe(actions);
    expect(document.activeElement).toBe(doneLine);
    expect(buttons()).not.toContain("Send this version to the watch");
  });

  it("the block stays, saying what was done, when the row's view changes under it — and the sheet's own note does not say it twice", async () => {
    stubFetch(detailAnswers({ send: true }));
    let setRow: (w: WorkoutDto) => void = () => undefined;
    function Harness() {
      const [w, set] = useState(run());
      setRow = set;
      return createElement(RunWorkoutDetail, { w, today: TODAY, corosWritesEnabled: true, onClose: () => undefined });
    }
    mount(createElement(Harness));
    await settle();
    await act(async () => button("Send this version to the watch").click());
    await settle();
    const doneLine = host!.querySelector(".watch-version-done")!;
    // The Plan's next read: the rewrite is on its way.
    act(() => setRow(run({ corosSyncView: "syncing", syncAction: { agent: "app", code: "sending" } })));
    await settle(5);
    expect(host!.querySelector(".watch-version-done")).toBe(doneLine);
    expect(document.activeElement).toBe(doneLine);
    expect(host!.textContent).not.toContain("Sending this to your COROS watch");
  });

  it("when a rewrite can't reach it, says why in one line and offers to keep the watch's version — kept, the app takes it at the next sync", async () => {
    const calls = stubFetch(detailAnswers({ send: false, why: "cant_rewrite" }));
    mount(sheetWithLine());
    await settle();
    const statusReads = calls.filter((c) => c.path === "/api/sync/status").length;
    expect(host!.querySelector(".watch-version-says")!.textContent).toBe(
      "Your watch has an earlier version of this session. Run Garden can't rewrite this one on your watch.",
    );
    expect(buttons()).not.toContain("Send this version to the watch");
    await act(async () => button("Keep the watch's version").click());
    await settle();
    expect(calls).toContainEqual({ method: "POST", path: "/api/plan/workouts/w-tempo/watch-version/keep" });
    // The read that brings it in, asked for at once.
    expect(calls).toContainEqual({ method: "POST", path: "/api/sync/read-now" });
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/send"))).toEqual([]);
    expect(calls.filter((c) => c.path === "/api/sync/status").length, "the line counts down").toBeGreaterThan(statusReads);
    expect(host!.querySelector(".watch-version-done")!.textContent).toBe("Run Garden will take the watch's version at the next sync.");
  });

  it("says plainly when a press didn't go through — and what to do, when retrying can't help", async () => {
    stubFetch({
      ...detailAnswers({ send: true }),
      "/api/plan/workouts/w-tempo/watch-version/send": () => json({ error: "cant_rewrite" }, 409),
    });
    mount(createElement(RunWorkoutDetail, { w: run(), today: TODAY, corosWritesEnabled: true, onClose: () => undefined }));
    await settle();
    await act(async () => button("Send this version to the watch").click());
    await settle();
    expect(host!.querySelector('.watch-version-error[role="alert"]')!.textContent).toBe("Run Garden can't rewrite this one on your watch.");
    act(() => root?.unmount());
    host?.remove();

    for (const [code, words] of [
      ["writes_off", "Turn on COROS updates in Settings, then send it from here."],
      ["not_connected", "Reconnect COROS in Settings, then send it from here."],
    ] as const) {
      stubFetch({ ...detailAnswers({ send: true }), "/api/plan/workouts/w-tempo/watch-version/send": () => json({ error: code }, 409) });
      mount(createElement(RunWorkoutDetail, { w: run(), today: TODAY, corosWritesEnabled: true, onClose: () => undefined }));
      await settle();
      await act(async () => button("Send this version to the watch").click());
      await settle();
      expect(host!.querySelector('.watch-version-error[role="alert"]')!.textContent, code).toBe(words);
      act(() => root?.unmount());
      host?.remove();
    }
    root = null;
  });

  it("with COROS updates off or COROS not connected, it says what to do first — then send it from here — and nothing says it goes across on its own", async () => {
    for (const [why, code, words] of [
      ["writes_off", "enable_coros_writes", "Turn on COROS updates in Settings, then send it from here."],
      ["not_connected", "connect_coros", "Reconnect COROS in Settings, then send it from here."],
    ] as const) {
      stubFetch(detailAnswers({ send: false, why }));
      const w = run({ syncAction: { agent: "athlete", code, control: "settings" } });
      mount(createElement(RunWorkoutDetail, { w, today: TODAY, corosWritesEnabled: why !== "writes_off", onClose: () => undefined }));
      await settle();
      const says = host!.querySelector(".watch-version-says")!;
      expect(says.textContent).toBe(`Your watch has an earlier version of this session. ${words} Open Settings`);
      expect(says.querySelector('a[href="/settings"]')).not.toBeNull();
      expect(host!.textContent).not.toContain("on its own");
      expect(occurrences("in Settings")).toBe(1);
      expect(buttons()).toContain("Keep the watch's version");
      expect(buttons()).not.toContain("Send this version to the watch");
      act(() => root?.unmount());
      host?.remove();
    }
    root = null;
  });

  it("says nothing of it on a session the watch holds as it is", async () => {
    stubFetch(detailAnswers(undefined));
    mount(createElement(RunWorkoutDetail, { w: run({ corosSyncView: "synced", syncAction: undefined }), today: TODAY, corosWritesEnabled: true, onClose: () => undefined }));
    await settle();
    expect(host!.querySelector(".watch-version")).toBeNull();
    expect(buttons()).not.toContain("Keep the watch's version");
  });

  it("while the app takes the watch's version, the row says so — neither Synced nor Older on watch", async () => {
    stubFetch(detailAnswers(undefined));
    const w = run({ corosSyncView: "taking_watch_copy", syncAction: { agent: "app", code: "taking_watch_copy" } });
    mount(createElement(RunWorkoutDetail, { w, today: TODAY, corosWritesEnabled: true, onClose: () => undefined }));
    await settle();
    expect(host!.querySelector(".pill")!.textContent).toBe("Taking watch's version");
    expect(host!.textContent).toContain("Run Garden will take the watch's version at the next sync.");
    expect(host!.textContent).not.toContain("Older on watch");
    expect(host!.textContent).not.toContain("Synced");
    expect(host!.querySelector(".watch-version")).toBeNull();
  });

  it("an app-built session's sheet says it and offers to leave the watch as it is — no keep it can't make true, no read of its own", async () => {
    const calls = stubFetch({
      "/api/sync/notes": () => json({ notes: [] }),
      "/api/plan/workouts/slot-1/watch-version/leave": () => json({ ok: true }),
    });
    const slot = run({ id: "slot-1", title: "Strength A", category: "strength", sport: "strength", origin: "program", contentState: "outline", programId: "p1" });
    mount(createElement(SessionSheet, { w: slot, today: TODAY, onClose: () => undefined }));
    await act(async () => undefined);
    expect(host!.querySelector(".watch-version-says")!.textContent).toBe(
      "Your watch has an earlier version of this session. Run Garden can't replace the copy already on your watch.",
    );
    expect(buttons()).toContain("Leave the watch as it is");
    expect(buttons()).not.toContain("Keep the watch's version");
    expect(buttons()).not.toContain("Send this version to the watch");
    expect(calls.filter((c) => c.path.startsWith("/api/plan/workouts/"))).toEqual([]);
    await act(async () => button("Leave the watch as it is").click());
    await settle(5);
    expect(calls).toContainEqual({ method: "POST", path: "/api/plan/workouts/slot-1/watch-version/leave" });
    expect(host!.querySelector(".watch-version-done")!.textContent).toBe("Left as it is. It isn't counted any more.");
  });

  it("a sheet older than the session, refused leaving it as it is, says why in words", async () => {
    stubFetch({
      "/api/sync/notes": () => json({ notes: [] }),
      "/api/plan/workouts/slot-4/watch-version/leave": () => json({ error: "not_app_built" }, 409),
    });
    const slot = run({ id: "slot-4", title: "Strength D", category: "strength", sport: "strength", origin: "program", contentState: "outline", programId: "p1" });
    mount(createElement(SessionSheet, { w: slot, today: TODAY, onClose: () => undefined }));
    await act(async () => undefined);
    await act(async () => button("Leave the watch as it is").click());
    await settle(5);
    expect(host!.querySelector('.watch-version-error[role="alert"]')!.textContent).toBe(
      "This session can't be left as it is. Keep the watch's version instead.",
    );
  });

  it("an app-built session left as it is still says so, quietly, with nothing to press", async () => {
    stubFetch({ "/api/sync/notes": () => json({ notes: [] }) });
    const slot = run({ id: "slot-3", title: "Strength C", category: "strength", sport: "strength", origin: "program", contentState: "outline", programId: "p1", watchVersionLeft: true });
    mount(createElement(SessionSheet, { w: slot, today: TODAY, onClose: () => undefined }));
    await act(async () => undefined);
    expect(host!.querySelector(".watch-version-says")!.textContent).toBe("Your watch has an earlier version of this session. You've left it as it is.");
    expect(host!.querySelector(".watch-version-actions")).toBeNull();
  });

  it("an app-built session the watch holds as it is says nothing of it", async () => {
    stubFetch({ "/api/sync/notes": () => json({ notes: [] }) });
    const slot = run({ id: "slot-2", title: "Strength B", category: "strength", sport: "strength", origin: "program", contentState: "outline", programId: "p1", corosSyncView: "synced", syncAction: undefined });
    mount(createElement(SessionSheet, { w: slot, today: TODAY, onClose: () => undefined }));
    await act(async () => undefined);
    expect(host!.querySelector(".watch-version")).toBeNull();
  });
});

describe("the line, when something louder leads", () => {
  it("a write that couldn't sync leads; the sessions with an earlier version are still a tap away, on a line of their own", async () => {
    stubFetch({
      "/api/sync/status": () => json({ ...STATUS, state: "sync_issue", issueCount: 1 }),
      "/api/sync/notes": () => json({ notes: [] }),
    });
    mount(createElement(SyncPanel), "/");
    await settle();
    const rows = [...host!.querySelectorAll(".row")];
    expect(rows[0]!.textContent).toContain("1 change couldn't sync");
    expect(rows[0]!.textContent).toContain("Retry");
    expect(host!.querySelector(".sync-stale > summary")!.textContent).toBe("Your watch has an earlier version of 2 sessions");
    expect(host!.querySelectorAll(".sync-stale-list a")).toHaveLength(2);
  });
});

describe("a session the line names, beyond the Plan's own window", () => {
  it("still opens its sheet: read by its id", async () => {
    const far = run({ id: "w-far", title: "Long run, later", effectiveDate: "2027-01-20", originalPlanDate: "2027-01-20", lastVerifiedCorosDate: "2027-01-20" });
    const week = {
      weekStart: TODAY,
      days: ["19", "20", "21", "22", "23", "24", "25"].map((d) => ({ date: `2026-10-${d}`, workouts: [] })),
      plannedSeconds: 0,
      doneCount: 0,
      sessionCount: 0,
      weekIndex: null,
      weekTotal: null,
      adherence4w: { pct: null, trend: null },
      loadRatio: null,
      adventureDays: 0,
      headline: "on_track",
      focus: null,
    };
    const calls = stubFetch({
      "/api/plan/week": () => json(week),
      "/api/plan/workouts": () => json({ today: TODAY, workouts: [], plan: null, corosWritesEnabled: true }),
      "/api/plan/workouts/w-far": () => json({ workout: far, stages: [], match: null, watchVersion: { send: true } }),
      "/api/coach/plans": () => json({ plans: [] }),
      "/api/coach/state": () =>
        json({ messages: [], pendingProposals: [], settledProposals: [], openQuestion: null, memoryCount: 0, lastCoachAt: null, wakeAdvised: false }),
      "/api/plan/race": () => json({ race: null }),
      "/api/programs": () => json({ programs: [] }),
      "/api/settings": () => json({ prefs: { units: "km", timezone: "America/Los_Angeles" } }),
      "/api/sync/status": () => json({ ...STATUS, contentStaleCount: 1, contentStaleSessions: [{ workoutId: "w-far", date: "2027-01-20", title: "Long run, later" }] }),
      "/api/sync/notes": () => json({ notes: [] }),
    });
    mount(createElement(PlanScreen), "/plan?workout=w-far");
    await settle(40);
    const dialog = host!.querySelector('[role="dialog"]');
    expect(dialog, "the sheet opens").not.toBeNull();
    expect(dialog!.textContent).toContain("Long run, later");
    expect(dialog!.textContent).toContain("Your watch has an earlier version of this session.");
    expect(calls.filter((c) => c.path === "/api/plan/workouts/w-far").length).toBeGreaterThan(0);
  });
});
