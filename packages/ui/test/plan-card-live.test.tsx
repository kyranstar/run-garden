// @vitest-environment jsdom
/**
 * A WHOLE PLAN IN THE CONVERSATION (§8 §5, stream W) — the plan card, live: its title, line and lines; one Approve plan
 * and one Not now; while it goes on a part at a time it says so and keeps approving while the server says some remains;
 * done, "Added to your plan" with a link to Plan; a plan already part added offers to finish, never Not now; an older
 * closed card is one line, its lines one tap down. The server is a stubbed fetch. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationCardDto, DesignApproveResponse, DesignPlanLineDto } from "@rg/api-client";
import { toConversation, toProposal } from "../src/screens/studio/coach-tolerance.js";
import { approvePlanUntilDone, PLAN_ADDED, PLAN_ADDING, PlanCard, planOutcomeLine } from "../src/screens/studio/plan-card.js";
import { ProposalCard } from "../src/screens/studio/proposal-card.js";
import { button, click, json, serve, text, until, type Call } from "./coach-live-harness.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const LINES = ["Mon 18 May · New plan: 10K build · Mon 18 May to Sun 14 Jun — race day Sun 14 Jun", "Mon 18 May · Easy run · 40 min", "and 3 more"];
const card = (over: Partial<CoachConversationCardDto> = {}): CoachConversationCardDto => ({
  kind: "plan",
  proposalId: "dp-run-1",
  title: "10K build",
  summary: "4 weeks · 4 sessions to start · race Sun 14 Jun",
  status: "pending",
  lines: LINES,
  ...over,
});
const planLine = (outcome: DesignPlanLineDto["outcome"] = null): DesignPlanLineDto => ({
  opId: "plan",
  kind: "createPlan",
  title: "10K build",
  summary: "4 weeks · 4 sessions to start · race Sun 14 Jun",
  lines: LINES,
  why: "Four weeks that build.",
  issues: [{ code: "hard_adjacency", message: "Two hard days in a row on Tue and Wed." }],
  outcome,
});
const read = (status: string, outcome: DesignPlanLineDto["outcome"] = null) => ({ id: "dp-run-1", status, resolvedAt: null, lines: [], changes: [], plans: [planLine(outcome)] });
const answer = (over: Partial<DesignApproveResponse> = {}): DesignApproveResponse => ({ ok: true, status: "pending", applied: [], changed: [], refused: [], settled: [], remaining: [], ...over });

/** The harness's server, with answers that may wait (a Promise of a Response or a value). */
function serveAsync(routes: Record<string, (body: any) => unknown>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const [path, query = ""] = String(input).split("?") as [string, string?];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, query, body });
      const route = routes[`${method} ${path}`];
      if (!route) return json({ error: "offline" }, 503);
      const out = await route(body);
      return out instanceof Response ? out : json(out);
    }),
  );
  return calls;
}

async function mount(c: CoachConversationCardDto, closed = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = primedClient();
  await act(async () => {
    root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, createElement(PlanCard, { card: c, closed }))));
  });
}

