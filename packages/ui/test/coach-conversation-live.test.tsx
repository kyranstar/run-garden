// @vitest-environment jsdom
/**
 * THE COACH, A CONVERSATION (the new shape §5, stream C) — the app's one coach sheet, live:
 *
 *  - Opened with no conversation: the opening screen — one coach line from the day's own data, starter chips (general,
 *    or for what it sees), "Or start something yourself" (the quick starts, Build your own, Templates, the library) —
 *    and the box, "Ask anything", focused. No time-frame buttons anywhere.
 *  - "Seeing: …" over the box when it was opened from something; ✕ drops it, and the chips go back to the general ones.
 *  - A chip, or the box's words, is the athlete's turn: one run with no scope, the conversation it continues, what the
 *    coach sees as its focus. The words right; the run's trail while it works; then the coach's line, left, with its
 *    mark; cards inline.
 *  - The conversation comes back from the server on every open ("Reply"); "New conversation" in the sheet's menu leaves
 *    it — the opening screen, and the next send starts a new one — and holds across opens.
 *  - Cards: a suggestion still open is its full card; an older one closed is one line of what came of it; changes to
 *    the plan say how many, with Approve all (only the changes) and Look closer.
 *  - A question: one tap on an answer sends it; the box answers it in the athlete's own words.
 *  - The run already there (`existing`), the week's budget, a refused focus, the coach off: each one plain line, the
 *    words kept.
 *
 * The server is a stubbed fetch; the step loop is a stand-in the test drives. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationDto, CoachConversationTurnDto, CoachRunDto, CoachRunEventDto, DesignChangeLineDto, DesignLineDto, TodayResponse } from "@rg/api-client";
import { useCoach, useCoachSeeing } from "../src/screens/studio/coach-ask.js";
import { LEFT_CONVERSATION_KEY } from "../src/screens/studio/coach-conversation-model.js";
import { workoutFocus } from "../src/screens/studio/coach-focus.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import type { LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { button, click, dialog, drivenLoop, json, press, quietLoop, run, serve, settle, text, type, until, type Call, type Routes as Served } from "./coach-live-harness.js";
import { primedClient, todayDto, TODAY } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let client: QueryClient | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const WORKOUT = workoutFocus({ id: "w1", title: "Long run", effectiveDate: TODAY, workoutSeconds: 3600, calendarSeconds: 3600, category: "long", sport: "run" });

const turn = (over: Partial<CoachConversationTurnDto> = {}): CoachConversationTurnDto => ({
  runId: "run-1",
  at: `${TODAY}T08:00:00.000Z`,
  words: "Something for my hips",
  status: "finished",
  line: "Here's a gentle one for your hips.",
  cards: [],
  question: null,
  ...over,
});

const conversation = (turns: CoachConversationTurnDto[], id: string | null = turns[0]?.runId ?? null): CoachConversationDto => ({
  id,
  startedAt: turns[0]?.at ?? null,
  turns,
});

const NONE = conversation([], null);

const line = (opId: string, over: Partial<DesignLineDto> = {}): DesignLineDto =>
  ({
    opId,
    kind: "new",
    date: TODAY,
    time: "18:00",
    title: `Workout ${opId}`,
    minutes: 24,
    summary: `Workout ${opId} · 24 min`,
    effort: "Develop",
    place: "Home",
    parts: [],
    detail: [],
    reviewMean: 4.25,
    review: null,
    issues: [],
    outcome: null,
    written: null,
    ...over,
  }) as DesignLineDto;

const change = (opId: string, over: Partial<DesignChangeLineDto> = {}): DesignChangeLineDto => ({
  opId,
  kind: "skip",
  workoutId: `w-${opId}`,
  date: TODAY,
  time: null,
  summary: `Session ${opId} — skipped`,
  was: null,
  effect: null,
  why: "A lighter week.",
  issues: [],
  outcome: null,
  ...over,
});

/** A screen that registers what it shows and has the nav's Coach button, and a way to leave. */
function Screen({ seeing = null }: { seeing?: typeof WORKOUT | null }) {
  useCoachSeeing(seeing);
  const coach = useCoach();
  const navigate = useNavigate();
  return createElement(
    "div",
    null,
    createElement("button", { type: "button", id: "coach", onClick: () => coach?.open() }, "Coach"),
    createElement("button", { type: "button", id: "leave", onClick: () => navigate("/elsewhere") }, "Leave"),
  );
}

function mount(o: { seeing?: typeof WORKOUT | null; loop?: () => LoopDeps; today?: TodayResponse; children?: ReactNode } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  client = primedClient({ today: o.today ?? todayDto(null) });
  const screen = o.children ?? createElement(Screen, { seeing: o.seeing ?? null });
  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: client! },
        createElement(
          MemoryRouter,
          { initialEntries: ["/plan"] },
          createElement(
            CoachSheetProvider,
            { loopDeps: o.loop ?? quietLoop(() => run()) },
            createElement(
              Routes,
              null,
              createElement(Route, { path: "/plan", element: screen }),
              createElement(Route, { path: "/elsewhere", element: createElement("p", null, "elsewhere") }),
            ),
          ),
        ),
      ),
    );
  });
}

