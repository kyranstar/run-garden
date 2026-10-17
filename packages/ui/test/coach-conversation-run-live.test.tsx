// @vitest-environment jsdom
/**
 * THE RUN INSIDE THE CONVERSATION (the new shape §5, stream C) — what the Studio's coach did with a run, now that the
 * run is a turn of the conversation (ported from Stage 3 Task 9's and fix wave 3B's journeys; the composer's scope
 * buttons are gone, so are their cases):
 *
 *  - The question: one question answers with one tap (or Skip); two questions keep the form — chips pressed with a ✓,
 *    words typed winning, Send; a refusal says the server's words; today's condition check is the app's own sheet,
 *    and its saved id answers — only after the save is back.
 *  - Undo on a kept answer's line while the run is live; on a Remembered line in a turn's trail once it is over.
 *  - Cancel: at once under $0.50, asked first above.
 *  - The focus: a send moves it to the run's heading; an answer back to it; a question that appears takes it to its
 *    first answer unless the athlete is typing.
 *  - A live run the server holds (started elsewhere, or left mid-run) is the one shown and stepped — never a stale one.
 *  - While a run works a line naming its suggestion is no reason to read it; when it ends the conversation is read
 *    again and its card shows.
 *  - The box's counter near the limit; a 404 from the coach's routes, one quiet line; offline, one line.
 *
 * The server is a stubbed fetch; the step loop is a stand-in. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { onlineManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationDto, CoachRunDto, CoachRunEventDto, CoachRunStepResult, TodayResponse } from "@rg/api-client";
import { CoachConversation, COUNTER_FROM, REQUEST_MAX_CHARS } from "../src/screens/studio/coach-conversation.js";
import { emptyStudioCtx } from "../src/screens/studio/model.js";
import { COACH_CURRENT_QUERY } from "../src/screens/studio/run-keeper.js";
import { NOT_AVAILABLE_LINE, TRAIL_FOLD_LINE } from "../src/screens/studio/run-model.js";
import type { LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { button, click, json, settle, text, type, until, type Call } from "./coach-live-harness.js";
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
/** A two-question ask: the form, with Send. */
const askedTwo = ev(2, "question", "How are the hips today?", {
  tool: "ask_athlete",
  data: {
    questions: [
      { text: "How are the hips today?", chips: ["tight", "okay"] },
      { text: "Home or the gym?", chips: ["Home", "Gym"] },
    ],
  },
});
const NONE: CoachConversationDto = { id: null, startedAt: null, turns: [] };

/** The server: `routes` by "METHOD path"; the conversation none unless given; anything else a 503. */
function serve(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  const all: Record<string, unknown> = { "GET /api/coach/conversation": NONE, "GET /api/templates": { templates: [] }, "GET /api/objectives": { objectives: [] }, ...routes };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input).split("?")[0]!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, query: "", body });
      const answer = all[`${method} ${path}`];
      if (answer === undefined) return json({ error: "offline" }, 503);
      const out = typeof answer === "function" ? await (answer as (b: unknown) => unknown)(body) : answer;
      return out instanceof Response ? out.clone() : json(out);
    }),
  );
  return calls;
}

/** The loop's stand-in: its step never answers; its read answers `run` and `events`. */
const quietLoop =
  (r: () => CoachRunDto, events: () => CoachRunEventDto[] = () => []) =>
  (): LoopDeps => ({
    step: () => new Promise(() => undefined),
    read: async () => ({ run: r(), events: events() }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    visible: () => true,
    onVisibility: () => () => undefined,
  });

/** A loop the test drives: each step waits for `answer`; the read answers the server's run and its events after `afterSeq`. */
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

function mount(o: { today?: TodayResponse; loop?: () => LoopDeps; client?: QueryClient; prime?: (qc: QueryClient) => void } = {}) {
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
          { initialEntries: ["/plan"] },
          createElement(CoachConversation, { ctx: { ...emptyStudioCtx, profiles: [] }, loopDeps: o.loop ?? quietLoop(() => run()) }),
        ),
      ),
    );
  });
}

const box = () => document.querySelector<HTMLTextAreaElement>(".coach-box textarea");
const sendButton = () => document.querySelector<HTMLButtonElement>(".coach-box button[type=submit]");
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);
const live = (r: CoachRunDto, events: CoachRunEventDto[]) => ({ "GET /api/coach/runs/current": { run: r, events, proposal: null } });

