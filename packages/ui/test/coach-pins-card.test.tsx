// @vitest-environment jsdom
/**
 * THE MOVES IN ROTATION IN THE CONVERSATION (saved-posts import, Task 18) — the plan card's shape for the coach's
 * `move_pins` suggestion: its title, its line, the coach's lines (one a placement, one a saved move left out); one
 * Approve and one Not now, each its own op only; approved, "Programme's pool updated" with the lines the server skipped (a move
 * archived since); declined, "Not changed". The conversation hands a `pins` card to the plan card, and reads one
 * tolerantly. The server is a stubbed fetch. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationCardDto, DesignApproveResponse, DesignPinsLineDto } from "@rg/api-client";
import { toConversation, toProposal } from "../src/screens/studio/coach-tolerance.js";
import { PINS_WORDS, PlanCard } from "../src/screens/studio/plan-card.js";
import { ProposalCard } from "../src/screens/studio/proposal-card.js";
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

const OP = "pins-run-3";
const LINES = [
  "Zorbex hip circle — in rotation: it opens the hips your Thursday runs tighten.",
  "Zorbex neck nod — left in your library: your neck care already covers it.",
];
/** The lines as the server keeps them since the saves flow redesign (§3.5): a move's name apart from its text. */
const PIN_LINES = [
  { name: "Zorbex hip circle", text: "In rotation: it opens the hips your Thursday runs tighten." },
  { name: null, text: "Your neck care already covers the rest." },
];
const card = (over: Partial<CoachConversationCardDto> = {}): CoachConversationCardDto => ({
  kind: "pins",
  proposalId: "dp-run-3",
  title: "One saved move into your rotation",
  summary: "Hip circle in; the neck nod waits",
  status: "pending",
  lines: LINES,
  opId: OP,
  ...over,
});
const line = (outcome: DesignPinsLineDto["outcome"] = null, over: Partial<DesignPinsLineDto> = {}): DesignPinsLineDto => ({
  opId: OP,
  title: "One saved move into your rotation",
  summary: "Hip circle in; the neck nod waits",
  lines: LINES.map((text) => ({ text })),
  why: "It serves your hips.",
  pin: ["myZorbexHipCircle1"],
  unpin: [],
  issues: [],
  outcome,
  ...over,
});
const read = (status: string, outcome: DesignPinsLineDto["outcome"] = null) => ({ id: "dp-run-3", status, resolvedAt: null, lines: [], changes: [], pins: [line(outcome)] });
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