/** The server with no live run, the given conversation, and whatever else the test serves. */
function server(conv: CoachConversationDto | (() => CoachConversationDto), more: Served = {}): Call[] {
  return serve({
    "GET /api/coach/runs/current": { run: null },
    "GET /api/coach/conversation": typeof conv === "function" ? () => json(conv()) : conv,
    "GET /api/templates": { templates: [] },
    "GET /api/objectives": { objectives: [] },
    ...more,
  });
}

const box = () => dialog()?.querySelector<HTMLTextAreaElement>(".coach-box textarea") ?? null;
const sendButton = () => dialog()?.querySelector<HTMLButtonElement>(".coach-box button[type=submit]") ?? null;
const chips = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>(".coach-chips button") ?? [])].map((b) => b.textContent?.trim());
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/coach/runs").map((c) => c.body);
const seeingLine = () => dialog()?.querySelector(".coach-seeing") ?? null;

/** The conversation, or its opening drawn: its reads answered (it holds still until they have). */
const drawn = () => !!dialog()?.querySelector(".coach-turns, .coach-opening:not(.coach-opening--holding), .coach-off");

async function openCoach() {
  await click(document.getElementById("coach"), "the Coach button");
  await until(() => !!box(), "the box in the sheet");
  await until(drawn, "the conversation or its opening, drawn");
}