describe("the question", () => {
  it("one question: one tap on an answer sends it, and the run goes on", async () => {
    let server = run();
    const calls = serve({
      ...live(run(), [ev(1, "note", "Read the request."), asked]),
      "POST /api/coach/runs/run-1/answer": () => json({ run: (server = run({ status: "active" })) }),
    });
    mount({ loop: quietLoop(() => server, () => [ev(1, "note", "Read the request."), asked]) });
    await until(() => !!button("tight"), "the answers");
    // No Send to wait on, and no field of its own: the box below answers in the athlete's words.
    expect(button("Send")).toBeNull();
    expect(document.querySelector(".coach-ask-words")).toBeNull();
    await click(button("tight"), "the answer");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the answer sent");
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ answers: ["tight"] });
    await until(() => text().includes("Coach · designing"), "the run going on");
  });

  it("Skip posts dismissed: the coach goes on with its best judgement", async () => {
    const calls = serve({ ...live(run(), [asked]), "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }) });
    mount({ loop: quietLoop(() => run(), () => [asked]) });
    await until(() => !!button("Skip"), "Skip");
    await click(button("Skip"), "Skip");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the skip");
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ dismissed: true });
  });

  it("an answer the server refuses says its words", async () => {
    serve({
      ...live(run(), [asked]),
      "POST /api/coach/runs/run-1/answer": json({ error: "bad_answer", why: "The coach asked a question, not for a condition check." }, 400),
    });
    mount({ loop: quietLoop(() => run(), () => [asked]) });
    await until(() => !!button("tight"), "the answers");
    await click(button("tight"), "the answer");
    await until(() => text().includes("The coach asked a question, not for a condition check."), "the refusal");
  });

  it("two questions keep the form: chips pressed with a ✓ (never colour alone), words typed win, Send posts one answer each", async () => {
    const calls = serve({ ...live(run(), [askedTwo]), "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }) });
    mount({ loop: quietLoop(() => run(), () => [askedTwo]) });
    await until(() => !!button("Send"), "the form");
    expect(button("Send")!.disabled).toBe(true);
    const chip = () => [...document.querySelectorAll<HTMLButtonElement>(".coach-ask .chip")].find((b) => b.textContent?.includes("tight"))!;
    await click(chip(), "the chip");
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().textContent).toBe("✓tight");
    expect(chip().querySelector('[aria-hidden="true"]')?.textContent).toBe("✓");
    await type(document.querySelectorAll<HTMLInputElement>(".coach-ask-words")[1]!, "the park");
    await click(button("Gym"), "a chip the words win over");
    await type(document.querySelectorAll<HTMLInputElement>(".coach-ask-words")[1]!, "the park");
    await click(button("Send"), "Send");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the answer");
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ answers: ["tight", "the park"] });
  });

  it("a question that appears takes the focus to its first answer", async () => {
    serve(live(run(), [asked]));
    mount({ loop: quietLoop(() => run(), () => [asked]) });
    await until(() => !!document.querySelector(".coach-ask"), "the question");
    await until(() => document.activeElement?.textContent === "tight", "the focus on the first answer");
  });

  it("after an answer, the focus goes back to the run (B-I9)", async () => {
    serve({ ...live(run(), [asked]), "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }) });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => !!button("tight"), "the answers");
    await click(button("tight"), "the answer");
    await until(() => document.activeElement?.classList.contains("coach-run-title") === true, "the focus on the run");
  });

  it("after an answer, the trail is read before the next step: 'You answered…' shows live, with its Undo (B-I2)", async () => {
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
    await until(() => !!button("tight"), "the answers");
    await click(button("tight"), "the answer");
    await until(() => posts(calls, "/api/coach/runs/run-i2/answer").length === 1, "the answer");
    await until(() => loop.stepped.length === 1, "the next step");
    expect(text()).toContain("You answered: tight");
    expect(button("Undo")).not.toBeNull();
  });
});

