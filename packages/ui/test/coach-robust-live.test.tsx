// @vitest-environment jsdom
/**
 * The robustness pass (2026-10-16: "make sure the coach is robust, and doesn't crash if I navigate away mid response"),
 * live:
 *
 *  - The app's run keeper owns the step loop: leaving the Studio mid-step, the run goes on stepping; coming back shows
 *    the same loop at work (no second step asked); a live run is stepped when the app opens on another screen; the
 *    Studio tab carries a quiet ● (with words for a reader) while the coach has a run going.
 *  - One tap, one request: Now, Send, Approve, Decline and Cancel tapped twice or three times send once.
 *  - Recovery: a step another request holds (a reload mid-step, another tab) is said — "The coach is still working on
 *    this…" — never a bare header; past the model's deadline, "This is taking longer than usual."
 *  - Tolerance: a newer server's status, event kinds and a suggestion missing its lists render, never throw.
 *
 * The server is a stubbed fetch; the step loop's deps a driven stand-in. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESIGN_MODEL_DEADLINE_MS, type CoachRunDto, type CoachRunEventDto, type CoachRunStepResult } from "@rg/api-client";
import { features } from "../src/features.js";
import { CoachConversation } from "../src/screens/studio/coach-conversation.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { ProposalCard } from "../src/screens/studio/proposal-card.js";
import { CoachKeeper, CoachNavMark } from "../src/screens/studio/run-keeper.js";
import { LOST_LINE, SLOW_LINE, STILL_WORKING_LINE } from "../src/screens/studio/run-model.js";
import { RunView } from "../src/screens/studio/run-view.js";
import type { LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { primedClient, todayDto, TODAY } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const flags = { coach: features.coach, studio: features.studio };
/** Each test's own run: a step one test leaves out (the tab's registry keeps it) never holds the next test's. */
let runs = 1;
let RUN_ID = `run-${runs}`;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
  features.coach = flags.coach;
  features.studio = flags.studio;
  RUN_ID = `run-${++runs}`;
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const run = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: RUN_ID,
  role: "main",
  scope: { kind: "now" },
  request: "hips",
  status: "active",
  steps: 1,
  costUsd: 0.04,
  proposalId: null,
  error: null,
  createdAt: `${TODAY}T08:00:00.000Z`,
  updatedAt: `${TODAY}T08:00:00.000Z`,
  finishedAt: null,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});
const ev = (seq: number, summary = `Line ${seq}`, kind: CoachRunEventDto["kind"] = "note", payload: unknown = null): CoachRunEventDto => ({
  seq,
  kind,
  summary,
  payload,
  at: `${TODAY}T08:00:00.000Z`,
});
const step = (status: CoachRunStepResult["status"], events: CoachRunEventDto[] = [], due = true): CoachRunStepResult => ({
  status,
  nextDue: due ? { runId: RUN_ID, role: "main", at: new Date(0).toISOString() } : null,
  events,
});

interface Call {
  method: string;
  path: string;
  body: any;
}

function serve(routes: Record<string, unknown | ((body: any, calls: Call[]) => Response)>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const answer = routes[`${method} ${path}`];
      if (answer === undefined) return json({ error: "offline" }, 503);
      if (typeof answer === "function") return (answer as (b: unknown, c: Call[]) => Response)(body, calls);
      return answer instanceof Response ? answer.clone() : json(answer);
    }),
  );
  return calls;
}