describe("the opening screen", () => {
  it("one coach line from the day, the general chips, ways to start yourself, and the box — 'Ask anything', focused; no time-frame buttons", async () => {
    server(NONE);
    const today = { ...todayDto(null), readiness: { verdict: { level: "caution", reasons: ["x"] } } } as unknown as TodayResponse;
    mount({ today });
    await openCoach();
    const d = dialog()!;
    expect(d.querySelector("h2")?.textContent).toBe("Coach");
    expect(d.querySelector(".coach-opening .coach-msg--coach")?.textContent).toContain("A middling morning — steady suits today.");
    expect(chips()).toEqual(["Something for right now", "Plan my week", "I'm sore"]);
    expect(box()!.placeholder).toBe("Ask anything");
    await until(() => document.activeElement === box(), "the box focused");
    expect(d.textContent).toContain("Or start something yourself");
    const hrefs = [...d.querySelectorAll<HTMLAnchorElement>(".coach-start a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/studio/build/new");
    expect(hrefs).toContain("/studio/templates");
    expect(hrefs).toContain("/studio");
    // The quick starts are the Studio's own tiles.
    expect(d.querySelector(".coach-start .stu-quick")).not.toBeNull();
    for (const gone of ["Now", "Later today", "Plan ahead"]) expect(button(gone, d)).toBeNull();
    expect(d.textContent).not.toContain("Seeing:");
  });

  it("suggestions still open from before: 'Also waiting', a line each that opens its own card", async () => {
    server(NONE, {
      "GET /api/coach/runs/current": { run: null, alsoOpen: [{ proposalId: "dp-old", title: "Hips, gently", date: TODAY, time: "18:00", items: 1 }] },
    });
    mount();
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-also"), "Also waiting");
    expect(dialog()!.querySelector(".coach-also")!.textContent).toContain("Hips, gently");
  });

  it("past the week's cutoff: one plain line, and nothing sends — no chip, no box", async () => {
    const calls = server(NONE, { "GET /api/coach/spend": { spentMicros: 20_000_000, cutoffMicros: 20_000_000, warnMicros: 5_000_000 } });
    mount();
    await openCoach();
    await until(() => text().includes("This week's AI budget is used up."), "the line");
    expect([...dialog()!.querySelectorAll<HTMLButtonElement>(".coach-chips button")].every((b) => b.disabled)).toBe(true);
    await type(box()!, "Plan my week");
    expect(sendButton()!.disabled).toBe(true);
    await press("Enter", box()!);
    expect(posts(calls)).toEqual([]);
  });

  it("an active objective with a short title: its question among the chips", async () => {
    server(NONE, { "GET /api/objectives": { objectives: [{ id: "o1", title: "Wall sit", status: "active", keyResults: [] }] } });
    mount();
    await openCoach();
    await until(() => chips().length === 4, "four chips");
    expect(chips()).toEqual(["Something for right now", "Plan my week", "How is “Wall sit” going?", "I'm sore"]);
  });
});

describe("Seeing", () => {
  it("opened on a screen that shows something: 'Seeing: …' over the box, and chips for it; ✕ drops it, the chips go general", async () => {
    server(NONE);
    mount({ seeing: WORKOUT });
    await openCoach();
    expect(seeingLine()?.textContent).toContain(`Seeing: ${WORKOUT.label}`);
    expect(chips()).toEqual(["Shorten it", "Move it", "Why this run?"]);
    await click(seeingLine()!.querySelector("button"), "the seeing ✕");
    expect(seeingLine()).toBeNull();
    expect(chips()).toEqual(["Something for right now", "Plan my week", "I'm sore"]);
  });
});

describe("a turn", () => {
  it("a chip is the athlete's words: one run, no scope, a new conversation, what it sees as the focus — the words right, the trail while it works", async () => {
    const calls = server(NONE, {
      "POST /api/coach/runs": (body: any) => json({ run: run({ id: "run-7", request: body.request }), existing: false, conversationId: "run-7" }),
    });
    mount({ seeing: WORKOUT });
    await openCoach();
    await click(button("Shorten it", dialog()!), "the chip");
    await until(() => posts(calls).length === 1, "the start");
    expect(posts(calls)[0]).toEqual({ request: "Shorten it", conversationId: null, focus: { kind: "workout", id: "w1" } });
    await until(() => !!dialog()!.querySelector(".coach-msg--athlete"), "the athlete's words");
    expect(dialog()!.querySelector(".coach-msg--athlete")?.textContent).toBe("Shorten it");
    // The run at work, quietly: its trail and Cancel, not its request said twice.
    expect(dialog()!.querySelector(".coach-run")).not.toBeNull();
    expect(dialog()!.querySelector(".coach-run-request")).toBeNull();
    expect(button("Cancel", dialog()!)).not.toBeNull();
    // The opening screen has given way.
    expect(dialog()!.querySelector(".coach-opening")).toBeNull();
  });

  it("the box's words go too; Enter sends, Shift+Enter doesn't; an empty box sends nothing", async () => {
    const calls = server(NONE, {
      "POST /api/coach/runs": (body: any) => json({ run: run({ id: "run-8", request: body.request }), existing: false, conversationId: "run-8" }),
    });
    mount();
    await openCoach();
    expect(sendButton()!.disabled).toBe(true);
    await press("Enter", box()!);
    expect(posts(calls)).toEqual([]);
    await type(box()!, "Plan my week around a trip");
    await act(async () => {
      box()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    });
    await settle();
    expect(posts(calls)).toEqual([]);
    await press("Enter", box()!);
    await until(() => posts(calls).length === 1, "the start");
    expect(posts(calls)[0]).toEqual({ request: "Plan my week around a trip", conversationId: null });
    await until(() => box()!.value === "", "the box emptied");
  });

  it("while the coach works, nothing more is sent; once it is over, the coach's line — left, with its mark — and the focus on it, never pulled into the box", async () => {
    let status: CoachRunDto["status"] = "active";
    let conv: CoachConversationDto = NONE;
    const loop = drivenLoop(() => run({ id: "run-9", status }));
    const calls = server(() => conv, {
      "POST /api/coach/runs": (body: any) => {
        conv = conversation([turn({ runId: "run-9", words: body.request, status: "active", line: null })]);
        return json({ run: run({ id: "run-9", request: body.request }), existing: false, conversationId: "run-9" });
      },
    });
    mount({ loop: loop.deps });
    await openCoach();
    await type(box()!, "How is my wall sit going?");
    await click(sendButton(), "Send");
    await until(() => !!dialog()!.querySelector(".coach-run"), "the run at work");
    await type(box()!, "and another");
    expect(sendButton()!.disabled).toBe(true);
    await press("Enter", box()!);
    expect(posts(calls)).toHaveLength(1);
    // The answer: the read says the turn is over, with the coach's words.
    status = "finished";
    conv = conversation([turn({ runId: "run-9", words: "How is my wall sit going?", status: "finished", line: "Up 15 seconds in two weeks — steady." })]);
    await loop.answer({ status: "finished", nextDue: null, events: [] });
    await until(() => !!dialog()!.querySelector(".coach-msg--coach[data-turn='run-9']"), "the coach's line");
    const said = dialog()!.querySelector<HTMLElement>(".coach-msg--coach[data-turn='run-9']")!;
    expect(said.textContent).toContain("Up 15 seconds in two weeks — steady.");
    expect(said.querySelector(".coach-msg-mark")).not.toBeNull();
    expect(dialog()!.querySelector(".coach-run")).toBeNull();
    await until(() => document.activeElement === said, "the focus on the coach's line");
    expect(document.activeElement).not.toBe(box());
  });
});

describe("the box and the focus (the integrated review's fix round)", () => {
  /** The device's primary pointer: a touch screen (coarse) or a mouse (fine). */
  const pointer = (coarse: boolean) =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: coarse && q.includes("pointer: coarse"), media: q, addEventListener: () => undefined, removeEventListener: () => undefined })),
    );

  it("the box grows with its words, up to about six lines, then scrolls", async () => {
    server(NONE);
    mount();
    await openCoach();
    const field = box()!;
    let tall = 60;
    Object.defineProperty(field, "scrollHeight", { configurable: true, get: () => tall });
    await type(field, "a line\nanother\nand one more");
    expect(field.style.height).toBe("60px");
    tall = 1_000;
    await type(field, "a line\nanother\nand one more\n4\n5\n6\n7\n8\n9");
    const height = Number.parseFloat(field.style.height);
    expect(height).toBeGreaterThan(60);
    expect(height).toBeLessThan(1_000);
  });

  it("on a touch screen, Return is a new line — only the button sends", async () => {
    pointer(true);
    const calls = server(NONE, { "POST /api/coach/runs": (body: any) => json({ run: run({ id: "run-t1", request: body.request }), existing: false, conversationId: "run-t1" }) });
    mount();
    await openCoach();
    await type(box()!, "first line");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      box()!.dispatchEvent(enter);
    });
    await settle(10);
    expect(posts(calls)).toEqual([]);
    expect(enter.defaultPrevented).toBe(false);
    await click(sendButton(), "Send");
    await until(() => posts(calls).length === 1, "the button's send");
  });

  it("with a keyboard, Return sends — but never words an action wrote, until the athlete changes them", async () => {
    pointer(false);
    const calls = server(NONE, { "POST /api/coach/runs": (body: any) => json({ run: run({ id: "run-t2", request: body.request }), existing: false, conversationId: "run-t2" }) });
    function Asker() {
      const coach = useCoach();
      return createElement("button", { type: "button", id: "coach", onClick: () => coach?.open({ request: "Extend my plan by two weeks" }) }, "Extend");
    }
    mount({ children: createElement(Asker) });
    await openCoach();
    await press("Enter", box()!);
    await settle(10);
    expect(posts(calls)).toEqual([]);
    await type(box()!, "Extend my plan by three weeks");
    await press("Enter", box()!);
    await until(() => posts(calls).length === 1, "Return's send, once the words are the athlete's");
    expect(posts(calls)[0]).toMatchObject({ request: "Extend my plan by three weeks" });
  });

  it("the Seeing ✕: the focus goes to the box, and the next request carries no focus", async () => {
    const calls = server(NONE, { "POST /api/coach/runs": (body: any) => json({ run: run({ id: "run-t3", request: body.request }), existing: false, conversationId: "run-t3" }) });
    mount({ seeing: WORKOUT });
    await openCoach();
    // The open's own focus first (the box, as the sheet opens on nothing to show).
    await until(() => document.activeElement === box(), "the box focused as the sheet opens");
    await settle(10);
    const drop = seeingLine()!.querySelector<HTMLButtonElement>("button")!;
    // As a tap or a key does: the ✕ holds the focus as it goes.
    act(() => drop.focus());
    expect(document.activeElement).toBe(drop);
    await click(drop, "the seeing ✕");
    expect(document.activeElement).toBe(box());
    await type(box()!, "Plan my week");
    await click(sendButton(), "Send");
    await until(() => posts(calls).length === 1, "the start");
    expect(posts(calls)[0]).toEqual({ request: "Plan my week", conversationId: null });
    expect("focus" in posts(calls)[0]).toBe(false);
  });

  it("kept, the request carries what it sees as its focus — its kind and id, never its label", async () => {
    const calls = server(NONE, { "POST /api/coach/runs": (body: any) => json({ run: run({ id: "run-t4", request: body.request }), existing: false, conversationId: "run-t4" }) });
    mount({ seeing: WORKOUT });
    await openCoach();
    await type(box()!, "Plan my week");
    await click(sendButton(), "Send");
    await until(() => posts(calls).length === 1, "the start");
    expect(posts(calls)[0].focus).toEqual({ kind: "workout", id: "w1" });
  });

  it("after Approve all, the focus goes to what came of it — a status line", async () => {
    let applied = false;
    const done = (c: DesignChangeLineDto) => ({ ...c, outcome: { status: "applied", at: "x", workoutId: c.workoutId, before: { date: TODAY, time: "08:00", minutes: 30 } } });
    const read = () => ({
      id: "dp-run-5",
      status: applied ? "approved" : "pending",
      resolvedAt: null,
      lines: [],
      changes: applied ? [done(change("c1")), done(change("c2"))] : [change("c1"), change("c2")],
    });
    const cards = [{ kind: "plan_changes" as const, proposalId: "dp-run-5", title: "Changes to your plan", summary: "2 changes to your week", status: "pending" }];
    server(conversation([turn({ runId: "run-5", line: "Two lighter days.", cards })]), {
      "GET /api/coach/proposals/dp-run-5": () => json(read()),
      "POST /api/coach/proposals/dp-run-5/approve": () => {
        applied = true;
        return json({ ok: true, status: "approved", applied: [], changed: [], refused: [], settled: [], remaining: [] });
      },
    });
    mount();
    await openCoach();
    const card = () => dialog()!.querySelector<HTMLElement>(".coach-changes")!;
    await until(() => !!card() && !!button("Approve all", card()) && !button("Approve all", card())!.disabled, "Approve all ready");
    await click(button("Approve all", card()), "Approve all");
    await until(() => document.activeElement?.classList.contains("coach-changes-outcome") === true, "the focus on what came of it");
    expect(document.activeElement?.getAttribute("role")).toBe("status");
    expect(document.activeElement?.textContent).toBe("✓ 2 changes made");
  });

  it("the focus never falls out of the sheet: a control that goes leaves it in the dialog", async () => {
    server(conversation([turn({ cards: [{ kind: "workout", proposalId: "dp-run-1", title: "Hips", summary: "Today", status: "pending" }] })]), {
      "GET /api/coach/proposals/dp-run-1": { id: "dp-run-1", status: "pending", resolvedAt: null, lines: [line("a", { title: "Hips" })], changes: [] },
    });
    mount();
    await openCoach();
    await until(() => !!button("Decline", dialog()!), "the card");
    await click(button("Decline", dialog()!), "Decline");
    const keep = button("Keep it", dialog()!)!;
    act(() => keep.focus());
    await click(keep, "Keep it");
    await settle(10);
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });
});