describe("the moves-in-rotation card", () => {
  it("shows its title, line and the coach's lines; Approve approves its own op, then says Programme's pool updated with what was skipped", async () => {
    let state = read("pending");
    const calls = serve({
      "GET /api/coach/proposals/dp-run-3": () => state,
      "POST /api/coach/proposals/dp-run-3/approve": () => {
        state = read("approved", { status: "applied", at: "x", pinned: ["myZorbexHipCircle1"], unpinned: [], lines: ["Zorbex quad shuffle — not in your library any more, skipped"] });
        return answer({ status: "approved", pinned: [{ opId: OP, summary: "1 move in your programme's pool" }] });
      },
    });
    await mount(card());
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve, enabled once read");
    expect(document.querySelector("h3")?.textContent).toBe("One saved move into your rotation");
    expect(text()).toContain("Hip circle in; the neck nod waits");
    expect([...document.querySelectorAll(".coach-plan-lines li")].map((l) => l.textContent)).toEqual(LINES);
    expect(button("Not now")).not.toBeNull();
    await click(button("Approve"), "Approve");
    await until(() => text().includes(`✓ ${PINS_WORDS.done}`), "updated");
    // AMENDED 2026-10-25 (the saved-posts fix wave, coach-context audit I1a): a pin puts a move in the programme's pool.
    expect(PINS_WORDS.done).toBe("Programme's pool updated");
    expect(text()).toContain("Zorbex quad shuffle — not in your library any more, skipped");
    // Its own op only: never the suggestion's other cards.
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ opIds: [OP] }]);
    // Nothing of it is on Plan: no link there.
    expect([...document.querySelectorAll("a")].find((a) => a.textContent === "See it on Plan")).toBeUndefined();
    expect(button("Approve")).toBeNull();
    expect(button("Not now")).toBeNull();
  });

  it("Not now declines its own op; the card says nothing changed", async () => {
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
    await until(() => text().includes(PINS_WORDS.declined), "not changed");
    expect(PINS_WORDS.declined).toBe("Not changed");
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/coach/proposals/dp-run-3/decline", { opIds: [OP] }]]);
  });

  it("refused (its library couldn't be read): the server's words, still open to approve", async () => {
    serve({ "GET /api/coach/proposals/dp-run-3": () => read("pending", { status: "refused", at: "x", error: "library_unreadable", why: "The athlete's library couldn't be read just now — try again." }) });
    await mount(card());
    await until(() => text().includes("couldn't be read just now"), "the refusal");
  });

  it("one an approve claimed and didn't finish (review 1, finding 4): it says so and offers Finish — never Not now", async () => {
    serve({ "GET /api/coach/proposals/dp-run-3": () => read("pending", { status: "applying", at: "x" }) });
    await mount(card());
    await until(() => !!button(PINS_WORDS.finish), "Finish");
    expect(PINS_WORDS.finish).toBe("Finish");
    expect(text()).toContain(PINS_WORDS.part);
    expect(button("Not now")).toBeNull();
    expect(button("Approve")).toBeNull();
  });

  it("each line shows its move's name once, in bold, then its text; a line with no move is its text", async () => {
    const shown = () => [...document.querySelectorAll(".coach-plan-lines li")].map((l) => [l.textContent, [...l.querySelectorAll("strong")].map((s) => s.textContent)]);
    const want = [
      ["Zorbex hip circle In rotation: it opens the hips your Thursday runs tighten.", ["Zorbex hip circle"]],
      ["Your neck care already covers the rest.", []],
    ];
    serve({ "GET /api/coach/proposals/dp-run-3": () => read("pending") });
    await mount(card({ lines: ["Zorbex hip circle: In rotation: it opens the hips your Thursday runs tighten.", "Your neck care already covers the rest."], pinLines: PIN_LINES }));
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    expect(shown()).toEqual(want);
    act(() => root?.unmount());
    host?.remove();
    // Closed, one tap down: the same.
    await mount(card({ status: "approved", pinLines: PIN_LINES }), true);
    expect(shown()).toEqual(want);
    act(() => root?.unmount());
    host?.remove();
    // A card from an older server, with no lines of its own: the suggestion's read, each line with its name.
    serve({ "GET /api/coach/proposals/dp-run-3": () => ({ ...read("pending"), pins: [line(null, { lines: [{ moveId: "myZorbexHipCircle1", name: "Zorbex hip circle", text: PIN_LINES[0]!.text }, { text: PIN_LINES[1]!.text }] })] }) });
    await mount(card({ lines: undefined }));
    await until(() => document.querySelectorAll(".coach-plan-lines li").length === 2, "the read's lines");
    expect(shown()).toEqual(want);
  });

  it("an older turn's, closed: one line of what came of it, its lines one tap down", async () => {
    serve({ "GET /api/coach/proposals/dp-run-3": () => read("approved", { status: "applied", at: "x", pinned: ["myZorbexHipCircle1"], unpinned: [], lines: [] }) });
    await mount(card({ status: "approved" }), true);
    await until(() => text().includes(`One saved move into your rotation · Hip circle in; the neck nod waits — ${PINS_WORDS.done}`), "the closed line");
    expect(button("Show")).not.toBeNull();
  });
});

