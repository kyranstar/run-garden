// @vitest-environment jsdom
/**
 * THE OPEN BATCH, IN THE COACH (the saves flow redesigned §3.1–§3.2, §12.1, §12.3), live in the app's coach sheet:
 *
 *  - The sheet's header holds a chip while a batch is open ("9 new saved moves"); a tap brings the saves card into view
 *    in the current sheet — no new conversation.
 *  - The conversation starts with the card, above whatever conversation is open: the server's line, Fit them in, Choose
 *    first, and "not now".
 *  - Fit them in fits the batch (every new move on the coach's call), then sends the request in the current
 *    conversation with its batch. A run that can't start (refused, the run already there, the coach at work) cancels the
 *    fit — only a fit of its own that the server took — and leaves the words in the box.
 *  - Opened with a fit (Today's Fit them in), the conversation sends it once it has settled.
 *  - "not now" asks first; OK puts it aside; closing the sheet any other way puts nothing aside.
 *  - While fitting, every button gives way to "Fitting in… open the coach".
 *  - A run's end reads the open batch again: a fit's run that ended with no proposal handed it back on the server
 *    (workout editability §7), so Fit them in is back at once — in a sheet that never sent the fit too.
 *
 * The server is a stubbed fetch; the step loop a stand-in. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationDto, CoachConversationTurnDto, CoachRunDto } from "@rg/api-client";
import { FIT_SAVES_REQUEST, type OpenSavesBatchDto } from "@rg/saves";
import { useCoach, useCoachSeeing } from "../src/screens/studio/coach-ask.js";
import { workoutFocus } from "../src/screens/studio/coach-focus.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import { NOT_AVAILABLE_LINE } from "../src/screens/studio/run-model.js";
import { FIT_FAILED_LINE, FITTING_LINE, OPEN_FIRST_LINE, PUT_ASIDE_LINE } from "../src/screens/studio/saves-model.js";
import type { LoopDeps } from "../src/screens/studio/use-coach-run.js";
import { button, click, dialog, drivenLoop, json, quietLoop, run, serve, settle, type, until, type Call, type Routes as Served } from "./coach-live-harness.js";
import { libraryDto, placesDto, primedClient, profileDto, TODAY, todayDto } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

const LINE = "Nine new moves came in from your saves: 5 hip and 4 neck. Want me to fit them into the week, or choose first?";
const OPEN: OpenSavesBatchDto = { id: "b1", counts: { new: 9, linked: 4 }, groups: [{ group: "hip", count: 5 }, { group: "neck", count: 4 }], line: LINE, fitting: false };

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
const conversation = (turns: CoachConversationTurnDto[]): CoachConversationDto => ({ id: turns[0]?.runId ?? null, startedAt: turns[0]?.at ?? null, turns });
const ONE_TURN = conversation([turn()]);

const SESSION = workoutFocus({ id: "w1", title: "Easy run", effectiveDate: TODAY, workoutSeconds: 2400, calendarSeconds: 2400, category: "easy", sport: "run" });

/** A screen that registers today's session, with the nav's Coach button and Today's Fit them in (the coach opened with
 * the fit). */
function Screen() {
  useCoachSeeing(SESSION);
  const coach = useCoach();
  return createElement(
    "div",
    null,
    createElement("button", { type: "button", id: "coach", onClick: () => coach?.open() }, "Coach"),
    createElement("button", { type: "button", id: "coach-fit", onClick: () => coach?.open({ fit: { batchId: "b1", request: FIT_SAVES_REQUEST } }) }, "Fit from Today"),
  );
}

let client: QueryClient | null = null;

