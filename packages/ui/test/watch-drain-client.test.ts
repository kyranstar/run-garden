/**
 * A move or remove of a sent programme session leaves its watch copy's take-off to a request of its own (ruling 3-R11,
 * re-review 3-B NEW-1): the route answers `watchDrain`, and the client fires the targeted drain. Without the flag no
 * drain is sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@rg/api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubWorker(answer: Record<string, unknown>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/sessions/watch/drain") return new Response(JSON.stringify({ executed: 1 }));
      return new Response(JSON.stringify(answer));
    }),
  );
  return calls;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the client drains a programme session's take-off after a move or remove", () => {
  it("move answering watchDrain → one drain request", async () => {
    const calls = stubWorker({ workoutId: "w1", corosSyncState: "calendar_only", watchDrain: true });
    await api.move("w1", "2026-10-10", "18:00");
    await settle();
    expect(calls).toEqual(["/api/plan/workouts/w1/move", "/api/sessions/watch/drain"]);
  });

  it("remove answering watchDrain → one drain request", async () => {
    const calls = stubWorker({ ok: true, watchDrain: true });
    await api.removeWorkout("w1");
    await settle();
    expect(calls).toEqual(["/api/plan/workouts/w1/remove", "/api/sessions/watch/drain"]);
  });

  it("no watchDrain → no drain request", async () => {
    const calls = stubWorker({ workoutId: "w1", corosSyncState: "synced" });
    await api.move("w1", "2026-10-10", "18:00");
    await settle();
    expect(calls).toEqual(["/api/plan/workouts/w1/move"]);
  });
});