describe("Undo", () => {
  it("on the kept answer's line, while the run is live: its handle", async () => {
    const answered = ev(3, "note", "You answered: tight", { answers: ["tight"], receipt: { undo: { handle: "run-1:toolu_7" } } });
    const r = run({ status: "active" });
    const calls = serve({ ...live(r, [asked, answered]), "POST /api/coach/runs/run-1/undo-answer": { undone: 1 } });
    mount({ loop: quietLoop(() => r, () => [asked, answered]) });
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
  const overTurn = (runId: string): CoachConversationDto => ({
    id: runId,
    startedAt: `${TODAY}T08:00:00.000Z`,
    turns: [{ runId, at: `${TODAY}T08:00:00.000Z`, words: "Knees like a long warm-up", status: "finished", line: "Noted.", cards: [], question: null }],
  });

  it("on a Remembered line in a turn's trail, the run over: the memory taken back, the memory list read again", async () => {
    const over = run({ id: "run-rm", status: "finished", finishedAt: `${TODAY}T08:05:00.000Z` });
    const calls = serve({
      "GET /api/coach/runs/current": { run: null },
      "GET /api/coach/conversation": overTurn("run-rm"),
      "GET /api/coach/runs/run-rm": { run: over, events: [ev(1, "note", "Read your request and today's plan."), remembered("run-rm")] },
      "POST /api/coach/runs/run-rm/undo-answer": { undone: 1 },
    });
    mount({ prime: (qc) => qc.setQueryData(["coach-memory"], { memory: [] }) });
    await until(() => !!button(TRAIL_FOLD_LINE), "the turn's trail");
    await click(button(TRAIL_FOLD_LINE), "the trail");
    await until(() => !!button("Undo"), "Undo on the Remembered line");
    await click(button("Undo"), "Undo");
    await until(() => posts(calls, "/api/coach/runs/run-rm/undo-answer").length === 1, "the undo");
    expect(posts(calls, "/api/coach/runs/run-rm/undo-answer")[0]!.body).toEqual({ handle: "rm:run-rm:toolu_1" });
    await until(() => lastClient!.getQueryState(["coach-memory"])?.isInvalidated === true, "the memory list read again");
  });

  it("on a Remembered line already taken back (404): said plainly, and not offered again", async () => {
    const over = run({ id: "run-rm2", status: "finished", finishedAt: `${TODAY}T08:05:00.000Z` });
    serve({
      "GET /api/coach/runs/current": { run: null },
      "GET /api/coach/conversation": overTurn("run-rm2"),
      "GET /api/coach/runs/run-rm2": { run: over, events: [remembered("run-rm2")] },
      "POST /api/coach/runs/run-rm2/undo-answer": () => json({ error: "not_found" }, 404),
    });
    mount();
    await until(() => !!button(TRAIL_FOLD_LINE), "the turn's trail");
    await click(button(TRAIL_FOLD_LINE), "the trail");
    await until(() => !!button("Undo"), "Undo");
    await click(button("Undo"), "Undo");
    await until(() => text().includes("That memory was already taken back."), "the plain words");
    expect(button("Undo")).toBeNull();
  });
});

describe("today's condition check", () => {
  const check = ev(2, "question", "The coach asks you to log today's condition check.", { tool: "ask_athlete", data: { check: "condition", why: "Landing drills need today's check." } });

  it("the why as text, the app's own sheet — the saved check's id answers, after the save is back; the focus back to the run", async () => {
    let saved = false;
    const calls = serve({
      ...live(run(), [check]),
      "POST /api/conditions/checks": (body: any) => {
        saved = true;
        return json({ check: { id: "chk-1", profileId: body.profileId, date: TODAY, value: body.value, feelingOff: false } });
      },
      "POST /api/coach/runs/run-1/answer": () => {
        expect(saved).toBe(true);
        return json({ run: run({ status: "active" }) });
      },
    });
    // Once answered, the server's run is at work again.
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => text().includes("Landing drills need today's check."), "the why");
    // The check is the coach's ask: the box answers nothing.
    expect(box()!.placeholder).not.toBe("Answer in your own words");
    await click(button("Do the jaw check"), "the check's button");
    const sheet = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    await click([...sheet.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "2"), "a reading");
    await click(button("Save", sheet), "Save");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the answer");
    expect(posts(calls, "/api/conditions/checks")[0]!.body).toEqual({ profileId: "tmj", value: 2, feelingOff: false });
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ conditionCheckId: "chk-1" });
    await until(() => document.activeElement?.classList.contains("coach-run-title") === true, "the focus on the run");
  });

  it("Skip posts dismissed; a saved check with no id answers nothing, and says so", async () => {
    const calls = serve({
      ...live(run(), [check]),
      "POST /api/conditions/checks": (body: any) => json({ check: { profileId: body.profileId, date: TODAY, value: body.value, feelingOff: false } }),
      "POST /api/coach/runs/run-1/answer": () => json({ run: run({ status: "active" }) }),
    });
    mount({ loop: quietLoop(() => run(), () => [check]) });
    await until(() => !!button("Do the jaw check"), "the check's button");
    await click(button("Do the jaw check"), "the check's button");
    const sheet = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    await click([...sheet.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "1"), "a reading");
    await click(button("Save", sheet), "Save");
    await until(() => text().includes("Couldn't save that — try again."), "the line");
    expect(posts(calls, "/api/coach/runs/run-1/answer")).toHaveLength(0);
    await click(button("Skip"), "Skip");
    await until(() => posts(calls, "/api/coach/runs/run-1/answer").length === 1, "the skip");
    expect(posts(calls, "/api/coach/runs/run-1/answer")[0]!.body).toEqual({ dismissed: true });
  });
});