function mountSheet(loop: () => LoopDeps = quietLoop(() => run())) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  client = primedClient({ today: todayDto(null) });
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: client! },
        createElement(
          MemoryRouter,
          { initialEntries: ["/plan"] },
          createElement(
            CoachSheetProvider,
            { loopDeps: loop },
            createElement(
              Routes,
              null,
              createElement(Route, { path: "/plan", element: createElement(Screen) }),
              createElement(Route, { path: "/studio/saves/:batchId", element: createElement("div", { id: "saves-screen" }, "the batch page") }),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * The server: the open batch as it stands (a fit starts it fitting; a cancel, a dismissal end that), the conversation,
 * and whatever else the test serves. Every read the opening makes answered.
 */
function server(o: { open?: OpenSavesBatchDto | null; conv?: CoachConversationDto | (() => CoachConversationDto); more?: Served } = {}) {
  const state = { open: o.open === undefined ? OPEN : o.open };
  const conv = o.conv ?? ONE_TURN;
  const calls = serve({
    "GET /api/my-saves/open": () => ({ open: state.open }),
    "POST /api/my-saves/batches/b1/fit": () => {
      state.open = state.open && { ...state.open, fitting: true };
      return { batchId: "b1", request: FIT_SAVES_REQUEST, moves: 9, links: 13 };
    },
    "POST /api/my-saves/batches/b1/fit/cancel": () => {
      state.open = state.open && { ...state.open, fitting: false };
      return { ok: true };
    },
    "POST /api/my-saves/batches/b1/dismiss": () => {
      state.open = null;
      return { ok: true };
    },
    "GET /api/coach/runs/current": { run: null },
    "GET /api/coach/conversation": typeof conv === "function" ? () => json(conv()) : conv,
    "GET /api/coach/nudges": { nudges: [] },
    "GET /api/templates": { templates: [] },
    "GET /api/objectives": { objectives: [] },
    "GET /api/library": libraryDto({ tmj: true }),
    "GET /api/places": placesDto(["dumbbells"]),
    "GET /api/profile": profileDto(),
    "GET /api/plan/today": todayDto(null),
    ...o.more,
  });
  return { calls, state };
}

const startRun = (body: { request: string }) => json({ run: run({ id: "run-f", request: body.request }), existing: false, conversationId: "run-1" });
const runPosts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/coach/runs").map((c) => c.body);
const posted = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path).length;
const card = () => dialog()?.querySelector<HTMLElement>("#coach-saves-card") ?? null;
const chip = () => dialog()?.querySelector<HTMLButtonElement>(".sheet-head .coach-saves-chip") ?? null;
const box = () => dialog()?.querySelector<HTMLTextAreaElement>(".coach-box textarea") ?? null;
const link = (name: string, scope: ParentNode) => [...scope.querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.trim() === name) ?? null;
/** The conversation drawn: its turns, or its opening. */
const drawn = () => !!dialog()?.querySelector(".coach-turns, .coach-opening:not(.coach-opening--holding)");

async function openCoach(id = "coach") {
  await click(document.getElementById(id), "the Coach button");
  await until(() => !!box(), "the box in the sheet");
  await until(drawn, "the conversation drawn");
}

describe("the open batch in the coach", () => {
  it("with an open batch, the sheet's header holds the chip and the conversation starts with the card, word for word", async () => {
    const scrolled: Element[] = [];
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const { calls } = server();
    mountSheet();
    await openCoach();
    await until(() => !!card(), "the saves card");
    // The chip: in the sheet's header, before its menu.
    expect(chip()?.textContent?.trim()).toBe("9 new saved moves");
    const tools = dialog()!.querySelector(".coach-sheet-tools")!;
    expect(tools.firstElementChild).toBe(chip());
    // The card: first in the conversation, above the turn already there.
    const convo = dialog()!.querySelector(".coach-convo")!;
    expect(convo.firstElementChild).toBe(card());
    expect(convo.querySelector(".coach-turns")).not.toBeNull();
    const c = card()!;
    expect(c.querySelector(".coach-msg--coach .coach-msg-body")?.textContent).toBe(LINE);
    expect(button("Fit them in", c)).not.toBeNull();
    expect(link("Choose first", c)).not.toBeNull();
    expect(button("not now", c)).not.toBeNull();
    // Nothing else on it: the line, two buttons, the link.
    expect([...c.querySelectorAll("button, a")].map((b) => b.textContent?.trim())).toEqual(["Fit them in", "Choose first", "not now"]);
    // A tap on the chip brings the card into view — the same sheet, no new conversation.
    await click(chip(), "the chip");
    expect(scrolled).toEqual([c]);
    expect(document.activeElement).toBe(c);
    expect(runPosts(calls)).toEqual([]);
    expect(dialog()!.querySelector(".coach-turns")).not.toBeNull();
  });

  it("nothing of it with no open batch, or one with nothing left in it", async () => {
    let { calls } = server({ open: null });
    mountSheet();
    await openCoach();
    await until(() => calls.some((c) => c.path === "/api/my-saves/open"), "the open batch read");
    await settle(20);
    expect(chip()).toBeNull();
    expect(card()).toBeNull();
    act(() => root!.unmount());
    host!.remove();

    ({ calls } = server({ open: { ...OPEN, counts: { new: 0, linked: 0 }, groups: [] } }));
    mountSheet();
    await openCoach();
    await until(() => calls.some((c) => c.path === "/api/my-saves/open"), "the open batch read");
    await settle(20);
    expect(chip()).toBeNull();
    expect(card()).toBeNull();
  });

  it("Fit them in fits, then sends the request in the current conversation with its batch: POST /api/coach/runs carries { request: FIT_SAVES_REQUEST, savesBatchId }", async () => {
    const order: string[] = [];
    const { calls } = server({
      more: {
        "POST /api/coach/runs": (body: { request: string }) => {
          order.push("run");
          return startRun(body);
        },
      },
    });
    mountSheet();
    await openCoach();
    await until(() => !!card(), "the saves card");
    await click(button("Fit them in", card()!), "Fit them in");
    await until(() => runPosts(calls).length === 1, "the run started");
    const fit = calls.find((c) => c.path === "/api/my-saves/batches/b1/fit")!;
    // No choices key: what the owner chose on the batch page stands (final fix wave, saves flow redesign).
    expect(fit.body).toEqual({});
    expect(calls.indexOf(fit)).toBeLessThan(calls.findIndex((c) => c.path === "/api/coach/runs"));
    // The current conversation, continued — not a new one. No focus: the session the sheet sees is no part of a fit.
    expect(dialog()!.textContent).toContain("Seeing: ");
    expect(runPosts(calls)[0]).toEqual({ request: FIT_SAVES_REQUEST, conversationId: "run-1", savesBatchId: "b1" });
    // The card says it is fitting; nothing cancelled.
    await until(() => !!card()?.textContent?.includes(FITTING_LINE), "fitting");
    expect(posted(calls, "/api/my-saves/batches/b1/fit/cancel")).toBe(0);
    expect(order).toEqual(["run"]);
  });

  it("a refused run start cancels the fit: the card offers Fit them in again, and the box keeps only the athlete's own words", async () => {
    const { calls } = server({
      more: { "POST /api/coach/runs": json({ error: "week_budget", spentUsd: 4.99, cutoffUsd: 5 }, 409) },
    });
    mountSheet();
    await openCoach();
    await until(() => !!card(), "the saves card");
    // The athlete had started writing something of their own.
    await type(box()!, "Something for my hips");
    await click(button("Fit them in", card()!), "Fit them in");
    await until(() => posted(calls, "/api/my-saves/batches/b1/fit/cancel") === 1, "the fit cancelled");
    await until(() => !!button("Fit them in", card()!), "Fit them in back");
    expect(card()!.textContent).not.toContain(FITTING_LINE);
    // The fit's words are never left in the box (final fix wave): Fit them in is back, and a plain send of them would
    // carry no batch. The athlete's own words stay as they were.
    expect(box()!.value).toBe("Something for my hips");
    // Cancelled after its own fit, once.
    const paths = calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(paths).toEqual(["/api/my-saves/batches/b1/fit", "/api/coach/runs", "/api/my-saves/batches/b1/fit/cancel"]);
  });

  it("a run start refused 404 saves_batch_not_found cancels the fit and says the fit's own line — never that the coach isn't available", async () => {
    const { calls } = server({
      more: { "POST /api/coach/runs": json({ error: "saves_batch_not_found" }, 404) },
    });
    mountSheet();
    await openCoach();
    await until(() => !!card(), "the saves card");
    await click(button("Fit them in", card()!), "Fit them in");
    await until(() => posted(calls, "/api/my-saves/batches/b1/fit/cancel") === 1, "the fit cancelled");
    await until(() => !!dialog()?.textContent?.includes(FIT_FAILED_LINE), "the fit's line");
    // The coach is there: its box stays, and nothing says otherwise (final fix wave, saves flow redesign).
    expect(dialog()!.textContent).not.toContain(NOT_AVAILABLE_LINE);
    expect(box()).not.toBeNull();
    expect(box()!.value).toBe("");
  });

  it("a fit the server refuses (409 batch_open) says finish the batch that is open first, and cancels nothing", async () => {
    const { calls } = server({ more: { "POST /api/my-saves/batches/b1/fit": json({ error: "batch_open" }, 409), "POST /api/coach/runs": startRun } });
    mountSheet();
    await openCoach();
    await until(() => !!card(), "the saves card");
    await click(button("Fit them in", card()!), "Fit them in");
    await until(() => !!card()?.textContent?.includes(OPEN_FIRST_LINE), "the refusal said");
    expect(runPosts(calls)).toEqual([]);
    expect(posted(calls, "/api/my-saves/batches/b1/fit/cancel")).toBe(0);
  });

  it("Choose first goes to the batch page", async () => {
    const { calls } = server();
    mountSheet();
    await openCoach();
    await until(() => !!card(), "the saves card");
    expect(link("Choose first", card()!)!.getAttribute("href")).toBe("/studio/saves/b1");
    await click(link("Choose first", card()!), "Choose first");
    await until(() => !!document.getElementById("saves-screen"), "the batch page");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("not now asks first, then puts it aside: the sheet's words, word for word; OK dismisses; closing the sheet doesn't", async () => {
    const { calls } = server();
    mountSheet();
    const spy = vi.spyOn(client!, "invalidateQueries");
    await openCoach();
    await until(() => !!card(), "the saves card");
    const aside = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d !== dialog()) ?? null;
    await click(button("not now", card()!), "not now");
    await until(() => !!aside(), "the put-aside sheet");
    expect(aside()!.querySelector(".sheet-body")?.textContent).toBe(PUT_ASIDE_LINE);
    expect([...aside()!.querySelectorAll(".sheet-foot button")].map((b) => b.textContent)).toEqual(["OK"]);
    // Closed another way: nothing put aside.
    await click(aside()!.querySelector('button[aria-label="Close"]'), "Close");
    await until(() => !aside(), "the sheet closed");
    expect(posted(calls, "/api/my-saves/batches/b1/dismiss")).toBe(0);
    expect(card()).not.toBeNull();
    // OK: put aside, the card gone, the reads again.
    await click(button("not now", card()!), "not now");
    await until(() => !!aside(), "the put-aside sheet");
    await click(button("OK", aside()!), "OK");
    await until(() => posted(calls, "/api/my-saves/batches/b1/dismiss") === 1, "the dismissal");
    await until(() => !card() && !chip(), "the card and the chip gone");
    expect(aside()).toBeNull();
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining([JSON.stringify(["saves", "open"]), JSON.stringify(["saves", "batches"]), JSON.stringify(["saves", "batch", "b1"])]));
  });

  it("while fitting, every button gives way to Fitting in… open the coach", async () => {
    const { calls } = server({ open: { ...OPEN, fitting: true } });
    mountSheet();
    await openCoach();
    await until(() => !!card(), "the saves card");
    const c = card()!;
    expect(c.querySelector(".coach-msg-body")?.textContent).toBe(LINE);
    expect(c.querySelectorAll("button, a")).toHaveLength(0);
    expect(c.textContent).toContain(FITTING_LINE);
    // The chip stays: the batch is still open.
    expect(chip()?.textContent?.trim()).toBe("9 new saved moves");
    expect(calls.filter((x) => x.method === "POST")).toEqual([]);
  });
});

describe("a fit the coach was opened with (Today's Fit them in)", () => {
  it("is sent once the conversation has settled, in the current conversation, with its batch", async () => {
    const { calls } = server({ open: { ...OPEN, fitting: true }, more: { "POST /api/coach/runs": startRun } });
    mountSheet();
    await openCoach("coach-fit");
    await until(() => runPosts(calls).length === 1, "the run started");
    expect(runPosts(calls)[0]).toEqual({ request: FIT_SAVES_REQUEST, conversationId: "run-1", savesBatchId: "b1" });
    await settle(50);
    expect(runPosts(calls)).toHaveLength(1);
    expect(posted(calls, "/api/my-saves/batches/b1/fit/cancel")).toBe(0);
  });

  it("the coach at work: the fit is cancelled, nothing sent, and its words are not left in the box", async () => {
    const live = conversation([turn({ status: "active", line: null })]);
    const { calls } = server({ open: { ...OPEN, fitting: true }, conv: live, more: { "POST /api/coach/runs": startRun } });
    mountSheet(quietLoop(() => run()));
    await openCoach("coach-fit");
    await until(() => posted(calls, "/api/my-saves/batches/b1/fit/cancel") === 1, "the fit cancelled");
    expect(runPosts(calls)).toEqual([]);
    await settle(20);
    expect(box()!.value).toBe("");
  });

  it("the run already there answers (existing): the fit is cancelled and its words are not left in the box", async () => {
    const { calls } = server({
      open: { ...OPEN, fitting: true },
      more: { "POST /api/coach/runs": json({ run: run({ id: "run-x", request: "plan my week" }), existing: true, offer: "continue_or_cancel", ignoredRequest: { scope: { kind: "now" }, request: FIT_SAVES_REQUEST }, conversationId: "run-1" }) },
    });
    mountSheet();
    await openCoach("coach-fit");
    await until(() => posted(calls, "/api/my-saves/batches/b1/fit/cancel") === 1, "the fit cancelled");
    expect(runPosts(calls)).toHaveLength(1);
    await settle(20);
    expect(box()!.value).toBe("");
  });

  it("a fit-in run that ends without its card cancels the fit (no hour of Fitting in…); one that ends with it doesn't", async () => {
    const PINS = { kind: "pins" as const, proposalId: "dp-pins", title: "Moves in rotation", summary: "Eight join", status: "pending" };
    // Two runs of their own (a run's step is held across the tab by its id).
    for (const [runId, cards] of [["run-words", []], ["run-pins", [PINS]]] as const) {
      let status: CoachRunDto["status"] = "active";
      let conv = ONE_TURN;
      const loop = drivenLoop(() => run({ id: runId, status }));
      const { calls } = server({
        open: { ...OPEN, fitting: true },
        conv: () => conv,
        more: {
          "POST /api/coach/runs": (body: { request: string }) => {
            conv = conversation([turn(), turn({ runId, words: body.request, status: "active", line: null })]);
            return json({ run: run({ id: runId, request: body.request }), existing: false, conversationId: "run-1" });
          },
          "GET /api/coach/proposals/dp-pins": { id: "dp-pins", status: "pending", resolvedAt: null, lines: [], changes: [], plans: [], pins: [] },
        },
      });
      mountSheet(loop.deps);
      await openCoach("coach-fit");
      await until(() => runPosts(calls).length === 1, "the run started");
      await settle(30);
      expect(posted(calls, "/api/my-saves/batches/b1/fit/cancel")).toBe(0);
      status = "finished";
      conv = conversation([turn(), turn({ runId, words: FIT_SAVES_REQUEST, status: "finished", line: "Done.", cards: [...cards] })]);
      await loop.answer({ status: "finished", nextDue: null, events: [] });
      await until(() => !!dialog()!.querySelector(`[data-turn-reply='${runId}']`), "the run over");
      await settle(50);
      expect(posted(calls, "/api/my-saves/batches/b1/fit/cancel"), runId).toBe(cards.length === 0 ? 1 : 0);
      act(() => root!.unmount());
      host!.remove();
      root = null;
    }
  });
});

describe("a fit run's end (workout editability §7)", () => {
  it("a fit run's end re-reads the open batch: the server handed it back, so Fit them in is there at once — even in a sheet that never sent the fit", async () => {
    // The sheet opened on the fit's run at work (sent from a sheet since closed): this one has no fit of its own to end.
    // A run id of its own (a run's step is held across the tab by its id).
    let status: CoachRunDto["status"] = "active";
    let conv = conversation([turn(), turn({ runId: "run-fit-over", words: FIT_SAVES_REQUEST, status: "active", line: null })]);
    const loop = drivenLoop(() => run({ id: "run-fit-over", request: FIT_SAVES_REQUEST, status }));
    const { calls, state } = server({ open: { ...OPEN, fitting: true }, conv: () => conv });
    mountSheet(loop.deps);
    await openCoach();
    await until(() => !!card()?.textContent?.includes(FITTING_LINE), "Fitting in… on the card");
    // The run ends in words: its end, on the server, handed the batch back.
    status = "finished";
    state.open = { ...OPEN, fitting: false };
    conv = conversation([turn(), turn({ runId: "run-fit-over", words: FIT_SAVES_REQUEST, status: "finished", line: "Those moves are in your week already." })]);
    await loop.answer({ status: "finished", nextDue: null, events: [] });
    await until(() => !!card() && !!button("Fit them in", card()!), "Fit them in back on the card");
    expect(posted(calls, "/api/my-saves/batches/b1/fit/cancel")).toBe(0);
  });
});
