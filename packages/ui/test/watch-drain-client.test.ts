/**
 * THE APP DRAINS THE WATCH ONE JOB A REQUEST (ruling 3-R11; the watch mirrors the plan §3.7, A5). `POST
 * /api/sessions/watch/drain` runs one watch job — a push, a delete, or the mirror's one record — and answers what is
 * left (`{ran, pending}`); `drainWatchUntilIdle` asks again while something is left, at most six requests, and stops
 * at the first that ran nothing, failed, or re-queued its job after a COROS blip (`retried`). A move or remove of an app-built session answers `watchDrain`, and the client
 * runs that chain; without the flag no drain is sent. Chains never overlap: a second waits for the first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, drainWatchUntilIdle } from "@rg/api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

const DRAIN = "/api/sessions/watch/drain";
type Answer = Record<string, unknown> | number;

/** The worker: each drain answers the next of `drains` (a number is an HTTP error status); anything else `answer`. */
function stubWorker(answer: Record<string, unknown>, drains: Answer[] = [{ ran: true, pending: 0 }]): string[] {
  const calls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === DRAIN) {
        const next = drains[Math.min(i++, drains.length - 1)]!;
        if (typeof next === "number") return new Response(JSON.stringify({ error: "x" }), { status: next });
        return new Response(JSON.stringify(next));
      }
      return new Response(JSON.stringify(answer));
    }),
  );
  return calls;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const drainsIn = (calls: string[]) => calls.filter((c) => c === DRAIN).length;

describe("drainWatchUntilIdle — the client chains drains, one job a request", () => {
  it("asks again while jobs are left, and stops once none is (pending 0)", async () => {
    const calls = stubWorker({}, [{ ran: true, pending: 2 }, { ran: true, pending: 1 }, { ran: true, pending: 0 }, { ran: true, pending: 9 }]);
    expect(await drainWatchUntilIdle()).toEqual({ ran: 3, pending: 0 });
    expect(drainsIn(calls)).toBe(3);
  });

  it("at most six requests a chain, whatever is left", async () => {
    const calls = stubWorker({}, [{ ran: true, pending: 5 }]);
    expect(await drainWatchUntilIdle()).toEqual({ ran: 6, pending: 5 });
    expect(drainsIn(calls)).toBe(6);
  });

  it("at most `max` when asked for fewer", async () => {
    const calls = stubWorker({}, [{ ran: true, pending: 5 }]);
    expect(await drainWatchUntilIdle(2)).toEqual({ ran: 2, pending: 5 });
    expect(drainsIn(calls)).toBe(2);
  });

  it("stops at the first error, resolving with what ran (never rejects)", async () => {
    const calls = stubWorker({}, [{ ran: true, pending: 3 }, 500, { ran: true, pending: 0 }]);
    expect(await drainWatchUntilIdle()).toEqual({ ran: 1, pending: 3 });
    expect(drainsIn(calls)).toBe(2);
  });

  it("the switch off (404 on the first request): one request, nothing ran", async () => {
    const calls = stubWorker({}, [404]);
    expect(await drainWatchUntilIdle()).toEqual({ ran: 0, pending: 0 });
    expect(drainsIn(calls)).toBe(1);
  });

  it("stops when a request ran nothing though jobs are left (another invocation holds them, or none can run now)", async () => {
    const calls = stubWorker({}, [{ ran: false, pending: 2 }, { ran: true, pending: 0 }]);
    expect(await drainWatchUntilIdle()).toEqual({ ran: 0, pending: 2 });
    expect(drainsIn(calls)).toBe(1);
  });

  it("stops when the job it ran was re-queued after a COROS blip (retried): the executor's tries are not burned in seconds", async () => {
    const calls = stubWorker({}, [{ ran: true, pending: 2, retried: true }, { ran: true, pending: 1 }, { ran: true, pending: 0 }]);
    expect(await drainWatchUntilIdle()).toEqual({ ran: 1, pending: 2 });
    expect(drainsIn(calls)).toBe(1);
  });

  it("two chains never overlap: the second starts when the first has finished", async () => {
    let inFlight = 0;
    let most = 0;
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        n += 1;
        return new Response(JSON.stringify({ ran: true, pending: n % 2 === 1 ? 1 : 0 }));
      }),
    );
    const [a, b] = await Promise.all([drainWatchUntilIdle(), drainWatchUntilIdle()]);
    expect(most).toBe(1);
    expect(a).toEqual({ ran: 2, pending: 0 });
    expect(b).toEqual({ ran: 2, pending: 0 });
  });
});

describe("the client drains an app-built session's watch jobs after a move or remove", () => {
  it("move answering watchDrain → the chain, until nothing is left", async () => {
    const calls = stubWorker({ workoutId: "w1", corosSyncState: "calendar_only", watchDrain: true }, [
      { ran: true, pending: 2 },
      { ran: true, pending: 1 },
      { ran: true, pending: 0 },
    ]);
    await api.move("w1", "2026-10-10", "18:00");
    for (let i = 0; i < 5; i++) await settle();
    expect(calls).toEqual(["/api/plan/workouts/w1/move", DRAIN, DRAIN, DRAIN]);
  });

  it("remove answering watchDrain → one drain request when one job is all there is", async () => {
    const calls = stubWorker({ ok: true, watchDrain: true });
    await api.removeWorkout("w1");
    await settle();
    expect(calls).toEqual(["/api/plan/workouts/w1/remove", DRAIN]);
  });

  it("no watchDrain → no drain request", async () => {
    const calls = stubWorker({ workoutId: "w1", corosSyncState: "synced" });
    await api.move("w1", "2026-10-10", "18:00");
    await settle();
    expect(calls).toEqual(["/api/plan/workouts/w1/move"]);
  });
});

