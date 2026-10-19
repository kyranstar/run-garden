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
import { GENERAL_CHIPS } from "../src/screens/studio/coach-conversation-model.js";
import { NUDGES_QUERY } from "../src/screens/studio/coach-opening.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import { click, dialog, quietLoop, run, serve, settle, until, type Call, type Routes as Served } from "./coach-live-harness.js";
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
