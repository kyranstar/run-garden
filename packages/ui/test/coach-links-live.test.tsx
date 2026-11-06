// @vitest-environment jsdom
/**
 * A LINK PASTED INTO THE COACH (audit 2026-11-06, I5): the owner checks on imports "mostly in the coach", but the coach
 * had no way to take a link. A message that is only links goes to the link route (`POST /api/my-saves/links`, one call
 * a link), and the conversation shows where each stands — no model run. Words beside a link are the coach's, as ever.
 * Only what the owner typed is sent: the sheet's own words (an action's request) never are. The server is a stubbed
 * fetch; the step loop a stand-in. Synthetic data only.
 */
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachConversationDto } from "@rg/api-client";
import type { LinkDto } from "@rg/saves";
import { useCoach } from "../src/screens/studio/coach-ask.js";
import { CoachSheetProvider } from "../src/screens/studio/coach-sheet.js";
import { stillMoving, type PastedTurn } from "../src/screens/studio/coach-links.js";
import { click, dialog, json, quietLoop, run, serve, settle, text, type, until, type Call } from "./coach-live-harness.js";
import { libraryDto, placesDto, primedClient, profileDto, TODAY, todayDto } from "./studio-fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S = ["ht", "tps://"].join("");
const yt = (v: string) => `${S}www.${["you", "tube.com"].join("")}/watch?v=${v}`;
const A = "Zx9_-QaB3cD";
const B = "Yt0000000ab";

const ONE_TURN: CoachConversationDto = {
  id: "run-1",
  startedAt: `${TODAY}T08:00:00.000Z`,
  turns: [{ runId: "run-1", at: `${TODAY}T08:00:00.000Z`, words: "Something for my hips", status: "finished", line: "Here's a gentle one for your hips.", cards: [], question: null }],
};
const waiting = (key: string): LinkDto => ({
  id: `l-${key}`, source: "youtube", key, url: yt(key), title: null, addedAt: `${TODAY}T09:00:00.000Z`, addedFrom: "app", postId: null,
  state: "waiting", words: "Waiting for your computer's extension", moves: null, action: null, batchId: null,
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.unstubAllGlobals();
});

function Screen({ request }: { request?: string }) {
  const coach = useCoach();
  return createElement("button", { type: "button", id: "coach", onClick: () => coach?.open(request ? { request } : undefined) }, "Coach");
}

function mount(request?: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const client = primedClient({ today: todayDto(null) });
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: ["/plan"] },
          createElement(CoachSheetProvider, { loopDeps: quietLoop(() => run()) }, createElement(Routes, null, createElement(Route, { path: "/plan", element: createElement(Screen, { request }) }))),
        ),
      ),
    ),
  );
}

function server(more: Record<string, unknown> = {}): Call[] {
  return serve({
    ...more,
    "GET /api/my-saves/open": { open: null },
    "GET /api/coach/runs/current": { run: null },
    "GET /api/coach/conversation": ONE_TURN,
    "GET /api/coach/nudges": { nudges: [] },
    "GET /api/templates": { templates: [] },
    "GET /api/objectives": { objectives: [] },
    "GET /api/library": libraryDto({ tmj: true }),
    "GET /api/places": placesDto(["dumbbells"]),
    "GET /api/profile": profileDto(),
    "GET /api/plan/today": todayDto(null),
    "GET /api/my-saves/links": { links: [waiting(A)] },
    "POST /api/my-saves/links": (body: { url: string }) =>
      body.url === yt(A) ? { state: "added", link: waiting(A) } : { state: "known", postId: "p9", firstSeenAt: "2026-11-03T15:00:00.000Z" },
    "POST /api/coach/runs": (body: { request: string }) => json({ run: run({ id: "run-2", request: body.request }), existing: false, conversationId: "run-1" }),
  });
}

const box = () => dialog()?.querySelector<HTMLTextAreaElement>(".coach-box textarea") ?? null;
const send = () => dialog()?.querySelector<HTMLButtonElement>(".coach-box button[type=submit]") ?? null;
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path).map((c) => c.body);

