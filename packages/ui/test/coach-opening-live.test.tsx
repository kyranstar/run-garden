// @vitest-environment jsdom
/**
 * THE COACH'S OPENING SCREEN HOLDS STILL WHILE IT IS READ (UX System 4: a read landing moves nothing under a tap — the
 * Studio home's f030c6a, here for the coach's opening). What it draws is its reads' to decide: the line (today), the
 * "needs you" chips (`GET /api/coach/nudges`), "Also waiting" (the current run's read), the quick starts (the Studio's
 * reads, the templates). Any of them landing late would push what is under it down under a tap aimed at it, so nothing
 * is drawn until they have answered or failed — then it is drawn once. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationDto, TodayResponse } from "@rg/api-client";
import { useCoach } from "../src/screens/studio/coach-ask.js";
import {
  GENERAL_CHIPS,
  HOW_IT_FELT,
  markOpeningSeen,
  OPENING_SEEN_KEY,
  OPENING_SEEN_MAX,
  readOpeningSeen,
} from "../src/screens/studio/coach-conversation-model.js";
import { NUDGES_QUERY, READ_THE_REVIEW } from "../src/screens/studio/coach-opening.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import { button, click, dialog, json, quietLoop, run, serve, settle, until, type Call, type Routes as Served } from "./coach-live-harness.js";
import { libraryDto, placesDto, primedClient, profileDto, TODAY, todayDto } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(`${TODAY}T16:00:00Z`));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NONE: CoachConversationDto = { id: null, startedAt: null, turns: [] };
const MISSED = { id: "missed:w9", label: "Rework my week around Tuesday's tempo", request: "Rework my week around Tuesday's tempo — I missed it." };
const caution = { ...todayDto(null), readiness: { verdict: { level: "caution", reasons: ["x"] } } } as unknown as TodayResponse;
const good = { ...todayDto(null), readiness: { verdict: { level: "good", reasons: ["x"] } } } as unknown as TodayResponse;

function Screen() {
  const coach = useCoach();
  return createElement("button", { type: "button", id: "coach", onClick: () => coach?.open() }, "Coach");
}

/** Every read the opening makes answered — the Studio's own too — unless the test says otherwise. */
function server(more: Served = {}): Call[] {
  return serve({
    "GET /api/coach/runs/current": { run: null },
    "GET /api/coach/conversation": NONE,
    "GET /api/templates": { templates: [] },
    "GET /api/objectives": { objectives: [] },
    "GET /api/coach/nudges": { nudges: [MISSED] },
    "GET /api/library": libraryDto({ tmj: true }),
    "GET /api/places": placesDto(["dumbbells"]),
    "GET /api/profile": profileDto(),
    "GET /api/plan/today": caution,
    ...more,
  });
}

/** The read at `path` held until the returned release (then answered as served); every other read as served. */
function hold(path: string): () => Promise<void> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  const served = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    String(input).split("?")[0] === path ? held.then(() => served(input, init)) : served(input, init),
  );
  return () => act(async () => release());
}

function mountSheet(client: QueryClient = primedClient({ today: caution })): QueryClient {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: ["/plan"] },
          createElement(CoachSheetProvider, { loopDeps: quietLoop(() => run()) }, createElement(Routes, null, createElement(Route, { path: "/plan", element: createElement(Screen) }))),
        ),
      ),
    ),
  );
  return client;
}

const SESSION = {
  id: "session:a1",
  line: "Today's strength session is done — 42 min, all 18 sets in.",
  source: "session" as const,
  chips: [{ id: "session:a1", label: "Plan tomorrow around it", request: "Plan tomorrow around today's strength session — 42 min, all 18 sets in." }],
  workoutId: "w7",
};
const REVIEW = {
  id: "review:2026-10-05",
  line: "From last week's review: You ran 4 times for 32.1 kilometres.",
  source: "review" as const,
  chips: [{ id: "review:2026-10-05", label: "Plan this week", request: "Plan my week around how last week went." }],
};
const OFFER = { workoutId: "w7", title: "Leg day", date: TODAY, seconds: 2520, category: "strength" };

