/**
 * A WHOLE PLAN, A REQUEST AT A TIME (§8 §4): a thread proposal that shapes a plan, and the Plan's Retire, answer
 * `remaining` until done, and the client asks again — bounded — draining the coach's watch writes once, at the end.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, STRUCTURAL_ROUNDS_MAX } from "@rg/api-client";
import { approveProposal } from "../src/coach-approve.js";
import { retirePlan } from "../src/screens/plan.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The worker behind `fetch`: each path answers in turn from its list (the last answer repeats). */
function stubWorker(routes: Record<string, Response[]>): string[] {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const answers = routes[url];
      if (!answers) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      const n = seen.get(url) ?? 0;
      seen.set(url, n + 1);
      return answers[Math.min(n, answers.length - 1)]!.clone();
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise((r) => setTimeout(r, 0));
const APPROVE = "/api/coach/proposals/p1/approve";
const RETIRE = "/api/coach/plans/cp1/retire";
const DRAIN = "/api/coach/drain";

describe("a structural approve asks again while the answer says `remaining`", () => {
  it("until done, then drains the watch writes once", async () => {
    const calls = stubWorker({
      [APPROVE]: [json({ ok: true, remaining: true }), json({ ok: true, remaining: true }), json({ ok: true, coachDrain: true })],
      [DRAIN]: [json({ executed: 0 })],
    });
    await expect(approveProposal("p1")).resolves.toEqual({ applied: true });
    await settle();
    expect(calls).toEqual([APPROVE, APPROVE, APPROVE, DRAIN]);
  });

  it("a part-way answer never drains: the plan is still being added", async () => {
    const calls = stubWorker({ [APPROVE]: [json({ ok: true, remaining: true, coachDrain: true }), json({ ok: true })] });
    await api.coachApprove("p1");
    await settle();
    expect(calls).toEqual([APPROVE, APPROVE]);
  });

  it("is bounded: a server that never finishes is an error after STRUCTURAL_ROUNDS_MAX requests", async () => {
    const calls = stubWorker({ [APPROVE]: [json({ ok: true, remaining: true })] });
    await expect(api.coachApprove("p1")).rejects.toThrow("approve_unfinished");
    expect(calls).toHaveLength(STRUCTURAL_ROUNDS_MAX);
  });
});

describe("the Plan's Retire asks again while the answer says `remaining`", () => {
  it("until the plan is retired", async () => {
    const calls = stubWorker({ [RETIRE]: [json({ ok: true, remaining: true }), json({ ok: true, remaining: true }), json({ ok: true })] });
    await expect(retirePlan({ id: "cp1", source: "coach" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([RETIRE, RETIRE, RETIRE]);
  });

  it("is bounded too", async () => {
    const calls = stubWorker({ [RETIRE]: [json({ ok: true, remaining: true })] });
    await expect(api.coachPlanRetire("cp1")).rejects.toThrow("retire_unfinished");
    expect(calls).toHaveLength(STRUCTURAL_ROUNDS_MAX);
  });
});