/** A loop the test drives: each step waits until `answer` gives its result; the read answers the server's run. */
function drivenLoop(server: { run: () => CoachRunDto; events?: () => CoachRunEventDto[] }) {
  const waiting: Array<(r: CoachRunStepResult) => void> = [];
  const stepped: string[] = [];
  const deps = (): LoopDeps => ({
    step: (id) => {
      stepped.push(id);
      return new Promise<CoachRunStepResult>((r) => waiting.push(r));
    },
    read: async (_id, afterSeq) => ({ run: server.run(), events: (server.events?.() ?? []).filter((e) => e.seq > afterSeq) }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    visible: () => true,
    onVisibility: () => () => undefined,
  });
  const answer = async (r: CoachRunStepResult) => {
    await until(() => waiting.length > 0, "a step out");
    await act(async () => waiting.shift()!(r));
    await settle(10);
  };
  return { deps, stepped, answer, out: () => waiting.length };
}

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");
async function until(test: () => boolean, what: string) {
  for (let i = 0; i < 150; i++) {
    if (test()) return;
    await settle(5);
  }
  throw new Error(`waited for ${what}; the page says: ${text()}`);
}
const button = (name: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;
const link = (name: string) => [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.trim().startsWith(name)) ?? null;
async function tap(el: Element | null | undefined, what: string, times = 1) {
  if (!el) throw new Error(`no ${what} in: ${text()}`);
  // Every tap lands before React draws the first one's answer: a double or triple tap.
  await act(async () => {
    for (let i = 0; i < times; i++) (el as HTMLElement).click();
  });
  await settle();
}
async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

function mountTree(el: ReactNode, o: { at?: string; client?: QueryClient } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = o.client ?? primedClient({ today: todayDto(null) });
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: [o.at ?? "/studio"] }, el)));
  });
  return qc;
}

/** The app as the keeper sees it: the Studio's coach on /studio, a Plan elsewhere, links between, the nav's mark. */
function app(deps: () => LoopDeps) {
  return createElement(
    CoachKeeper,
    { deps },
    createElement(
      "nav",
      null,
      createElement(Link, { to: "/plan" }, "Plan"),
      createElement(Link, { to: "/studio" }, "Studio", createElement(CoachNavMark)),
    ),
    createElement(
      Routes,
      null,
      createElement(Route, { path: "/studio", element: createElement(CoachConversation, { ctx: { ...emptyStudioCtx, profiles: [] } }) }),
      createElement(Route, { path: "/plan", element: createElement("p", null, "The plan") }),
    ),
  );
}

// ── The run keeper ──────────────────────────────────────────────────────────

