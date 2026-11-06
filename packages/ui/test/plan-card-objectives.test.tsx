// @vitest-environment jsdom
/**
 * The coach's changes to the athlete's objectives, as a card (audit fixes, 2026-11-06, E6): each change before → after
 * with the coach's why beneath it (and "your word" when it is the athlete's), Approve and Not now for its own changes
 * only; done, "Objectives updated" and a link to the board. Nothing changes until Approve. The server is a stubbed
 * fetch. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationCardDto, DesignObjectiveLineDto } from "@rg/api-client";
import { OBJECTIVES_WORDS, PlanCard } from "../src/screens/studio/plan-card.js";
import { button, click, serve, text, until } from "./coach-live-harness.js";
import { primedClient } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  vi.unstubAllGlobals();
});

const RETARGET: DesignObjectiveLineDto = {
  opId: "obj-retarget-kr-1", change: "retarget", title: "Strong legs", line: "Zorbex wall sit: target 120 s → 90 s",
  why: "You're at 45 s of 120 s with half the time gone.", basis: "stand", outcome: null,
};
const RETIRE: DesignObjectiveLineDto = { opId: "obj-retire-o-2", change: "retire", title: "Zorbex mobility", line: "Zorbex mobility: active → dropped", why: "You said it no longer matters.", basis: "owner", outcome: null };
const card = (over: Partial<CoachConversationCardDto> = {}): CoachConversationCardDto => ({
  kind: "objectives", proposalId: "dp-run-9", title: "Changes to your objectives", summary: "2 changes", status: "pending", lines: [RETARGET.line, RETIRE.line], ...over,
});
const read = (over: Record<string, unknown> = {}) => ({ id: "dp-run-9", status: "pending", resolvedAt: null, lines: [], changes: [], objectives: [RETARGET, RETIRE], ...over });

async function mount(c: CoachConversationCardDto) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = primedClient();
  await act(async () => {
    root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, createElement(PlanCard, { card: c }))));
  });
}

describe("the objectives card (E6)", () => {
  it("each change before → after, the coach's why beneath it — 'your word' for the athlete's", async () => {
    serve({ "GET /api/coach/proposals/dp-run-9": () => read() });
    await mount(card());
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    const items = [...document.querySelectorAll(".coach-objective-change")];
    expect(items.map((i) => i.querySelector(".coach-objective-line")!.textContent)).toEqual([RETARGET.line, RETIRE.line]);
    expect(items[0]!.querySelector(".coach-objective-why")!.textContent).toBe(RETARGET.why);
    expect(items[1]!.querySelector(".coach-objective-why")!.textContent).toBe(`${RETIRE.why} (your word)`);
  });

  it("Approve approves its own changes, nothing else of the suggestion; done, the board one tap away", async () => {
    let state = read();
    const calls = serve({
      "GET /api/coach/proposals/dp-run-9": () => state,
      "POST /api/coach/proposals/dp-run-9/approve": () => {
        state = read({ status: "approved", objectives: [RETARGET, RETIRE].map((o) => ({ ...o, outcome: { status: "applied", at: "x" } })) });
        return { ok: true, status: "approved", applied: [], changed: [], refused: [], settled: [], remaining: [] };
      },
    });
    await mount(card());
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    await click(button("Approve"), "Approve");
    await until(() => text().includes(OBJECTIVES_WORDS.done), "done");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ opIds: [RETARGET.opId, RETIRE.opId] }]);
    expect((document.querySelector(`a[href="/studio/objectives"]`) as HTMLAnchorElement).textContent).toBe("See your objectives");
  });

  it("a stale change says why; Not now declines its own", async () => {
    serve({ "GET /api/coach/proposals/dp-run-9": () => read({ objectives: [{ ...RETARGET, outcome: { status: "refused", at: "x", error: "stale", why: "It changed since the coach suggested this — ask again." } }] }) });
    await mount(card({ lines: [RETARGET.line], summary: "1 change", title: "A change to your objectives" }));
    await until(() => text().includes("It changed since the coach suggested this"), "the stale line");
    act(() => root?.unmount());
    root = null;
    const calls = serve({
      "GET /api/coach/proposals/dp-run-9": () => read(),
      "POST /api/coach/proposals/dp-run-9/decline": () => ({ ok: true, status: "declined", declined: [RETARGET.opId, RETIRE.opId], settled: [] }),
    });
    await mount(card());
    await until(() => !!button("Not now") && !button("Not now")!.disabled, "Not now");
    await click(button("Not now"), "Not now");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ opIds: [RETARGET.opId, RETIRE.opId] }]);
  });

  it("the suggestion's read keeps its objective changes through the tolerance", async () => {
    const { toProposal } = await import("../src/screens/studio/coach-tolerance.js");
    expect(toProposal(read()).objectives).toEqual([RETARGET, RETIRE]);
    expect(toProposal(read({ objectives: [{ opId: 5 }, { ...RETARGET, basis: "nonsense" }] })).objectives).toEqual([{ ...RETARGET, basis: "stand" }]);
  });
});