describe("an answer in words", () => {
  const answer = `${"Your wall sit is up fifteen seconds in two weeks, held clean each time. ".repeat(10)}Keep the same rhythm.\n\nNext week, add five seconds.`;

  it("shown whole as the coach's words the moment the run ends — wrapped, never clipped, no card — and never a trail line too", async () => {
    let status: CoachRunDto["status"] = "active";
    const events: CoachRunEventDto[] = [{ seq: 1, kind: "note", summary: "Read your last two weeks.", payload: null, at: "x" }];
    const loop = drivenLoop(
      () => run({ id: "run-a", status, scope: { kind: "auto" } as never }),
      () => events,
    );
    // The conversation's read never catches up here: the answer is the run's own.
    server(conversation([turn({ runId: "run-a", words: "How is my wall sit going?", status: "active", line: null })]), {
      "GET /api/coach/runs/current": () => json({ run: run({ id: "run-a", status, scope: { kind: "auto" } as never }), events, proposal: null }),
    });
    mount({ loop: loop.deps });
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-run"), "the run at work");
    expect(dialog()!.textContent).not.toMatch(/\bauto\b/i);
    status = "finished";
    events.push(
      { seq: 2, kind: "tool_call", summary: "Finishing", payload: { tool: "finish", toolUseId: "t1" }, at: "x" },
      { seq: 3, kind: "tool_result", summary: answer, payload: { tool: "finish", toolUseId: "t1", ok: true, receipt: { final: true, answer: true } }, at: "x" },
    );
    await loop.answer({ status: "finished", nextDue: null, events: events.slice(1) });
    await until(() => !!dialog()!.querySelector(".coach-msg--coach[data-turn='run-a']"), "the coach's words");
    const said = dialog()!.querySelector<HTMLElement>(".coach-msg--coach[data-turn='run-a']")!;
    expect([...said.querySelectorAll("p")].map((p) => p.textContent)).toEqual(answer.split("\n\n"));
    expect(dialog()!.querySelector(".coach-pc")).toBeNull();
    expect(dialog()!.querySelector(".coach-changes")).toBeNull();
    expect(dialog()!.querySelector(".coach-run")).toBeNull();
  });
});

