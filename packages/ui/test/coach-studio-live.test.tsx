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
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachRunDto, CoachRunEventDto, TemplateDto, TodayResponse } from "@rg/api-client";
import { StudioCoach, COUNTER_FROM, REQUEST_MAX_CHARS } from "../src/screens/studio/composer.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import type { LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { EXISTING_LINE, NOT_AVAILABLE_LINE, OUT_OF_CREDITS_FALLBACK } from "../src/screens/studio/run-model.js";
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

function mount(o: { today?: TodayResponse; loop?: () => LoopDeps; state?: unknown } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = primedClient({ today: o.today ?? todayDto(null) });
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

  it("Plan ahead offers This week and the next workouts", async () => {
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": (body: any) => json({ run: run({ scope: body.scope, status: "active" }), existing: false }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => !!field(), "the composer");
    await click(button("Plan ahead"), "Plan ahead");
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toEqual(["This week", "Next 3 workouts"]);
    await click(button("Next 3 workouts"), "Next 3 workouts");
    expect(posts(calls, "/api/coach/runs")[0]!.body).toEqual({ scope: { kind: "next_n", n: 3 }, request: null });
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
    const calls = serve({
      "GET /api/coach/runs/current": { run: run(), events: [ev(1, "note", "Read the request."), asked], proposal: null },
      "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }),
    });
    mount();
    await until(() => text().includes("How are the hips today?"), "the question");
    expect(button("Send")!.disabled).toBe(true);
    await click(button("tight"), "the chip");
    expect(button("tight")!.getAttribute("aria-pressed")).toBe("true");
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
    await click(document.querySelector(".condition-chip"), "the check's chip");
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
    await click(document.querySelector(".condition-chip"), "the check's chip");
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
  it("out of credits, nothing proposed: the pinned words over the programme session, a template and a quick start", async () => {
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
    await until(() => text().includes(OUT_OF_CREDITS_FALLBACK), "the pinned words");
    const tiles = [...document.querySelectorAll<HTMLAnchorElement>(".coach-fallback .stu-qs")];
    expect(tiles.map((a) => a.getAttribute("href"))).toEqual(["/plan?workout=w-prog", "/studio/build/template/t1", expect.stringMatching(/^\/studio\/build\/quick\//)]);
    expect(tiles.map((a) => a.querySelector(".stu-qs-name")?.textContent).slice(0, 2)).toEqual(["Strength A", "Morning flow"]);
    // The composer is back, for a new request.
    expect(field()).not.toBeNull();
  });
});