const opening = () => dialog()?.querySelector(".coach-opening") ?? null;
const holding = () => !!dialog()?.querySelector(".coach-opening--holding");
const drawn = () => !!dialog()?.querySelector(".coach-opening:not(.coach-opening--holding)");
const chips = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>(".coach-chips button") ?? [])].map((b) => b.textContent?.trim());
const line = () => dialog()?.querySelector(".coach-opening .coach-msg--coach p")?.textContent ?? null;
const tiles = () => dialog()?.querySelectorAll(".coach-start .stu-qs").length ?? 0;
const templatesLink = () => [...(dialog()?.querySelectorAll("a") ?? [])].find((a) => a.textContent === "Templates") ?? null;
const reads = (calls: Call[], path: string) => calls.filter((c) => c.path === path).length;

async function openCoach() {
  await click(document.getElementById("coach"), "the Coach button");
  await until(() => !!opening(), "the opening screen");
}

/** Nothing tappable drawn while it holds: no line, no chip, no tile, no link — one quiet status. */
function expectHolding() {
  expect(holding()).toBe(true);
  expect(line()).toBeNull();
  expect(chips()).toEqual([]);
  expect(tiles()).toBe(0);
  expect(templatesLink()).toBeNull();
  expect(dialog()!.querySelector(".coach-opening--holding [role=status]")?.textContent).toBe("Loading");
}

describe("the coach's opening holds still while it is read (2026-10-19)", () => {
  it("the chips' read out: nothing drawn; then once — the line, the needs-you chip first, the quick starts", async () => {
    server();
    const release = hold("/api/coach/nudges");
    mountSheet();
    await openCoach();
    await settle(50);
    expectHolding();
    await release();
    await until(drawn, "the opening drawn");
    expect(line()).toBe("A middling morning — steady suits today.");
    expect(chips()).toEqual([MISSED.label, ...GENERAL_CHIPS]);
    expect(tiles()).toBeGreaterThan(0);
    expect(templatesLink()).not.toBeNull();
  });

  it("the current run's read out ('Also waiting' would come late, above the quick starts): nothing drawn until it answers", async () => {
    server({ "GET /api/coach/runs/current": { run: null, alsoOpen: [{ proposalId: "dp-old", title: "Hips, gently", date: TODAY, time: "18:00", items: 1 }] } });
    const release = hold("/api/coach/runs/current");
    mountSheet();
    await click(document.getElementById("coach"), "the Coach button");
    await settle(50);
    // The conversation's own read has answered; the opening, if it is there, holds.
    expect(drawn()).toBe(false);
    expect(chips()).toEqual([]);
    await release();
    await until(drawn, "the opening drawn");
    expect(dialog()!.querySelector(".coach-also")?.textContent).toContain("Hips, gently");
  });

  it("the templates read out (a pinned template's tile would wrap the quick starts): nothing drawn until it answers", async () => {
    server();
    const release = hold("/api/templates");
    mountSheet();
    await openCoach();
    await settle(50);
    expectHolding();
    await release();
    await until(drawn, "the opening drawn");
    expect(chips()[0]).toBe(MISSED.label);
  });

  it("the Studio's reads out (a switched-on profile's care tile is theirs to decide): nothing drawn until they answer", async () => {
    server();
    const release = hold("/api/library");
    mountSheet();
    await openCoach();
    await settle(50);
    expectHolding();
    await release();
    await until(drawn, "the opening drawn");
    expect(dialog()!.querySelector(".coach-start .stu-qs .stu-qs-name")?.textContent).toBe("Jaw care");
  });

  it("drawn, it stays as drawn: a read landing later — another line, another chip — moves nothing", async () => {
    let nudges = [MISSED];
    let today: TodayResponse = caution;
    const calls = server({ "GET /api/coach/nudges": () => ({ nudges }), "GET /api/plan/today": () => today });
    const client = mountSheet();
    await openCoach();
    await until(drawn, "the opening drawn");
    const before = chips();
    expect(line()).toBe("A middling morning — steady suits today.");
    nudges = [{ id: "race:x", label: "Get me ready for race day", request: "Get me ready for race day." }, MISSED];
    today = good;
    await act(async () => {
      await client.refetchQueries({ queryKey: NUDGES_QUERY });
      await client.refetchQueries({ queryKey: ["today"] });
    });
    await settle(20);
    expect(reads(calls, "/api/coach/nudges")).toBe(2);
    expect(client.getQueryData<TodayResponse>(["today"])?.readiness?.verdict?.level).toBe("good");
    expect(chips()).toEqual(before);
    expect(line()).toBe("A middling morning — steady suits today.");
  });

  it("a session's quick review: offered as drawn, gone once it is saved — one offered after the opening was drawn waits for the next", async () => {
    const offer = { workoutId: "w7", title: "Leg day", date: TODAY, seconds: 2520, category: "strength" };
    let today: TodayResponse = { ...caution, watchReviews: [offer] } as TodayResponse;
    server({ "GET /api/plan/today": () => today });
    const client = mountSheet(primedClient({ today }));
    await openCoach();
    await until(drawn, "the opening drawn");
    const logButton = () => [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Log your session") ?? null;
    expect(logButton()).not.toBeNull();
    // Saved: the read again has none.
    today = caution;
    await act(async () => void (await client.refetchQueries({ queryKey: ["today"] })));
    await settle(20);
    expect(logButton()).toBeNull();
    // Another offered after the opening was drawn: not drawn now.
    today = { ...caution, watchReviews: [{ ...offer, workoutId: "w8" }] } as TodayResponse;
    await act(async () => void (await client.refetchQueries({ queryKey: ["today"] })));
    await settle(20);
    expect(logButton()).toBeNull();
  });

  it("the current run's read failing, after its retries: drawn without 'Also waiting' — never held for good", { timeout: 15_000 }, async () => {
    const calls = server({ "GET /api/coach/runs/current": () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }) });
    mountSheet();
    await click(document.getElementById("coach"), "the Coach button");
    // Its two retries wait a second, then two (run-keeper's `currentRetry`).
    for (let i = 0; i < 120 && !drawn(); i += 1) await settle(50);
    expect(drawn()).toBe(true);
    expect(reads(calls, "/api/coach/runs/current")).toBeGreaterThanOrEqual(3);
    expect(dialog()!.querySelector(".coach-also")).toBeNull();
    expect(chips()[0]).toBe(MISSED.label);
  });

  it("a read that fails is answered: drawn once from what there is — no spinner again, no read over and over", async () => {
    const calls = server({
      "GET /api/templates": () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
      "GET /api/coach/nudges": () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
    });
    mountSheet();
    await openCoach();
    await until(drawn, "the opening drawn");
    await settle(200);
    expect(holding()).toBe(false);
    expect(chips()).toEqual([...GENERAL_CHIPS]);
    expect(reads(calls, "/api/templates")).toBeLessThanOrEqual(3);
    expect(reads(calls, "/api/coach/nudges")).toBe(1);
  });
});