describe("the conversation, kept", () => {
  it("comes back on open: the turns, 'Reply' — and a send continues it by its id", async () => {
    const calls = server(conversation([turn()]), {
      "POST /api/coach/runs": (body: any) => json({ run: run({ id: "run-2", request: body.request }), existing: false, conversationId: "run-1" }),
    });
    mount();
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-msg--athlete"), "the turns");
    expect(dialog()!.querySelector(".coach-msg--athlete")?.textContent).toBe("Something for my hips");
    expect(dialog()!.querySelector(".coach-msg--coach")?.textContent).toContain("Here's a gentle one for your hips.");
    expect(dialog()!.querySelector(".coach-opening")).toBeNull();
    expect(box()!.placeholder).toBe("Reply");
    await type(box()!, "make it 10 minutes");
    await click(sendButton(), "Send");
    await until(() => posts(calls).length === 1, "the start");
    expect(posts(calls)[0]).toEqual({ request: "make it 10 minutes", conversationId: "run-1" });
  });

  it("opened on a conversation, the box doesn't take the focus (a phone's keyboard stays down); with words written for the athlete, it does", async () => {
    server(conversation([turn()]));
    mount();
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-msg--athlete"), "the turns");
    await settle(20);
    expect(document.activeElement).not.toBe(box());
    act(() => root?.unmount());
    host?.remove();
    server(conversation([turn()]));
    function Asker() {
      const coach = useCoach();
      return createElement("button", { type: "button", id: "coach", onClick: () => coach?.open({ request: "and an easier one tomorrow" }) }, "Ask");
    }
    mount({ children: createElement(Asker) });
    await openCoach();
    await until(() => document.activeElement === box(), "the box focused, its words in it");
  });

  it("a run that ends while the athlete types in the box: the focus stays in the box", async () => {
    let status: CoachRunDto["status"] = "active";
    let conv: CoachConversationDto = conversation([turn({ runId: "run-t", status: "active", line: null })]);
    const loop = drivenLoop(() => run({ id: "run-t", status }));
    server(() => conv, { "GET /api/coach/runs/current": () => json({ run: run({ id: "run-t", status }), events: [], proposal: null }) });
    mount({ loop: loop.deps });
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-run"), "the run at work");
    act(() => box()!.focus());
    await type(box()!, "and then");
    status = "finished";
    conv = conversation([turn({ runId: "run-t", status: "finished", line: "Done for today." })]);
    await loop.answer({ status: "finished", nextDue: null, events: [] });
    await until(() => text().includes("Done for today."), "the coach's line");
    await settle(20);
    expect(document.activeElement).toBe(box());
  });

  it("'New conversation' in the sheet's menu: the opening screen, the next send a new one — and it holds when the sheet opens again", async () => {
    const calls = server(conversation([turn()]), {
      "POST /api/coach/runs": (body: any) => json({ run: run({ id: "run-3", request: body.request }), existing: false, conversationId: "run-3" }),
    });
    mount();
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-msg--athlete"), "the turns");
    await click(dialog()!.querySelector('button[aria-label="More"]'), "the menu");
    await click(dialog()!.querySelector('[role="menuitem"]'), "New conversation");
    await until(() => !!dialog()!.querySelector(".coach-opening"), "the opening screen");
    expect(localStorage.getItem(LEFT_CONVERSATION_KEY)).toBe("run-1");
    await click(dialog()!.querySelector('button[aria-label="Close"]'), "✕");
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-opening:not(.coach-opening--holding)"), "the opening screen again");
    expect(dialog()!.querySelector(".coach-msg--athlete")).toBeNull();
    await click(button("Plan my week", dialog()!), "a chip");
    await until(() => posts(calls).length === 1, "the start");
    expect(posts(calls)[0]).toEqual({ request: "Plan my week", conversationId: null });
  });

  it("no 'New conversation' to offer with nothing to leave; none while the coach works", async () => {
    server(NONE);
    mount();
    await openCoach();
    await click(dialog()!.querySelector('button[aria-label="More"]'), "the menu");
    expect(dialog()!.querySelector<HTMLButtonElement>('[role="menuitem"]')?.disabled).toBe(true);
    act(() => root?.unmount());
    host?.remove();
    const working = run({ id: "run-w", status: "stepping" });
    server(conversation([turn(), turn({ runId: "run-w", status: "stepping", line: null })]), { "GET /api/coach/runs/current": { run: working, events: [], proposal: null } });
    mount({ loop: quietLoop(() => working) });
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-run"), "the run at work");
    await click(dialog()!.querySelector('button[aria-label="More"]'), "the menu");
    expect(dialog()!.querySelector<HTMLButtonElement>('[role="menuitem"]')?.disabled).toBe(true);
  });

  it("a turn's trail is one tap down: 'How the coach made this' reads the run's lines", async () => {
    const events: CoachRunEventDto[] = [{ seq: 1, kind: "tool_call", summary: "Read your last two weeks", payload: null, at: "x" }];
    const calls = server(conversation([turn()]), { "GET /api/coach/runs/run-1": { run: run({ status: "finished" }), events } });
    mount();
    await openCoach();
    await until(() => !!button("How the coach made this", dialog()!), "the trail's fold");
    expect(calls.some((c) => c.path === "/api/coach/runs/run-1")).toBe(false);
    await click(button("How the coach made this", dialog()!), "the fold");
    await until(() => text().includes("Read your last two weeks"), "the trail");
  });
});

