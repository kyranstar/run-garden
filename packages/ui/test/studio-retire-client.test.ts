/**
 * Retiring the old generator's plan, from the client (Stage 2 Task 9, fix round 2): its removals are queued, not run,
 * so the client drains them a request at a time and they reach the watch soon; a refusal reads in plain words in the
 * confirmation; an Undo that reaches a retired plan's session says the plan is retired.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, STUDIO_DRAIN_MAX } from "@rg/api-client";
import { retireRefusalText } from "../src/screens/plan.js";
import { undoRefusalText } from "../src/screens/today.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const RETIRE = "/api/studio/plans/sp1/retire";
const DRAIN = "/api/sync/drain-writes";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The worker behind `fetch`: each path answers in turn (the last answer repeats). */
function stubWorker(routes: Record<string, Response[]>): Array<{ url: string; body: unknown }> {
  const calls: Array<{ url: string; body: unknown }> = [];
  const seen = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const answers = routes[url] ?? [json({ error: "not_found" }, 404)];
      const n = seen.get(url) ?? 0;
      seen.set(url, n + 1);
      return answers[Math.min(n, answers.length - 1)]!.clone();
    }),
  );
  return calls;
}

describe("studioPlanRetire drains what it queued", () => {
  it("one job a request, until a request runs nothing", async () => {
    const calls = stubWorker({ [RETIRE]: [json({ ok: true, summary: { deletes: 3 } })], [DRAIN]: [json({ ok: true, executed: 1 }), json({ ok: true, executed: 1 }), json({ ok: true, executed: 0 })] });
    await api.studioPlanRetire("sp1");
    for (let i = 0; i < 10; i++) await settle();
    const drains = calls.filter((c) => c.url === DRAIN);
    expect(drains).toHaveLength(3);
    expect(drains.every((c) => (c.body as { cap: number }).cap === 1)).toBe(true);
  });

  it("at most STUDIO_DRAIN_MAX requests; the hourly lane runs the rest", async () => {
    const calls = stubWorker({ [RETIRE]: [json({ ok: true, summary: { deletes: 40 } })], [DRAIN]: [json({ ok: true, executed: 1 })] });
    await api.studioPlanRetire("sp1");
    for (let i = 0; i < 30; i++) await settle();
    expect(calls.filter((c) => c.url === DRAIN)).toHaveLength(STUDIO_DRAIN_MAX);
  });

  it("nothing queued (retired here, nothing on the watch), nothing drained; a refusal drains nothing either", async () => {
    let calls = stubWorker({ [RETIRE]: [json({ ok: true, summary: { deletes: 0 } })] });
    await api.studioPlanRetire("sp1");
    for (let i = 0; i < 5; i++) await settle();
    expect(calls.map((c) => c.url)).toEqual([RETIRE]);
    calls = stubWorker({ [RETIRE]: [json({ error: "writes_disabled" }, 412)] });
    await expect(api.studioPlanRetire("sp1")).rejects.toBeInstanceOf(ApiError);
    for (let i = 0; i < 5; i++) await settle();
    expect(calls.map((c) => c.url)).toEqual([RETIRE]);
  });
});

describe("why a Retire did not happen", () => {
  const refused = (status: number, error: string) => new ApiError(status, { error });
  it("names the Settings switch when writing to COROS is off", () => {
    expect(retireRefusalText(refused(412, "writes_disabled"))).toBe(
      "Writing to COROS is switched off. Turn on “Keep my watch in sync with the plan” in Settings, then retire it.",
    );
  });
  it("says what else stood in the way, plainly", () => {
    expect(retireRefusalText(refused(409, "plan_completed"))).toBe("This plan is already over.");
    expect(retireRefusalText(refused(409, "already_retired"))).toBe("This plan is already retired.");
    expect(retireRefusalText(refused(409, "not_current"))).toBe("A newer plan has replaced this one.");
    expect(retireRefusalText(refused(404, "not_found"))).toBe("That plan is gone.");
    expect(retireRefusalText(refused(500, "push_failed"))).toBe("Couldn't retire it. Try again.");
    expect(retireRefusalText(new TypeError("Failed to fetch"))).toBe("Retiring needs a connection.");
  });
});

describe("why an Undo did not happen", () => {
  it("a retired plan's session: the plan is retired — never the generic line", () => {
    expect(undoRefusalText(new ApiError(409, { error: "plan_retired" }))).toBe("That plan is retired.");
    expect(undoRefusalText(new ApiError(409, { error: "undo_unsupported_rename" }))).toBe("Renamed on COROS — delete it there to re-push.");
    expect(undoRefusalText(new ApiError(500, {}))).toBe("Couldn't undo — try again.");
  });
});