describe("a suggestion holding a workout beside the moves in rotation (or a programme change) — review 1, finding 1", () => {
  const workout = {
    opId: "wk-1", kind: "new", date: "2026-10-15", time: "18:00", title: "Hips, gently", minutes: 24, summary: "Hips, gently · 24 min", effort: "Develop",
    place: "Home", parts: ["Main"], detail: ["Glute bridge 2 × 12"], reviewMean: 4.5, review: null, issues: [], outcome: null, written: null,
  };
  const programme = {
    opId: "prog-p1", programmeId: "p1", title: "Mobility: new days", summary: "Tue · Thu", lines: [], why: "w", issues: [], outcome: null,
  };
  async function mountWorkoutCard(beside: Record<string, unknown>) {
    const calls = serve({
      "GET /api/coach/proposals/dp-run-3": () => ({ id: "dp-run-3", status: "pending", resolvedAt: null, lines: [workout], changes: [], ...beside }),
      "POST /api/coach/proposals/dp-run-3/approve": () => answer({ status: "partially_approved" }),
      "POST /api/coach/proposals/dp-run-3/decline": () => ({ ok: true, status: "partially_approved", declined: ["wk-1"], settled: [] }),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    client = primedClient();
    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client: client! }, createElement(ProposalCard, { proposalId: "dp-run-3", today: "2026-10-15" }))));
    });
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve");
    return calls;
  }

  for (const [what, beside] of [
    ["the moves in rotation", { pins: [line()] }],
    ["a programme change", { programmes: [programme] }],
  ] as const) {
    it(`the workout's card approves only its own workout, never \`{}\` — ${what} beside it is its own card's to decide`, async () => {
      const calls = await mountWorkoutCard(beside);
      await click(button("Approve"), "Approve");
      await until(() => calls.some((c) => c.method === "POST"), "the approve");
      expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/coach/proposals/dp-run-3/approve", { opIds: ["wk-1"] }]]);
    });

    it(`the workout's card declines only its own workout — ${what} beside it stays open`, async () => {
      const calls = await mountWorkoutCard(beside);
      await click(button("Decline"), "Decline");
      await until(() => !!document.querySelector(".coach-pc-decline"), "the reason box");
      await click(button("Decline", document.querySelector(".coach-pc-decline")!), "Decline, confirmed");
      await until(() => calls.some((c) => c.method === "POST"), "the decline");
      expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/coach/proposals/dp-run-3/decline", { opIds: ["wk-1"] }]]);
    });
  }
});

describe("the moves in rotation, read tolerantly", () => {
  it("a suggestion's pins lines, each with its op and outcome; the card's kind, op and lines", () => {
    const applied = { status: "applied" as const, at: "x", pinned: ["a"], unpinned: ["b"], lines: ["c"] };
    const r = toProposal({ id: "dp-1", status: "approved", resolvedAt: null, pins: [line(applied), { nonsense: true }, line(null, { opId: "" }), line({ status: "applying", at: "y" }, { opId: "pins-2", pin: [] })] });
    expect(r.pins).toEqual([line(applied), line({ status: "applying", at: "y" }, { opId: "pins-2", pin: [] })]);
    const c = toConversation({ id: "c1", startedAt: "x", turns: [{ runId: "r1", at: "x", words: "w", status: "finished", line: null, cards: [card()], question: null }] });
    expect(c.turns[0]!.cards[0]).toMatchObject({ kind: "pins", opId: OP, lines: LINES });
    // A line stored before the saves flow redesign is a plain string: its text. A move's line keeps its move and name.
    const named = { moveId: "myZorbexHipCircle1", name: "Zorbex hip circle", text: "In rotation." };
    expect(toProposal({ id: "dp-1", status: "pending", resolvedAt: null, pins: [{ ...line(), lines: ["Plain.", named, { text: 3 }, { name: "x" }, 7] }] }).pins![0]!.lines).toEqual([{ text: "Plain." }, named]);
    // The card's pin lines: a name or null, and a text.
    const withPins = toConversation({ id: "c1", startedAt: "x", turns: [{ runId: "r1", at: "x", words: "w", status: "finished", line: null, cards: [card({ pinLines: [...PIN_LINES, { name: 3, text: "Odd name." }, { name: "No text" }] as never })], question: null }] });
    expect(withPins.turns[0]!.cards[0]!.pinLines).toEqual([...PIN_LINES, { name: null, text: "Odd name." }]);
  });
});
