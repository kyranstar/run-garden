/**
 * "Make it so" never reports an applied proposal as a failure, and the coach's watch writes drain in requests of
 * their own (2026-10-10). The owner's approve applied and committed, the card said it had failed, and the second tap
 * read "already resolved elsewhere — nothing changed here".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, COACH_DRAIN_MAX } from "@rg/api-client";
import { approveProposal } from "../src/coach-approve.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Answer = Response | Error | ((n: number) => Response | Error);

/** The worker behind `fetch`: each path answers in turn from its list (the last answer repeats). */
function stubWorker(routes: Record<string, Answer[]>): string[] {
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
      const a = answers[Math.min(n, answers.length - 1)]!;
      const out = typeof a === "function" ? a(n) : a;
      if (out instanceof Error) throw out;
      return out.clone();
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const settle = () => new Promise((r) => setTimeout(r, 0));
const APPROVE = "/api/coach/proposals/p1/approve";
const READ = "/api/coach/proposals/p1";
const DRAIN = "/api/coach/drain";

describe("approveProposal: an applied proposal is never an error", () => {
  it("a plain success is applied", async () => {
    stubWorker({ [APPROVE]: [json({ ok: true })] });
    await expect(approveProposal("p1")).resolves.toEqual({ applied: true });
  });

  it("a 409 not_pending whose status is approved is applied — the first tap landed", async () => {
    stubWorker({ [APPROVE]: [json({ error: "not_pending", status: "approved" }, 409)] });
    await expect(approveProposal("p1")).resolves.toEqual({ applied: true, already: true });
  });

  it("a 409 for a proposal declined or expired elsewhere is still the card's refusal", async () => {
    const calls = stubWorker({ [APPROVE]: [json({ error: "not_pending", status: "expired" }, 409)] });
    await expect(approveProposal("p1")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual([APPROVE]); // a 409 is an answer: nothing to re-read
  });

  it("a 5xx re-reads the proposal before saying anything: approved is applied", async () => {
    const calls = stubWorker({ [APPROVE]: [json({ error: "internal" }, 500)], [READ]: [json({ id: "p1", status: "approved", resolvedAt: "x" })] });
    await expect(approveProposal("p1")).resolves.toEqual({ applied: true, already: true });
    expect(calls).toEqual([APPROVE, READ]);
  });

  it("a dropped connection re-reads too", async () => {
    stubWorker({ [APPROVE]: [new TypeError("Failed to fetch")], [READ]: [json({ id: "p1", status: "approved", resolvedAt: "x" })] });
    await expect(approveProposal("p1")).resolves.toEqual({ applied: true, already: true });
  });

  it("a 5xx whose re-read says still pending — or cannot be read — keeps the error", async () => {
    stubWorker({ [APPROVE]: [json({ error: "internal" }, 502)], [READ]: [json({ id: "p1", status: "pending", resolvedAt: null })] });
    await expect(approveProposal("p1")).rejects.toMatchObject({ status: 502 });
    stubWorker({ [APPROVE]: [new TypeError("Failed to fetch")], [READ]: [new TypeError("Failed to fetch")] });
    await expect(approveProposal("p1")).rejects.toBeInstanceOf(TypeError);
  });

  it("a 4xx that is not 409 is an answer, not a lost one: no re-read", async () => {
    const calls = stubWorker({ [APPROVE]: [json({ error: "not_found" }, 404)] });
    await expect(approveProposal("p1")).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([APPROVE]);
  });
});

describe("the coach's watch writes drain in requests of their own (ruling 3-R11)", () => {
  it("an approve answering coachDrain drains until a request runs nothing", async () => {
    const calls = stubWorker({ [APPROVE]: [json({ ok: true, coachDrain: true })], [DRAIN]: [json({ executed: 1 }), json({ executed: 1 }), json({ executed: 0 })] });
    await api.coachApprove("p1");
    for (let i = 0; i < 5; i++) await settle();
    expect(calls).toEqual([APPROVE, DRAIN, DRAIN, DRAIN]);
  });

  it("drains at most COACH_DRAIN_MAX requests; the hourly lane runs the rest", async () => {
    const calls = stubWorker({ [APPROVE]: [json({ ok: true, coachDrain: true })], [DRAIN]: [json({ executed: 1 })] });
    await api.coachApprove("p1");
    for (let i = 0; i < COACH_DRAIN_MAX * 3; i++) await settle();
    expect(calls.filter((c) => c === DRAIN)).toHaveLength(COACH_DRAIN_MAX);
  });

  it("an approve with nothing queued fires no drain", async () => {
    const calls = stubWorker({ [APPROVE]: [json({ ok: true })] });
    await api.coachApprove("p1");
    await settle();
    expect(calls).toEqual([APPROVE]);
  });

  it("the banner's Retry drains the rewrites it queued again, and nothing when it queued none", async () => {
    const calls = stubWorker({ "/api/sync/retry": [json({ ok: true, movesRetried: 0, studioRetried: 0, rewritesRetried: 1 })], [DRAIN]: [json({ executed: 1 }), json({ executed: 0 })] });
    await api.retrySync();
    for (let i = 0; i < 5; i++) await settle();
    expect(calls).toEqual(["/api/sync/retry", DRAIN, DRAIN]);
    const quiet = stubWorker({ "/api/sync/retry": [json({ ok: true, movesRetried: 0, studioRetried: 0, rewritesRetried: 0 })] });
    await api.retrySync();
    await settle();
    expect(quiet).toEqual(["/api/sync/retry"]);
  });
});