describe("Cancel", () => {
  it("under $0.50 it cancels at once; above, it asks first", async () => {
    const cheap = run({ status: "active", costUsd: 0.2 });
    const calls = serve({ ...live(cheap, [ev(1, "note", "Read the request.")]), "POST /api/coach/runs/run-1/cancel": () => json({ run: run({ status: "cancelled", costUsd: 0.2 }) }) });
    mount({ loop: quietLoop(() => cheap) });
    await until(() => !!button("Cancel"), "Cancel");
    await click(button("Cancel"), "Cancel");
    await until(() => posts(calls, "/api/coach/runs/run-1/cancel").length === 1, "the cancel");
    act(() => root?.unmount());
    host?.remove();

    const dear = run({ status: "active", costUsd: 0.62 });
    const calls2 = serve({ ...live(dear, [ev(1, "note", "Read the request.")]), "POST /api/coach/runs/run-1/cancel": () => json({ run: run({ status: "cancelled", costUsd: 0.62 }) }) });
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

describe("the run shown", () => {
  it("a send moves the focus to the run's heading (B-I9)", async () => {
    serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": (body: any) => json({ run: run({ request: body.request, status: "active" }), existing: false, conversationId: "run-1" }),
    });
    mount({ loop: quietLoop(() => run({ status: "active" })) });
    await until(() => !!box(), "the box");
    await type(box()!, "hips");
    await click(sendButton(), "Send");
    await until(() => document.activeElement?.classList.contains("coach-run-title") === true, "the focus on the run's heading");
    expect(document.activeElement?.textContent).toBe("Coach · designing");
  });

  it("the run already there waiting on a question shows the question; typing in the box keeps the focus", async () => {
    const there = run({ id: "run-live-q", status: "waiting_athlete", request: "an older request" });
    const question = ev(2, "question", "How are the hips today?", { tool: "ask_athlete", data: { questions: [{ text: "How are the hips today?", chips: ["tight"] }] } });
    serve({
      "GET /api/coach/runs/current": { run: null },
      "POST /api/coach/runs": () => json({ run: there, existing: true, offer: "answer_or_cancel", ignoredRequest: { scope: { kind: "now" }, request: "new words" } }),
    });
    const loop = drivenLoop({ run: () => there, events: () => [ev(1, "note", "Read your request and today's plan."), question] });
    mount({ loop: loop.deps });
    await until(() => !!box(), "the box");
    await type(box()!, "new words");
    act(() => box()!.focus());
    await click(sendButton(), "Send");
    await until(() => !!document.querySelector(".coach-ask"), "the question card");
    expect(text()).toContain("The coach is waiting for your answer below.");
    expect(document.activeElement).toBe(box());
    expect(loop.stepped).toEqual([]);
  });

  it("a run over, then a live one started elsewhere: the live one is shown and stepped", async () => {
    let current: unknown = { run: null };
    let conv: CoachConversationDto = NONE;
    const created = run({ id: "run-a", status: "active", request: "here" });
    serve({
      "GET /api/coach/runs/current": () => json(current),
      "GET /api/coach/conversation": () => json(conv),
      "POST /api/coach/runs": () => {
        conv = { id: "run-a", startedAt: "x", turns: [{ runId: "run-a", at: "x", words: "here", status: "active", line: null, cards: [], question: null }] };
        return json({ run: created, existing: false, conversationId: "run-a" });
      },
    });
    let server = created;
    const loop = drivenLoop({ run: () => server });
    mount({ loop: loop.deps });
    await until(() => !!box(), "the box");
    await type(box()!, "here");
    await click(sendButton(), "Send");
    await until(() => loop.stepped.includes("run-a"), "the first run stepped");
    // It ends with nothing proposed; meanwhile another device started a run.
    server = run({ id: "run-a", status: "finished" });
    conv = { id: "run-a", startedAt: "x", turns: [{ runId: "run-a", at: "x", words: "here", status: "finished", line: "Nothing to change today.", cards: [], question: null }] };
    current = { run: run({ id: "run-b", status: "active", request: "from the phone" }), events: [ev(1, "note", "Read your request and today's plan.")], proposal: null };
    await loop.answer({ status: "finished", nextDue: null, events: [] });
    await until(() => text().includes("from the phone"), "the other device's run");
    await until(() => loop.stepped.includes("run-b"), "the live one stepped");
    expect(text()).toContain("Nothing to change today.");
  });

  it("left mid-run and back: the run as the server has it now, never the one kept — a stale run never stepped", async () => {
    let server = run({ id: "run-ret", status: "active" });
    let events = [ev(1, "note", "Read your request and today's plan.")];
    serve({ "GET /api/coach/runs/current": () => json({ run: server, events, proposal: null }) });
    const loop = drivenLoop({ run: () => server, events: () => events });
    mount({ loop: loop.deps });
    await until(() => text().includes("Coach · designing"), "the live run");
    const client = lastClient!;
    await loop.answer({ status: "active", nextDue: { runId: "run-ret", role: "main", at: new Date(Date.now() + 60_000).toISOString() }, events: [] });
    act(() => root?.unmount());
    host?.remove();
    server = run({ id: "run-ret", status: "waiting_athlete" });
    events = [...events, ev(2, "question", "How are the hips today?", { tool: "ask_athlete", data: { questions: [{ text: "How are the hips today?", chips: ["tight"] }] } })];
    const again = drivenLoop({ run: () => server, events: () => events });
    mount({ loop: again.deps, client });
    await until(() => !!document.querySelector(".coach-ask"), "the question card");
    expect(text()).toContain("Coach · waiting for you");
    expect(again.stepped).toEqual([]);
  });

  it("back with the run kept from before: never the kept run — the server's", async () => {
    const kept = run({ id: "run-k06", status: "active", request: "kept" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    serve({
      "GET /api/coach/runs/current": async () => {
        await gate;
        return json({ run: run({ id: "run-k06", status: "waiting_athlete", request: "kept" }), events: [asked], proposal: null });
      },
    });
    mount({ loop: quietLoop(() => run({ id: "run-k06", status: "waiting_athlete" }), () => [asked]), prime: (qc) => qc.setQueryData(COACH_CURRENT_QUERY, { run: kept, events: [], proposal: null }) });
    await settle(30);
    expect(document.querySelector(".coach-run")).toBeNull();
    release();
    await until(() => !!document.querySelector(".coach-ask"), "the question, as the server has it");
  });

  it("a live set, the week tighter than its limit: what the week has left beside its estimate", async () => {
    const set = run({ scope: { kind: "week" }, status: "waiting_set", estimateUsd: 4.2, ceilingUsd: 6, costUsd: 0.5, request: null });
    serve({ ...live(set, [ev(1, "tool_result", "Planned the set — 4 workouts", { tool: "plan_set", ok: true })]), "GET /api/coach/spend": { spentMicros: 17_900_000, cutoffMicros: 20_000_000, warnMicros: 5_000_000 } });
    mount({ loop: quietLoop(() => set) });
    await until(() => text().includes("About $4.20; $2.10 left this week"), "the week's left beside the estimate");
  });

  it("a live set: its estimate beside the limit, and Cancel", async () => {
    const set = run({ scope: { kind: "week" }, status: "waiting_set", estimateUsd: 4.2, ceilingUsd: 6, request: null });
    serve(live(set, [ev(1, "tool_result", "Planned the set — 4 workouts", { tool: "plan_set", ok: true })]));
    mount({ loop: quietLoop(() => set) });
    await until(() => text().includes("About $4.20; the limit is $6.00"), "the estimate");
    expect(text()).toContain("Coach · planning the set");
    expect(button("Cancel")).not.toBeNull();
  });

  it("while the run works, a line naming its suggestion is no reason to read it; when it ends, its card comes with the conversation's read", async () => {
    let server = run({ id: "run-set", scope: { kind: "week" }, status: "active", request: "Plan my week" });
    let conv: CoachConversationDto = {
      id: "run-set",
      startedAt: "x",
      turns: [{ runId: "run-set", at: "x", words: "Plan my week", status: "active", line: null, cards: [], question: null }],
    };
    const designed = ev(2, "note", "Monday's workout is designed.", { proposalId: "dp-run-set" });
    const calls = serve({
      "GET /api/coach/runs/current": () => json({ run: server, events: [designed], proposal: null }),
      "GET /api/coach/conversation": () => json(conv),
      "GET /api/coach/proposals/dp-run-set": {
        id: "dp-run-set",
        status: "pending",
        resolvedAt: null,
        lines: [
          { opId: "op-a", kind: "new", date: TODAY, time: null, title: "Monday hips", minutes: 20, summary: "Monday hips · 20 min", effort: "Maintain", place: "Home", parts: [], detail: [], reviewMean: 4.5, review: null, issues: [], outcome: null, written: null },
        ],
        changes: [],
      },
    });
    const loop = drivenLoop({ run: () => server, events: () => [designed] });
    mount({ loop: loop.deps });
    await until(() => text().includes("Monday's workout is designed."), "the live set");
    await settle(30);
    expect(calls.filter((c) => c.path === "/api/coach/proposals/dp-run-set")).toHaveLength(0);
    server = run({ id: "run-set", scope: { kind: "week" }, status: "finished", request: "Plan my week", proposalId: "dp-run-set" });
    conv = {
      id: "run-set",
      startedAt: "x",
      turns: [
        {
          runId: "run-set",
          at: "x",
          words: "Plan my week",
          status: "finished",
          line: "One for Monday.",
          cards: [{ kind: "set", proposalId: "dp-run-set", title: "Your week", summary: "1 workout · Mon 19 Oct", status: "pending" }],
          question: null,
        },
      ],
    };
    await loop.answer({ status: "finished", nextDue: null, events: [] });
    await until(() => text().includes("Monday hips"), "the set's card");
    expect(text()).toContain("One for Monday.");
  });
});

describe("the box, the coach off, offline", () => {
  it("the counter shows only near the limit", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    await until(() => !!box(), "the box");
    expect(box()!.maxLength).toBe(REQUEST_MAX_CHARS);
    await type(box()!, "x".repeat(COUNTER_FROM - 1));
    expect(document.querySelector(".coach-composer-count")).toBeNull();
    await type(box()!, "x".repeat(COUNTER_FROM));
    expect(document.querySelector(".coach-composer-count")?.textContent).toBe(`${COUNTER_FROM} / ${REQUEST_MAX_CHARS}`);
  });

  it("a 404 from the coach's routes: one quiet line, said once — nothing asked again, no box", async () => {
    const calls = serve({ "GET /api/coach/runs/current": json({ error: "not_found" }, 404), "GET /api/coach/conversation": json({ error: "not_found" }, 404) });
    mount();
    await until(() => text().includes(NOT_AVAILABLE_LINE), "the quiet line");
    await settle(50);
    expect(calls.filter((c) => c.path === "/api/coach/runs/current")).toHaveLength(1);
    expect(document.querySelectorAll(".coach-off")).toHaveLength(1);
    expect(box()).toBeNull();
  });

  it("a 404 when sending: the quiet line, and nothing asked for again", async () => {
    const calls = serve({ "GET /api/coach/runs/current": { run: null }, "POST /api/coach/runs": json({ error: "not_found" }, 404) });
    mount();
    await until(() => !!box(), "the box");
    await type(box()!, "hips");
    await click(sendButton(), "Send");
    await until(() => text().includes(NOT_AVAILABLE_LINE), "the quiet line");
    await settle(50);
    expect(posts(calls, "/api/coach/runs")).toHaveLength(1);
  });

  it("offline, a send says it couldn't reach the coach — it doesn't wait silently", async () => {
    serve({ "GET /api/coach/runs/current": { run: null } });
    mount();
    await until(() => !!box(), "the box");
    await type(box()!, "hips");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    onlineManager.setOnline(false);
    try {
      await click(sendButton(), "Send");
      await until(() => text().includes("Couldn't reach the coach — try again."), "the line");
    } finally {
      onlineManager.setOnline(true);
    }
  });
});
