// @vitest-environment jsdom
/**
 * The review card after the audits (2026-11-06): the coach's headline under the title with the count beneath it in the
 * card's own words ("1 in · 1 left out", E4); and a decided card, once the conversation has moved on, still opens to
 * its review — In / Left out, the chips, the names that open the trail, Challenge — one tap down (E3). The server is a
 * stubbed fetch. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationCardDto, DesignPinsLineDto } from "@rg/api-client";
import { CoachReplyContext } from "../src/screens/studio/coach-reply.js";
import { PlanCard } from "../src/screens/studio/plan-card.js";
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

const OP = "pins-run-8";
const SAID = { id: "q1.1", kind: "quote" as const, label: "said 1:12", postId: "post-1", position: 0, quote: 1 };
const HISTORY = { id: "history", kind: "history" as const, label: "your history" };
const LIFT = {
  moveId: "myZorbexHipLiftAbc123", name: "Zorbex hip lift", text: "She says it's for stiff hips after easy runs.", decision: "in" as const,
  where: "joins your rotation", dose: "2 × 6 each side", cites: [SAID, HISTORY], post: { id: "post-1", position: 0 },
};
const NOD = { moveId: "myZorbexNeckNodAbc123", name: "Zorbex neck nod", text: "Your neck care already covers it.", decision: "out" as const, cites: [HISTORY], post: { id: "post-1", position: 2 } };
const HEADLINE = "Add the hip lift after your easy runs: your plan has had no hip work for three weeks. Leave the neck nod — your care covers it.";
const pinsLine = (over: Partial<DesignPinsLineDto> = {}): DesignPinsLineDto => ({
  opId: OP, title: "Hip work back in", summary: HEADLINE, count: "1 in · 1 left out", lines: [LIFT, NOD], why: "Hips first.", pin: [LIFT.moveId], unpin: [], issues: [], outcome: null, ...over,
});
const card = (over: Partial<CoachConversationCardDto> = {}): CoachConversationCardDto => ({
  kind: "pins", proposalId: "dp-run-8", title: "Hip work back in", summary: HEADLINE, count: "1 in · 1 left out", status: "pending", opId: OP,
  lines: ["Zorbex hip lift: …", "Zorbex neck nod: …"], pinLines: [LIFT, NOD], ...over,
});
const read = (over: Record<string, unknown> = {}) => ({ id: "dp-run-8", status: "pending", resolvedAt: null, lines: [], changes: [], pins: [pinsLine()], corrections: [], ...over });

async function mount(c: CoachConversationCardDto, o: { closed?: boolean; wrap?: (n: ReactNode) => ReactNode } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = primedClient();
  const wrap = o.wrap ?? ((n: ReactNode) => n);
  await act(async () => {
    root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, wrap(createElement(PlanCard, { card: c, closed: o.closed ?? false })))));
  });
}

describe("the review card's headline (E4)", () => {
  it("the coach's headline under the title, the count beneath it in the card's words", async () => {
    serve({ "GET /api/coach/proposals/dp-run-8": () => read() });
    await mount(card());
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    expect(document.querySelector(".coach-changes-summary")!.textContent).toBe(HEADLINE);
    expect(document.querySelector(".coach-changes-count")!.textContent).toBe("1 in · 1 left out");
    // Its words are the groups' own: In, then Left out.
    expect([...document.querySelectorAll(".coach-review-group")].map((h) => h.textContent)).toEqual(["In", "Left out"]);
  });

  it("a card stored before (no count) draws no count line", async () => {
    serve({ "GET /api/coach/proposals/dp-run-8": () => read({ pins: [pinsLine({ summary: "One joins the rotation.", count: undefined })] }) });
    await mount(card({ summary: "One joins the rotation.", count: undefined }));
    await until(() => !!button("Approve"), "Approve");
    expect(document.querySelector(".coach-changes-count")).toBeNull();
  });
});

describe("a decided card, once the conversation moved on (E3)", () => {
  const decided = () =>
    read({ status: "approved", pins: [pinsLine({ outcome: { status: "applied", at: "x", pinned: [LIFT.moveId], unpinned: [], lines: [] } })] });

  it("closed, it says what came of it; Show opens its review — In / Left out, the chips, the names, Challenge — and no Approve", async () => {
    serve({ "GET /api/coach/proposals/dp-run-8": () => decided() });
    const challenge = vi.fn();
    await mount(card({ status: "approved" }), { closed: true, wrap: (n) => createElement(CoachReplyContext.Provider, { value: { challenge } }, n) });
    await until(() => text().includes("Programme's pool updated"), "what came of it");
    // Its closed line: the title and the count — never the whole headline.
    expect(document.querySelector(".coach-card-closed-line")!.textContent).toContain("Hip work back in · 1 in · 1 left out — Programme's pool updated");
    expect(document.querySelectorAll(".coach-review-line")).toHaveLength(0);
    await click(button("Show"), "Show");
    expect([...document.querySelectorAll(".coach-review-group")].map((h) => h.textContent)).toEqual(["In", "Left out"]);
    const [lift] = [...document.querySelectorAll(".coach-review-line")];
    expect([...lift!.querySelectorAll(".coach-cite")].map((c) => c.textContent)).toEqual(["said 1:12", "your history"]);
    expect(lift!.querySelector(".coach-review-where")!.textContent).toBe("joins your rotation · 2 × 6 each side");
    expect(button("Approve")).toBeFalsy();
    await click(document.querySelectorAll(".coach-challenge")[0] as HTMLButtonElement, "Challenge the lift");
    expect(challenge).toHaveBeenCalledWith("About Zorbex hip lift: ");
  });

  it("a closed card stored before the review (plain lines) still shows its lines as before", async () => {
    serve({ "GET /api/coach/proposals/dp-run-8": () => read({ status: "approved", pins: [pinsLine({ lines: [{ text: "Zorbex hip lift — in rotation." }], outcome: { status: "applied", at: "x", pinned: [], unpinned: [], lines: [] } })] }) });
    await mount(card({ status: "approved", pinLines: [{ name: null, text: "Zorbex hip lift — in rotation." }], count: undefined }), { closed: true });
    await until(() => !!button("Show"), "Show");
    await click(button("Show"), "Show");
    expect(document.querySelectorAll(".coach-review-line")).toHaveLength(0);
    expect(text()).toContain("Zorbex hip lift — in rotation.");
  });
});
