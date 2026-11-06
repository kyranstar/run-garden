// @vitest-environment jsdom
/**
 * A CHANGE TO A PLAN'S PURPOSE, BRIEF, ENDING OR PAUSE IN THE CONVERSATION (plans with a purpose, Stage 1) — the plan
 * card's shape for the coach's `change_plan`: the plan's name and what changes as its title, its ending in one line, a
 * line a changed field; one Approve and one Not now, each its own op only; done at once, "Plan updated"; refused (the
 * athlete edited the plan since, or a pause that has gone by), the server's words. A suggestion may hold a plan change
 * beside a whole plan: this card reads its own line, by its op. The server is a stubbed fetch. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationCardDto, DesignApproveResponse, DesignPlanChangeLineDto } from "@rg/api-client";
import { toConversation, toProposal } from "../src/screens/studio/coach-tolerance.js";
import { PlanCard } from "../src/screens/studio/plan-card.js";
import { cardOpIds, foldPlanChanges, landedButWords, mergedPlanChanges, ownPlanChange, PLAN_CHANGE_WORDS } from "../src/screens/studio/plan-change-card.js";
import { button, click, serve, text, until } from "./coach-live-harness.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const OP = "pc-plan-1";
const LINES = ["Purpose: Run a first 10K", "When it ends: Ask me → Continue"];
const SUMMARY = "Ending: Continue";
const card = (over: Partial<CoachConversationCardDto> = {}): CoachConversationCardDto => ({
  kind: "plan_change",
  proposalId: "dp-run-3",
  title: "Base block: new purpose and ending",
  summary: SUMMARY,
  status: "pending",
  lines: LINES,
  opId: OP,
  ...over,
});
const line = (outcome: DesignPlanChangeLineDto["outcome"] = null, over: Partial<DesignPlanChangeLineDto> = {}): DesignPlanChangeLineDto => ({
  opId: OP,
  planId: "plan-1",
  title: "Base block: new purpose and ending",
  summary: SUMMARY,
  lines: LINES,
  why: "It is what you told me you want.",
  issues: [],
  outcome,
  ...over,
});
const read = (status: string, outcome: DesignPlanChangeLineDto["outcome"] = null, more: DesignPlanChangeLineDto[] = []) => ({
  id: "dp-run-3",
  status,
  resolvedAt: null,
  lines: [],
  changes: [],
  planChanges: [...more, line(outcome)],
});
const answer = (over: Partial<DesignApproveResponse> = {}): DesignApproveResponse => ({ ok: true, status: "pending", applied: [], changed: [], refused: [], settled: [], remaining: [], ...over });

async function mount(c: CoachConversationCardDto, closed = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  client = primedClient();
  await act(async () => {
    root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client: client! }, createElement(PlanCard, { card: c, closed }))));
  });
}

describe("the plan change card", () => {
  it("shows the plan's name and what changes, its ending and a line a field; Approve decides its own op only, then Plan updated", async () => {
    // Another plan's change in the same suggestion: this card reads its own line, by its op.
    const other = line(null, { opId: "pc-plan-9", planId: "plan-9", title: "Strength: new brief", lines: ["Brief: Two lifts a week."] });
    let state = read("pending", null, [other]);
    const calls = serve({
      "GET /api/coach/proposals/dp-run-3": () => state,
      "POST /api/coach/proposals/dp-run-3/approve": () => {
        state = read("partially_approved", { status: "applied", at: "x", changed: ["purpose", "onEnd"] }, [other]);
        return answer({ status: "partially_approved", planned: [{ opId: OP, summary: SUMMARY }] });
      },
    });
    await mount(card());
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve, enabled once read");
    expect(document.querySelector("h3")?.textContent).toBe("Base block: new purpose and ending");
    expect(text()).toContain(SUMMARY);
    expect([...document.querySelectorAll(".coach-plan-lines li")].map((l) => l.textContent)).toEqual(LINES);
    expect(text()).not.toContain("Strength: new brief");
    expect(button("Not now")).not.toBeNull();
    await click(button("Approve"), "Approve");
    await until(() => text().includes(`✓ ${PLAN_CHANGE_WORDS.done}`), "updated");
    expect(PLAN_CHANGE_WORDS.done).toBe("Plan updated");
    // Its own op only: never the other plan's change or the suggestion's other cards.
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ opIds: [OP] }]);
    expect(button("Approve")).toBeNull();
    expect(button("Not now")).toBeNull();
  });

  it("Not now declines its own op; the card says it wasn't changed", async () => {
    let state = read("pending");
    const calls = serve({
      "GET /api/coach/proposals/dp-run-3": () => state,
      "POST /api/coach/proposals/dp-run-3/decline": () => {
        state = read("declined", { status: "declined", at: "x" });
        return { ok: true, status: "declined", declined: [OP], settled: [] };
      },
    });
    await mount(card());
    await until(() => !!button("Not now") && !button("Not now")!.disabled, "Not now");
    await click(button("Not now"), "Not now");
    await until(() => text().includes(PLAN_CHANGE_WORDS.declined), "not changed");
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/coach/proposals/dp-run-3/decline", { opIds: [OP] }]]);
  });

  it("refused (the athlete edited the plan since): the server's words, no buttons", async () => {
    serve({ "GET /api/coach/proposals/dp-run-3": () => read("pending", { status: "refused", at: "x", error: "stale", why: "Its settings changed since this was suggested: ask the coach again." }) });
    await mount(card());
    await until(() => text().includes("Its settings changed since this was suggested"), "the refusal");
    expect(button("Approve")).toBeNull();
  });

  it("an older turn's closed card is one line of what came of it", async () => {
    serve({ "GET /api/coach/proposals/dp-run-3": () => read("approved", { status: "applied", at: "x", changed: ["purpose"] }) });
    await mount(card({ status: "approved" }), true);
    await until(() => text().includes(PLAN_CHANGE_WORDS.done), "the closed line");
    expect(text()).toContain("Base block: new purpose and ending");
  });
});

describe("the plan change, read tolerantly and chosen by its op", () => {
  it("a suggestion's plan lines each with their own op and outcome; the card's kind and op; the line its op names", () => {
    const applied = line({ status: "applied", at: "x", changed: ["purpose"] });
    const r = toProposal({ id: "dp-1", status: "pending", resolvedAt: null, planChanges: [applied, { nonsense: true }] });
    expect(r.planChanges).toEqual([applied]);
    const c = toConversation({ id: "c1", startedAt: "x", turns: [{ runId: "r1", at: "x", words: "w", status: "finished", line: null, cards: [card()], question: null }] });
    expect(c.turns[0]!.cards[0]).toMatchObject({ kind: "plan_change", opId: OP, lines: LINES });
    const m = toConversation({ id: "c1", startedAt: "x", turns: [{ runId: "r1", at: "x", words: "w", status: "finished", line: null, cards: [{ ...card(), kind: "plan", opId: undefined, opIds: ["plan", OP, 7] }], question: null }] });
    expect(m.turns[0]!.cards[0]!.opIds).toEqual(["plan", OP]);
    const other = line(null, { opId: "pc-plan-9" });
    expect(ownPlanChange([other, applied], OP)).toBe(applied);
    expect(ownPlanChange([other], OP)).toBeNull();
    expect(ownPlanChange([other], undefined)).toBe(other);
    expect(ownPlanChange(undefined, OP)).toBeNull();
  });
});

describe("one card, never two: a plan change beside a whole plan", () => {
  const PLAN_OP = "plan";
  const PLAN_LINES = ["Mon 19 Oct · New plan: Build block"];
  const merged = (over: Partial<CoachConversationCardDto> = {}): CoachConversationCardDto => ({
    kind: "plan",
    proposalId: "dp-run-3",
    title: "Build block",
    summary: "3 weeks · 1 session to start",
    status: "pending",
    lines: [...PLAN_LINES, "Brief: Base block, then the build."],
    opIds: [PLAN_OP, OP],
    ...over,
  });
  type Outcome = { status: string; [k: string]: unknown } | null;
  const structure = (outcome: Outcome = null) => ({
    opId: PLAN_OP, kind: "createPlan", title: "Build block", summary: "3 weeks", lines: PLAN_LINES, why: "The next phase.", issues: [], outcome,
  });
  const both = (status: string, plan: unknown, change: Outcome = null) => ({
    id: "dp-run-3", status, resolvedAt: null, lines: [], changes: [], plans: [plan],
    planChanges: [line(change as DesignPlanChangeLineDto["outcome"], { lines: ["Brief: Base block, then the build."] })],
  });

  it("shows the plan's lines and the change's lines on the one card; one Approve decides both ops", async () => {
    let state = both("pending", structure());
    const calls = serve({
      "GET /api/coach/proposals/dp-run-3": () => state,
      "POST /api/coach/proposals/dp-run-3/approve": () => {
        state = both("approved", structure({ status: "applied", at: "x", summary: "1 session" }), { status: "applied", at: "x", changed: ["brief"] });
        return answer({ status: "approved" });
      },
    });
    await mount(merged());
    await until(() => !!button("Approve plan") && !button("Approve plan")!.disabled, "Approve plan");
    expect(document.querySelectorAll("section.coach-plan")).toHaveLength(1);
    expect([...document.querySelectorAll(".coach-plan-lines li")].map((l) => l.textContent)).toEqual([...PLAN_LINES, "Brief: Base block, then the build."]);
    await click(button("Approve plan"), "Approve plan");
    await until(() => text().includes("✓ Added to your plan"), "done");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ opIds: [PLAN_OP, OP] }]);
    expect(button("Approve plan")).toBeNull();
  });

  it("Not now declines both ops in one request", async () => {
    let state = both("pending", structure());
    const calls = serve({
      "GET /api/coach/proposals/dp-run-3": () => state,
      "POST /api/coach/proposals/dp-run-3/decline": () => {
        state = both("declined", structure({ status: "declined", at: "x" }), { status: "declined", at: "x" });
        return { ok: true, status: "declined", declined: [PLAN_OP, OP], settled: [] };
      },
    });
    await mount(merged());
    await until(() => !!button("Not now") && !button("Not now")!.disabled, "Not now");
    await click(button("Not now"), "Not now");
    await until(() => text().includes("Not added"), "declined");
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/coach/proposals/dp-run-3/decline", { opIds: [PLAN_OP, OP] }]]);
  });

  it("a plan applied while its change was refused says the refusal, not done", async () => {
    serve({
      "GET /api/coach/proposals/dp-run-3": () =>
        both("partially_approved", structure({ status: "applied", at: "x", summary: "1 session" }), { status: "refused", at: "x", error: "stale", why: "Its settings changed since this was suggested: ask the coach again." }),
    });
    await mount(merged());
    await until(() => text().includes("couldn't be saved"), "the refusal");
    // What landed and what didn't, in one line; the card stops offering Approve (a second tap would only meet the same refusal).
    expect(text()).toContain("Added to your plan; the change to its details couldn't be saved: its settings changed since this was suggested.");
    expect(text()).not.toContain("✓ Added to your plan");
    expect(button("Approve plan")).toBeNull();
    expect(button("Not now")).toBeNull();
  });

  it("a plan refused with its change refused says the plan's words (nothing landed)", async () => {
    serve({
      "GET /api/coach/proposals/dp-run-3": () =>
        both("pending", structure({ status: "refused", at: "x", error: "plan_refused", why: "That plan isn't there any more." }), { status: "refused", at: "x", error: "plan_refused", why: "The new plan wasn't added, so this change wasn't saved: ask the coach again." }),
    });
    await mount(merged());
    await until(() => text().includes("That plan isn't there any more."), "the plan's refusal");
    expect(text()).not.toContain("Added to your plan");
    expect(landedButWords("Added to your plan", "Its settings changed since this was suggested: ask the coach again.")).toBe(
      "Added to your plan; the change to its details couldn't be saved: its settings changed since this was suggested.",
    );
  });

  it("the pure fold: lines after the plan's, one outcome — applying kept, a refusal first, open while any op is open", () => {
    type O = { status: string; why?: string } | null;
    const p = { lines: ["a"], issues: [] as Array<{ code: string; message: string }>, outcome: { status: "applied" } as O };
    const c = (outcome: O) => ({ lines: ["b"], issues: [] as Array<{ code: string; message: string }>, outcome });
    expect(foldPlanChanges(p, [c({ status: "applied" })])).toMatchObject({ lines: ["a", "b"], outcome: { status: "applied" } });
    expect(foldPlanChanges(p, [c({ status: "refused", why: "No." })])!.outcome).toEqual({ status: "refused", why: "Added to your plan; the change to its details couldn't be saved: no." });
    // The plan itself refused: its own refusal first, as it is.
    expect(foldPlanChanges({ ...p, outcome: { status: "refused", why: "gone" } }, [c({ status: "refused", why: "no" })])!.outcome).toEqual({ status: "refused", why: "gone" });
    expect(foldPlanChanges(p, [c(null)])!.outcome).toBeNull();
    expect(foldPlanChanges({ ...p, outcome: { status: "applying" } }, [c(null)])!.outcome).toEqual({ status: "applying" });
    expect(foldPlanChanges(p, [])).toBe(p);
    expect(foldPlanChanges(null, [c(null)])).toBeNull();
    expect(cardOpIds({ opIds: ["plan", "pc-1"] }, "plan")).toEqual(["plan", "pc-1"]);
    expect(cardOpIds({}, "plan")).toEqual(["plan"]);
    expect(mergedPlanChanges([line(), line(null, { opId: "pc-other" })], ["plan", OP]).map((g) => g.opId)).toEqual([OP]);
  });
});
