// @vitest-environment jsdom
/**
 * A PROGRAMME CHANGE IN THE CONVERSATION (§8 §5, stream W) — the plan card's shape for a change to a programme's
 * settings: its title, its new pattern, a line a setting ("Days Mon · Wed · Fri → Tue · Thu") and where its next
 * sessions go; one Approve and one Not now, each its own op only; while its sessions are placed a request at a time it
 * says "Moving your sessions…" and keeps approving while the server says some remains; done, "Programme updated" with a
 * link to Plan; refused stale, the server's words; one already part applied offers to finish, never Not now. The
 * conversation shows one such card a programme. The server is a stubbed fetch. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationCardDto, DesignApproveResponse, DesignProgrammeLineDto } from "@rg/api-client";
import { toConversation, toProposal } from "../src/screens/studio/coach-tolerance.js";
import { PlanCard, PROGRAMME_WORDS } from "../src/screens/studio/plan-card.js";
import { button, click, json, serve, text, until, type Call } from "./coach-live-harness.js";
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

const OP = "prog-p1";
const LINES = ["Days Mon · Wed · Fri → Tue · Thu", "Next sessions move to Tue 20 Oct · Thu 22 Oct · Tue 27 Oct"];
const card = (over: Partial<CoachConversationCardDto> = {}): CoachConversationCardDto => ({
  kind: "programme",
  proposalId: "dp-run-2",
  title: "Mobility: new days",
  summary: "Tue · Thu · 3 a week · 30 min",
  status: "pending",
  lines: LINES,
  opId: OP,
  ...over,
});
const line = (outcome: DesignProgrammeLineDto["outcome"] = null, over: Partial<DesignProgrammeLineDto> = {}): DesignProgrammeLineDto => ({
  opId: OP,
  programmeId: "p1",
  title: "Mobility: new days",
  summary: "Tue · Thu · 3 a week · 30 min",
  lines: LINES,
  why: "Your Mondays are full.",
  issues: [{ code: "days_short", message: "2 days for 3 sessions a week: the rest go on the week's other days" }],
  outcome,
  ...over,
});
const read = (status: string, outcome: DesignProgrammeLineDto["outcome"] = null, more: DesignProgrammeLineDto[] = []) => ({
  id: "dp-run-2",
  status,
  resolvedAt: null,
  lines: [],
  changes: [],
  programmes: [...more, line(outcome)],
});
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
  client = primedClient();
  await act(async () => {
    root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client: client! }, createElement(PlanCard, { card: c, closed }))));
  });
}

describe("the programme card", () => {
  it("shows its title, pattern, lines and notes; Approve asks again while some remains, says it is moving the sessions, then Programme updated", async () => {
    let state = read("pending");
    let rounds = 0;
    let release: (() => void) | null = null;
    // Another programme's change in the same suggestion: this card reads its own line, by its op.
    const other = line(null, { opId: "prog-p9", programmeId: "p9", title: "Strength: new goal", lines: ["Weekly goal 2 → 3 sessions"] });
    state = read("pending", null, [other]);
    const calls = serveAsync({
      "GET /api/coach/proposals/dp-run-2": () => state,
      "POST /api/coach/proposals/dp-run-2/approve": () => {
        rounds += 1;
        if (rounds < 3) return answer({ remaining: [OP] });
        return new Promise<Response>((r) => {
          release = () => {
            state = read("partially_approved", { status: "applied", at: "x", placed: 6, archived: 6 }, [other]);
            r(json(answer({ status: "partially_approved", planned: [{ opId: OP, summary: "Tue · Thu · 3 a week · 30 min — 6 sessions placed again" }] })));
          };
        });
      },
    });
    await mount(card());
    await until(() => !!button("Approve") && !button("Approve")!.disabled, "Approve, enabled once read");
    expect(document.querySelector("h3")?.textContent).toBe("Mobility: new days");
    expect(text()).toContain("Tue · Thu · 3 a week · 30 min");
    expect([...document.querySelectorAll(".coach-plan-lines li")].map((l) => l.textContent)).toEqual(LINES);
    expect(text()).toContain("2 days for 3 sessions a week: the rest go on the week's other days");
    expect(text()).not.toContain("Strength: new goal");
    expect(button("Not now")).not.toBeNull();
    await click(button("Approve"), "Approve");
    await until(() => text().includes(PROGRAMME_WORDS.doing), "the moving line");
    expect(PROGRAMME_WORDS.doing).toBe("Moving your sessions…");
    await until(() => release !== null, "the third round");
    await act(async () => release!());
    await until(() => text().includes(`✓ ${PROGRAMME_WORDS.done}`), "updated");
    expect(PROGRAMME_WORDS.done).toBe("Programme updated");
    // Its own op only, every round: never the other programme's change or the suggestion's other cards.
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ opIds: [OP] }, { opIds: [OP] }, { opIds: [OP] }]);
    expect([...document.querySelectorAll("a")].find((a) => a.textContent === "See it on Plan")?.getAttribute("href")).toBe("/plan");
    expect(button("Approve")).toBeNull();
    expect(button("Not now")).toBeNull();
  });

  it("Not now declines its own op; the card says it wasn't changed", async () => {
    let state = read("pending");
    const calls = serve({
      "GET /api/coach/proposals/dp-run-2": () => state,
      "POST /api/coach/proposals/dp-run-2/decline": () => {
        state = read("declined", { status: "declined", at: "x" });
        return { ok: true, status: "declined", declined: [OP], settled: [] };
      },
    });
    await mount(card());
    await until(() => !!button("Not now") && !button("Not now")!.disabled, "Not now");
    await click(button("Not now"), "Not now");
    await until(() => text().includes(PROGRAMME_WORDS.declined), "not changed");
    expect(PROGRAMME_WORDS.declined).toBe("Not changed");
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([["/api/coach/proposals/dp-run-2/decline", { opIds: [OP] }]]);
  });

  it("refused stale (the athlete changed its settings since): the server's words", async () => {
    serve({ "GET /api/coach/proposals/dp-run-2": () => read("pending", { status: "refused", at: "x", error: "stale", why: "Its settings changed since this was suggested: ask the coach again." }) });
    await mount(card());
    await until(() => text().includes("Its settings changed since this was suggested"), "the refusal");
  });

  it("one already part applied says so and offers to finish — never Not now", async () => {
    serve({ "GET /api/coach/proposals/dp-run-2": () => read("pending", { status: "applying", at: "x", progress: { written: true, placed: 2, archived: 3 } }) });
    await mount(card());
    await until(() => !!button(PROGRAMME_WORDS.finish), "Finish");
    expect(text()).toContain(PROGRAMME_WORDS.part);
    expect(button("Not now")).toBeNull();
    expect(button("Approve")).toBeNull();
  });
});

describe("the programme change, read tolerantly", () => {
  it("a suggestion's programme lines, each with its own op and outcome; the card's kind and op", () => {
    const r = toProposal({ id: "dp-1", status: "pending", resolvedAt: null, programmes: [{ ...line({ status: "applying", at: "x", progress: { written: true, placed: 1, archived: 2 } }) }, { nonsense: true }] });
    expect(r.programmes).toEqual([line({ status: "applying", at: "x", progress: { written: true, placed: 1, archived: 2 } })]);
    const c = toConversation({ id: "c1", startedAt: "x", turns: [{ runId: "r1", at: "x", words: "w", status: "finished", line: null, cards: [card()], question: null }] });
    expect(c.turns[0]!.cards[0]).toMatchObject({ kind: "programme", opId: OP, lines: LINES });
  });
});