describe("the app's run keeper", () => {
  it("leaving the Studio mid-step, the run goes on stepping; back, the same loop shows it at work — no step asked twice", async () => {
    let server = run({ status: "active" });
    const turn = () => ({ runId: RUN_ID, at: "x", words: "hips", status: server.status, line: server.status === "finished" ? "Here's one for your hips." : null, cards: [], question: null });
    serve({
      "GET /api/coach/runs/current": () => json({ run: server, events: [ev(1)], proposal: null }),
      "GET /api/coach/conversation": () => json({ id: RUN_ID, startedAt: "x", turns: [turn()] }),
    });
    const loop = drivenLoop({ run: () => server });
    mountTree(app(loop.deps));
    await until(() => loop.stepped.length === 1, "the first step");
    expect(text()).toContain("Designing…");
    await tap(link("Plan"), "the Plan link");
    expect(text()).toContain("The plan");
    // The step answers while the athlete is on the Plan: the next one is asked at once.
    await loop.answer(step("active", [ev(2, "Read today")]));
    await until(() => loop.stepped.length === 2, "the second step, from the Plan");
    expect(loop.out()).toBe(1);
    // Back in the Studio: the run as the loop holds it — its new line, its step at work — and nothing asked twice.
    await tap(link("Studio"), "the Studio link");
    await until(() => text().includes("Read today"), "the line the step wrote");
    expect(text()).toContain("Designing…");
    await settle(20);
    expect(loop.stepped).toHaveLength(2);
    server = run({ status: "finished" });
    await loop.answer(step("finished", [ev(3, "Done.")], false));
    await until(() => text().includes("Here's one for your hips."), "the run over: the coach's line");
  });

  it("a live run is stepped when the app opens on another screen", async () => {
    serve({ "GET /api/coach/runs/current": { run: run({ status: "active" }), events: [ev(1)], proposal: null } });
    const loop = drivenLoop({ run: () => run({ status: "active" }) });
    mountTree(app(loop.deps), { at: "/plan" });
    await until(() => loop.stepped.length === 1, "a step from the Plan");
    expect(text()).toContain("The plan");
  });

  it("no live run (or one over): nothing is stepped", async () => {
    serve({ "GET /api/coach/runs/current": { run: run({ status: "finished" }), events: [], proposal: null } });
    const loop = drivenLoop({ run: () => run({ status: "finished" }) });
    mountTree(app(loop.deps), { at: "/plan" });
    await settle(50);
    expect(loop.stepped).toEqual([]);
  });

  it("with the coach off, the keeper reads nothing and steps nothing", async () => {
    features.coach = false;
    const calls = serve({ "GET /api/coach/runs/current": { run: run({ status: "active" }), events: [], proposal: null } });
    const loop = drivenLoop({ run: () => run({ status: "active" }) });
    mountTree(app(loop.deps), { at: "/plan" });
    await settle(50);
    expect(calls.filter((c) => c.path.startsWith("/api/coach"))).toEqual([]);
    expect(loop.stepped).toEqual([]);
    expect(document.querySelector(".nav-coach-mark")).toBeNull();
  });

  it("the Studio tab's ● says what the coach is doing — working, waiting for you — and goes when the run is over", async () => {
    let server = run({ status: "active" });
    serve({ "GET /api/coach/runs/current": () => json({ run: server, events: [ev(1)], proposal: null }) });
    const loop = drivenLoop({ run: () => server });
    mountTree(app(loop.deps), { at: "/plan" });
    await until(() => !!document.querySelector(".nav-coach-mark"), "the mark");
    const mark = () => document.querySelector(".nav-coach-mark");
    expect(mark()!.textContent).toBe("● — the coach is working");
    expect(mark()!.querySelector('[aria-hidden="true"]')!.textContent).toBe("●");
    server = run({ status: "waiting_athlete" });
    await loop.answer(step("waiting_athlete", [ev(2, "How are the hips?", "question", { tool: "ask_athlete", data: { questions: [{ text: "How are the hips?", chips: [] }] } })], false));
    await until(() => mark()?.textContent === "● — the coach is waiting for you", "the waiting mark");
    await act(async () => undefined);
    // Over: no mark.
    await tap(link("Studio"), "the Studio link");
    await until(() => !!button("Cancel"), "Cancel");
    serve({ [`POST /api/coach/runs/${RUN_ID}/cancel`]: { run: run({ status: "cancelled" }) }, "GET /api/coach/runs/current": { run: null } });
    await tap(button("Cancel"), "Cancel");
    await until(() => mark() === null, "the mark gone");
  });
});

// ── One tap, one request ────────────────────────────────────────────────────