/**
 * A CHANGE TO TODAY'S SESSION GOES ON AS THE DAY'S BUILD (the watch mirrors the plan §3.3; M1): a session of today whose
 * check is answered is never sent a provisional copy, so after a change lands on one (a Studio save, a coach approve, a
 * move onto today, Put on) the client asks for its build — the sheet's own `POST …/build`, whose mirror pushes the gated
 * day build — and then runs the drain chain. Only for today's sessions, and only those the build may go on: nothing for
 * another day (the drain or the sweep makes its copy), a started session or one whose check is still unanswered.
 */
describe("watchFollows / watchFollowsChange — the build after a change to today's session", () => {
  type Seen = { method: string; path: string };
  /** The worker: each session's GET answers its `sessions` entry; build answers it; the drain runs nothing left. */
  function stub(sessions: Record<string, Record<string, unknown>>, today: { todaySessions: Array<{ workout: { id: string; origin: string } }> } = { todaySessions: [] }): Seen[] {
    const calls: Seen[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ method, path: url });
        if (url === DRAIN) return new Response(JSON.stringify({ ran: true, pending: 0 }));
        if (url === "/api/plan/today") return new Response(JSON.stringify(today));
        const id = /^\/api\/sessions\/([^/]+)(\/build)?$/.exec(url)?.[1];
        if (id && sessions[id]) return new Response(JSON.stringify(sessions[id]));
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }),
    );
    return calls;
  }
  const checked = (over: Record<string, unknown> = {}) => ({
    workoutId: "x", contentState: "built", locked: false, lockedBy: null, checks: { tmj: { pre: 2, feelingOff: false } },
    profiles: [{ profileId: "tmj", check: { label: "Jaw", min: 0, max: 10 }, care: "Jaw care" }], ...over,
  });
  const shape = (calls: Seen[]) => calls.map((c) => `${c.method} ${c.path}`);

  it("today's session, its check answered: its build asked for, then the drain chain", async () => {
    const { watchFollows } = await import("../src/components/watch-catch-up.js");
    const calls = stub({ s1: checked() });
    expect(await watchFollows(["s1"])).toEqual({ ran: 1, pending: 0 });
    expect(shape(calls)).toEqual(["GET /api/sessions/s1", "POST /api/sessions/s1/build", `POST ${DRAIN}`]);
  });

  it("no build for a session started (or done), sent-and-started, or with its check unanswered — the drain chain still runs", async () => {
    const { watchFollows } = await import("../src/components/watch-catch-up.js");
    const calls = stub({
      started: checked({ contentState: "started", lockedBy: "started" }),
      unanswered: checked({ checks: {} }),
    });
    await watchFollows(["started", "unanswered", "gone"]);
    expect(calls.filter((c) => c.path.endsWith("/build"))).toEqual([]);
    expect(shape(calls).at(-1)).toBe(`POST ${DRAIN}`);
  });

  it("a build locked only for the watch (sent, not started) is built again: the copy follows the change", async () => {
    const { watchFollows } = await import("../src/components/watch-catch-up.js");
    const calls = stub({ sent: checked({ locked: true, lockedBy: "watch" }) });
    await watchFollows(["sent"]);
    expect(shape(calls)).toContain("POST /api/sessions/sent/build");
  });

  it("watchFollowsChange: only the changed sessions on today's page (app-built) are built; another day's change is the drain's alone", async () => {
    const { watchFollowsChange } = await import("../src/components/watch-catch-up.js");
    const today = { todaySessions: [{ workout: { id: "today-1", origin: "studio" } }, { workout: { id: "run-1", origin: "coach" } }] };
    const readToday = () => api.today();
    let calls = stub({ "today-1": checked(), "run-1": checked() }, today);
    await watchFollowsChange(["today-1", "ahead-9", "run-1"], readToday);
    expect(calls.filter((c) => c.path.endsWith("/build")).map((c) => c.path)).toEqual(["/api/sessions/today-1/build"]);
    calls = stub({}, today);
    await watchFollowsChange(["ahead-9"], readToday);
    expect(shape(calls)).toEqual(["GET /api/plan/today", `POST ${DRAIN}`]);
  });

  it('watchFollowsChange("all") — the thread approve, which does not say what it touched: every app session of today', async () => {
    const { watchFollowsChange } = await import("../src/components/watch-catch-up.js");
    const today = { todaySessions: [{ workout: { id: "a", origin: "program" } }, { workout: { id: "b", origin: "template" } }] };
    const calls = stub({ a: checked(), b: checked() }, today);
    await watchFollowsChange("all", () => api.today());
    expect(calls.filter((c) => c.path.endsWith("/build")).map((c) => c.path)).toEqual(["/api/sessions/a/build", "/api/sessions/b/build"]);
  });

  it("followApproved: the approve's applied workouts and changed sessions follow; an approve that wrote nothing sends nothing", async () => {
    const { followApproved } = await import("../src/components/watch-catch-up.js");
    const today = { todaySessions: [{ workout: { id: "w-new", origin: "studio" } }, { workout: { id: "w-moved", origin: "studio" } }] };
    let calls = stub({ "w-new": checked(), "w-moved": checked() }, today);
    followApproved([{ applied: [{ workout: { id: "w-new" } }], changed: [{ workoutId: "w-moved" }] }], () => api.today());
    for (let i = 0; i < 20 && !calls.some((c) => c.path === DRAIN); i += 1) await settle();
    expect(calls.filter((c) => c.path.endsWith("/build")).map((c) => c.path)).toEqual(["/api/sessions/w-new/build", "/api/sessions/w-moved/build"]);
    calls = stub({}, today);
    followApproved([{ applied: [], changed: [] }], () => api.today());
    await settle();
    expect(calls).toEqual([]);
  });
});
