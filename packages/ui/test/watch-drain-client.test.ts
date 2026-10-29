/**
 * THE APP DRAINS THE WATCH ONE JOB A REQUEST (ruling 3-R11; the watch mirrors the plan §3.7, A5). `POST
 * /api/sessions/watch/drain` runs one watch job — a push, a delete, or the mirror's one record — and answers what is
 * left (`{ran, pending}`); `drainWatchUntilIdle` asks again while something is left, at most six requests, and stops
 * at the first that ran nothing or failed. A move or remove of an app-built session answers `watchDrain`, and the client
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