describe("one tap, one request", () => {
  it("Send tapped twice — and three times — starts one run", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": (body: any) => json({ run: run({ scope: body.scope, request: body.request, status: "active" }), existing: false }),
    });
    const loop = drivenLoop({ run: () => run({ status: "active" }) });
    mountTree(createElement(CoachConversation, { ctx: { ...emptyStudioCtx, profiles: [] }, loopDeps: loop.deps }));
    await until(() => !!document.querySelector(".coach-box textarea"), "the box");
    await type(document.querySelector<HTMLTextAreaElement>(".coach-box textarea")!, "hips");
    await tap(document.querySelector<HTMLButtonElement>(".coach-box button[type=submit]"), "Send", 3);
    await until(() => text().includes("Coach · designing"), "the run");
    expect(posts(calls, "/api/coach/runs")).toHaveLength(1);
  });

  it("an answer tapped three times answers once", async () => {
    const asking = run({ status: "waiting_athlete" });
    const calls = serve({
      "GET /api/coach/runs/current": {
        run: asking,
        events: [ev(1), ev(2, "How are the hips?", "question", { tool: "ask_athlete", data: { questions: [{ text: "How are the hips?", chips: ["tight", "okay"] }] } })],
        proposal: null,
      },
      [`POST /api/coach/runs/${RUN_ID}/answer`]: { run: run({ status: "active" }) },
    });
    const loop = drivenLoop({ run: () => asking });
    mountTree(createElement(CoachConversation, { ctx: { ...emptyStudioCtx, profiles: [] }, loopDeps: loop.deps }));
    await until(() => !!button("tight"), "the question");
    await tap(button("tight"), "an answer", 3);
    await settle(20);
    expect(posts(calls, `/api/coach/runs/${RUN_ID}/answer`)).toHaveLength(1);
  });

  it("Cancel tapped twice cancels once", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: run({ status: "active", costUsd: 0.1 }), events: [ev(1)], proposal: null },
      [`POST /api/coach/runs/${RUN_ID}/cancel`]: { run: run({ status: "cancelled" }) },
    });
    const loop = drivenLoop({ run: () => run({ status: "active" }) });
    mountTree(createElement(CoachConversation, { ctx: { ...emptyStudioCtx, profiles: [] }, loopDeps: loop.deps }));
    await until(() => !!button("Cancel"), "Cancel");
    await tap(button("Cancel"), "Cancel", 2);
    await settle(20);
    expect(posts(calls, `/api/coach/runs/${RUN_ID}/cancel`)).toHaveLength(1);
  });

  it("Approve tapped twice approves once; Decline tapped twice declines once", async () => {
    const line = {
      opId: "op-1",
      kind: "new",
      date: "2026-10-15",
      time: "18:00",
      title: "Hips",
      minutes: 20,
      summary: "Hips · 20 min",
      effort: "Maintain",
      place: "Home",
      parts: [],
      detail: [],
      reviewMean: 4.5,
      review: null,
      issues: [],
      outcome: null,
      written: null,
    };
    const calls = serve({
      "GET /api/coach/proposals/dp-1": { id: "dp-1", status: "pending", resolvedAt: null, lines: [line], changes: [] },
      "POST /api/coach/proposals/dp-1/approve": { ok: true, status: "pending", applied: [], changed: [], refused: [], settled: [], remaining: [] },
      "POST /api/coach/proposals/dp-1/decline": { ok: true, status: "declined", declined: ["op-1"], settled: [] },
    });
    mountTree(createElement(ProposalCard, { proposalId: "dp-1" }));
    await until(() => !!button("Approve"), "Approve");
    await tap(button("Approve"), "Approve", 2);
    await settle(20);
    expect(posts(calls, "/api/coach/proposals/dp-1/approve")).toHaveLength(1);
    await until(() => !!button("Decline") && !button("Decline")!.disabled, "Decline");
    await tap(button("Decline"), "Decline (open)");
    await until(() => !!document.querySelector(".coach-pc-decline"), "the decline box");
    await tap(button("Decline", document.querySelector(".coach-pc-decline")!), "Decline", 2);
    await settle(20);
    expect(posts(calls, "/api/coach/proposals/dp-1/decline")).toHaveLength(1);
  });
});

// ── Recovery ────────────────────────────────────────────────────────────────