describe("the plan card", () => {
  it("shows the plan's title, line, lines and the plan checks' notes; Approve plan asks again while some remains, says it is adding, then Added to your plan with a link to Plan", async () => {
    let state = read("pending");
    let rounds = 0;
    let release: (() => void) | null = null;
    const calls = serveAsync({
      "GET /api/coach/proposals/dp-run-1": () => state,
      "POST /api/coach/proposals/dp-run-1/approve": () => {
        rounds += 1;
        if (rounds < 3) return answer({ remaining: ["plan"] });
        return new Promise<Response>((r) => {
          release = () => {
            state = read("approved", { status: "applied", at: "x", summary: "Added “10K build” with 4 sessions" });
            r(json(answer({ status: "approved", planned: [{ opId: "plan", summary: "Added “10K build” with 4 sessions" }] })));
          };
        });
      },
    });
    await mount(card());
    await until(() => !!button("Approve plan") && !button("Approve plan")!.disabled, "Approve plan, enabled once read");
    expect(document.querySelector("h3")?.textContent).toBe("10K build");
    expect(text()).toContain("4 weeks · 4 sessions to start · race Sun 14 Jun");
    expect([...document.querySelectorAll(".coach-plan-lines li")].map((l) => l.textContent)).toEqual(LINES);
    expect(text()).toContain("Two hard days in a row on Tue and Wed.");
    expect(button("Not now")).not.toBeNull();
    await click(button("Approve plan"), "Approve plan");
    await until(() => text().includes(PLAN_ADDING), "the adding line");
    expect(button("Approve plan")?.disabled ?? true).toBe(true);
    await until(() => release !== null, "the third round");
    await act(async () => release!());
    await until(() => text().includes(`✓ ${PLAN_ADDED}`), "added");
    const approves = calls.filter((c) => c.method === "POST");
    // Its own op only, every round: never the suggestion's other cards' workouts or changes (review-1 I1).
    expect(approves.map((c) => c.body)).toEqual([{ opIds: ["plan"] }, { opIds: ["plan"] }, { opIds: ["plan"] }]);
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent === "See it on Plan");
    expect(link?.getAttribute("href")).toBe("/plan");
    expect(button("Approve plan")).toBeNull();
    expect(button("Not now")).toBeNull();
    // The plan checks' notes are for deciding: gone once decided.
    expect(text()).not.toContain("Two hard days in a row");
  });

  it("Not now declines the suggestion; the card says it wasn't added", async () => {
    let state = read("pending");
    const calls = serve({
      "GET /api/coach/proposals/dp-run-1": () => state,
      "POST /api/coach/proposals/dp-run-1/decline": () => {
        state = read("declined", { status: "declined", at: "x" });
        return { ok: true, status: "declined", declined: ["plan"], settled: [] };
      },
    });
    await mount(card());
    await until(() => !!button("Not now") && !button("Not now")!.disabled, "Not now");
    await click(button("Not now"), "Not now");
    await until(() => text().includes("Not added"), "not added");
    // Its own op only: a workout beside it in the suggestion stays the athlete's to decide (review-1 I1).
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/coach/proposals/dp-run-1/decline", { opIds: ["plan"] }]]);
  });

  it("a plan already part added says so and offers to finish — never Not now", async () => {
    serve({ "GET /api/coach/proposals/dp-run-1": () => read("pending", { status: "applying", at: "x", progress: { step: "sessions", done: 3 } }) });
    await mount(card());
    await until(() => !!button("Finish adding"), "Finish adding");
    expect(text()).toContain("Part of it is on your plan already.");
    expect(button("Not now")).toBeNull();
    expect(button("Approve plan")).toBeNull();
  });

  it("an older turn's closed card is one line of what came of it, its lines one tap down", async () => {
    serve({ "GET /api/coach/proposals/dp-run-1": () => read("approved", { status: "applied", at: "x", summary: "Added" }) });
    await mount(card({ status: "approved" }), true);
    await until(() => text().includes(`10K build · 4 weeks · 4 sessions to start · race Sun 14 Jun — ${PLAN_ADDED}`), "the closed line");
    const list = document.querySelector<HTMLElement>(".coach-plan-lines")!;
    expect(list.hidden).toBe(true);
    await click(button("Show"), "Show");
    expect(list.hidden).toBe(false);
    expect(button("Hide")?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("a suggestion holding a plan and a workout", () => {
  it("the workout's card approves its own workout, never `{}` — the plan beside it is its own card's to decide (review-1 I1)", async () => {
    const workout = {
      opId: "wk-1", kind: "new", date: "2026-10-15", time: "18:00", title: "Hips, gently", minutes: 24, summary: "Hips, gently · 24 min", effort: "Develop",
      place: "Home", parts: ["Main"], detail: ["Glute bridge 2 × 12"], reviewMean: 4.5, review: null, issues: [], outcome: null, written: null,
    };
    const calls = serveAsync({
      "GET /api/coach/proposals/dp-run-1": () => ({ id: "dp-run-1", status: "pending", resolvedAt: null, lines: [workout], changes: [], plans: [planLine()] }),
      "POST /api/coach/proposals/dp-run-1/approve": () => answer({ status: "partially_approved" }),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const client = primedClient();
    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, createElement(ProposalCard, { proposalId: "dp-run-1", today: "2026-10-15" }))));
    });
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    await click(button("Approve"), "Approve");
    await until(() => calls.some((c) => c.method === "POST"), "the approve");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ opIds: ["wk-1"] }]);
  });
});