describe("cards", () => {
  it("an open suggestion is its full card; an older one closed is one line of what came of it", async () => {
    const old = turn({ runId: "run-1", cards: [{ kind: "workout", proposalId: "dp-run-1", title: "Hips, gently", summary: "Today · Now · 24 min", status: "superseded" }] });
    const now = turn({
      runId: "run-2",
      words: "make it shorter",
      line: "Shorter, same aim.",
      cards: [{ kind: "workout", proposalId: "dp-run-2", title: "Hips, shorter", summary: "Today · Now · 12 min", status: "pending" }],
    });
    server(conversation([old, now]), {
      "GET /api/coach/proposals/dp-run-2": { id: "dp-run-2", status: "pending", resolvedAt: null, lines: [line("a", { title: "Hips, shorter", minutes: 12 })], changes: [] },
    });
    mount();
    await openCoach();
    await until(() => text().includes("Workout") || text().includes("Hips, shorter ·") || !!dialog()!.querySelector(".coach-pc"), "the open card");
    await until(() => !!dialog()!.querySelector(".coach-pc"), "the full card");
    expect(button("Approve", dialog()!)).not.toBeNull();
    expect(dialog()!.querySelector(".coach-card-closed")?.textContent).toContain("Hips, gently · Today · Now · 24 min — Replaced");
    // No "Change something…" on the card: the box replies.
    expect(dialog()!.querySelector(".coach-pc-follow")).toBeNull();
  });

  it("the newest turn's card stays whole once decided — what came of it in view, never folded to a line", async () => {
    const applied = { status: "applied", at: "x", workoutId: "w-new", rev: 1, written: { date: TODAY, time: "18:00", title: "Hips", minutes: 24 } };
    server(conversation([turn({ cards: [{ kind: "workout", proposalId: "dp-run-1", title: "Hips", summary: "Today · 6 PM", status: "approved" }] })]), {
      "GET /api/coach/proposals/dp-run-1": { id: "dp-run-1", status: "approved", resolvedAt: "x", lines: [line("a", { title: "Hips", outcome: applied } as never)], changes: [] },
    });
    mount();
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-pc"), "the whole card");
    expect(dialog()!.querySelector(".coach-card-closed")).toBeNull();
    expect(dialog()!.textContent).toContain("On your plan for");
  });

  it("changes to the plan: Approve all sends the changes only, by their ids — never the workout beside them", async () => {
    let approved: any = null;
    const read = { id: "dp-run-4", status: "pending", resolvedAt: null, lines: [line("w")], changes: [change("c1"), change("c2")] };
    const cards = [
      { kind: "workout" as const, proposalId: "dp-run-4", title: "Easy legs", summary: "Today · 6 PM · 24 min", status: "pending" },
      { kind: "plan_changes" as const, proposalId: "dp-run-4", title: "Changes to your plan", summary: "2 changes to your week", status: "pending" },
    ];
    server(conversation([turn({ runId: "run-4", line: "Two lighter days.", cards })]), {
      "GET /api/coach/proposals/dp-run-4": () => json(read),
      "POST /api/coach/proposals/dp-run-4/approve": (body: any) => {
        approved = body;
        return json({ ok: true, status: "partially_approved", applied: [], changed: [], refused: [], settled: [], remaining: [] });
      },
    });
    mount();
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-changes"), "the changes card");
    const card = dialog()!.querySelector<HTMLElement>(".coach-changes")!;
    await until(() => !!button("Approve all", card) && !button("Approve all", card)!.disabled, "Approve all ready");
    await click(button("Approve all", card), "Approve all");
    await until(() => approved !== null, "the approve");
    expect(approved).toEqual({ opIds: ["c1", "c2"] });
  });

  it("changes to the plan: how many, Approve all (the changes only, by their ids) and Look closer", async () => {
    let approved: any = null;
    const read = { id: "dp-run-4", status: "pending", resolvedAt: null, lines: [line("w")], changes: [change("c1"), change("c2")] };
    const cards = [
      { kind: "workout" as const, proposalId: "dp-run-4", title: "Easy legs", summary: "Today · 6 PM · 24 min", status: "pending" },
      { kind: "plan_changes" as const, proposalId: "dp-run-4", title: "Changes to your plan", summary: "2 changes to your week", status: "pending" },
    ];
    server(conversation([turn({ runId: "run-4", line: "Two lighter days, and one easy session.", cards })]), {
      "GET /api/coach/proposals/dp-run-4": () => json(read),
      "POST /api/coach/proposals/dp-run-4/approve": (body: any) => {
        approved = body;
        return json({ ok: true, status: "partially_approved", applied: [], changed: [], refused: [], settled: [], remaining: [] });
      },
    });
    mount();
    await openCoach();
    await until(() => !!dialog()!.querySelector(".coach-changes"), "the changes card");
    const card = dialog()!.querySelector<HTMLElement>(".coach-changes")!;
    expect(card.textContent).toContain("2 changes to your week");
    // The workout's card holds the workout alone; the changes are this card's.
    await until(() => !!dialog()!.querySelector(".coach-pc"), "the workout's card");
    expect(dialog()!.querySelector(".coach-pc")!.textContent).not.toContain("Session c1");
    await until(() => !!button("Approve all", card) && !button("Approve all", card)!.disabled, "Approve all ready");
    await click(button("Look closer", card), "Look closer");
    await until(() => card.textContent!.includes("Session c1 — skipped") && card.textContent!.includes("Session c2 — skipped"), "the changes, each");
    // Looked at closer, each change's own card decides them: its Approve names the changes, never the whole suggestion.
    expect(button("Approve all", card)).toBeNull();
    await click(button("Approve", card), "Approve");
    await until(() => approved !== null, "the approve");
    expect(approved).toEqual({ opIds: ["c1", "c2"] });
  });
});

