// @vitest-environment jsdom
/**
 * THE WATCH'S EARLIER VERSION, AS THE ATHLETE MEETS IT (the owner, 2026-10-19: "It's always there and annoying and not
 * actionable or removable"). The account line opens to the sessions it counts — date · title, each opening its sheet on
 * the Plan — and the sheet says it in one sentence with what can honestly be done: "Send this version to the watch"
 * when a rewrite can reach it, else why not, and "Keep the watch's version". Either counts the line down (the status is
 * read again). Synthetic data only.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStatusDto, WatchVersionDto, WorkoutDto } from "@rg/api-client";
import type { SyncAction } from "@rg/domain";
import { SessionSheet } from "../src/components/session-sheet.js";
import { RunWorkoutDetail } from "../src/screens/plan.js";
import { SyncPanel } from "../src/screens/today.js";

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
  it("says it once, and offers to send this version — sent, the coach's drain runs it and the line is read again", async () => {
    const calls = stubFetch(detailAnswers({ send: true }));
    // The Plan's own line beside the sheet, as on the page.
    mount(
      createElement(
        "div",
        null,
        createElement(SyncPanel, { quietWhenHealthy: true }),
        createElement(RunWorkoutDetail, { w: run(), today: TODAY, corosWritesEnabled: true, onClose: () => undefined }),
      ),
    );
    await settle();
    expect(occurrences("Your watch has an earlier version of this session.")).toBe(1);
    expect(host!.textContent).not.toContain("no way to");
    expect(buttons()).toEqual(expect.arrayContaining(["Send this version to the watch", "Keep the watch's version"]));
    for (const name of ["Send this version to the watch", "Keep the watch's version"]) {
      expect(button(name).classList.contains("btn"), `${name} is a 44 px button`).toBe(true);
    }
    const statusReads = calls.filter((c) => c.path === "/api/sync/status").length;

    await act(async () => button("Send this version to the watch").click());
    await settle();
    expect(calls).toContainEqual({ method: "POST", path: "/api/plan/workouts/w-tempo/watch-version/send" });
    expect(calls).toContainEqual({ method: "POST", path: "/api/coach/drain" });
    expect(calls.filter((c) => c.path === "/api/sync/status").length).toBeGreaterThan(statusReads);
  });

  it("when a rewrite can't reach it, says why in one line and offers to keep the watch's version", async () => {
    const calls = stubFetch(detailAnswers({ send: false, why: "cant_rewrite" }));
    mount(
      createElement(
        "div",
        null,
        createElement(SyncPanel, { quietWhenHealthy: true }),
        createElement(RunWorkoutDetail, { w: run(), today: TODAY, corosWritesEnabled: true, onClose: () => undefined }),
      ),
    );
    await settle();
    const statusReads = calls.filter((c) => c.path === "/api/sync/status").length;
    expect(host!.querySelector(".watch-version-says")!.textContent).toBe(
      "Your watch has an earlier version of this session. Run Garden can't rewrite this one on your watch.",
    );
    expect(buttons()).not.toContain("Send this version to the watch");
    await act(async () => button("Keep the watch's version").click());
    await settle();
    expect(calls).toContainEqual({ method: "POST", path: "/api/plan/workouts/w-tempo/watch-version/keep" });
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/send"))).toEqual([]);
    expect(calls.filter((c) => c.path === "/api/sync/status").length, "the line counts down").toBeGreaterThan(statusReads);
  });

  it("says plainly when a press didn't go through", async () => {
    stubFetch({
      ...detailAnswers({ send: true }),
      "/api/plan/workouts/w-tempo/watch-version/send": () => json({ error: "cant_rewrite" }, 409),
    });
    mount(createElement(RunWorkoutDetail, { w: run(), today: TODAY, corosWritesEnabled: true, onClose: () => undefined }));
    await settle();
    await act(async () => button("Send this version to the watch").click());
    await settle();
    expect(host!.querySelector('.watch-version-error[role="alert"]')!.textContent).toBe("Run Garden can't rewrite this one on your watch.");
  });

  it("with COROS updates off, the sheet's own banner says what to do — the reason is not said twice", async () => {
    stubFetch(detailAnswers({ send: false, why: "writes_off" }));
    const w = run({ syncAction: { agent: "athlete", code: "enable_coros_writes", control: "settings" } });
    mount(createElement(RunWorkoutDetail, { w, today: TODAY, corosWritesEnabled: false, onClose: () => undefined }));
    await settle();
    expect(occurrences("COROS updates are off")).toBe(1);
    expect(host!.querySelector(".watch-version-says")!.textContent).toBe("Your watch has an earlier version of this session.");
    expect(buttons()).toContain("Keep the watch's version");
    expect(buttons()).not.toContain("Send this version to the watch");
  });

  it("says nothing of it on a session the watch holds as it is", async () => {
    stubFetch(detailAnswers(undefined));
    mount(createElement(RunWorkoutDetail, { w: run({ corosSyncView: "synced", syncAction: undefined }), today: TODAY, corosWritesEnabled: true, onClose: () => undefined }));
    await settle();
    expect(host!.querySelector(".watch-version")).toBeNull();
    expect(buttons()).not.toContain("Keep the watch's version");
  });

  it("an app-built session's sheet says it and offers to keep the watch's version — with no read of its own", async () => {
    const calls = stubFetch({ "/api/sync/notes": () => json({ notes: [] }) });
    const slot = run({ id: "slot-1", title: "Strength A", category: "strength", sport: "strength", origin: "program", contentState: "outline", programId: "p1" });
    mount(createElement(SessionSheet, { w: slot, today: TODAY, onClose: () => undefined }));
    await act(async () => undefined);
    expect(host!.querySelector(".watch-version-says")!.textContent).toBe(
      "Your watch has an earlier version of this session. Run Garden can't rewrite this one on your watch.",
    );
    expect(buttons()).toContain("Keep the watch's version");
    expect(buttons()).not.toContain("Send this version to the watch");
    expect(calls.filter((c) => c.path.startsWith("/api/plan/workouts/"))).toEqual([]);
  });

  it("an app-built session the watch holds as it is says nothing of it", async () => {
    stubFetch({ "/api/sync/notes": () => json({ notes: [] }) });
    const slot = run({ id: "slot-2", title: "Strength B", category: "strength", sport: "strength", origin: "program", contentState: "outline", programId: "p1", corosSyncView: "synced", syncAction: undefined });
    mount(createElement(SessionSheet, { w: slot, today: TODAY, onClose: () => undefined }));
    await act(async () => undefined);
    expect(host!.querySelector(".watch-version")).toBeNull();
  });
});