// ── The coach notices (stream H) ─────────────────────────────────────────────

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/coach/runs").map((c) => (c.body as { request: string }).request);
const chipClasses = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>(".coach-chips button") ?? [])].map((b) => b.className.replace(/^chip coach-chip ?/, ""));
const startRun = (body: unknown) => json({ run: run({ id: "run-h", request: (body as { request: string }).request }), existing: false, conversationId: "run-h" });

describe("the coach notices: its own line, and its chips first", () => {
  it("after a session: its line; Log how it felt first — it opens the quick review, nothing sent — then Plan tomorrow around it; two at most", async () => {
    const withOffer = { ...caution, watchReviews: [OFFER] } as TodayResponse;
    const calls = server({ "GET /api/coach/nudges": { nudges: [MISSED], opening: SESSION }, "GET /api/plan/today": withOffer, "POST /api/coach/runs": startRun });
    mountSheet(primedClient({ today: withOffer }));
    await openCoach();
    await until(drawn, "the opening drawn");
    expect(line()).toBe(SESSION.line);
    expect(dialog()!.querySelector(".coach-opening .coach-msg--coach .coach-msg-mark")).not.toBeNull();
    // The needs-you chip is past the two.
    expect(chips()).toEqual([HOW_IT_FELT, "Plan tomorrow around it", ...GENERAL_CHIPS]);
    expect(chipClasses().slice(0, 2)).toEqual(["coach-chip--opening", "coach-chip--opening"]);
    // The quick review is the chip's now, not also a button below.
    expect(button("Log your session", dialog()!)).toBeNull();
    await click(button(HOW_IT_FELT, dialog()!), "Log how it felt");
    await until(() => calls.some((c) => c.path === "/api/sessions/w7/watch-review"), "the quick review read");
    expect(posts(calls)).toEqual([]);
    await click(button("Not now"), "Not now");
    await click(button("Plan tomorrow around it", dialog()!), "Plan tomorrow around it");
    await until(() => posts(calls).length === 1, "the start");
    expect(posts(calls)).toEqual([SESSION.chips[0]!.request]);
  });

  it("a session with no quick review to log: Plan tomorrow around it, then the needs-you chip", async () => {
    server({ "GET /api/coach/nudges": { nudges: [MISSED], opening: { ...SESSION, source: "read", line: "Today's run: Even splits." } } });
    mountSheet();
    await openCoach();
    await until(drawn, "the opening drawn");
    expect(line()).toBe("Today's run: Even splits.");
    expect(chips()).toEqual(["Plan tomorrow around it", MISSED.label, ...GENERAL_CHIPS]);
    expect(chipClasses().slice(0, 2)).toEqual(["coach-chip--opening", "coach-chip--needs"]);
  });

  it("on Monday: the review's sentence, the whole of it one tap down, and Plan this week — Plan my week not said twice", async () => {
    const calls = server({ "GET /api/coach/nudges": { nudges: [], opening: REVIEW }, "POST /api/coach/runs": startRun });
    mountSheet();
    await openCoach();
    await until(drawn, "the opening drawn");
    expect(line()).toBe(REVIEW.line);
    const more = [...dialog()!.querySelectorAll<HTMLAnchorElement>(".coach-opening .coach-msg--coach a")];
    expect(more.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([[READ_THE_REVIEW, "/growth"]]);
    expect(chips()).toEqual(["Plan this week", "Something for right now", "I'm sore"]);
    await click(button("Plan this week", dialog()!), "Plan this week");
    await until(() => posts(calls).length === 1, "the start");
    expect(posts(calls)).toEqual(["Plan my week around how last week went."]);
  });

  it("a line drawn is kept as shown here: the next opening asks for what comes after it", async () => {
    let answer: unknown = { nudges: [], opening: REVIEW };
    const calls = server({ "GET /api/coach/nudges": () => answer });
    mountSheet();
    await openCoach();
    await until(drawn, "the opening drawn");
    expect(JSON.parse(localStorage.getItem(OPENING_SEEN_KEY) ?? "[]")).toEqual([REVIEW.id]);
    expect(calls.filter((c) => c.path === "/api/coach/nudges").map((c) => c.query)).toEqual([""]);
    await click(dialog()!.querySelector('button[aria-label="Close"]'), "✕");
    answer = { nudges: [], opening: SESSION };
    await openCoach();
    await until(() => drawn() && line() === SESSION.line, "the next line");
    expect(calls.filter((c) => c.path === "/api/coach/nudges").map((c) => decodeURIComponent(c.query))).toEqual(["", `seen=${REVIEW.id}`]);
    expect(JSON.parse(localStorage.getItem(OPENING_SEEN_KEY) ?? "[]")).toEqual([REVIEW.id, SESSION.id]);
    // None left: the day's own line.
    await click(dialog()!.querySelector('button[aria-label="Close"]'), "✕");
    answer = { nudges: [] };
    await openCoach();
    await until(() => drawn() && line() === "A middling morning — steady suits today.", "the day's line");
  });

  it("the device keeps the eight newest it has shown, each once; storage that holds anything else is none", () => {
    for (let i = 0; i < 10; i += 1) markOpeningSeen(`session:a${i}`);
    expect(JSON.parse(localStorage.getItem(OPENING_SEEN_KEY)!)).toHaveLength(OPENING_SEEN_MAX);
    markOpeningSeen("session:a5");
    expect(readOpeningSeen()).toEqual(["session:a2", "session:a3", "session:a4", "session:a6", "session:a7", "session:a8", "session:a9", "session:a5"]);
    localStorage.setItem(OPENING_SEEN_KEY, '[1, "session:x", null]');
    expect(readOpeningSeen()).toEqual(["session:x"]);
    localStorage.setItem(OPENING_SEEN_KEY, '{"not":"a list"}');
    expect(readOpeningSeen()).toEqual([]);
    localStorage.setItem(OPENING_SEEN_KEY, "not json");
    expect(readOpeningSeen()).toEqual([]);
  });

  it("no line of the coach's own while it holds: what the coach noticed waits with the rest", async () => {
    server({ "GET /api/coach/nudges": { nudges: [], opening: REVIEW } });
    const release = hold("/api/coach/nudges");
    mountSheet();
    await openCoach();
    await settle(50);
    expectHolding();
    expect(localStorage.getItem(OPENING_SEEN_KEY)).toBeNull();
    await release();
    await until(drawn, "the opening drawn");
    expect(line()).toBe(REVIEW.line);
  });
});