async function openCoach() {
  await click(document.getElementById("coach"), "the Coach button");
  await until(() => !!box(), "the box");
  await until(() => !!dialog()?.querySelector(".coach-turns"), "the conversation");
}

describe("a link pasted into the coach's box", () => {
  it("only links: each goes to the link route, the conversation says where each stands, and no run starts", async () => {
    const calls = server();
    mount();
    await openCoach();
    await type(box()!, `${yt(A)}\n${yt(B)}`);
    await click(send(), "Send");
    await until(() => posts(calls, "/api/my-saves/links").length === 2, "both links sent");
    expect(posts(calls, "/api/my-saves/links")).toEqual([{ url: yt(A) }, { url: yt(B) }]);
    expect(posts(calls, "/api/coach/runs")).toEqual([]);
    await until(() => text().includes("Already in — imported Tue 3 Nov."), "the second link's answer");
    const said = dialog()!.querySelector<HTMLElement>(".coach-links")!;
    expect(said).toBeTruthy();
    const rows = [...said.querySelectorAll("li")].map((li) => [li.querySelector(".coach-link-title")!.textContent, li.querySelector(".coach-link-words")!.textContent]);
    expect(rows).toEqual([
      [yt(A), "Waiting for your computer's extension"],
      [yt(B), "Already in — imported Tue 3 Nov."],
    ]);
    expect(box()!.value).toBe("");
  });

  it("a playlist alone is answered for what it is, and nothing is sent anywhere", async () => {
    const calls = server();
    mount();
    await openCoach();
    await type(box()!, `${S}www.${["you", "tube.com"].join("")}/playlist?list=PLzorbex`);
    await click(send(), "Send");
    await settle(10);
    expect(posts(calls, "/api/my-saves/links")).toEqual([]);
    expect(posts(calls, "/api/coach/runs")).toEqual([]);
    expect(text()).toContain("Single videos and posts only — not playlists or channels.");
  });

  it("words beside a link are a message to the coach: a run starts, no link is added", async () => {
    const calls = server();
    mount();
    await openCoach();
    await type(box()!, `What do you make of this one? ${yt(A)}`);
    await click(send(), "Send");
    await until(() => posts(calls, "/api/coach/runs").length === 1, "the run started");
    expect(posts(calls, "/api/my-saves/links")).toEqual([]);
  });

  it("the sheet's own words (an action's request) are never sent as links, even when they are one", async () => {
    const calls = server();
    mount(yt(A));
    await openCoach();
    expect(box()!.value).toBe(yt(A));
    await click(send(), "Send");
    await settle(10);
    expect(posts(calls, "/api/my-saves/links")).toEqual([]);
  });
});

describe("the coach's pasted links, settled (review, 2026-11-06)", () => {
  const turn = (settled: boolean): PastedTurn => ({ id: 1, words: yt(A), rows: [{ source: "youtube", key: A, url: yt(A), words: "Waiting", settled }], note: null });
  it("a link is on its way until the link list says where it ended: then the list is read no more", () => {
    expect(stillMoving([turn(false)], undefined)).toBe(true);
    expect(stillMoving([turn(false)], [waiting(A)])).toBe(true);
    expect(stillMoving([turn(false)], [{ ...waiting(A), state: "moves", words: "2 moves", moves: 2 }])).toBe(false);
    expect(stillMoving([turn(false)], [{ ...waiting(A), state: "failed", words: "Failed: x" }])).toBe(false);
    expect(stillMoving([turn(true)], [waiting(A)])).toBe(false);
  });

  it("links go in even when the week's coach budget is used up: they cost the coach nothing", async () => {
    const calls = server({ "GET /api/coach/spend": { spentMicros: 5_000_000, cutoffMicros: 5_000_000 } });
    mount();
    await openCoach();
    await until(() => text().includes("This week's AI budget is used up."), "the budget line");
    await type(box()!, yt(A));
    expect(send()!.disabled).toBe(false);
    await click(send(), "Send");
    await until(() => posts(calls, "/api/my-saves/links").length === 1, "the link sent");
    expect(posts(calls, "/api/coach/runs")).toEqual([]);
  });
});