describe("a question", () => {
  const asking: CoachRunEventDto[] = [
    { seq: 1, kind: "question", summary: "Home or gym?", payload: { tool: "ask_athlete", data: { questions: [{ text: "Home or gym?", chips: ["Home", "Gym"] }] } }, at: "x" },
  ];

  it("one tap on an answer sends it; the box answers in the athlete's own words", async () => {
    const answers: any[] = [];
    const live = run({ id: "run-5", status: "waiting_athlete", request: "Something for tonight" });
    server(conversation([turn({ runId: "run-5", words: "Something for tonight", status: "waiting_athlete", line: null, question: { text: "Home or gym?", choices: ["Home", "Gym"] } })]), {
      "GET /api/coach/runs/current": { run: live, events: asking, proposal: null },
      "POST /api/coach/runs/run-5/answer": (body: any) => {
        answers.push(body);
        return json({ run: { ...live, status: "active" } });
      },
    });
    mount({ loop: quietLoop(() => live, () => asking) });
    await openCoach();
    await until(() => !!button("Home", dialog()!), "the answers");
    expect(box()!.placeholder).toBe("Answer in your own words");
    await click(button("Home", dialog()!), "an answer");
    await until(() => answers.length === 1, "the answer sent");
    expect(answers[0]).toEqual({ answers: ["Home"] });
  });

  it("typed in the box, the answer is the athlete's words", async () => {
    const answers: any[] = [];
    const live = run({ id: "run-6", status: "waiting_athlete" });
    server(conversation([turn({ runId: "run-6", status: "waiting_athlete", line: null })]), {
      "GET /api/coach/runs/current": { run: live, events: asking, proposal: null },
      "POST /api/coach/runs/run-6/answer": (body: any) => {
        answers.push(body);
        return json({ run: { ...live, status: "active" } });
      },
    });
    const calls = serveCalls();
    mount({ loop: quietLoop(() => live, () => asking) });
    await openCoach();
    await until(() => box()!.placeholder === "Answer in your own words", "the box answering");
    await type(box()!, "The park, actually");
    await click(sendButton(), "Send");
    await until(() => answers.length === 1, "the answer sent");
    expect(answers[0]).toEqual({ answers: ["The park, actually"] });
    expect(posts(calls())).toEqual([]);
  });
});

