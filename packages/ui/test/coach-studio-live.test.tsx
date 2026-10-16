// @vitest-environment jsdom
/**
 * Stage 3 Task 9 — the coach in the Studio, live: the composer and the run it opens, the question, ways to train now.
 *
 *  - Now / Later today / a scope from the menu post `{ scope, request }`; the counter shows only near the limit.
 *  - An answer carrying `existing` opens THAT run, says so in one line, and offers the words this tap carried back into
 *    the field — never dropped.
 *  - A 404 (the server's coach is off) is one quiet line, said once: nothing is asked again.
 *  - A set's estimate shows beside its limit once its plan made one.
 *  - The question: Send posts the answers, Skip `{ dismissed: true }`, Undo the kept answer's handle; today's condition
 *    check is the app's own sheet, and its saved id answers the coach — only once the server's save is back.
 *  - A run that stopped with nothing proposed offers the day's programme session, a template and a quick start.
 *
 * The server is a stubbed fetch; the step loop's own deps are a quiet stand-in. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { onlineManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachRunDto, CoachRunEventDto, CoachRunStepResult, TemplateDto, TodayResponse } from "@rg/api-client";
import { StudioCoach, COACH_CURRENT_QUERY, COUNTER_FROM, REQUEST_MAX_CHARS } from "../src/screens/studio/composer.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import type { LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { EXISTING_LINE, NOT_AVAILABLE_LINE, QUICK_BELOW_LINE, TRAIL_FOLD_LINE } from "../src/screens/studio/run-model.js";
import { primedClient, todayDto, TODAY } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const run = (over: Partial<CoachRunDto> = {}): CoachRunDto => ({
  id: "run-1",
  role: "main",
  scope: { kind: "now" },
  request: "hips",
  status: "waiting_athlete",
  steps: 2,
  costUsd: 0.12,
  proposalId: null,
  error: null,
  createdAt: `${TODAY}T08:00:00.000Z`,
  updatedAt: `${TODAY}T08:00:00.000Z`,
  finishedAt: null,
  estimateUsd: null,
  ceilingUsd: 1.5,
  ...over,
});
const ev = (seq: number, kind: CoachRunEventDto["kind"], summary: string, payload: unknown = null): CoachRunEventDto => ({ seq, kind, summary, payload, at: `${TODAY}T08:00:00.000Z` });
const asked = ev(2, "question", "How are the hips today?", {
  tool: "ask_athlete",
  data: { questions: [{ text: "How are the hips today?", chips: ["tight", "okay"], why: "the warm-up", allowFreeText: true }] },
});

interface Call {
  method: string;
  path: string;
  body: any;
}

/** The server: `routes` answer by "METHOD path" (a function gets the body); anything else is a 503. */
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

/** The loop's stand-in: its step never answers (no model here); its read answers `run`. */
const quietLoop = (r: () => CoachRunDto) => (): LoopDeps => ({
  step: () => new Promise(() => undefined),
  read: async () => ({ run: r(), events: [] }),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  visible: () => true,
  onVisibility: () => () => undefined,
});

/**
 * A loop the test drives: each step waits until `answer` gives its result; the read answers the server's run and its
 * events after `afterSeq`. Records every step by its run.
 */
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
  return { deps, stepped, answer };
}

let lastClient: QueryClient | null = null;