describe("read tolerantly", () => {
  it("a plan card keeps its lines (texts only); a suggestion's read keeps its plans, each outcome by its status", () => {
    const conv = toConversation({ id: "c", startedAt: "x", turns: [{ runId: "r", at: "x", words: "w", status: "finished", line: "l", question: null,
      cards: [{ kind: "plan", proposalId: "dp-r", title: "10K build", summary: "s", status: "pending", lines: ["one", 2, "two"] }] }] });
    expect(conv.turns[0]!.cards[0]).toEqual({ kind: "plan", proposalId: "dp-r", title: "10K build", summary: "s", status: "pending", lines: ["one", "two"] });
    const p = toProposal({ id: "dp-r", status: "pending", resolvedAt: null, plans: [
      { opId: "plan", kind: "createPlan", title: "10K build", summary: "s", lines: ["a"], why: "w", issues: [{ code: "ramp", message: "m" }, { bad: 1 }],
        outcome: { status: "applying", at: "t", progress: { step: "sessions", done: 3, extra: 1 } } },
      { title: "no id" },
    ] });
    expect(p.plans).toEqual([{ opId: "plan", kind: "createPlan", title: "10K build", summary: "s", lines: ["a"], why: "w", issues: [{ code: "ramp", message: "m" }],
      outcome: { status: "applying", at: "t", progress: { step: "sessions", done: 3 } } }]);
    expect(toProposal({ id: "x", status: "pending", resolvedAt: null }).plans).toBeUndefined();
  });
});

describe("approvePlanUntilDone", () => {
  it("asks again with what remains, a changed proposal read again, one in flight answered as such; past its rounds, unfinished", async () => {
    const bodies: unknown[] = [];
    const seq = [answer({ remaining: ["plan"] }), "changed", answer({ status: "approved" })];
    const approve = async (b: unknown) => {
      bodies.push(b);
      const next = seq.shift();
      if (next === "changed") throw Object.assign(new (await import("@rg/api-client")).ApiError(409, { error: "proposal_changed" }), {});
      return next as DesignApproveResponse;
    };
    const reread = vi.fn(async () => undefined);
    const answers = await approvePlanUntilDone(approve as never, reread, ["plan"]);
    expect(answers.map((a) => a.status)).toEqual(["pending", "approved"]);
    expect(bodies).toEqual([{ opIds: ["plan"] }, { opIds: ["plan"] }, { opIds: ["plan"] }]);
    expect(reread).toHaveBeenCalledTimes(1);
    const { ApiError } = await import("@rg/api-client");
    const flying = await approvePlanUntilDone(async () => {
      throw new ApiError(409, { error: "in_flight", opIds: ["plan"], status: "pending" });
    }, reread, ["plan"]);
    expect(flying).toEqual([answer({ inFlight: ["plan"] })]);
    await expect(approvePlanUntilDone(async () => answer({ remaining: ["plan"] }), reread, ["plan"], 3)).rejects.toThrow("approve_unfinished");
  });

  it("what came of a plan, in one line", () => {
    expect(planOutcomeLine("pending", planLine())).toBeNull();
    expect(planOutcomeLine("pending", planLine({ status: "applying", at: "x", progress: null }))).toBeNull();
    expect(planOutcomeLine("approved", planLine({ status: "applied", at: "x", summary: "Added" }))).toBe(PLAN_ADDED);
    expect(planOutcomeLine("pending", planLine({ status: "refused", at: "x", error: "plan_refused", why: "That plan isn't there any more, so it wasn't extended." }))).toBe("That plan isn't there any more, so it wasn't extended.");
    expect(planOutcomeLine("declined", planLine({ status: "declined", at: "x" }))).toBe("Not added");
    expect(planOutcomeLine("superseded", planLine())).toBe("Replaced by a newer plan");
    expect(planOutcomeLine("expired", planLine())).toBe("Its day passed");
  });
});