/** The calls the last `serve` records (its stub's). */
function serveCalls(): () => Call[] {
  const f = globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } };
  return () =>
    f.mock.calls.map(([input, init]) => ({
      method: init?.method ?? "GET",
      path: String(input).split("?")[0]!,
      query: "",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
}

describe("plain lines, the words kept", () => {
  it("the run already there answers: it shows, one line says so, and the words stay in the box", async () => {
    const there = run({ id: "run-x", status: "stepping", request: "Plan my week" });
    server(NONE, {
      "POST /api/coach/runs": () =>
        json({ run: there, existing: true, offer: "continue_or_cancel", ignoredRequest: { scope: { kind: "now" }, request: "Hips" }, conversationId: "run-x" }),
    });
    mount({ loop: quietLoop(() => there) });
    await openCoach();
    await type(box()!, "Hips");
    await click(sendButton(), "Send");
    await until(() => text().includes("You already have the coach working on something"), "the line");
    expect(box()!.value).toBe("Hips");
    expect(dialog()!.querySelector(".coach-msg--athlete")?.textContent).toBe("Plan my week");
  });

  it("the week's budget: one plain line, the words kept, nothing started", async () => {
    server(NONE, { "POST /api/coach/runs": () => json({ error: "week_budget", spentUsd: 20, cutoffUsd: 20 }, 409) });
    mount();
    await openCoach();
    await type(box()!, "Plan my week");
    await click(sendButton(), "Send");
    await until(() => text().includes("This week's AI budget is used up."), "the budget line");
    expect(box()!.value).toBe("Plan my week");
    expect(dialog()!.querySelector(".coach-msg--athlete")).toBeNull();
  });

  it("a focus the server refuses: its words; the seeing can be dropped to ask anyway", async () => {
    server(NONE, { "POST /api/coach/runs": () => json({ error: "focus_not_found" }, 404) });
    mount({ seeing: WORKOUT });
    await openCoach();
    await type(box()!, "Shorter please");
    await click(sendButton(), "Send");
    await until(() => text().includes("That isn't there any more"), "the refusal");
    expect(box()!.value).toBe("Shorter please");
  });

  it("offline: it says it couldn't reach the coach", async () => {
    server(NONE, { "POST /api/coach/runs": () => json({ error: "offline" }, 503) });
    mount();
    await openCoach();
    await type(box()!, "Plan my week");
    await click(sendButton(), "Send");
    await until(() => text().includes("Couldn't reach the coach — try again."), "the line");
    expect(box()!.value).toBe("Plan my week");
  });

  it("the coach off (a 404 from its routes): one quiet line, no box", async () => {
    serve({ "GET /api/coach/runs/current": json({ error: "not_found" }, 404), "GET /api/coach/conversation": json({ error: "not_found" }, 404) });
    mount();
    await click(document.getElementById("coach"), "the Coach button");
    await until(() => text().includes("The coach isn't available here."), "the line");
    expect(box()).toBeNull();
  });
});

describe("the sheet", () => {
  it("Escape closes it and gives the focus back; leaving the screen closes it", async () => {
    server(NONE);
    mount();
    const opener = document.getElementById("coach")!;
    opener.focus();
    await openCoach();
    await press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    await openCoach();
    await act(async () => box()!.blur());
    await click(document.getElementById("leave"), "Leave");
    expect(dialog()).toBeNull();
  });

  it("opened with words: they are in the box, unsent", async () => {
    const calls = server(NONE);
    function Asker() {
      const coach = useCoach();
      return createElement("button", { type: "button", id: "coach", onClick: () => coach?.open({ request: "Extend my plan by two weeks" }) }, "Extend");
    }
    mount({ children: createElement(Asker) });
    await openCoach();
    expect(box()!.value).toBe("Extend my plan by two weeks");
    await settle(10);
    expect(posts(calls)).toEqual([]);
  });
});