describe("recovery: never a ● with nothing said", () => {
  it("reopened while the server holds the step (a reload mid-step): 'The coach is still working on this…', with its ●", async () => {
    const holding = run({ status: "stepping" });
    serve({
      "GET /api/coach/runs/current": { run: holding, events: [ev(1, "Read your request")], proposal: null },
      [`POST /api/coach/runs/${RUN_ID}/step`]: json({ error: "busy" }, 409),
      // The page's own reads, read tolerantly: a newer shape of a field is none, never drawn raw.
      [`GET /api/coach/runs/${RUN_ID}`]: { run: { ...holding, request: { text: "a newer shape" } }, events: [] },
    });
    mountTree(createElement(CoachConversation, { ctx: { ...emptyStudioCtx, profiles: [] } }));
    await until(() => text().includes(STILL_WORKING_LINE), "the still-working line");
    const nowLine = document.querySelector(".coach-line--now");
    expect(nowLine?.textContent).toContain("●");
    expect(nowLine?.textContent).toContain(STILL_WORKING_LINE);
    await settle(1_200);
    expect(document.querySelector(".coach-broken")).toBeNull();
    expect(text()).toContain(STILL_WORKING_LINE);
  });

  it("past the model's own deadline: 'This is taking longer than usual.' — not before", () => {
    const t0 = Date.parse(`${TODAY}T08:00:00.000Z`);
    const view = (now: number, o: { inFlight?: boolean; status?: CoachRunDto["status"] } = {}) => {
      mountTree(
        createElement(RunView, {
          run: run({ status: o.status ?? "active" }),
          status: o.status ?? "active",
          events: [ev(1)],
          inFlight: o.inFlight ?? true,
          workingSince: t0,
          now: () => now,
        }),
      );
      const said = text();
      act(() => root?.unmount());
      host?.remove();
      root = null;
      return said;
    };
    expect(view(t0 + DESIGN_MODEL_DEADLINE_MS - 1_000)).not.toContain(SLOW_LINE);
    expect(view(t0 + DESIGN_MODEL_DEADLINE_MS + 1_000)).toContain(SLOW_LINE);
    // Another request's step, as long: said too; a run waiting on the athlete: never.
    expect(view(t0 + DESIGN_MODEL_DEADLINE_MS + 1_000, { inFlight: false, status: "stepping" })).toContain(SLOW_LINE);
    expect(view(t0 + DESIGN_MODEL_DEADLINE_MS + 1_000, { inFlight: false, status: "waiting_athlete" })).not.toContain(SLOW_LINE);
  });

  it("the words: a lost connection keeps trying (no pause line: the coach goes on with the app closed, Task 13 §2.12)", () => {
    expect(LOST_LINE).toBe("Can't reach the coach right now. It keeps trying.");
  });
});

// ── Tolerance ───────────────────────────────────────────────────────────────

describe("a newer server's answers render, never throw", () => {
  it("an unknown status and event kind: its own words, its line, no failure claimed", async () => {
    serve({
      "GET /api/coach/runs/current": { run: null },
      // A turn whose status this bundle never saw, and fields of shapes it never saw: read as none, never drawn raw.
      "GET /api/coach/conversation": { id: RUN_ID, startedAt: "x", turns: [{ runId: RUN_ID, at: "x", words: { text: "a newer shape" }, status: "thinking_hard", line: null, cards: "nope", question: 7 }] },
      [`GET /api/coach/runs/${RUN_ID}`]: {
        run: { ...run(), status: "thinking_hard", request: { text: "a newer shape" } },
        events: [ev(1, "Read your request"), { seq: 2, kind: "plan_v2", summary: "Planned something new", payload: { weird: [1, { a: null }] }, at: "x" }, { seq: 3, kind: "note", summary: null }],
      },
    });
    const loop = drivenLoop({ run: () => run() });
    mountTree(createElement(CoachConversation, { ctx: { ...emptyStudioCtx, profiles: [] }, loopDeps: loop.deps }));
    await until(() => text().includes("thinking hard"), "its own words");
    await tap(button("How the coach made this"), "the trail");
    expect(text()).toContain("Planned something new");
    expect(text()).not.toContain("refused");
    expect(text()).not.toContain("undefined");
    expect(document.querySelector(".coach-broken")).toBeNull();
    expect(loop.stepped).toEqual([]);
  });

  it("a suggestion missing its lists, an unknown outcome and a change of an unknown kind: the card renders", async () => {
    serve({
      "GET /api/coach/proposals/dp-1": {
        id: "dp-1",
        status: "pending",
        resolvedAt: null,
        lines: [{ opId: "op-1", title: "Hips and back", date: "2026-10-15", time: "18:00", minutes: 20, reviewMean: undefined, outcome: null }],
        changes: [{ opId: "ch-1", kind: "swap_v2", summary: "Swapped a session", why: 5, outcome: { status: "declined", reason: 7 } }],
      },
    });
    mountTree(createElement(ProposalCard, { proposalId: "dp-1" }));
    await until(() => text().includes("Hips and back"), "the card");
    expect(text()).toContain("Swapped a session");
    expect(text()).not.toContain("undefined");
  });
});