function mount(o: { today?: TodayResponse; loop?: () => LoopDeps; state?: unknown; client?: QueryClient; prime?: (qc: QueryClient) => void } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = o.client ?? primedClient({ today: o.today ?? todayDto(null) });
  o.prime?.(qc);
  lastClient = qc;
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          { initialEntries: [{ pathname: "/studio", state: o.state ?? null }] },
          createElement(StudioCoach, { ctx: { ...emptyStudioCtx, profiles: [] }, loopDeps: o.loop ?? quietLoop(() => run()) }),
        ),
      ),
    );
  });
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
async function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`no ${what} in: ${text()}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}
const button = (name: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;
const field = () => document.querySelector<HTMLTextAreaElement>(".coach-composer-field");
async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

// ── The composer ────────────────────────────────────────────────────────────

describe("the composer", () => {
  it("with no run to show: the field, Now, Later today, Plan ahead; each starts a run with the field's words", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": (body: any) => json({ run: run({ scope: body.scope, request: body.request, status: "active" }), existing: false }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => !!field(), "the composer");
    expect(field()!.placeholder).toBe("What would help today?");
    expect(field()!.maxLength).toBe(REQUEST_MAX_CHARS);
    await type(field()!, "  a 30-minute lower-body session  ");
    await click(button("Now"), "Now");
    await until(() => text().includes("Coach · designing"), "the run view");
    expect(posts(calls, "/api/coach/runs").map((c) => c.body)).toEqual([{ scope: { kind: "now" }, request: "a 30-minute lower-body session" }]);
    // While the coach works, its run view stands in the composer's place.
    expect(field()).toBeNull();
  });

  it("Plan ahead offers the next 7 days and the next workouts", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": (body: any) => json({ run: run({ scope: body.scope, status: "active" }), existing: false }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => !!field(), "the composer");
    await click(button("Plan ahead"), "Plan ahead");
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toEqual(["Next 7 days", "Next 3 workouts"]);
    await click(button("Next 3 workouts"), "Next 3 workouts");
    expect(posts(calls, "/api/coach/runs")[0]!.body).toEqual({ scope: { kind: "next_n", n: 3 }, request: null });
  });

  const coachPrefs = (coach: { defaultScope?: "now" | "later_today" | "week" | "next_n"; nextN?: number }) => ({
    coach,
    settings: { defaultScope: coach.defaultScope ?? "now", nextN: coach.nextN ?? 3, trainingTimes: [], ceilingsUsd: { day: 1.5, set: 6 } },
    model: { id: "m", name: "The coach's model" },
  });
  const primary = () => [...document.querySelectorAll<HTMLButtonElement>(".coach-composer-actions .btn-primary")].map((b) => b.textContent?.trim());

  it("the athlete's settings lead: their next workouts — Plan ahead the primary button, its item marked, N theirs", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "GET /api/coach/preferences": coachPrefs({ defaultScope: "next_n", nextN: 5 }),
      "POST /api/coach/runs": (body: any) => json({ run: run({ scope: body.scope, status: "active" }), existing: false }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => primary().join() === "Plan ahead", "Plan ahead, the primary button");
    // One tap starts the default (fix wave 3B, M10); the menu is the ▾ beside it.
    await click(document.querySelector(".coach-scope-more"), "the ▾");
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((m) => m.textContent)).toEqual(["Next 7 days", "Next 5 workouts · your default"]);
    expect(items.map((m) => m.getAttribute("aria-current"))).toEqual([null, "true"]);
    await click(items[1], "Next 5 workouts");
    expect(posts(calls, "/api/coach/runs")[0]!.body).toEqual({ scope: { kind: "next_n", n: 5 }, request: null });
  });

  it("later today as the default: its button is the primary one; the next 7 days mark their item", async () => {
    serve({ "GET /api/coach/runs/current": { run: null }, "GET /api/coach/preferences": coachPrefs({ defaultScope: "later_today" }) });
    mount();
    await until(() => primary().join() === "Later today", "Later today, the primary button");
    act(() => root?.unmount());
    host?.remove();
    serve({ "GET /api/coach/runs/current": { run: null }, "GET /api/coach/preferences": coachPrefs({ defaultScope: "week" }) });
    mount();
    await until(() => primary().join() === "Plan ahead", "Plan ahead, the primary button");
    await click(document.querySelector(".coach-scope-more"), "the ▾");
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toEqual(["Next 7 days · your default", "Next 3 workouts"]);
  });

  it("no settings to read (a 404): Now leads, and the next workouts are three", async () => {
    serve({ "GET /api/coach/runs/current": { run: null }, "GET /api/coach/preferences": () => json({ error: "not_found" }, 404) });
    mount();
    await until(() => !!field(), "the composer");
    await settle(20);
    expect(primary()).toEqual(["Now"]);
    await click(button("Plan ahead"), "Plan ahead");
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toEqual(["Next 7 days", "Next 3 workouts"]);
  });

  it("the counter shows only near the limit", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    await until(() => !!field(), "the composer");
    await type(field()!, "x".repeat(COUNTER_FROM - 1));
    expect(document.querySelector(".coach-composer-count")).toBeNull();
    await type(field()!, "x".repeat(COUNTER_FROM));
    expect(document.querySelector(".coach-composer-count")?.textContent).toBe(`${COUNTER_FROM} / ${REQUEST_MAX_CHARS}`);
  });

  it("`existing`: the live run opens, one line says so, and the words this tap carried are offered back into the field", async () => {
    const live = run({ id: "run-live", request: "an older request", status: "waiting_athlete" });
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": () => json({ run: live, existing: true, offer: "answer_or_cancel", ignoredRequest: { scope: { kind: "now" }, request: "my new words" } }),
    });
    mount({ loop: quietLoop(() => live) });
    await until(() => !!field(), "the composer");
    await type(field()!, "my new words");
    await click(button("Now"), "Now");
    await until(() => text().includes(EXISTING_LINE), "the line");
    expect(text()).toContain("“an older request”");
    expect(posts(calls, "/api/coach/runs")).toHaveLength(1);
    await click(button("Copy my words back"), "Copy my words back");
    expect(field()!.value).toBe("my new words");
    expect(button("Copy my words back")).toBeNull();
  });

  it("a 404 from the coach's routes: one quiet line, said once — nothing asked again", async () => {
    const calls = serve({ "GET /api/coach/runs/current": json({ error: "not_found" }, 404) });
    mount();
    await until(() => text().includes(NOT_AVAILABLE_LINE), "the quiet line");
    await settle(50);
    expect(calls.filter((c) => c.path.startsWith("/api/coach/runs"))).toHaveLength(1);
    expect(document.querySelectorAll(".coach-off")).toHaveLength(1);
    expect(field()).toBeNull();
  });

  it("a 404 when starting: the quiet line, and no run asked for again", async () => {
    const calls = serve({ "GET /api/coach/runs/current": { run: null }, "POST /api/coach/runs": json({ error: "not_found" }, 404) });
    mount();
    await until(() => !!field(), "the composer");
    await click(button("Later today"), "Later today");
    await until(() => text().includes(NOT_AVAILABLE_LINE), "the quiet line");
    await settle(50);
    expect(posts(calls, "/api/coach/runs")).toHaveLength(1);
  });

  it("a live set shows its estimate beside the limit, in place of the composer", async () => {
    const set = run({ scope: { kind: "week" }, status: "waiting_set", estimateUsd: 4.2, ceilingUsd: 6, request: null });
    serve({ "GET /api/coach/runs/current": { run: set, events: [ev(1, "tool_result", "Planned the set — 4 workouts", { tool: "plan_set", ok: true })], proposal: null } });
    mount({ loop: quietLoop(() => set) });
    await until(() => text().includes("About $4.20; the limit is $6.00"), "the estimate");
    expect(text()).toContain("Coach · planning the set");
    expect(field()).toBeNull();
    expect(button("Cancel")).not.toBeNull();
  });

  it("the Plan coach sheet's link lands with the composer focused", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount({ state: { coach: "compose" } });
    await until(() => !!field(), "the composer");
    expect(document.activeElement).toBe(field());
  });
});

// ── The question ────────────────────────────────────────────────────────────

describe("the question", () => {
  it("Send posts the answers — a chip, or words of one's own — and the run goes on", async () => {
    // The server's run: waiting on the athlete until the answer is in.
    let server = run();
    const calls = serve({
      "GET /api/coach/runs/current": { run: run(), events: [ev(1, "note", "Read the request."), asked], proposal: null },
      "POST /api/coach/runs/run-1/answer": () => json({ run: (server = run({ status: "active" })) }),
    });
    mount({ loop: quietLoop(() => server) });
    await until(() => text().includes("How are the hips today?"), "the question");
    expect(button("Send")!.disabled).toBe(true);
    await click(button("tight"), "the chip");
    expect(document.querySelector('.coach-ask .chip[aria-pressed="true"]')?.textContent).toBe("✓tight");
    await click(button("Send"), "Send");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the answer");
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ answers: ["tight"] });
    await until(() => text().includes("Coach · designing"), "the run going on");
  });

  it("words typed win over a chip", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: run(), events: [asked], proposal: null },
      "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }),
    });
    mount();
    await until(() => text().includes("How are the hips today?"), "the question");
    await click(button("okay"), "the chip");
    await type(document.querySelector<HTMLInputElement>(".coach-ask-words")!, "stiff on the left");
    await click(button("Send"), "Send");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the answer");
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ answers: ["stiff on the left"] });
  });

  it("Skip posts dismissed: the coach goes on with its best judgement", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: run(), events: [asked], proposal: null },
      "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }),
    });
    mount();
    await until(() => text().includes("How are the hips today?"), "the question");
    await click(button("Skip"), "Skip");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the skip");
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ dismissed: true });
  });

  it("an answer the server refuses says its words", async () => {
    serve({
      "GET /api/coach/runs/current": { run: run(), events: [asked], proposal: null },
      "POST /api/coach/runs/run-1/answer": json({ error: "bad_answer", why: "The coach asked a question, not for a condition check." }, 400),
    });
    mount();
    await until(() => text().includes("How are the hips today?"), "the question");
    await click(button("tight"), "the chip");
    await click(button("Send"), "Send");
    await until(() => text().includes("The coach asked a question, not for a condition check."), "the refusal");
  });

  it("Undo on the kept answer's line posts its handle while the run is live", async () => {
    const answered = ev(3, "note", "You answered: tight", { answers: ["tight"], receipt: { undo: { handle: "run-1:toolu_7" } } });
    const live = run({ status: "active" });
    const calls = serve({
      "GET /api/coach/runs/current": { run: live, events: [asked, answered], proposal: null },
      "POST /api/coach/runs/run-1/undo-answer": { undone: 1 },
    });
    mount({ loop: quietLoop(() => live) });
    await until(() => !!button("Undo"), "Undo");
    await click(button("Undo"), "Undo");
    await until(() => posts(calls, "/api/coach/runs/run-1/undo-answer").length === 1, "the undo");
    expect(posts(calls, "/api/coach/runs/run-1/undo-answer")[0]!.body).toEqual({ handle: "run-1:toolu_7" });
    await until(() => !button("Undo"), "Undo gone");
  });

  const remembered = (runId: string) =>
    ev(2, "tool_result", "Remembered (you said): Knees like a long warm-up.", {
      tool: "remember",
      ok: true,
      receipt: { memoryId: "mem-1", kind: "fact", confidence: "stated", undo: { handle: `rm:${runId}:toolu_1` } },
    });

  it("Undo on a Remembered line, the run over: the memory is taken back and the memory list read again", async () => {
    const over = run({ id: "run-rm", status: "finished", finishedAt: `${TODAY}T08:05:00.000Z` });
    const calls = serve({
      "GET /api/coach/runs/current": { run: over, events: [ev(1, "note", "Read your request and today's plan."), remembered("run-rm")], proposal: null },
      "POST /api/coach/runs/run-rm/undo-answer": { undone: 1 },
      "GET /api/templates": { templates: [] },
    });
    mount({ loop: quietLoop(() => over), prime: (qc) => qc.setQueryData(["coach-memory"], { memory: [] }) });
    await until(() => !!button("Undo"), "Undo on the Remembered line");
    await click(button("Undo"), "Undo");
    await until(() => posts(calls, "/api/coach/runs/run-rm/undo-answer").length === 1, "the undo");
    expect(posts(calls, "/api/coach/runs/run-rm/undo-answer")[0]!.body).toEqual({ handle: "rm:run-rm:toolu_1" });
    await until(() => lastClient!.getQueryState(["coach-memory"])?.isInvalidated === true, "the memory list read again");
    await until(() => !button("Undo"), "Undo gone");
  });

  it("Undo on a Remembered line already taken back (404): said plainly, and not offered again", async () => {
    const over = run({ id: "run-rm2", status: "finished", finishedAt: `${TODAY}T08:05:00.000Z` });
    serve({
      "GET /api/coach/runs/current": { run: over, events: [ev(1, "note", "Read your request and today's plan."), remembered("run-rm2")], proposal: null },
      "POST /api/coach/runs/run-rm2/undo-answer": () => json({ error: "not_found" }, 404),
      "GET /api/templates": { templates: [] },
    });
    mount({ loop: quietLoop(() => over) });
    await until(() => !!button("Undo"), "Undo on the Remembered line");
    await click(button("Undo"), "Undo");
    await until(() => text().includes("That memory was already taken back."), "the plain words");
    expect(text()).not.toContain("Couldn't take that back");
    expect(button("Undo")).toBeNull();
  });

  it("today's condition check: the why as text, the app's own sheet — and the saved check's id answers, after the save is back", async () => {
    const check = ev(2, "question", "The coach asks you to log today's condition check.", { tool: "ask_athlete", data: { check: "condition", why: "Landing drills need today's check." } });
    let saved = false;
    const calls = serve({
      "GET /api/coach/runs/current": { run: run(), events: [check], proposal: null },
      "POST /api/conditions/checks": (body: any) => {
        saved = true;
        return json({ check: { id: "chk-1", profileId: body.profileId, date: TODAY, value: body.value, feelingOff: false } });
      },
      "POST /api/coach/runs/run-1/answer": (body: any) => {
        // Never before the server's save has answered.
        expect(saved).toBe(true);
        return json({ run: run({ status: "active" }), echoed: body });
      },
    });
    mount();
    await until(() => text().includes("Landing drills need today's check."), "the why");
    await click(button("Do the jaw check"), "the check's button");
    const sheet = document.querySelector('[role="dialog"]')!;
    await click([...sheet.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "2"), "a reading");
    await click(button("Save", sheet), "Save");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the answer");
    expect(posts(calls, "/api/conditions/checks")[0]!.body).toEqual({ profileId: "tmj", value: 2, feelingOff: false });
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ conditionCheckId: "chk-1" });
  });
});

describe("today's condition check, the other ways", () => {
  const check = ev(2, "question", "The coach asks you to log today's condition check.", { tool: "ask_athlete", data: { check: "condition", why: "Landing drills need it." } });

  it("Skip posts dismissed", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: run(), events: [check], proposal: null },
      "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }),
    });
    mount();
    await until(() => text().includes("Landing drills need it."), "the why");
    await click(button("Skip"), "Skip");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the skip");
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ dismissed: true });
  });

  it("a saved check with no id answers nothing, and says so", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: run(), events: [check], proposal: null },
      "POST /api/conditions/checks": (body: any) => json({ check: { profileId: body.profileId, date: TODAY, value: body.value, feelingOff: false } }),
      "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }),
    });
    mount();
    await until(() => text().includes("Landing drills need it."), "the why");
    await click(button("Do the jaw check"), "the check's button");
    const sheet = document.querySelector('[role="dialog"]')!;
    await click([...sheet.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "1"), "a reading");
    await click(button("Save", sheet), "Save");
    await until(() => text().includes("Couldn't save that — try again."), "the line");
    expect(posts(calls, "/api/coach/runs/run-1/answer")).toHaveLength(0);
  });
});

describe("Cancel", () => {
  it("under $0.50 it cancels at once; above, it asks first", async () => {
    const cheap = run({ status: "active", costUsd: 0.2 });
    const calls = serve({
      "GET /api/coach/runs/current": { run: cheap, events: [ev(1, "note", "Read the request.")], proposal: null },
      "POST /api/coach/runs/run-1/cancel": () => json({ run: run({ status: "cancelled", costUsd: 0.2 }) }),
    });
    mount({ loop: quietLoop(() => cheap) });
    await until(() => !!button("Cancel"), "Cancel");
    await click(button("Cancel"), "Cancel");
    await until(() => posts(calls, "/api/coach/runs/run-1/cancel").length === 1, "the cancel");
    await until(() => text().includes("Coach · cancelled"), "cancelled");
    act(() => root?.unmount());
    host?.remove();

    const dear = run({ status: "active", costUsd: 0.62 });
    const calls2 = serve({
      "GET /api/coach/runs/current": { run: dear, events: [ev(1, "note", "Read the request.")], proposal: null },
      "POST /api/coach/runs/run-1/cancel": () => json({ run: run({ status: "cancelled", costUsd: 0.62 }) }),
    });
    mount({ loop: quietLoop(() => dear) });
    await until(() => !!button("Cancel"), "Cancel");
    await click(button("Cancel"), "Cancel");
    expect(posts(calls2, "/api/coach/runs/run-1/cancel")).toHaveLength(0);
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.textContent?.includes("Stop the coach?"));
    expect(dialog?.textContent).toContain("$0.62");
    await click(button("Stop it", dialog!), "Stop it");
    await until(() => posts(calls2, "/api/coach/runs/run-1/cancel").length === 1, "the cancel");
  });
});

// ── When it stopped ─────────────────────────────────────────────────────────

describe("fix round: the run's end, a return mid-run, an `existing` question", () => {
  const line = (opId: string, title: string) => ({
    opId, kind: "new", date: TODAY, time: null, title, minutes: 20, summary: `${title} · 20 min`, effort: "Maintain", place: "Home",
    parts: ["Main"], detail: [], reviewMean: 4.5, review: null, issues: [], outcome: null, written: null,
  });

  it("a set's suggestion appears when its run ends — never read while it works, a read left from before read again", async () => {
    let server = run({ id: "run-set", scope: { kind: "week" }, status: "active", request: null });
    const designed = ev(2, "note", "Monday's workout is designed.", { proposalId: "dp-run-set" });
    const calls = serve({
      "GET /api/coach/runs/current": () => json({ run: server, events: [ev(1, "tool_result", "Planned the set", { tool: "plan_set", ok: true }), designed], proposal: null }),
      "GET /api/coach/proposals/dp-run-set": () =>
        json(server.status === "finished" ? { id: "dp-run-set", status: "pending", resolvedAt: null, lines: [line("op-a", "Monday hips")], changes: [] } : { id: "dp-run-set", status: "unreviewed", resolvedAt: null, lines: [], changes: [] }),
    });
    const loop = drivenLoop({ run: () => server });
    // A read of the suggestion left from before, unreviewed then.
    mount({ loop: loop.deps, prime: (qc) => qc.setQueryData(["coach-design-proposal", "dp-run-set"], { id: "dp-run-set", status: "unreviewed", resolvedAt: null, lines: [], changes: [] }) });
    await until(() => text().includes("Coach · designing"), "the live set");
    await settle(30);
    // While the set works, a line naming the suggestion is no reason to read it.
    expect(calls.filter((c) => c.path === "/api/coach/proposals/dp-run-set")).toHaveLength(0);
    expect(document.querySelector(".coach-pc")).toBeNull();
    server = run({ id: "run-set", scope: { kind: "week" }, status: "finished", request: null, proposalId: "dp-run-set" });
    await loop.answer({ status: "finished", nextDue: null, events: [ev(3, "note", "The set is ready.", { proposalId: "dp-run-set" })] });
    await until(() => text().includes("Monday hips"), "the set's card");
    expect(document.querySelector(".coach-fallback")).toBeNull();
  });

  it("a failed set whose suggestion was never made the athlete's offers the ways to train now", async () => {
    const failed = run({ id: "run-set", scope: { kind: "week" }, status: "failed", error: "gateway_402", request: null, finishedAt: `${TODAY}T08:05:00.000Z` });
    serve({
      "GET /api/coach/runs/current": {
        run: failed,
        events: [ev(1, "note", "Monday's workout is designed.", { proposalId: "dp-run-set" }), ev(2, "error", "The AI account is out of credits — the coach stopped here.")],
        proposal: null,
      },
      "GET /api/coach/proposals/dp-run-set": { id: "dp-run-set", status: "unreviewed", resolvedAt: null, lines: [line("op-a", "Monday hips")], changes: [] },
      "GET /api/templates": { templates: [] },
    });
    mount({ loop: quietLoop(() => failed) });
    await until(() => !!document.querySelector(".coach-fallback"), "the ways to train now");
    expect(document.querySelector(".coach-pc")).toBeNull();
  });

  it("left mid-run and back: the run as the server has it now, never the one the screen kept — a stale run never stepped", async () => {
    let server = run({ id: "run-ret", status: "active" });
    let events = [ev(1, "note", "Read your request and today's plan.")];
    serve({ "GET /api/coach/runs/current": () => json({ run: server, events, proposal: null }) });
    const loop = drivenLoop({ run: () => server, events: () => events });
    mount({ loop: loop.deps });
    await until(() => text().includes("Coach · designing"), "the live run");
    const client = lastClient!;
    // Its step comes back (the next one due in a minute), and the screen is left.
    await loop.answer({ status: "active", nextDue: { runId: "run-ret", role: "main", at: new Date(Date.now() + 60_000).toISOString() }, events: [] });
    act(() => root?.unmount());
    host?.remove();
    // Meanwhile, on another device, the coach asked a question.
    server = run({ id: "run-ret", status: "waiting_athlete" });
    events = [...events, ev(2, "question", "How are the hips today?", { tool: "ask_athlete", data: { questions: [{ text: "How are the hips today?", chips: ["tight"] }] } })];
    const again = drivenLoop({ run: () => server, events: () => events });
    // Back: the client still holds the run as it was — active. The screen waits for the server's word, and shows that.
    mount({ loop: again.deps, client });
    await until(() => !!document.querySelector(".coach-ask"), "the question card");
    expect(text()).toContain("Coach · waiting for you");
    expect(again.stepped).toEqual([]);
  });

  it("a run over, then a live one started elsewhere: the live one is shown and stepped", async () => {
    let current: unknown = { run: null };
    const created = run({ id: "run-a", status: "active" });
    serve({
      "GET /api/coach/runs/current": () => json(current),
      "POST /api/coach/runs": () => json({ run: created, existing: false }),
      "GET /api/templates": { templates: [] },
    });
    let server = created;
    const loop = drivenLoop({ run: () => server });
    mount({ loop: loop.deps });
    await until(() => !!field(), "the composer");
    await click(button("Now"), "Now");
    await until(() => loop.stepped.includes("run-a"), "the first run stepped");
    // It ends with nothing proposed; meanwhile another device started a run.
    server = run({ id: "run-a", status: "finished" });
    current = { run: run({ id: "run-b", status: "active", request: "from the phone" }), events: [ev(1, "note", "Read your request and today's plan.")], proposal: null };
    await loop.answer({ status: "finished", nextDue: null, events: [ev(1, "note", "Nothing was proposed.", { proposed: false })] });
    await until(() => text().includes("“from the phone”"), "the other device's run");
    await until(() => loop.stepped.includes("run-b"), "the live one stepped");
  });

  it("an `existing` run waiting on a question shows the question", async () => {
    const live = run({ id: "run-live-q", status: "waiting_athlete", request: "an older request" });
    const question = ev(2, "question", "How are the hips today?", { tool: "ask_athlete", data: { questions: [{ text: "How are the hips today?", chips: ["tight"] }] } });
    serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": () => json({ run: live, existing: true, offer: "answer_or_cancel", ignoredRequest: { scope: { kind: "now" }, request: "new words" } }),
    });
    const loop = drivenLoop({ run: () => live, events: () => [ev(1, "note", "Read your request and today's plan."), question] });
    mount({ loop: loop.deps });
    await until(() => !!field(), "the composer");
    await type(field()!, "new words");
    // Typing in the composer: the question that appears doesn't take the focus away.
    act(() => field()!.focus());
    await click(button("Now"), "Now");
    await until(() => !!document.querySelector(".coach-ask"), "the question card");
    expect(text()).toContain("How are the hips today?");
    expect(document.activeElement).toBe(field());
    expect(loop.stepped).toEqual([]);
  });

  it("a question that appears takes the focus to its first answer", async () => {
    serve({ "GET /api/coach/runs/current": { run: run(), events: [asked], proposal: null } });
    mount();
    await until(() => !!document.querySelector(".coach-ask"), "the question card");
    expect(document.activeElement?.textContent).toBe("tight");
  });

  it("cancelling the run that was already there keeps the words offered back", async () => {
    const live = run({ id: "run-live", status: "active", request: "an older request", costUsd: 0.1 });
    serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": () => json({ run: live, existing: true, offer: "continue_or_cancel", ignoredRequest: { scope: { kind: "now" }, request: "my new words" } }),
      "POST /api/coach/runs/run-live/cancel": () => json({ run: { ...live, status: "cancelled" } }),
      "GET /api/templates": { templates: [] },
    });
    mount({ loop: quietLoop(() => live) });
    await until(() => !!field(), "the composer");
    await type(field()!, "my new words");
    await click(button("Now"), "Now");
    await until(() => text().includes(EXISTING_LINE), "the existing line");
    await click(button("Cancel"), "Cancel");
    await until(() => text().includes("Coach · cancelled"), "cancelled");
    await click(button("Copy my words back"), "Copy my words back");
    expect(field()!.value).toBe("my new words");
    // Taken back: they are the athlete's draft now, offered no more — edited or not.
    await type(field()!, "my new words, and more");
    expect(button("Copy my words back")).toBeNull();
  });

  it("words offered back are let go when a new run starts", async () => {
    const live = run({ id: "run-k15", status: "active", request: "an older request", costUsd: 0.1 });
    const fresh = run({ id: "run-k15b", status: "finished", request: "other words", finishedAt: `${TODAY}T08:05:00.000Z` });
    let creates = 0;
    serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": () =>
        (creates += 1) === 1
          ? json({ run: live, existing: true, offer: "continue_or_cancel", ignoredRequest: { scope: { kind: "now" }, request: "my new words" } })
          : json({ run: fresh, existing: false }),
      "POST /api/coach/runs/run-k15/cancel": () => json({ run: { ...live, status: "cancelled" } }),
      "GET /api/templates": { templates: [] },
    });
    mount({ loop: quietLoop(() => live) });
    await until(() => !!field(), "the composer");
    await type(field()!, "my new words");
    await click(button("Now"), "Now");
    await until(() => text().includes(EXISTING_LINE), "the existing line");
    await click(button("Cancel"), "Cancel");
    await until(() => !!button("Copy my words back"), "the words offered back");
    await type(field()!, "other words");
    await click(button("Now"), "Now");
    await until(() => text().includes("“other words”"), "the new run");
    await settle(20);
    expect(button("Copy my words back")).toBeNull();
  });

  it("while the run works, a line naming its suggestion is no reason to read it", async () => {
    const live = run({ id: "run-k01", scope: { kind: "week" }, status: "active", request: null });
    const calls = serve({
      "GET /api/coach/runs/current": { run: live, events: [ev(1, "note", "Monday's workout is designed.", { proposalId: "dp-run-k01" })], proposal: null },
      "GET /api/coach/proposals/dp-run-k01": { id: "dp-run-k01", status: "unreviewed", resolvedAt: null, lines: [], changes: [] },
    });
    mount({ loop: quietLoop(() => live) });
    await until(() => text().includes("Monday's workout is designed."), "the live set");
    await settle(30);
    expect(calls.filter((c) => c.path === "/api/coach/proposals/dp-run-k01")).toHaveLength(0);
  });

  it("a run just over stays shown: an older suggestion the next read finds doesn't take its place", async () => {
    let server = run({ id: "run-k05", status: "active", request: "this one" });
    let current: unknown = { run: server, events: [], proposal: null };
    serve({
      "GET /api/coach/runs/current": () => json(current),
      "GET /api/coach/proposals/dp-run-old": { id: "dp-run-old", status: "pending", resolvedAt: null, lines: [line("op-o", "Older hips")], changes: [] },
      "GET /api/templates": { templates: [] },
    });
    const loop = drivenLoop({ run: () => server });
    mount({ loop: loop.deps });
    await until(() => text().includes("“this one”"), "the live run");
    // It ends with nothing proposed; the next read of the current run finds an older run's suggestion still open.
    server = run({ id: "run-k05", status: "finished", request: "this one" });
    current = {
      run: run({ id: "run-old", status: "finished", request: "from before", proposalId: "dp-run-old", finishedAt: `${TODAY}T07:00:00.000Z` }),
      events: [],
      proposal: { id: "dp-run-old", status: "pending", flags: [] },
    };
    await loop.answer({ status: "finished", nextDue: null, events: [ev(1, "note", "Nothing was proposed.", { proposed: false })] });
    await until(() => text().includes("Coach · done"), "the run over");
    await settle(40);
    expect(text()).toContain("“this one”");
    expect(text()).not.toContain("“from before”");
  });

  it("back mid-run with the run kept from before: nothing until this screen's own read — not the composer, not the kept run", async () => {
    const kept = run({ id: "run-k06", status: "active", request: "kept" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    serve({
      "GET /api/coach/runs/current": async () => {
        await gate;
        return json({ run: run({ id: "run-k06", status: "waiting_athlete", request: "kept" }), events: [asked], proposal: null });
      },
    });
    mount({ loop: quietLoop(() => run({ id: "run-k06", status: "waiting_athlete" })), prime: (qc) => qc.setQueryData(COACH_CURRENT_QUERY, { run: kept, events: [], proposal: null }) });
    await settle(30);
    expect(field()).toBeNull();
    expect(document.querySelector(".coach-run")).toBeNull();
    release();
    await until(() => !!document.querySelector(".coach-ask"), "the question, as the server has it");
  });

  it("a kept read that found no run shows the composer at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    serve({
      "GET /api/coach/runs/current": async () => {
        await gate;
        return json({ run: null });
      },
    });
    mount({ prime: (qc) => qc.setQueryData(COACH_CURRENT_QUERY, { run: null }) });
    await settle(10);
    expect(field()).not.toBeNull();
    release();
  });

  it("a run started, the screen left and opened again: never the empty composer while the run is live", async () => {
    const created = run({ id: "run-k10", status: "active", request: "started here" });
    let current: unknown = { run: null };
    let hold = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    serve({
      "GET /api/coach/runs/current": async () => {
        if (hold) await gate;
        return json(current);
      },
      "POST /api/coach/runs": () => {
        current = { run: created, events: [], proposal: null };
        return json({ run: created, existing: false });
      },
    });
    mount({ loop: quietLoop(() => created) });
    await until(() => !!field(), "the composer");
    await type(field()!, "started here");
    await click(button("Now"), "Now");
    await until(() => text().includes("“started here”"), "the run");
    await settle(30);
    const client = lastClient!;
    act(() => root?.unmount());
    host?.remove();
    hold = true;
    mount({ loop: quietLoop(() => created), client });
    await settle(10);
    expect(field()).toBeNull();
    release();
    await until(() => text().includes("“started here”"), "the run, as the server has it");
  });

  it("a stop's line waits for its suggestion's read: no ways to train now shown, then taken back", async () => {
    const failed = run({ id: "run-k08", status: "failed", error: "gateway_402", proposalId: "dp-run-k08", finishedAt: `${TODAY}T08:05:00.000Z` });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    serve({
      "GET /api/coach/runs/current": { run: failed, events: [ev(1, "error", "The AI account is out of credits — the coach stopped here.")], proposal: null },
      "GET /api/coach/proposals/dp-run-k08": async () => {
        await gate;
        return json({ id: "dp-run-k08", status: "pending", resolvedAt: null, lines: [line("op-a", "Reviewed hips")], changes: [] });
      },
      "GET /api/templates": { templates: [] },
    });
    mount({ loop: quietLoop(() => failed) });
    await until(() => text().includes("Coach · "), "the run");
    await settle(40);
    expect(document.querySelector(".coach-fallback")).toBeNull();
    release();
    await until(() => text().includes("Reviewed hips"), "the suggestion");
    expect(document.querySelector(".coach-fallback")).toBeNull();
  });

  it("offline, a start says it couldn't reach the coach — it doesn't wait silently", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    await until(() => !!field(), "the composer");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    onlineManager.setOnline(false);
    try {
      await click(button("Now"), "Now");
      await until(() => text().includes("Couldn't reach the coach — try again."), "the line");
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

describe("a run that stopped with what was reviewed", () => {
  it("the failure line first, then the suggestion with its stop's note — no tiles", async () => {
    const stopped = run({ status: "stopped_cap", error: "run_ceiling", proposalId: null, finishedAt: `${TODAY}T08:05:00.000Z` });
    const note = "The coach stopped at this design's spending limit; this is what had been reviewed by then.";
    serve({
      "GET /api/coach/runs/current": {
        run: stopped,
        events: [ev(1, "note", "This design reached its spending limit ($1.50) — the coach stopped here."), ev(2, "note", "Proposed what had been reviewed before the stop.", { proposalId: "dp-run-1" })],
        proposal: { id: "dp-run-1", status: "pending", flags: [note] },
      },
      "GET /api/coach/proposals/dp-run-1": {
        id: "dp-run-1",
        status: "pending",
        resolvedAt: null,
        lines: [
          {
            opId: "op-a", kind: "new", date: TODAY, time: null, title: "Hips, reviewed", minutes: 20, summary: "Hips, reviewed · 20 min", effort: "Maintain", place: "Home",
            parts: ["Main"], detail: [], reviewMean: 4.5, review: null, issues: [], outcome: null, written: null,
          },
        ],
        changes: [],
      },
    });
    mount({ loop: quietLoop(() => stopped) });
    await until(() => text().includes("Hips, reviewed"), "the card");
    const failure = document.querySelector(".coach-run-failure")!;
    const card = document.querySelector(".coach-pc")!;
    expect(failure.textContent).toBe("This design reached its spending limit. Start a new one when you're ready.");
    expect(failure.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.textContent).toContain(note);
    expect(document.querySelector(".coach-fallback")).toBeNull();
  });
});

describe("ways to train now", () => {
  it("out of credits, nothing proposed: said once, then today's session — a pinned template is among the quick starts below", async () => {
    const today = {
      ...todayDto(null),
      todaySessions: [{ workout: { id: "w-prog", origin: "program", title: "Strength A", completionState: "scheduled", contentState: "built" }, build: { minutes: 35 } }],
    } as unknown as TodayResponse;
    const template: TemplateDto = {
      id: "t1", name: "Morning flow", doc: null, pinned: true, uses: 3, lastUsedAt: null, createdAt: "", updatedAt: "", minutes: 20, discipline: "yoga",
    };
    const stopped = run({ status: "failed", error: "gateway_402", finishedAt: `${TODAY}T08:05:00.000Z` });
    serve({
      "GET /api/coach/runs/current": { run: stopped, events: [ev(1, "error", "The AI account is out of credits — the coach stopped here."), ev(2, "note", "Nothing was proposed.")], proposal: null },
      "GET /api/templates": { templates: [{ ...template, doc: { version: 1, title: "Morning flow", intent: { summary: "", goals: [], focus: [], effort: "maintain" }, parts: [], source: { kind: "studio" } } }] },
    });
    mount({ today, loop: quietLoop(() => stopped) });
    await until(() => !!document.querySelector(".coach-fallback .stu-qs"), "the ways to train now");
    expect(document.querySelector(".coach-fallback")!.textContent).toContain("The AI account is out of credits. The coach can design again once credits are added.");
    const tiles = [...document.querySelectorAll<HTMLAnchorElement>(".coach-fallback .stu-qs")];
    expect(tiles.map((a) => a.getAttribute("href"))).toEqual(["/plan?workout=w-prog"]);
    expect(tiles.map((a) => a.querySelector(".stu-qs-name")?.textContent)).toEqual(["Strength A"]);
    expect(text()).toContain(QUICK_BELOW_LINE);
    // Said once: the trail that ended in it is folded (the lines one tap down).
    expect(document.querySelector<HTMLElement>(".coach-run-trail")!.hidden).toBe(true);
    // The composer is back, for a new request.
    expect(field()).not.toBeNull();
  });
});

// ── Fix wave 3B, Part U ─────────────────────────────────────────────────────

describe("fix wave 3B: the composer", () => {
  const coachPrefs = (coach: { defaultScope?: "now" | "later_today" | "week" | "next_n"; nextN?: number }) => ({
    coach,
    settings: { defaultScope: coach.defaultScope ?? "now", nextN: coach.nextN ?? 3, trainingTimes: [], ceilingsUsd: { day: 1.5, set: 6 } },
    model: { id: "m", name: "The coach's model" },
  });

  it("an 'Ask the coach' heading over it, in the quick starts' eyebrow; the group is named by it (B-I10)", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    await until(() => !!field(), "the composer");
    const h = document.querySelector<HTMLElement>(".coach-composer-box h2.eyebrow")!;
    expect(h.textContent).toBe("Ask the coach");
    expect(document.querySelector(".coach-composer-box")!.getAttribute("aria-labelledby")).toBe(h.id);
  });

  it("before the tap, what a week plan costs; Plan ahead's menu says Next 7 days, never 'This week' (M4, M8)", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    await until(() => !!field(), "the composer");
    expect(document.querySelector(".coach-composer-cost")?.textContent).toBe("A week plan usually costs about $3–5.");
    await click(button("Plan ahead"), "Plan ahead");
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toEqual(["Next 7 days", "Next 3 workouts"]);
    expect(text()).not.toContain("This week");
  });

  it("a set as the default: Plan ahead is one tap — it starts that set at once; a small ▾ opens the menu (M10)", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "GET /api/coach/preferences": coachPrefs({ defaultScope: "next_n", nextN: 5 }),
      "POST /api/coach/runs": (body: any) => json({ run: run({ scope: body.scope, status: "active" }), existing: false }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => !!document.querySelector(".coach-scope-more"), "the ▾");
    const more = document.querySelector<HTMLButtonElement>(".coach-scope-more")!;
    expect(more.getAttribute("aria-label")).toBe("More ways to plan ahead");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect([...document.querySelectorAll<HTMLButtonElement>(".coach-composer-actions .btn-primary")].map((b) => b.textContent?.trim())).toEqual(["Plan ahead"]);
    await click(more, "the ▾");
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toEqual(["Next 7 days", "Next 5 workouts · your default"]);
    await click(more, "the ▾ again");
    await click(button("Plan ahead"), "Plan ahead");
    await until(() => posts(calls, "/api/coach/runs").length === 1, "the start");
    expect(posts(calls, "/api/coach/runs")[0]!.body).toEqual({ scope: { kind: "next_n", n: 5 }, request: null });
  });

  it("the next 7 days as the default: one tap starts them", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "GET /api/coach/preferences": coachPrefs({ defaultScope: "week" }),
      "POST /api/coach/runs": (body: any) => json({ run: run({ scope: body.scope, status: "active" }), existing: false }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => !!document.querySelector(".coach-scope-more"), "the ▾");
    await click(button("Plan ahead"), "Plan ahead");
    await until(() => posts(calls, "/api/coach/runs").length === 1, "the start");
    expect(posts(calls, "/api/coach/runs")[0]!.body).toEqual({ scope: { kind: "week" }, request: null });
  });

  it("not a set as the default: Plan ahead opens its menu, no ▾ beside it", async () => {
    serve({ "GET /api/coach/runs/current": { run: null }, "GET /api/coach/preferences": coachPrefs({ defaultScope: "now" }) });
    mount();
    await until(() => !!field(), "the composer");
    await settle(20);
    expect(document.querySelector(".coach-scope-more")).toBeNull();
    expect(button("Plan ahead")!.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("the existing run's notice says how to ask for something new (M10)", () => {
    expect(EXISTING_LINE).toContain("Cancel it to ask for something new.");
  });

  it("arriving with a request (the board's 'Ask the coach for a test'): the field holds it, focused (B-I11)", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount({ state: { coach: "compose", request: "A test for: Plank hold" } });
    await until(() => !!field(), "the composer");
    expect(field()!.value).toBe("A test for: Plank hold");
    expect(document.activeElement).toBe(field());
  });
});

describe("fix wave 3B: the question, the trail, the focus", () => {
  it("a chosen chip says so: pressed, filled, and a ✓ — never colour alone (B-C1)", async () => {
    serve({ "GET /api/coach/runs/current": { run: run(), events: [asked], proposal: null } });
    mount();
    await until(() => text().includes("How are the hips today?"), "the question");
    const chip = () => [...document.querySelectorAll<HTMLButtonElement>(".coach-ask .chip")].find((b) => b.textContent?.includes("tight"))!;
    expect(chip().textContent).toBe("tight");
    await click(chip(), "the chip");
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().textContent).toBe("✓tight");
    expect(chip().querySelector('[aria-hidden="true"]')?.textContent).toBe("✓");
    // Chosen again: not chosen, no ✓.
    await click(chip(), "the chip again");
    expect(chip().textContent).toBe("tight");
  });

  it("after Send, the trail is read before the next step: 'You answered…' shows live, with its Undo (B-I2)", async () => {
    // Its own run: a step another test left out on run-1 would hold this one's (the tab's one-step-a-run registry).
    let server = run({ id: "run-i2" });
    let events: CoachRunEventDto[] = [ev(1, "note", "Read your request and today's plan."), asked];
    const calls = serve({
      "GET /api/coach/runs/current": () => json({ run: server, events, proposal: null }),
      "POST /api/coach/runs/run-i2/answer": () => {
        server = run({ id: "run-i2", status: "active" });
        events = [...events, ev(3, "note", "You answered: tight", { answers: ["tight"], receipt: { undo: { handle: "run-i2:toolu_3" } } })];
        return json({ run: server });
      },
    });
    const loop = drivenLoop({ run: () => server, events: () => events });
    mount({ loop: loop.deps });
    await until(() => text().includes("How are the hips today?"), "the question");
    await click(button("tight"), "the chip");
    await click(button("Send"), "Send");
    await until(() => posts(calls, "/api/coach/runs/run-i2/answer").length === 1, "the answer");
    // The next step goes out and never answers (within the poll's 2 s, nothing else reads): the line is the read's,
    // made before the step.
    await until(() => loop.stepped.length === 1, "the next step");
    expect(text()).toContain("You answered: tight");
    expect(button("Undo")).not.toBeNull();
  });

  it("after Now, the focus goes to the run's heading — the composer it was in is gone (B-I9)", async () => {
    serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": (body: any) => json({ run: run({ scope: body.scope, request: body.request, status: "active" }), existing: false }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => !!field(), "the composer");
    await click(button("Now"), "Now");
    await until(() => document.activeElement?.classList.contains("coach-run-title") === true, "the focus on the run's heading");
    expect(document.activeElement?.textContent).toBe("Coach · designing");
  });

  it("after an answer — a chip sent, a check saved — the focus goes back to the run (B-I9)", async () => {
    serve({
      "GET /api/coach/runs/current": { run: run(), events: [asked], proposal: null },
      "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => text().includes("How are the hips today?"), "the question");
    await click(button("tight"), "the chip");
    await click(button("Send"), "Send");
    await until(() => document.activeElement?.classList.contains("coach-run-title") === true, "the focus on the run");
  });

  it("the check ask's sheet saved: the focus goes back to the run (B-I9)", async () => {
    const check = ev(2, "question", "The coach asks you to log today's condition check.", { tool: "ask_athlete", data: { check: "condition", why: "Landing drills need it." } });
    serve({
      "GET /api/coach/runs/current": { run: run(), events: [check], proposal: null },
      "POST /api/conditions/checks": (body: any) => json({ check: { id: "chk-9", profileId: body.profileId, date: TODAY, value: body.value, feelingOff: false } }),
      "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => !!button("Do the jaw check"), "the check's button");
    await click(button("Do the jaw check"), "Do the jaw check");
    const sheet = document.querySelector('[role="dialog"]')!;
    await click([...sheet.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "2"), "a reading");
    await click(button("Save", sheet), "Save");
    await until(() => document.activeElement?.classList.contains("coach-run-title") === true, "the focus on the run");
  });

  it("once over, the trail folds to one line; one tap opens it (B-I7)", async () => {
    const over = run({ status: "finished", finishedAt: `${TODAY}T08:05:00.000Z` });
    serve({
      "GET /api/coach/runs/current": { run: over, events: [ev(1, "note", "Read your request and today's plan."), ev(2, "note", "Nothing was proposed.", { proposed: false })], proposal: null },
      "GET /api/templates": { templates: [] },
    });
    mount({ loop: quietLoop(() => over) });
    await until(() => !!button(TRAIL_FOLD_LINE), "the fold");
    const trail = () => document.querySelector<HTMLElement>(".coach-run-trail")!;
    expect(trail().hidden).toBe(true);
    expect(button(TRAIL_FOLD_LINE)!.getAttribute("aria-expanded")).toBe("false");
    await click(button(TRAIL_FOLD_LINE), "the fold");
    expect(trail().hidden).toBe(false);
    expect(button(TRAIL_FOLD_LINE)!.getAttribute("aria-expanded")).toBe("true");
    expect(trail().textContent).toContain("Read your request and today's plan.");
  });
});
